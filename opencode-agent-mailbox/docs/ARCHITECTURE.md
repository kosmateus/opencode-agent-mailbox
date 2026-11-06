# Architecture and guarantees

## Boundaries

- `domain/model.ts`: versioned request schema, immutable origin, current holder, lifecycle and routing invariants. No host or database API.
- `application/mailbox.ts`: use cases; injected repository, session directory and clock. Strict descendant authorization uses iterative ancestry walking with cycle detection.
- `application/dispatcher.ts`: durable outbox reconciliation, retry/backoff and expiry. No model execution.
- `application/status.ts`: read-only, iterative and paginated descendant inspection.
- `ports/index.ts`: atomic repository and host session admission contracts.
- `adapters/sqlite.ts`: local SQLite, WAL, atomic request+outbox updates, per-connection serialization and contention retries between connections. Zero SQLite busy timeout prevents a synchronous busy wait from blocking the event loop while another local connection needs it to commit.
- `adapters/opencode.ts`: official SDK synthetic admission with fixed IDs, steer and no wake.
- `adapters/tools.ts`: host permission assertions, validation, agent-facing tool contracts and error mapping.
- `index.ts`: composition root, lifecycle and agent instructions; `tui.ts`: independent native notifications.

## Delivery protocol

1. Validate the trusted caller and target hierarchy.
2. Commit request transition and its outbox entries in one SQLite write transaction.
3. Return the acceptance receipt to the tool caller.
4. Dispatcher submits a synthetic item using a stable ID. OpenCode atomically admits/delivers that ID once.
5. Commit `admitted` locally. If acknowledgement is lost, retry the same host ID, never invent another.

Concurrent dispatchers can submit the same outbox item, but OpenCode's durable inbox is the deduplication boundary. The plugin does not claim a distributed exactly-once network protocol. SQLite protects the immutable answer, and the host protects effective message admission. There is no global model lock, interruption, session switching, or waiting for a subagent's completion.

The request key uses SHA-256 of a JSON tuple containing caller identity and trusted tool invocation identity. Direct application callers default to a cryptographically random UUID as invocation identity. Delivery IDs are SHA-256 derived from request, kind and hop. User input never becomes a filesystem path or SQL fragment; every SQL argument is parameterized.

Same-project plugin instances share one project database, including worktrees. Project IDs are hashed into private directories. The database is owner-readable/writable; parent directories are created with mode 0700. OS user compromise is outside the threat model. Use a private data directory and local storage. Multi-host coordination over a shared filesystem is not supported.

## Lifecycle and retention

Requests transition pending -> answered/cancelled/expired/failed. Answer admission has its own state because saving an answer and delivering it are separate operations. Forwarding changes the holder without ending pending state. Sender-only cancellation and holder-only reply are rechecked inside the write transaction.

Records are intentionally not automatically deleted: retained IDs act as idempotency tombstones and permit inspection after restart. Their text contains project communication. Back up or remove the project mailbox directory only with all relevant OpenCode servers stopped; removing it also removes correlation/deduplication history. OpenCode's own transcript retention is independent. Large deployments should monitor database size and define a retention policy before deleting old records.

## Known boundaries

- Safe-step injection requires another execution step. Idle agents are never automatically woken by this plugin.
- The model decides whether/when to answer. The plugin guarantees routing and correlation, not model compliance.
- The native host controls background completion notices; those are not unsolicited plugin reports.
- An admitted or concurrently admitting message cannot be recalled through the SDK available to plugins. Cancellation rejects future domain operations; it does not erase history.
- Hierarchy validation and host admission cannot be in the same database transaction as the plugin. Host deletion/movement between them is handled as failed admission. The adapter rechecks project membership immediately before admission.
- Status is reconstructed from host session/transcript state and may be stale during recovery. Fetching a very large tree costs host reads, not model tokens.
- TUI notifications are best-effort and coalesced, while durable transcript insertion is host-idempotent. Pixel layout remains the native OpenCode layout.
