import { createClient, type Client } from '@libsql/client';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Request, MailboxError, participants } from '../domain/model.js';
import type { Repository } from '../ports/index.js';
// Hot reload/package caches can load physically distinct native SQLite copies.
// Their in-process lock tables do not coordinate, even for identical binaries.
// Keep all our connections in one native runtime, not merely one write queue.
const runtimeKey = Symbol.for('@opentoria/opencode-agent-mailbox/sqlite-runtime/v1');
type SqliteRuntime = {
  createClient: typeof createClient;
  writeQueues: Map<string | symbol, Promise<void>>;
};
const processGlobals = globalThis as typeof globalThis & { [runtimeKey]?: SqliteRuntime };
const runtime = (processGlobals[runtimeKey] ??= { createClient, writeQueues: new Map() });
const { writeQueues } = runtime;
export class SqliteRepository implements Repository {
  private inFlight = 0;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private drained: (() => void) | undefined;
  private constructor(
    private readonly db: Client,
    private readonly maxPending: number,
    private readonly queueKey: string | symbol = Symbol(),
  ) {}
  static async open(path: string, maxPending = 1000): Promise<SqliteRepository> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const url = pathToFileURL(path).href;
    const db = runtime.createClient({ url });
    try {
      await db.execute('PRAGMA busy_timeout=0');
      await db.execute('PRAGMA synchronous=FULL');
      await retryBusy(() => db.execute('PRAGMA journal_mode=WAL'));
      await retryBusy(() =>
        db.execute(
          'CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, active INTEGER NOT NULL, body TEXT NOT NULL)',
        ),
      );
      await retryBusy(() => db.execute('CREATE INDEX IF NOT EXISTS requests_active ON requests(active)'));
      await retryBusy(() => db.execute('CREATE TABLE IF NOT EXISTS deleted_sessions (id TEXT PRIMARY KEY)'));
      await chmod(path, 0o600);
      return new SqliteRepository(db, maxPending, url);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  private decode(body: unknown): Request {
    return Request.parse(JSON.parse(String(body)));
  }
  get(id: string): Promise<Request | undefined> {
    return this.withConnection(async () => {
      const row = (await this.db.execute({ sql: 'SELECT body FROM requests WHERE id=?', args: [id] }))
        .rows[0];
      return row ? this.decode(row.body) : undefined;
    });
  }
  update<T>(
    id: string,
    change: (current: Request | undefined) => { request: Request | undefined; result: T },
  ): Promise<T> {
    const execute = async () => {
      const tx = await this.db.transaction('write');
      try {
        const row = (await tx.execute({ sql: 'SELECT body FROM requests WHERE id=?', args: [id] })).rows[0];
        const { request, result } = change(row ? this.decode(row.body) : undefined);
        if (!request) {
          await tx.commit();
          return result;
        }
        Request.parse(request);
        const deleted = await tx.execute({
          sql: 'SELECT id FROM deleted_sessions WHERE id IN (SELECT value FROM json_each(?)) LIMIT 1',
          args: [JSON.stringify(participants(request))],
        });
        if (deleted.rows.length)
          throw new MailboxError('SESSION_UNAVAILABLE', 'A request participant has been deleted.');
        if (!row) {
          const count = (await tx.execute('SELECT COUNT(*) AS n FROM requests WHERE active=1')).rows[0];
          if (Number(count?.n) >= this.maxPending)
            throw new MailboxError('CAPACITY', 'Pending request limit reached.');
        }
        const active = request.state === 'pending' || request.outbox.some((d) => d.state === 'pending');
        await tx.execute({
          sql: 'INSERT INTO requests(id,active,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET active=excluded.active,body=excluded.body',
          args: [id, active ? 1 : 0, JSON.stringify(request)],
        });
        await tx.commit();
        return result;
      } catch (error) {
        await tx.rollback();
        throw error;
      } finally {
        tx.close();
      }
    };
    return this.withConnection(() => this.serialize(execute));
  }
  active(): Promise<Request[]> {
    return this.withConnection(async () =>
      (await this.db.execute('SELECT body FROM requests WHERE active=1')).rows.map((r) =>
        this.decode(r.body),
      ),
    );
  }
  sessionIDs(): Promise<string[]> {
    return this.withConnection(async () => {
      const ids = new Set<string>();
      for (const row of (await this.db.execute('SELECT body FROM requests')).rows)
        for (const id of participants(this.decode(row.body))) ids.add(id);
      return [...ids];
    });
  }
  purgeSession(sessionID: string, knownParticipant = false): Promise<void> {
    return this.withConnection(() =>
      this.serialize(async () => {
        const tx = await this.db.transaction('write');
        try {
          const removed = await tx.execute({
            sql: `DELETE FROM requests WHERE json_extract(body, '$.origin') = ?
            OR json_extract(body, '$.holder') = ?
            OR EXISTS (SELECT 1 FROM json_each(body, '$.route') WHERE value = ?)
            OR EXISTS (SELECT 1 FROM json_each(body, '$.outbox')
              WHERE json_extract(value, '$.from') = ? OR json_extract(value, '$.to') = ?)`,
            args: [sessionID, sessionID, sessionID, sessionID, sessionID],
          });
          if (removed.rowsAffected || knownParticipant)
            await tx.execute({
              sql: 'INSERT OR IGNORE INTO deleted_sessions(id) VALUES(?)',
              args: [sessionID],
            });
          await tx.commit();
        } catch (error) {
          await tx.rollback();
          throw error;
        } finally {
          tx.close();
        }
      }),
    );
  }
  private serialize<T>(execute: () => Promise<T>): Promise<T> {
    const previous = writeQueues.get(this.queueKey) ?? Promise.resolve();
    const job = previous.then(() => retryBusy(execute));
    const tail = job.then(
      () => undefined,
      () => undefined,
    );
    writeQueues.set(this.queueKey, tail);
    void tail.then(() => {
      if (writeQueues.get(this.queueKey) === tail) writeQueues.delete(this.queueKey);
    });
    return job;
  }
  private withConnection<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new MailboxError('STORAGE', 'Mailbox storage is closing.'));
    this.inFlight++;
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        this.inFlight--;
        if (this.closing && this.inFlight === 0) this.drained?.();
      });
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      if (this.inFlight) await new Promise<void>((resolve) => (this.drained = resolve));
      this.db.close();
    })();
    return this.closePromise;
  }
}

async function retryBusy<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const busy = error instanceof Error && /SQLITE_BUSY|database is locked/.test(error.message);
      if (!busy || attempt >= 12) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250, 10 * 2 ** attempt) + Math.random() * 20),
      );
    }
  }
}
