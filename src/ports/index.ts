import type { Delivery, Request, Session } from '../domain/model.js';
export interface Repository {
  get(id: string): Promise<Request | undefined>;
  /** Callback is synchronous; request and outbox are committed atomically. */
  update<T>(
    id: string,
    change: (current: Request | undefined) => { request: Request; result: T },
  ): Promise<T>;
  active(): Promise<Request[]>;
  close(): void;
}
export interface Sessions {
  get(id: string): Promise<Session>;
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
