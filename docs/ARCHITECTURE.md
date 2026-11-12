# Architecture and guarantees

## Boundaries

- `domain/model.ts`: versioned request schema, immutable origin, current holder, lifecycle and routing invariants. No host or database API.
- `application/mailbox.ts`: use cases; injected repository, session directory, clock and per-tree mode store. Default authorization is strict descendant-only; opted-in routing checks both sessions' root and project with iterative cycle detection.
- `application/dispatcher.ts`: durable outbox reconciliation, retry/backoff and expiry. No model execution.
- `application/cleanup.ts`: purge requests involving a deleted participant and reconcile missed deletions before dispatch starts.
- `application/status.ts`: read-only, iterative and paginated descendant inspection.
- `ports/index.ts`: atomic repository and host session admission contracts.
- `adapters/sqlite.ts`: local SQLite, WAL, atomic request+outbox updates, per-database write serialization within a process and contention retries between processes. Zero SQLite busy timeout prevents a synchronous busy wait from blocking the event loop while another connection needs it to commit.
- `adapters/opencode.ts`: official SDK synthetic admission with fixed IDs, complete message descriptions, steer and answer-only wake policy.
- `adapters/session-mode.ts`: durable user-set bidirectional and wake overrides, keyed by project and session-tree root.
- `adapters/lifecycle.ts`: public `session.deleted` subscription with cancellation on plugin unload. Events are global, but purges operate only on matching IDs in the current project database.
- `adapters/tools.ts`: host permission assertions, validation, agent-facing tool contracts and error mapping.
- `index.ts`: composition root, lifecycle and agent instructions; `rpc.ts` exposes user controls and a body-free pending-question count; `tui.ts` registers session commands, an awaiting-reply status (`tui-pending.ts`) and optional native notifications.

## Delivery protocol

1. Validate the trusted caller and target hierarchy.
2. Commit request transition and its outbox entries in one SQLite write transaction.
3. Return the acceptance receipt to the tool caller.
4. Dispatcher submits a synthetic item using a stable ID. OpenCode atomically admits/delivers that ID once.
5. Commit `admitted` locally. If acknowledgement is lost, retry the same host ID, never invent another.

Concurrent dispatchers can submit the same outbox item, but OpenCode's durable inbox is the deduplication boundary. The plugin does not claim a distributed exactly-once network protocol. SQLite protects the immutable answer, and the host protects effective message admission. There is no global model lock, interruption, session switching, or waiting for a subagent's completion.

The request key uses SHA-256 of a JSON tuple containing caller identity and trusted tool invocation identity. Direct application callers default to a cryptographically random UUID as invocation identity. Delivery IDs are SHA-256 derived from request, kind and hop. User input never becomes a filesystem path or SQL fragment; every SQL argument is parameterized.

Same-project plugin instances share one project database, including worktrees. Project IDs are hashed into private directories. The database is owner-readable/writable; parent directories are created with mode 0700. OS user compromise is outside the threat model. Use a private data directory and local storage. Multi-host coordination over a shared filesystem is not supported.

Bidirectional mode defaults off. The global plugin option provides the default; the user-only `/mailbox-bidirectional on|off` command stores an explicit override for the selected session's root tree. Reply wake-up defaults on and has its own `/mailbox-wake-on-reply on|off` override. Both are scoped by project and root in OpenCode plugin storage, so one tree cannot change another and commands never edit plugin configuration. A per-request wake override takes precedence over the tree override and global setting. No model-facing mailbox tool changes tree settings. `maxMessageLength` counts Unicode code points (default 4000) and rejects rather than truncates; the existing 16000 UTF-16 code-unit schema cap remains a hard limit.

Requests default to `requiresReply: true`, including legacy records read without that field. A no-reply informational message uses a `notification` delivery; after successful admission it is terminally `notified`, so it does not remain active waiting for an answer. Questions and notifications to a direct child or authorized peer subagent (such as a sibling or cousin) use `resume:true`; non-direct descendants and upward parent/ancestor routes do not force wake. Answers use request or effective tree/global wake policy for the original sender. If answer wake-up is disabled, the answer is still durably queued.

## Lifecycle and retention

Requests transition pending -> answered/notified/cancelled/expired/failed. Answer admission has its own state because saving an answer and delivering it are separate operations. Forwarding changes the holder without ending pending state. Sender-only cancellation and holder-only reply are rechecked inside the write transaction.

Records remain inspectable while their participant sessions exist. A public `session.deleted` event atomically deletes requests/outboxes referencing that session as origin, holder, route hop or delivery endpoint. Startup reconciliation also checks settled records, so deletion while the plugin was inactive is recovered before dispatch. Archived sessions remain intact. Deleted root settings are removed without editing global plugin configuration.

The same SQLite transaction records a content-free deleted-session ID guard, and every subsequent write checks participant IDs against these guards. This closes the deletion/write race across plugin instances. Unknown foreign-session events do not create guards in this project's database. Dispatcher acknowledgements become no-ops if their request was concurrently purged. The guard contains no question or answer and survives restarts.

OpenCode removes the deleted session's own history. Copies already admitted to other surviving sessions cannot be recalled through the plugin SDK; in-flight host admission may race deletion. Logical SQLite deletion is not forensic erasure of WAL files, backups or external logs. Back up or remove the project mailbox directory only with all relevant OpenCode servers stopped; removing it also removes correlation/deduplication guards.

## Known boundaries

- Questions and notifications wake a direct child or authorized peer subagent; non-direct descendants and upward parent/ancestor routes remain queued without an automatic wake. Answers may wake an idle original sender according to request, tree, then global policy; disabling answer wake preserves the durable inbox entry for the next run.
- The model decides whether/when to answer. The plugin guarantees routing and correlation, not model compliance.
- The native host controls background completion notices; those are not unsolicited plugin reports.
- An admitted or concurrently admitting message cannot be recalled through the SDK available to plugins. Cancellation rejects future domain operations; it does not erase history.
- Hierarchy validation and host admission cannot be in the same database transaction as the plugin. Host deletion/movement between them is handled as failed admission. The adapter rechecks project membership immediately before admission.
- Status is reconstructed from host session/transcript state and may be stale during recovery. Fetching a very large tree costs host reads, not model tokens.
- Optional TUI toasts are disabled by default and best-effort/coalesced, while compact sanitized transcript summaries and durable inbox insertion are host-idempotent. Pixel layout remains the native OpenCode layout.
