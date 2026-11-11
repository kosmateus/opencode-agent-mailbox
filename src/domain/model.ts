import { z } from 'zod';
export const SessionID = z.string().min(1).max(256);
export const MAX_TEXT_CODE_UNITS = 16000;
export const Text = z.string().min(1).max(MAX_TEXT_CODE_UNITS).regex(/\S/u);
export const RequestID = z.string().regex(/^req_[a-f0-9]{64}$/);
export const Delivery = z.object({
  id: z.string(),
  kind: z.enum(['question', 'answer', 'notification']),
  from: SessionID,
  to: SessionID,
  text: Text,
  state: z.enum(['pending', 'admitted', 'failed', 'cancelled']),
  attempts: z.number().int().nonnegative(),
  nextAt: z.number(),
  error: z.string().optional(),
});
export type Delivery = z.infer<typeof Delivery>;
export const Request = z.object({
  version: z.literal(1),
  id: RequestID,
  origin: SessionID,
  holder: SessionID,
  question: Text,
  route: z.array(SessionID).min(2),
  createdAt: z.number(),
  expiresAt: z.number(),
  requiresReply: z.boolean().default(true),
  wakeOnReply: z.boolean().optional(),
  state: z.enum(['pending', 'answered', 'notified', 'cancelled', 'expired', 'failed']),
  answer: z.object({ by: SessionID, text: Text }).optional(),
  outbox: z.array(Delivery),
});
export type Request = z.infer<typeof Request>;
export type ErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CLOSED'
  | 'CONFLICT'
  | 'SESSION_UNAVAILABLE'
  | 'CAPACITY'
  | 'STORAGE'
  | 'SHUTDOWN';
export class MailboxError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MailboxError';
  }
}
export function parseMessage(value: unknown, maxMessageLength: number): string {
  const parsed = Text.safeParse(value);
  if (!parsed.success)
    throw new MailboxError(
      'INVALID_INPUT',
      `message must be nonempty and no more than ${MAX_TEXT_CODE_UNITS} UTF-16 code units.`,
    );
  const length = [...parsed.data].length;
  if (length > maxMessageLength)
    throw new MailboxError(
      'INVALID_INPUT',
      `message exceeds maxMessageLength (${maxMessageLength} Unicode code points).`,
    );
  return parsed.data;
}
export interface Session {
  id: string;
  parentID?: string;
  projectID: string;
  title: string;
  archived: boolean;
}
export function assertOpen(request: Request, now: number): void {
  if (request.state !== 'pending' || request.expiresAt <= now)
    throw new MailboxError('CLOSED', 'Request is settled, cancelled or expired.');
}
export function assertHolder(request: Request, actor: string): void {
  if (request.holder !== actor)
    throw new MailboxError('FORBIDDEN', 'Only the current recipient may reply or forward.');
}
export function assertNoLoop(request: Request, target: string): void {
  if (request.route.includes(target)) throw new MailboxError('FORBIDDEN', 'Routing cycle rejected.');
}
