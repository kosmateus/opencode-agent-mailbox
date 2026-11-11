import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import type { Plugin } from '@opencode/plugin';
import { SqliteRepository } from '../src/adapters/sqlite.js';
import { watchSessionDeletion } from '../src/adapters/lifecycle.js';
import { SessionModeStore } from '../src/adapters/session-mode.js';
import { Mailbox } from '../src/application/mailbox.js';
import { Dispatcher } from '../src/application/dispatcher.js';
import { SessionCleanup } from '../src/application/cleanup.js';
import { MailboxError, type Session } from '../src/domain/model.js';
import type { Sessions } from '../src/ports/index.js';

let directory: string, repo: SqliteRepository, mailbox: Mailbox, dispatcher: Dispatcher;
let nodes: Map<string, Session>, host: Sessions, cleanup: SessionCleanup;
beforeEach(async () => {
  directory = await mkdtemp('/tmp/opencode/mailbox-cleanup-');
  repo = await SqliteRepository.open(join(directory, 'mailbox.db'));
  nodes = new Map(
    ['A', 'B', 'C', 'S'].map((id) => [
      id,
      {
        id,
        title: id,
        projectID: 'p',
        archived: false,
        ...(id === 'A' ? {} : { parentID: id === 'C' ? 'B' : 'A' }),
      },
    ]),
  );
  host = {
    get: async (id) => {
      const session = nodes.get(id);
      if (!session) throw new MailboxError('SESSION_UNAVAILABLE', 'Missing');
      return session;
    },
    admit: vi.fn(async () => {}),
  };
  mailbox = new Mailbox(repo, host);
  dispatcher = new Dispatcher(repo, host);
  cleanup = new SessionCleanup(repo, host);
});
afterEach(async () => {
  await dispatcher.stop();
  repo.close();
  await rm(directory, { recursive: true, force: true });
});

