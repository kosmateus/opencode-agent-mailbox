import { createClient, type Client } from '@libsql/client';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Request, MailboxError, participants } from '../domain/model.js';
import type { Repository } from '../ports/index.js';
export class SqliteRepository implements Repository {
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(
    private readonly db: Client,
    private readonly maxPending: number,
  ) {}
  static async open(path: string, maxPending = 1000): Promise<SqliteRepository> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const db = createClient({ url: pathToFileURL(path).href });
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
      return new SqliteRepository(db, maxPending);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  private decode(body: unknown): Request {
    return Request.parse(JSON.parse(String(body)));
  }
  async get(id: string): Promise<Request | undefined> {
    const row = (await this.db.execute({ sql: 'SELECT body FROM requests WHERE id=?', args: [id] })).rows[0];
    return row ? this.decode(row.body) : undefined;
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
    return this.serialize(execute);
  }
  async active(): Promise<Request[]> {
    return (await this.db.execute('SELECT body FROM requests WHERE active=1')).rows.map((r) =>
      this.decode(r.body),
    );
  }
  async sessionIDs(): Promise<string[]> {
    const ids = new Set<string>();
    for (const row of (await this.db.execute('SELECT body FROM requests')).rows)
      for (const id of participants(this.decode(row.body))) ids.add(id);
    return [...ids];
  }
  purgeSession(sessionID: string, knownParticipant = false): Promise<void> {
    return this.serialize(async () => {
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
    });
  }
  private serialize<T>(execute: () => Promise<T>): Promise<T> {
    const job = this.tail.then(() => retryBusy(execute));
    this.tail = job.catch(() => undefined);
    return job;
  }
  close(): void {
    this.db.close();
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
