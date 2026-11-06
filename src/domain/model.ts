import { z } from 'zod';
export const SessionID = z.string().min(1).max(256);
export const Text = z.string().trim().min(1).max(16000);
export const RequestID = z.string().regex(/^req_[a-f0-9]{64}$/);
export const Delivery = z.object({
  id: z.string(),
  kind: z.enum(['question', 'answer']),
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
  state: z.enum(['pending', 'answered', 'cancelled', 'expired', 'failed']),
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
