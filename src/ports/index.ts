import type { Delivery, Request, Session } from '../domain/model.js';
export interface Repository {
  get(id: string): Promise<Request | undefined>;
  /** Callback is synchronous; undefined request means no write (for a concurrently purged record). */
  update<T>(
    id: string,
    change: (current: Request | undefined) => { request: Request | undefined; result: T },
  ): Promise<T>;
  active(): Promise<Request[]>;
  sessionIDs(): Promise<string[]>;
  purgeSession(sessionID: string, knownParticipant?: boolean): Promise<void>;
  close(): void;
}
export interface Sessions {
  get(id: string): Promise<Session>;
  /** A successful project-scoped lookup also covers authorization before a request is committed. */
  hasSeen?(id: string): boolean;
  /** Admission is idempotent by delivery.id, never waits for a model. */
  admit(request: Request, delivery: Delivery): Promise<void>;
}
export type TreeSetting = 'bidirectional' | 'wakeOnReply';
/** Optional user overrides scoped to a project's session-tree root. */
export interface TreeSettings {
  get(rootSessionID: string, setting: TreeSetting): Promise<boolean | undefined>;
  set(rootSessionID: string, setting: TreeSetting, enabled: boolean): Promise<void>;
}
export interface Clock {
  now(): number;
}
