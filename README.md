# OpenCode Agent Mailbox

Asynchronous questions, delegated questions and direct replies between native OpenCode 2 agents. A sender continues working immediately after durable acceptance. A recipient answers at its next model step without abandoning its task. Forwarding transfers responsibility while preserving the original sender.

Independent community plugin, not built by or affiliated with the OpenCode team.

## Requirements and installation

Targets **OpenCode 2.2.5** and `@opencode/plugin@2.2.5`. OpenCode 1 is not supported. Later 2.x versions require compatibility testing. Development and CI use Node 24.22.1 and npm 11+. The installed plugin runs inside the OpenCode server, using local SQLite via `@libsql/client`. Linux x64 is covered by the real-host E2E test; other OS/architectures are not certified by that test.

Install the published package:

```sh
opencode plugin add @opentoria/opencode-agent-mailbox
```

A local installation also works after `npm ci && npm run build`:

```json
{
  "plugins": ["/absolute/path/to/opencode-agent-mailbox"],
  "experimental": { "subagent_depth": 4 }
}
```

OpenCode defaults to a shallow subagent depth. Increase its own `experimental.subagent_depth` when you need A -> B -> C -> D. The plugin never modifies that limit, native `subagent`, permissions or agent selection. There is no plugin-imposed depth limit. Native background subagents are created normally with `subagent({..., background: true})`.

## Configuration

```json
{
  "plugins": [
    {
      "package": "@opentoria/opencode-agent-mailbox",
      "options": {
        "timeoutMs": 300000,
        "pollMs": 250,
        "maxPending": 1000,
        "maxMessageLength": 4000,
        "bidirectional": false,
        "wakeOnReply": true,
        "toasts": false
      }
    }
  ]
}
```

- `timeoutMs`: question lifetime, 1000-86400000 ms; default five minutes.
- `pollMs`: outbox scan interval, 100-10000 ms. It does not poll models.
- `maxPending`: active requests/outboxes per project, 10-10000; default 1000. Overload fails explicitly with `CAPACITY`.
- `maxMessageLength`: maximum question and reply length in Unicode code points, 1-16000; default 4000. The existing hard cap remains 16000 UTF-16 code units. Accepted text, including surrounding whitespace, is preserved exactly. Overlong messages return `INVALID_INPUT`; they are never truncated.
- `bidirectional`: allow any two distinct sessions in the same project and session tree to initiate questions; default false. When false, only strict descendants can be targeted.
- `wakeOnReply`: wake an idle original sender when an answer arrives; default true. An individual question can override this with its own `wakeOnReply` value.
- `dataDirectory`: optional absolute, server-local directory. Default is `$XDG_DATA_HOME/opencode-agent-mailbox`, or `~/.local/share/opencode-agent-mailbox`. Each project gets a private subdirectory and SQLite database. Keep it on a local filesystem, not NFS or an untrusted shared volume.
- `toasts`: show native TUI notifications, default false. Transcript persistence and model delivery do not depend on this setting.

Configuration rejects unknown options. Existing OpenCode permission rules apply under the six tool names. Rules resolving to `ask` can require user approval before acceptance; an explicit deny always blocks the tool. The plugin never auto-approves anything.

### Session commands

- `/mailbox-bidirectional` toggles two-way messaging for the current session tree. Use `on` or `off` to set a specific value.
- `/mailbox-wake-on-reply` toggles automatic wake-up after an answer. It also accepts `on` or `off`.

These persisted per-tree overrides do not edit configuration and take precedence over the global options. A child session's command applies to its entire tree (same root and project), including siblings and cousins. Only user-facing commands expose these settings; they are not agent tools. Separate roots and projects remain isolated. For a question, an explicit `wakeOnReply` setting overrides the tree and global defaults.

## Tools

All tools are registered automatically as model-visible native tools, with JSON input schemas and complete descriptions. No manual agent prompt editing is needed.

- `ask_subagent({sessionID, message, timeoutMs?, requiresReply?, wakeOnReply?})`: accept a question and return `requestID` and `state: "pending"`. By default the target must be a strict descendant; in user-enabled bidirectional mode, any other session in the same tree and project is allowed. `requiresReply` defaults to true. Set it false for a durable notification that cannot be replied to or forwarded; it reaches terminal state `notified` after delivery. `wakeOnReply` applies only when a reply is required and overrides the sender's tree/global wake policy for that question. Continue working immediately.
- `reply_request({requestID, message})`: current recipient queues one immutable answer for the original sender; returns `state: "answered"`. Continue your task.
- `forward_question({requestID, targetSessionID})`: pass the same question to a strict descendant by default, or any unvisited session in the same tree and project in user-enabled bidirectional mode. Transfers the right to answer and returns the same ID and new recipient.
- `subagent_status({})`: read the entire descendant tree, tools, last actions, errors and execution elapsed time. Never invokes a model.
- `request_status({requestID})`: inspect lifecycle and outbox admission/retry state. Only route participants may inspect it; intermediaries cannot retrieve the answer body.
- `cancel_request({requestID})`: sender-only cancellation of an unanswered request.

Successful tool results have `ok: true`. Expected failures have `ok: false` and `error: {code, message}`. Host permission rejections propagate natively. See [API contracts](docs/API.md) for full schemas, lifecycle and errors.

## A -> B -> C -> D

A, while B is busy:

