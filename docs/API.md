# API reference

The caller identity is always OpenCode's trusted tool context `sessionID`, never an input parameter. Message text is agent-supplied data and does not grant new authority. Tool execution first validates inputs, then evaluates host permission rules, then performs the domain transition.

## Inputs

All inputs are strict JSON objects; unknown fields are rejected.

```ts
type Ask = {
  sessionID: string;
  message: string;
  timeoutMs?: number;
  requiresReply?: boolean;
  wakeOnReply?: boolean;
};
type Reply = { requestID: string; message: string };
type Forward = { requestID: string; targetSessionID: string };
type RequestLookup = { requestID: string }; // request_status, cancel_request
type SubagentStatus = Record<string, never>; // {}
type PendingQuestions = { sessionID: string }; // TUI RPC, not a model tool
```

Session IDs: nonempty strings, at most 256 characters; get their actual values from native subagent results or `subagent_status`. Messages must contain a non-whitespace character and have a configurable `maxMessageLength` of 1-16000 Unicode code points (default 4000). A separate hard cap of 16000 UTF-16 code units remains in place. Accepted text is preserved exactly, including leading and trailing whitespace; overlong input returns `INVALID_INPUT` and is never truncated. `requiresReply` defaults to true; `wakeOnReply` optionally overrides the sender's wake policy and is only valid when a reply is required. Request IDs: `req_` followed by 64 hexadecimal characters. Timeout: integer 1000-86400000 milliseconds, relative to durable request creation.

Examples:

```js
ask_subagent({ sessionID: 'ses_child', message: 'Which tests fail?', timeoutMs: 60000 });
ask_subagent({
  sessionID: 'ses_child',
  message: 'Investigate the failure; wake me when answered.',
  wakeOnReply: true,
});
ask_subagent({ sessionID: 'ses_child', message: 'The build is ready.', requiresReply: false });
reply_request({ requestID, message: 'The retry integration test fails.' });
forward_question({ requestID, targetSessionID: 'ses_grandchild' });
subagent_status({});
request_status({ requestID });
cancel_request({ requestID });
```

`requestID` in the examples is the actual ID returned by `ask_subagent`, not a literal placeholder string.

## Outputs

Tool `content` is a JSON-encoded object. These discriminated shapes describe its decoded value:

```ts
type State = 'pending' | 'answered' | 'notified' | 'cancelled' | 'expired' | 'failed';
type Receipt = { ok: true; requestID: string; state: State; targetSessionID?: string };
type Failure = { ok: false; error: { code: ErrorCode; message: string } };
type Delivery = {
  id: string;
  kind: 'question' | 'answer' | 'notification';
  from: string;
  to: string;
  text: string;
  state: 'pending' | 'admitted' | 'failed' | 'cancelled';
  attempts: number;
  nextAt: number;
  error?: string;
};
type RequestStatus = {
  ok: true;
  version: 1;
  id: string;
  origin: string;
  holder: string;
  question: string;
  route: string[];
  createdAt: number;
  expiresAt: number;
  requiresReply: boolean;
  wakeOnReply?: boolean;
  state: State;
  answer?: { by: string; text: string };
  outbox: Delivery[];
};
type Status = {
  ok: true;
  rootSessionID: string;
  observedAt: number;
  note: string;
  agents: Array<{
    sessionID: string;
    parentID?: string;
    depth: number;
    title?: string;
    activity: 'running' | 'idle';
    archived: boolean;
    outcome?: 'succeeded' | 'failed' | 'interrupted';
    activeTools: string[];
    lastAction?: string;
    lastActionAt?: number;
    lastError?: unknown;
    elapsedMs: number;
  }>;
};
type PendingQuestionCount = { count: number; nextExpiresAt?: number };
```

`lastError` retains the official OpenCode session error shape. All timestamps and durations are milliseconds. `elapsedMs` covers the most recent execution, not cumulative model CPU time. A tree read is a best-effort snapshot, not a global transaction across all live sessions. Status can change as it is read.

For schema compatibility, `RequestStatus.question` contains the original message text for both questions and informational notifications; `requiresReply` and the outbox `kind` distinguish them. Legacy requests without `requiresReply` are read as `true`.

The TUI-only `MailboxControl.pendingQuestions({sessionID})` RPC returns `PendingQuestionCount` for pending, unexpired, reply-requiring requests whose exact `origin` is that session. It reveals no request IDs or message content and does not poll a model. The TUI should query only the currently visible session.

`/mailbox-bidirectional` and `/mailbox-wake-on-reply` toggle the effective value for the current session tree when called without arguments. Both accept `on` or `off` for an explicit value. Their RPC methods, `setBidirectional` and `setWakeOnReply`, take `{sessionID, enabled?}` and return `{rootSessionID, enabled}`; omitting `enabled` toggles the current effective value. No command writes plugin configuration or affects an independent root.

