import { describe, expect, it, vi } from 'vitest';
import { SqliteRepository } from '../src/adapters/sqlite.js';

describe('SQLite repository lifecycle', () => {
  it('waits for an in-flight pending-question read before closing the client', async () => {
    let releaseRead!: () => void;
    let startedRead!: () => void;
    let closed = false;
    const readStarted = new Promise<void>((resolve) => (startedRead = resolve));
    const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
    type FakeClient = {
      execute: () => Promise<{ rows: never[] }>;
      close: () => void;
    };
    const client = {
      execute: vi.fn(async () => {
        startedRead();
        await readGate;
        if (closed) throw new Error('LibsqlError: SQLITE_IOERR: disk I/O error');
        return { rows: [] };
      }),
      close: vi.fn(() => {
        closed = true;
      }),
    };
    const Repository = SqliteRepository as unknown as new (
      client: FakeClient,
      maxPending: number,
    ) => SqliteRepository;
    const repository = new Repository(client as FakeClient, 1000);

    const pendingQuestions = repository.active();
    await readStarted;
    const closing = repository.close();

    expect(client.close).not.toHaveBeenCalled();
    releaseRead();
    await expect(pendingQuestions).resolves.toEqual([]);
    await closing;
    expect(client.close).toHaveBeenCalledOnce();
  });
});
