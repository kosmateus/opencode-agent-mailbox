# API reference

The caller identity is always OpenCode's trusted tool context `sessionID`, never an input parameter. Message text is agent-supplied data and does not grant new authority. Tool execution first validates inputs, then evaluates host permission rules, then performs the domain transition.

## Inputs

All inputs are strict JSON objects; unknown fields are rejected.

```ts
type Ask = { sessionID: string; message: string; timeoutMs?: number };
type Reply = { requestID: string; message: string };
type Forward = { requestID: string; targetSessionID: string };
type RequestLookup = { requestID: string }; // request_status, cancel_request
type SubagentStatus = Record<string, never>; // {}
```

Session IDs: nonempty strings, at most 256 characters; get their actual values from native subagent results or `subagent_status`. Messages: trimmed, nonempty, at most 16000 characters. Request IDs: `req_` followed by 64 hexadecimal characters. Timeout: integer 1000-86400000 milliseconds, relative to durable request creation.

Examples:

```js
ask_subagent({ sessionID: 'ses_child', message: 'Which tests fail?', timeoutMs: 60000 });
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
type State = 'pending' | 'answered' | 'cancelled' | 'expired' | 'failed';
type Receipt = { ok: true; requestID: string; state: State; targetSessionID?: string };
type Failure = { ok: false; error: { code: ErrorCode; message: string } };
type Delivery = {
  id: string;
  kind: 'question' | 'answer';
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
```

`lastError` retains the official OpenCode session error shape. All timestamps and durations are milliseconds. `elapsedMs` covers the most recent execution, not cumulative model CPU time. A tree read is a best-effort snapshot, not a global transaction across all live sessions. Status can change as it is read.

`ask_subagent`, `reply_request`, `forward_question` and `cancel_request` return `Receipt | Failure`; `request_status` returns `RequestStatus | Failure`; `subagent_status` returns `Status | Failure`. Host permission rejection/abort may terminate the tool before a JSON result.

## Semantics

- Acceptance waits for hierarchy checks and durable storage, never for the recipient model. Dispatch is asynchronous, bounded to 16 requests in flight per dispatcher.
- Replaying the same ask invocation (sessionID + messageID + tool call ID) reuses its request ID. A new tool invocation is a new question, even with identical text.
- Reply authorization is exclusive to the current holder. An identical repeated reply returns success; a different second reply is `CONFLICT`.
- Forwarding requires the current holder and a strict descendant in the same project. Visited sessions cannot be revisited. Repeating the most recent identical hop is idempotent. A delayed retry after a later hop is forbidden.
- Forwarding retains the original requestID and `origin`; only `holder`, route and question outbox change. The final answer goes to `origin` without asking any intermediate model.
- The original sender can cancel only while pending. Expiry is enforced on every reply/forward and by the dispatcher. An expired request may display pending until the next dispatcher scan, but late writes are already rejected.
- `answered` means an immutable answer was saved, not that its recipient has read it. Inspect the answer outbox entry for admission status.
- Missing or archived recipients produce terminal delivery failures. Transient errors retry with capped exponential backoff until the request's deadline. A saved answer may therefore have a failed delivery while its request remains `answered`.
- Idle or previously completed sessions remain addressable, with no forced wake. Archived/deleted sessions are not addressable. There is no assumption that a completed execution means the session was deleted.
- Cancellation/forwarding may race with an in-flight host admission. Already admitted stale questions remain visible; authorization rejects an obsolete holder's answer. The public plugin context has no inbox cancellation API, so the plugin does not bypass it with private endpoints.

## Errors

- `INVALID_INPUT`: malformed JSON contract, empty/oversized message, invalid timeout or ID.
- `NOT_FOUND`: unknown request ID.
- `FORBIDDEN`: wrong holder/sender, cross-project route, non-descendant, cycle or unauthorized inspection.
- `CLOSED`: cancelled, expired or settled request cannot undergo this transition.
- `CONFLICT`: idempotency identity reused with different input, or an immutable answer differs.
- `SESSION_UNAVAILABLE`: deleted, unknown or archived participant.
- `CAPACITY`: active request limit reached. Wait for completion/expiry before creating more.
- `STORAGE`: an unexpected storage/host operation could not be confirmed. Internal paths and raw exceptions are not returned to the model. Check the request before repeating a side effect.

Error codes are stable; human-readable messages may evolve. None of these errors silently changes session permissions or ends another agent's task.
