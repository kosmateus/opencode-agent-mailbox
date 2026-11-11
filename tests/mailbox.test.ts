import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mailbox, idFor } from '../src/application/mailbox.js';
import { Dispatcher } from '../src/application/dispatcher.js';
import { SqliteRepository } from '../src/adapters/sqlite.js';
import { MailboxError, Request, type Delivery, type Session } from '../src/domain/model.js';
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
  host.add('S', 'A');
  host.add('T', 'S');
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
  it('forbids parent, sibling, self and unrelated recipients by default', async () => {
    for (const [actor, target] of [
      ['B', 'A'],
      ['B', 'S'],
      ['B', 'B'],
      ['A', 'X'],
    ])
      await expect(mailbox.ask(actor!, target!, 'Q')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('allows any unvisited session in the same tree when globally enabled', async () => {
    const enabled = new Mailbox(repo, host, { now: () => now }, 300000, { bidirectional: true });

    expect((await enabled.ask('B', 'A', 'parent question')).state).toBe('pending');
    expect((await enabled.ask('B', 'S', 'sibling question')).state).toBe('pending');
    expect((await enabled.ask('C', 'T', 'cousin question')).state).toBe('pending');
    await expect(enabled.ask('B', 'X', 'other root')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('lets the user override mode for the whole root tree without affecting another tree', async () => {
    expect(await mailbox.setBidirectional('B', true)).toEqual({ rootSessionID: 'A', enabled: true });
    expect((await mailbox.ask('B', 'S', 'sibling question')).state).toBe('pending');
    expect((await mailbox.ask('T', 'B', 'cousin question')).state).toBe('pending');
    await expect(mailbox.ask('X', 'A', 'other tree')).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(await mailbox.setBidirectional('C', false)).toEqual({ rootSessionID: 'A', enabled: false });
    await expect(mailbox.ask('B', 'S', 'mode is off')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('returns only this session’s unexpired pending questions without their content', async () => {
    const own = await mailbox.ask('A', 'B', 'private question', 'pending-own');
    await mailbox.ask('B', 'C', 'another origin', 'pending-other');
    await mailbox.ask('A', 'B', 'informational update', 'pending-info', 100000, false);
    await mailbox.ask('A', 'B', 'about to expire', 'pending-expiring', 1000);
    now += 1001;

    expect(await mailbox.pendingQuestions('A')).toEqual({ count: 1, nextExpiresAt: 310000 });
    expect(await mailbox.pendingQuestions('B')).toEqual({ count: 1, nextExpiresAt: 310000 });
    expect(await mailbox.pendingQuestions('X')).toEqual({ count: 0 });
    expect(Object.keys(await mailbox.pendingQuestions('A')).sort()).toEqual(['count', 'nextExpiresAt']);
    expect((await repo.get(own.requestID))?.question).toBe('private question');
  });
  it('applies reply wake-up settings per tree without changing another root or config default', async () => {
    expect(await mailbox.shouldWakeOnReply('A')).toBe(true);
    await mailbox.setWakeOnReply('B', false);
    expect(await mailbox.shouldWakeOnReply('A')).toBe(false);
    expect(await mailbox.shouldWakeOnReply('X')).toBe(true);
    await mailbox.setWakeOnReply('C', true);
    expect(await mailbox.shouldWakeOnReply('A')).toBe(true);

    const globallyDisabled = new Mailbox(repo, host, { now: () => now }, 300000, { wakeOnReply: false });
    expect(await globallyDisabled.shouldWakeOnReply('A')).toBe(false);
    expect(await globallyDisabled.shouldWakeOnReply('X')).toBe(false);
    await globallyDisabled.setWakeOnReply('B', true);
    expect(await globallyDisabled.shouldWakeOnReply('A')).toBe(true);
    expect(await globallyDisabled.shouldWakeOnReply('X')).toBe(false);
  });
  it('toggles the effective session settings in both directions without changing global defaults', async () => {
    const defaults = { wakeOnReply: false, bidirectional: true };
    const configured = new Mailbox(repo, host, { now: () => now }, 300000, defaults);
    expect(await configured.setWakeOnReply('B')).toEqual({ rootSessionID: 'A', enabled: true });
    expect(await configured.setWakeOnReply('C')).toEqual({ rootSessionID: 'A', enabled: false });
    expect(await configured.shouldWakeOnReply('X')).toBe(false);
    expect(await configured.setBidirectional('B')).toEqual({ rootSessionID: 'A', enabled: false });
    await expect(configured.ask('B', 'S', 'off')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await configured.setBidirectional('C')).toEqual({ rootSessionID: 'A', enabled: true });
    await expect(configured.ask('B', 'S', 'on')).resolves.toMatchObject({ state: 'pending' });
    expect(defaults).toEqual({ wakeOnReply: false, bidirectional: true });
  });
  it('uses tree-wide authorization when forwarding only after opt-in', async () => {
    const r = await mailbox.ask('A', 'B', 'Q');
    await mailbox.setBidirectional('A', true);

    await mailbox.forward('B', r.requestID, 'S');
    expect((await repo.get(r.requestID))?.holder).toBe('S');
  });
  it('persists per-request wake policy across forward and includes it in idempotency', async () => {
    const r = await mailbox.ask('A', 'B', 'Question', 'wake-policy', undefined, true, false);
    expect((await repo.get(r.requestID))?.wakeOnReply).toBe(false);
    await mailbox.forward('B', r.requestID, 'C');
    expect((await repo.get(r.requestID))?.wakeOnReply).toBe(false);
    await expect(
      mailbox.ask('A', 'B', 'Question', 'wake-policy', undefined, true, true),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(mailbox.ask('A', 'B', 'Question', 'wake-policy', undefined, false)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const explicitWake = await mailbox.ask('A', 'B', 'Another question', 'wake-true', undefined, true, true);
    expect((await repo.get(explicitWake.requestID))?.wakeOnReply).toBe(true);
    await expect(
      mailbox.ask('A', 'B', 'Info', 'wake-invalid', undefined, false, false),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(await repo.get(idFor(JSON.stringify(['A', 'wake-invalid'])))).toBeUndefined();
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
  it('rejects another project even when bidirectional mode is enabled', async () => {
    const enabled = new Mailbox(repo, host, { now: () => now }, 300000, { bidirectional: true });
    host.add('other-project');
    host.nodes.get('other-project')!.projectID = 'other';
    await expect(enabled.ask('A', 'other-project', 'Q')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('enforces the default 4000 Unicode-code-point message limit for questions and replies', async () => {
    const atLimit = 'x'.repeat(4000);
    const r = await mailbox.ask('A', 'B', atLimit);
    await expect(mailbox.ask('A', 'B', `${atLimit}x`, 'too-long-4001')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(await repo.get(idFor(JSON.stringify(['A', 'too-long-4001'])))).toBeUndefined();
    await expect(mailbox.reply('B', r.requestID, `${atLimit}x`)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect((await repo.get(r.requestID))?.outbox).toHaveLength(1);
  });
  it('preserves the accepted message exactly without trimming or truncating', async () => {
    const message = '  leading and trailing whitespace\n';
    const r = await mailbox.ask('A', 'B', message);

    expect((await repo.get(r.requestID))?.question).toBe(message);
    expect((await repo.get(r.requestID))?.outbox[0]?.text).toBe(message);
  });
  it('supports a custom Unicode code-point limit without truncating', async () => {
    const limited = new Mailbox(repo, host, { now: () => now }, 300000, { maxMessageLength: 1 });
    const r = await limited.ask('A', 'B', '😀');

    await expect(limited.ask('A', 'B', '😀x')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(limited.reply('B', r.requestID, '😀x')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await repo.get(r.requestID))?.question).toBe('😀');
  });
  it('does not revalidate an already accepted question against a lower limit when forwarding', async () => {
    const wide = new Mailbox(repo, host, { now: () => now }, 300000, { maxMessageLength: 8 });
    const r = await wide.ask('A', 'B', '12345678');
    const narrow = new Mailbox(repo, host, { now: () => now }, 300000, { maxMessageLength: 1 });

    await expect(narrow.forward('B', r.requestID, 'C')).resolves.toMatchObject({ targetSessionID: 'C' });
    expect((await repo.get(r.requestID))?.question).toBe('12345678');
  });
  it('delivers informational notifications without waiting for or accepting a reply', async () => {
    const r = await mailbox.ask('A', 'B', 'An update', 'notification', 1000, false);

    expect(r.state).toBe('pending');
    await worker.tick();
    const saved = await repo.get(r.requestID);
    expect(saved?.requiresReply).toBe(false);
    expect(saved?.state).toBe('notified');
    expect(saved?.outbox[0]).toMatchObject({ kind: 'notification', state: 'admitted' });
    await expect(mailbox.reply('B', r.requestID, 'No reply')).rejects.toMatchObject({
      code: 'CLOSED',
      message: 'This informational notification does not require or accept a reply.',
    });
    await expect(mailbox.forward('B', r.requestID, 'C')).rejects.toMatchObject({
      code: 'CLOSED',
      message: 'Informational notifications cannot be forwarded as questions.',
    });
    now += 1001;
    await worker.tick();
    expect((await repo.get(r.requestID))?.state).toBe('notified');
    expect(host.admissions).toBe(1);
  });
  it('reads legacy requests as questions with inherited default wake policy', () => {
    const legacy = Request.parse({
      version: 1,
      id: `req_${'a'.repeat(64)}`,
      origin: 'A',
      holder: 'B',
      question: 'Q',
      route: ['A', 'B'],
      createdAt: 0,
      expiresAt: 1000,
      state: 'pending',
      outbox: [],
    });

    expect(legacy.requiresReply).toBe(true);
    expect(legacy.wakeOnReply).toBeUndefined();
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
