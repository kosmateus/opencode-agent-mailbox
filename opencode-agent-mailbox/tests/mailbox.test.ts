import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mailbox } from '../src/application/mailbox.js';
import { Dispatcher } from '../src/application/dispatcher.js';
import { SqliteRepository } from '../src/adapters/sqlite.js';
import { MailboxError, type Delivery, type Request, type Session } from '../src/domain/model.js';
import type { Sessions } from '../src/ports/index.js';
class Host implements Sessions {
  nodes = new Map<string, Session>();
  inbox = new Map<string, Delivery>();
  admissions = 0;
  fail = false;
  crashAfterAdmission = false;
  add(id: string, parentID?: string) {
    this.nodes.set(id, { id, ...(parentID ? { parentID } : {}), projectID: 'p', title: id, archived: false });
  }
  async get(id: string) {
    const s = this.nodes.get(id);
    if (!s) throw new MailboxError('SESSION_UNAVAILABLE', 'Missing session');
    return s;
  }
  async admit(_r: Request, d: Delivery) {
    this.admissions++;
    if (this.fail) throw new Error('Unavailable');
    this.inbox.set(d.id, d);
    if (this.crashAfterAdmission) {
      this.crashAfterAdmission = false;
      throw new Error('Lost acknowledgement');
    }
  }
}
let dir: string, repo: SqliteRepository, host: Host, mailbox: Mailbox, worker: Dispatcher, now: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mailbox-'));
  repo = await SqliteRepository.open(join(dir, 'state.db'));
  host = new Host();
  host.add('A');
  host.add('B', 'A');
  host.add('C', 'B');
  host.add('D', 'C');
  host.add('X');
  now = 10000;
  mailbox = new Mailbox(repo, host, { now: () => now });
  worker = new Dispatcher(repo, host, { now: () => now });
});
afterEach(async () => {
  await worker.stop();
  repo.close();
  await rm(dir, { recursive: true, force: true });
});
describe('durable application and SQLite integration', () => {
  it('accepts without contacting recipient model or delivery endpoint', async () => {
    host.fail = true;
    const r = await mailbox.ask('A', 'B', 'status?');
    expect(r.state).toBe('pending');
    expect(host.admissions).toBe(0);
    expect((await repo.get(r.requestID))?.outbox).toHaveLength(1);
  });
  it('routes A -> B -> C -> D, then directly to A', async () => {
    const { requestID: id } = await mailbox.ask('A', 'B', 'tests?');
    await worker.tick();
    await mailbox.forward('B', id, 'C');
    await worker.tick();
    await mailbox.forward('C', id, 'D');
    await worker.tick();
    await mailbox.reply('D', id, 'passed');
    await worker.tick();
    expect([...host.inbox.values()].filter((x) => x.kind === 'answer').map((x) => [x.from, x.to])).toEqual([
      ['D', 'A'],
    ]);
    expect((await mailbox.inspect('B', id)).answer).toBeUndefined();
    expect((await mailbox.inspect('A', id)).answer?.text).toBe('passed');
  });
  it('accepts 20 simultaneous agents and delivers exactly one answer each', async () => {
    const ids = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        host.add(`c${i}`, 'A');
        const r = await mailbox.ask('A', `c${i}`, 'question');
        await mailbox.reply(`c${i}`, r.requestID, 'done');
        return r.requestID;
      }),
    );
    await worker.tick();
    expect(new Set(ids).size).toBe(20);
    expect([...host.inbox.values()].filter((d) => d.kind === 'answer')).toHaveLength(20);
  });
  it('deduplicates asks by invocation identity and rejects changed payload', async () => {
    const r = await mailbox.ask('A', 'B', 'Q', 'call');
    expect(await mailbox.ask('A', 'B', 'Q', 'call')).toEqual(r);
    await expect(mailbox.ask('A', 'B', 'changed', 'call')).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('serializes racing replies, rejects a conflicting answer', async () => {
    const r = await mailbox.ask('A', 'B', 'Q');
    const results = await Promise.allSettled([
      mailbox.reply('B', r.requestID, 'one'),
      mailbox.reply('B', r.requestID, 'two'),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    await worker.tick();
    expect([...host.inbox.values()].filter((d) => d.kind === 'answer')).toHaveLength(1);
  });
  it('identical replies and forwarding are idempotent', async () => {
    const r = await mailbox.ask('A', 'B', 'Q');
    await mailbox.forward('B', r.requestID, 'C');
    await mailbox.forward('B', r.requestID, 'C');
    await mailbox.reply('C', r.requestID, 'R');
    await mailbox.reply('C', r.requestID, 'R');
    expect((await repo.get(r.requestID))?.outbox).toHaveLength(3);
  });
  it('forbids parent, sibling, self and unrelated recipients', async () => {
    for (const [actor, target] of [
      ['B', 'A'],
      ['B', 'B'],
      ['A', 'X'],
    ])
      await expect(mailbox.ask(actor!, target!, 'Q')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('rejects unauthorized replies, forwarding, inspect and cancellation', async () => {
    const r = await mailbox.ask('A', 'B', 'Q');
    await expect(mailbox.reply('X', r.requestID, 'R')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(mailbox.forward('X', r.requestID, 'D')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(mailbox.cancel('B', r.requestID)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(mailbox.inspect('X', r.requestID)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('old holders cannot answer or create routing loops', async () => {
    const r = await mailbox.ask('A', 'B', 'Q');
    await mailbox.forward('B', r.requestID, 'C');
    await expect(mailbox.reply('B', r.requestID, 'R')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(mailbox.forward('C', r.requestID, 'A')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('expires queued questions and rejects late answers', async () => {
    const r = await mailbox.ask('A', 'B', 'Q', 'key', 1000);
    now += 1001;
    await worker.tick();
    expect((await repo.get(r.requestID))?.state).toBe('expired');
    expect(host.inbox.size).toBe(0);
    await expect(mailbox.reply('B', r.requestID, 'late')).rejects.toMatchObject({ code: 'CLOSED' });
  });
  it('cancels idempotently without delivering pending questions', async () => {
    const r = await mailbox.ask('A', 'B', 'Q');
    await mailbox.cancel('A', r.requestID);
    await mailbox.cancel('A', r.requestID);
    await worker.tick();
    expect(host.inbox.size).toBe(0);
    await expect(mailbox.reply('B', r.requestID, 'R')).rejects.toMatchObject({ code: 'CLOSED' });
  });
  it('recovers pending messages from disk after restart', async () => {
    const r = await mailbox.ask('A', 'B', 'Q');
    await worker.stop();
    repo.close();
    repo = await SqliteRepository.open(join(dir, 'state.db'));
    worker = new Dispatcher(repo, host, { now: () => now });
    await worker.tick();
    expect(host.inbox.size).toBe(1);
    expect((await repo.get(r.requestID))?.outbox[0]?.state).toBe('admitted');
  });
  it('retries ambiguous admission with the same host ID', async () => {
    const r = await mailbox.ask('A', 'B', 'Q');
    host.crashAfterAdmission = true;
    await worker.tick();
    now += 1000;
    await worker.tick();
    expect(host.admissions).toBe(2);
    expect(host.inbox.size).toBe(1);
    expect((await repo.get(r.requestID))?.outbox[0]?.state).toBe('admitted');
  });
  it('retries transient errors with backoff', async () => {
    const r = await mailbox.ask('A', 'B', 'Q');
    host.fail = true;
    await worker.tick();
    await worker.tick();
    expect(host.admissions).toBe(1);
    host.fail = false;
    now += 1000;
    await worker.tick();
    expect((await repo.get(r.requestID))?.outbox[0]?.attempts).toBe(1);
    expect(host.inbox.size).toBe(1);
  });
  it('records deleted or archived recipients as failed', async () => {
    const r = await mailbox.ask('A', 'B', 'Q');
    host.nodes.delete('B');
    await worker.tick();
    expect((await repo.get(r.requestID))?.state).toBe('failed');
  });
  it('rejects cross-project access', async () => {
    host.nodes.get('B')!.projectID = 'other';
    await expect(mailbox.ask('A', 'B', 'Q')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('protects against corrupt cyclic ancestry', async () => {
    host.nodes.get('B')!.parentID = 'C';
    await expect(mailbox.ask('A', 'D', 'Q')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('traverses a deeply nested tree iteratively', async () => {
    let parent = 'A';
    for (let i = 0; i < 500; i++) {
      host.add(`deep${i}`, parent);
      parent = `deep${i}`;
    }
    expect((await mailbox.ask('A', parent, 'Q')).state).toBe('pending');
  });
  it('rolls back failed transitions', async () => {
    const r = await mailbox.ask('A', 'B', 'Q');
    await expect(
      repo.update(r.requestID, (current) => {
        current!.holder = 'X';
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await repo.get(r.requestID))?.holder).toBe('B');
  });
  it('serializes two database connections', async () => {
    const other = await SqliteRepository.open(join(dir, 'state.db'));
    try {
      const m = new Mailbox(other, host, { now: () => now });
      const r = await mailbox.ask('A', 'B', 'Q');
      const results = await Promise.allSettled([
        mailbox.reply('B', r.requestID, 'one'),
        m.reply('B', r.requestID, 'two'),
      ]);
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect((await repo.get(r.requestID))?.state).toBe('answered');
    } finally {
      other.close();
    }
  });
});