`ask_subagent`, `reply_request`, `forward_question` and `cancel_request` return `Receipt | Failure`; `request_status` returns `RequestStatus | Failure`; `subagent_status` returns `Status | Failure`. Host permission rejection/abort may terminate the tool before a JSON result.

## Semantics

- Acceptance waits for hierarchy checks and durable storage, never for the recipient model. Dispatch is asynchronous, bounded to 16 requests in flight per dispatcher.
- Replaying the same ask invocation (sessionID + messageID + tool call ID) reuses its request ID. A new tool invocation is a new question, even with identical text.
- Reply authorization is exclusive to the current holder. An identical repeated reply returns success; a different second reply is `CONFLICT`.
- By default, asking and forwarding require a strict descendant in the same project. If the global `bidirectional` option is true, or the user enables the current tree with `/mailbox-bidirectional on`, either operation may target any other session sharing the same root and project, including ancestors, siblings and cousins. Separate trees and projects remain isolated. A user can explicitly disable a tree with `/mailbox-bidirectional off`; models cannot change this setting. Per-tree overrides persist in plugin storage and override the global default.
- Answer wake-up precedence is explicit request `wakeOnReply`, then the current tree's user override (`/mailbox-wake-on-reply on|off`), then global `wakeOnReply` (default true). This policy controls waking the original sender after an answer. The tree command changes only that session tree, not plugin configuration. Answers to active sessions do not duplicate or interrupt their current run. When answer wake-up is disabled, an answer is still durably queued for the sender's next run.
- `pendingQuestions` is a read-only UI aggregate. It filters by exact origin, reply-required state, pending lifecycle and unexpired deadline, and returns only a count and next deadline.
- `requiresReply:false` delivers an informational notification with no reply/forward right. After successful admission its request reaches terminal state `notified`; no reply timeout is expected. A question or notification to a direct child or authorized peer subagent (such as a sibling or cousin) uses `resume:true`. Non-direct descendants and upward messages to parents/ancestors do not force a wake. Sibling/cousin routing still requires user-enabled bidirectional authorization. These recipient-wake rules are independent of `wakeOnReply`, which only controls waking the original sender after an answer. Supplying `wakeOnReply` with `requiresReply:false` is `INVALID_INPUT`.
- Forwarding requires the current holder. Visited sessions cannot be revisited. Repeating the most recent identical hop is idempotent. A delayed retry after a later hop is forbidden. Forwarding uses the already accepted question text; it is not rejected just because a later configuration lowers `maxMessageLength`.
- Forwarding retains the original requestID and `origin`; only `holder`, route and question outbox change. The final answer goes to `origin` without asking any intermediate model.
- The original sender can cancel only while pending. Expiry is enforced on every reply/forward and by the dispatcher. An expired request may display pending until the next dispatcher scan, but late writes are already rejected.
- `answered` means an immutable answer was saved, not that its original sender has read it. Inspect the answer outbox entry for admission status. `notified` means a no-reply informational message was admitted successfully.
- Missing or archived recipients produce terminal delivery failures. Transient errors retry with capped exponential backoff until the request's deadline. A saved answer may therefore have a failed delivery while its request remains `answered`.
- Deleting any participant session asynchronously purges the request and its outbox; later `request_status` returns `NOT_FOUND`. This includes original senders, current recipients, forwarding hops and notification participants. Missed deletions are reconciled on startup. Archives are retained. Content-free deletion guards reject stale writes without restoring payloads. Existing copies in surviving host transcripts are not erased.
- Idle or previously completed sessions remain addressable. Questions and notifications wake direct children and authorized peer subagents, but not non-direct descendants or upward parent/ancestor recipients. Answers wake an idle original sender only when the effective wake policy allows it. Archived/deleted sessions are not addressable. There is no assumption that a completed execution means the session was deleted.
- Cancellation/forwarding may race with an in-flight host admission. Already admitted stale questions remain visible; authorization rejects an obsolete holder's answer. The public plugin context has no inbox cancellation API, so the plugin does not bypass it with private endpoints.

## Errors

- `INVALID_INPUT`: malformed JSON contract, empty/oversized message, invalid timeout or ID. Message limits count Unicode code points, not UTF-16 code units; no content is silently cut off.
- `NOT_FOUND`: unknown request ID.
- `FORBIDDEN`: wrong holder/sender, cross-project or cross-tree route, non-descendant while bidirectional mode is disabled, cycle or unauthorized inspection.
- `CLOSED`: cancelled, expired or settled request cannot undergo this transition; informational notifications cannot be replied to or forwarded.
- `CONFLICT`: idempotency identity reused with different input, or an immutable answer differs.
- `SESSION_UNAVAILABLE`: deleted, unknown or archived participant.
- `CAPACITY`: active request limit reached. Wait for completion/expiry before creating more.
- `STORAGE`: an unexpected storage/host operation could not be confirmed. Internal paths and raw exceptions are not returned to the model. Check the request before repeating a side effect.

Error codes are stable; human-readable messages may evolve. None of these errors silently changes session permissions or ends another agent's task.
