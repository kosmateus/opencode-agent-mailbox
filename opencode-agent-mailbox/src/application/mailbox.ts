import { createHash, randomUUID } from 'node:crypto';
import {
  assertHolder,
  assertNoLoop,
  assertOpen,
  MailboxError,
  Text,
  type Delivery,
  type Request,
} from '../domain/model.js';
import type { Clock, Repository, Sessions } from '../ports/index.js';
export const idFor = (key: string): string => 'req_' + createHash('sha256').update(key).digest('hex');
export class Mailbox {
  constructor(
    private readonly repo: Repository,
    private readonly sessions: Sessions,
    private readonly clock: Clock = { now: Date.now },
    private readonly ttlMs = 300000,
  ) {}
  private async descendant(actor: string, target: string): Promise<void> {
    const source = await this.sessions.get(actor);
    if (source.archived) throw new MailboxError('SESSION_UNAVAILABLE', 'Sender is archived.');
    const seen = new Set<string>([actor]);
    let node = await this.sessions.get(target);
    if (node.archived) throw new MailboxError('SESSION_UNAVAILABLE', 'Recipient is archived.');
    while (true) {
      if (seen.has(node.id) || node.projectID !== source.projectID)
        throw new MailboxError('FORBIDDEN', 'Target must be a strict descendant in the same project.');
      seen.add(node.id);
      if (node.parentID === actor) return;
      if (!node.parentID) throw new MailboxError('FORBIDDEN', 'Target is outside your subtree.');
      node = await this.sessions.get(node.parentID);
      if (node.archived) throw new MailboxError('SESSION_UNAVAILABLE', 'An ancestor is archived.');
    }
  }
  private delivery(r: Request, kind: Delivery['kind'], from: string, to: string, text: string): Delivery {
    return {
      id: 'msg_' + createHash('sha256').update(`${r.id}:${kind}:${r.route.length}`).digest('hex'),
      kind,
      from,
      to,
      text,
      state: 'pending',
      attempts: 0,
      nextAt: this.clock.now(),
    };
  }
  async ask(actor: string, target: string, text: string, key: string = randomUUID(), timeoutMs = this.ttlMs) {
    text = Text.parse(text);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 86400000)
      throw new MailboxError('INVALID_INPUT', 'timeoutMs must be an integer from 1000 to 86400000.');
    await this.descendant(actor, target);
    const id = idFor(JSON.stringify([actor, key]));
    return this.repo.update(id, (current) => {
      if (current) {
        if (current.question !== text || current.route[1] !== target)
          throw new MailboxError('CONFLICT', 'Idempotency key already used with different input.');
        return { request: current, result: { requestID: id, state: current.state } };
      }
      const now = this.clock.now();
      const request: Request = {
        version: 1,
        id,
        origin: actor,
        holder: target,
        question: text,
        route: [actor, target],
        createdAt: now,
        expiresAt: now + timeoutMs,
        state: 'pending',
        outbox: [],
      };
      request.outbox.push(this.delivery(request, 'question', actor, target, text));
      return { request, result: { requestID: id, state: request.state } };
    });
  }
  async reply(actor: string, id: string, text: string) {
    text = Text.parse(text);
    return this.repo.update(id, (current) => {
      const request = this.required(current);
      assertHolder(request, actor);
      if (request.state === 'answered') {
        if (request.answer?.text !== text)
          throw new MailboxError('CONFLICT', 'An immutable answer already exists.');
        return { request, result: { requestID: id, state: request.state } };
      }
      assertOpen(request, this.clock.now());
      request.state = 'answered';
      request.answer = { by: actor, text };
      request.outbox.push(this.delivery(request, 'answer', actor, request.origin, text));
      return { request, result: { requestID: id, state: request.state } };
    });
  }
  async forward(actor: string, id: string, target: string) {
    // Authorize before revealing or querying a target on behalf of a caller.
    const existing = this.required(await this.repo.get(id));
    if (!(existing.holder === target && existing.route.at(-2) === actor)) assertHolder(existing, actor);
    await this.descendant(actor, target);
    return this.repo.update(id, (current) => {
      const request = this.required(current);
      if (request.holder === target && request.route.at(-2) === actor)
        return { request, result: { requestID: id, state: request.state, targetSessionID: target } };
      assertHolder(request, actor);
      assertOpen(request, this.clock.now());
      assertNoLoop(request, target);
      request.holder = target;
      request.route.push(target);
      // An undelivered old question is superseded; admitted history cannot be retracted.
      for (const item of request.outbox)
        if (item.kind === 'question' && item.state === 'pending') item.state = 'cancelled';
      request.outbox.push(this.delivery(request, 'question', actor, target, request.question));
      return { request, result: { requestID: id, state: request.state, targetSessionID: target } };
    });
  }
  async cancel(actor: string, id: string) {
    return this.repo.update(id, (current) => {
      const request = this.required(current);
      if (request.origin !== actor)
        throw new MailboxError('FORBIDDEN', 'Only the original sender may cancel.');
      if (request.state !== 'cancelled') {
        assertOpen(request, this.clock.now());
        request.state = 'cancelled';
      }
      for (const item of request.outbox) if (item.state === 'pending') item.state = 'cancelled';
      return { request, result: { requestID: id, state: request.state } };
    });
  }
  async inspect(actor: string, id: string): Promise<Request> {
    const request = this.required(await this.repo.get(id));
    if (!request.route.includes(actor)) throw new MailboxError('FORBIDDEN', 'Request is outside your route.');
    // Intermediate agents do not receive the answer body through inspection.
    if (actor !== request.origin && actor !== request.holder) {
      const copy = structuredClone(request);
      delete copy.answer;
      copy.outbox = copy.outbox.filter((d) => d.kind !== 'answer');
      return copy;
    }
    return request;
  }
  private required(request: Request | undefined): Request {
    if (!request) throw new MailboxError('NOT_FOUND', 'Unknown requestID.');
    return request;
  }
}