describe('session deletion cleanup', () => {
  it('purges sender, recipient, intermediate-hop and settled notification records, not unrelated conversations', async () => {
    const question = await mailbox.ask('A', 'B', 'Question');
    const sender = await mailbox.ask('B', 'C', 'From deleted sender');
    const forwarded = await mailbox.ask('A', 'B', 'Forwarded');
    await mailbox.forward('B', forwarded.requestID, 'C');
    const information = await mailbox.ask('A', 'B', 'Info', 'info', undefined, false);
    const other = await mailbox.ask('A', 'S', 'Unrelated');
    await mailbox.reply('S', other.requestID, 'Keep this answer');
    await dispatcher.tick();
    expect((await repo.get(information.requestID))?.state).toBe('notified');
    await cleanup.remove('B');
    for (const receipt of [question, sender, forwarded, information])
      expect(await repo.get(receipt.requestID)).toBeUndefined();
    expect((await repo.get(other.requestID))?.answer?.text).toBe('Keep this answer');
    await expect(mailbox.inspect('A', question.requestID)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('prevents stale writes and late asks from resurrecting deleted-session payloads across connections', async () => {
    const question = await mailbox.ask('A', 'B', 'Erase me');
    const stale = (await repo.get(question.requestID))!;
    const other = await SqliteRepository.open(join(directory, 'mailbox.db'));
    try {
      await other.purgeSession('B');
      await expect(
        repo.update(stale.id, () => ({ request: stale, result: undefined })),
      ).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' });
      await expect(mailbox.ask('A', 'B', 'Stale authorization')).rejects.toMatchObject({
        code: 'SESSION_UNAVAILABLE',
      });
      expect(await repo.get(stale.id)).toBeUndefined();
      expect(await repo.active()).toEqual([]);
    } finally {
      other.close();
    }
  });
  it('retains content-free deletion guards after a repository restart', async () => {
    const question = await mailbox.ask('A', 'B', 'Do not restore after restart');
    const stale = (await repo.get(question.requestID))!;
    await cleanup.remove('B');
    await dispatcher.stop();
    repo.close();
    repo = await SqliteRepository.open(join(directory, 'mailbox.db'));
    dispatcher = new Dispatcher(repo, host);
    await expect(repo.update(stale.id, () => ({ request: stale, result: undefined }))).rejects.toMatchObject({
      code: 'SESSION_UNAVAILABLE',
    });
    expect(await repo.get(stale.id)).toBeUndefined();
  });
  it('guards a deletion between authorization and the first request write without retaining foreign-session IDs', async () => {
    host.hasSeen = (id) => id === 'B';
    await cleanup.remove('B');
    await cleanup.remove('foreign-session');
    await expect(mailbox.ask('A', 'B', 'Late first write')).rejects.toMatchObject({
      code: 'SESSION_UNAVAILABLE',
    });
    const db = createClient({ url: pathToFileURL(join(directory, 'mailbox.db')).href });
    try {
      const rows = (await db.execute('SELECT id FROM deleted_sessions')).rows;
      expect(rows.map((row) => row.id)).toEqual(['B']);
    } finally {
      db.close();
    }
  });
  it('removes only the deleted root’s session setting overrides', async () => {
    const values = new Map<string, unknown>();
    const storage = {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => {
        values.set(key, value);
      },
      remove: async (key: string) => {
        values.delete(key);
      },
    };
    const settings = new SessionModeStore(storage as never, 'p');
    await settings.set('A', 'bidirectional', true);
    await settings.set('S', 'wakeOnReply', false);
    await new SessionCleanup(repo, host, (id) => settings.remove(id)).remove('A');
    expect(await settings.get('A', 'bidirectional')).toBeUndefined();
    expect(await settings.get('S', 'wakeOnReply')).toBe(false);
  });
  it('does not recreate a request when deletion races with an in-flight admission acknowledgement', async () => {
    const question = await mailbox.ask('A', 'B', 'In flight');
    host.admit = async () => {
      await repo.purgeSession('B');
    };
    await expect(dispatcher.tick()).resolves.toBeUndefined();
    expect(await repo.get(question.requestID)).toBeUndefined();
    expect(await repo.active()).toEqual([]);
  });
  it('reconciles missed deletion events for settled records while retaining archived sessions', async () => {
    const deleted = await mailbox.ask('A', 'B', 'Settled info', 'offline', undefined, false);
    const archived = await mailbox.ask('A', 'S', 'Archived is not deleted');
    await dispatcher.tick();
    nodes.delete('B');
    nodes.get('S')!.archived = true;
    await cleanup.reconcile();
    expect(await repo.get(deleted.requestID)).toBeUndefined();
    expect(await repo.get(archived.requestID)).toBeDefined();
  });
  it('does not purge content on transient lookup errors', async () => {
    const question = await mailbox.ask('A', 'B', 'Retain on network failure');
    host.get = async () => {
      throw new Error('Temporary host failure');
    };
    await expect(cleanup.reconcile()).rejects.toThrow('Temporary host failure');
    expect(await repo.get(question.requestID)).toBeDefined();
  });
  it('cleans all delivery references even if they are not present in a legacy route', async () => {
    const question = await mailbox.ask('A', 'S', 'Legacy references');
    await repo.update(question.requestID, (current) => {
      current!.outbox[0]!.from = 'B';
      return { request: current, result: undefined };
    });
    expect(await repo.sessionIDs()).toContain('B');
    await cleanup.remove('B');
    expect(await repo.get(question.requestID)).toBeUndefined();
  });
  it('handles global deletion events idempotently and stops its subscription on unload', async () => {
    const question = await mailbox.ask('A', 'B', 'Delete through event');
    const other = await mailbox.ask('A', 'S', 'Keep through foreign event');
    let resolve!: () => void;
    const processed = new Promise<void>((done) => {
      resolve = done;
    });
    const remove = cleanup.remove.bind(cleanup);
    vi.spyOn(cleanup, 'remove').mockImplementation(async (id) => {
      await remove(id);
      if (id === 'foreign-session') resolve();
    });
    const ctx = {
      event: {
        subscribe: async function* ({ signal }: { signal: AbortSignal }) {
          for (const sessionID of ['B', 'B', 'foreign-session'])
            yield { type: 'session.deleted', data: { sessionID } };
          if (!signal.aborted)
            await new Promise<void>((done) => signal.addEventListener('abort', () => done(), { once: true }));
        },
      },
    } as unknown as Plugin.Context;
    const stop = watchSessionDeletion(ctx, cleanup);
    await processed;
    expect(await repo.get(question.requestID)).toBeUndefined();
    expect(await repo.get(other.requestID)).toBeDefined();
    await stop();
  });
});