```json
{ "sessionID": "ses_B", "message": "Are the integration tests passing?" }
```

A stores the returned requestID and continues its own work. B receives the question at a safe step and calls:

```json
{ "requestID": "<returned requestID>", "targetSessionID": "ses_C" }
```

C forwards the same request to D. D calls:

```json
{ "requestID": "<received requestID>", "message": "All integration tests pass." }
```

The answer is admitted directly to A's durable inbox. B and C do not relay it and receive no mailbox answer. Agents report only in response to an actual question; the plugin does not schedule unsolicited progress reports. Native OpenCode subagent-completion notices continue to behave normally.

## TUI and delivery

Native tool results record sending and forwarding in the invoking session. Incoming synthetic messages display the complete accepted message with terminal controls sanitized, for example:

```text
Mailbox · Question queued · ses_A -> ses_B: Are the integration tests passing?
Mailbox · Reply queued · ses_D -> ses_A: All integration tests pass.
```

The transcript description is not truncated; the model receives the original message, including whitespace, separately. Questions, notifications and replies persist independently of toast settings. Native TUI toasts are opt-in with `toasts: true` (default false); they are deduplicated within the TUI process and coalesced to at most one per 1.5 seconds. No sound or pop-up dialog is installed.

For questions requiring a reply, a session-scoped `⏳ Awaiting reply` status appears above the composer until the question is answered, cancelled, expired or failed. It refreshes durable request state at most once per second for the visible session's own location, never polls models, and does not keep the sending tool running. Missing cached sessions do not generate RPC calls; failed reads back off for 30 seconds. It means a reply is pending, not that the recipient is actively working. Informational messages (`requiresReply: false`) do not create this status.

Questions and informational notifications use `delivery: "steer", resume: false`, so an idle recipient is never woken by them. An answer uses the same durable inbox delivery and wakes an idle original sender by default; per-request `wakeOnReply`, then the current tree's `/mailbox-wake-on-reply on|off`, then the global `wakeOnReply` option determine that behavior in order. When wake-up is disabled, the answer still remains in the sender's inbox until the next run. Active sessions are not duplicated or interrupted. Acceptance is not evidence that a model has read or answered the message. The plugin cannot guarantee a model will choose to reply. `request_status` distinguishes pending, admitted, failed and notification-complete (`notified`) states.

SQLite stores the request and outbox atomically. After a restart, pending entries retry automatically. Stable host inbox IDs prevent duplicate transcript insertions, including a crash after host acceptance but before local acknowledgement. The guarantee covers one effective answer admission, not exactly-once model reasoning or arbitrary tool side effects. Cancellation and expiry reject later replies; already admitted or concurrently admitting messages cannot be recalled through the public plugin API.

### Session deletion

Deleting a session also asynchronously removes mailbox requests and outboxes involving it, including settled notifications and questions forwarded through that session. Unrelated conversations remain. Session-tree setting overrides for the deleted root are removed as well; archiving is not deletion.

On startup the plugin reconciles missed deletion events before dispatching an outbox. Content-free deleted-session ID guards prevent stale writers or retries from recreating the erased messages. This removes the plugin's records, not copies already admitted to other surviving OpenCode transcripts; those belong to the host's history. In-flight admission can race deletion and cannot be recalled. SQLite WAL files, backups and external logs are not a secure-erasure guarantee.

## Troubleshooting

- **No answer**: the recipient may be idle, blocked by permission approval, finished, or not yet at a safe step. Inspect `request_status` and `subagent_status`. Informational notifications do not expect answers. Do not repeatedly ask the same question.
- **Nested agent creation fails**: adjust OpenCode's `experimental.subagent_depth`; the plugin preserves host limits.
- **FORBIDDEN**: by default, select a strict descendant. To message an ancestor, sibling or cousin, the user must enable bidirectional mode for that tree with `/mailbox-bidirectional on`. Reply from the current recipient; forwarding revokes the previous recipient's right to answer.
- **CONFLICT**: a different answer or different input was submitted under an existing identity. Answers are immutable.
- **STORAGE**: check filesystem permissions/free space. Retry only after inspection; admission may have succeeded even if its acknowledgement was lost.
- **Tool collision at startup**: another plugin owns one of these tool names. Resolve the collision; this plugin refuses to silently override it.
- **No toast**: toasts may be disabled or coalesced. Durable delivery is independent of the TUI. Idle messages remain in OpenCode's pending inbox until the next run.
- **Stale status after a crash**: runtime activity is reconstructed from persisted host timestamps and may lag recovery. It is explicitly a snapshot, not proof that a process is currently running.
- **Moved session**: same-project worktrees use the same mailbox database. Moving across projects is rejected rather than delivering into another trust boundary.

## Development and testing

```sh
npm ci
npm run check
npm run test:e2e
```

`check` runs strict typechecking (including TypeScript tests), ESLint, unit/integration tests, build and npm package-content checks. The E2E test installs the actual npm tarball into an isolated directory, starts OpenCode 2.2.5 with isolated XDG state, runs native background agents against a deterministic local model and validates real transcripts. It needs no paid model or external API key. Dependency installation still requires npm access. It writes temporary diagnostics to ignored `.e2e/`.

See [architecture](docs/ARCHITECTURE.md), [agent guide](docs/AGENTS.md), [test coverage](docs/TESTING.md) and [compatibility research](docs/COMPATIBILITY.md).
