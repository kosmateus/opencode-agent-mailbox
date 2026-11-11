import { MailboxError } from '../domain/model.js';
import type { Repository, Sessions } from '../ports/index.js';

export class SessionCleanup {
  constructor(
    private readonly repo: Repository,
    private readonly sessions: Sessions,
    private readonly removeSettings: (sessionID: string) => Promise<void> = async () => {},
  ) {}
  async remove(sessionID: string): Promise<void> {
    await this.repo.purgeSession(sessionID, this.sessions.hasSeen?.(sessionID) ?? false);
    await this.removeSettings(sessionID);
  }
  /** Reconcile missed deletion events before any outbox dispatch, including settled messages. */
  async reconcile(): Promise<void> {
    const ids = await this.repo.sessionIDs();
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, ids.length) }, async () => {
        while (cursor < ids.length) {
          const id = ids[cursor++]!;
          try {
            await this.sessions.get(id);
          } catch (error) {
            if (!(error instanceof MailboxError)) throw error;
            if (error.code === 'SESSION_UNAVAILABLE') await this.remove(id);
            else if (error.code !== 'FORBIDDEN') throw error;
          }
        }
      }),
    );
  }
}
