import { MailboxError } from '../domain/model.js';
import type { Clock, Repository, Sessions } from '../ports/index.js';
/** Stable host inbox IDs make concurrent workers and crash-after-admission safe. */
export class Dispatcher {
  private running: Promise<void> | undefined;
  private stopped = false;
  constructor(
    private readonly repo: Repository,
    private readonly sessions: Sessions,
    private readonly clock: Clock = { now: Date.now },
  ) {}
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return (this.running ??= this.drain().finally(() => {
      this.running = undefined;
    }));
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
  }
  private async drain(): Promise<void> {
    const requests = await this.repo.active();
    // Bounded parallelism without a depth limit or a model call in the delivery path.
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(16, requests.length) }, async () => {
        while (!this.stopped) {
          const snapshot = requests[cursor++];
          if (!snapshot) return;
          await this.deliver(snapshot.id);
        }
      }),
    );
  }
  private async deliver(id: string): Promise<void> {
    const request = await this.repo.update(id, (r) => {
      if (!r) throw new MailboxError('NOT_FOUND', 'Request disappeared.');
      if (r.state === 'pending' && r.expiresAt <= this.clock.now()) {
        r.state = 'expired';
        for (const d of r.outbox) if (d.state === 'pending') d.state = 'cancelled';
      }
      return { request: r, result: r };
    });
    for (const delivery of request.outbox) {
      if (delivery.state !== 'pending' || delivery.nextAt > this.clock.now()) continue;
      // Re-read before dispatch to reduce cancellation races. Host admission remains the boundary.
      const current = await this.repo.get(id);
      if (!current?.outbox.some((d) => d.id === delivery.id && d.state === 'pending')) continue;
      try {
        const recipient = await this.sessions.get(delivery.to);
        if (recipient.archived) throw new MailboxError('SESSION_UNAVAILABLE', 'Recipient is archived.');
        await this.sessions.admit(request, delivery);
        await this.repo.update(id, (r) => {
          if (!r) throw new MailboxError('NOT_FOUND', 'Request disappeared.');
          const d = r.outbox.find((x) => x.id === delivery.id);
          if (d) {
            d.state = 'admitted';
            delete d.error;
          }
          return { request: r, result: undefined };
        });
      } catch (error) {
        await this.repo.update(id, (r) => {
          if (!r) throw new MailboxError('NOT_FOUND', 'Request disappeared.');
          const d = r.outbox.find((x) => x.id === delivery.id);
          if (d?.state === 'pending') {
            d.attempts++;
            d.error = error instanceof Error ? error.message.slice(0, 300) : 'Delivery failed';
            const permanent =
              error instanceof MailboxError && ['SESSION_UNAVAILABLE', 'FORBIDDEN'].includes(error.code);
            if (permanent || this.clock.now() >= r.expiresAt) {
              d.state = 'failed';
              if (r.state === 'pending') r.state = 'failed';
            } else d.nextAt = this.clock.now() + Math.min(30000, 250 * 2 ** Math.min(d.attempts, 7));
          }
          return { request: r, result: undefined };
        });
      }
    }
  }
}
