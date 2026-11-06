# OpenCode Agent Mailbox

Asynchronous questions, delegated questions and direct replies between native OpenCode 2 agents. A sender continues working immediately after durable acceptance. A recipient answers at its next model step without abandoning its task. Forwarding transfers responsibility while preserving the original sender.

Independent community plugin, not built by or affiliated with the OpenCode team.

## Requirements and installation

Targets **OpenCode 2.2.5** and `@opencode/plugin@2.2.5`. OpenCode 1 is not supported. Later 2.x versions require compatibility testing. Development and CI use Node 24.22.1 and npm 11+. The installed plugin runs inside the OpenCode server, using local SQLite via `@libsql/client`. Linux x64 is covered by the real-host E2E test; other OS/architectures are not certified by that test.

After the package has been published under your chosen name:

```sh
opencode plugin add opencode-agent-mailbox
```

The repository's default npm name is `opencode-agent-mailbox`; replace it in this command if the owner published a scoped or renamed package. This source distribution does not itself publish an npm package.

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
      "package": "opencode-agent-mailbox",
      "options": {
        "timeoutMs": 300000,
        "pollMs": 250,
        "maxPending": 1000,
        "toasts": true
      }
    }
  ]
}
```

- `timeoutMs`: question lifetime, 1000-86400000 ms; default five minutes.
- `pollMs`: outbox scan interval, 100-10000 ms. It does not poll models.
- `maxPending`: active requests/outboxes per project, 10-10000; default 1000. Overload fails explicitly with `CAPACITY`.
- `dataDirectory`: optional absolute, server-local directory. Default is `$XDG_DATA_HOME/opencode-agent-mailbox`, or `~/.local/share/opencode-agent-mailbox`. Each project gets a private subdirectory and SQLite database. Keep it on a local filesystem, not NFS or an untrusted shared volume.
- `toasts`: show native TUI notifications, default true. Transcript persistence and model delivery do not depend on this setting.

Configuration rejects unknown options. Existing OpenCode permission rules apply under the six tool names. Rules resolving to `ask` can require user approval before acceptance; an explicit deny always blocks the tool. The plugin never auto-approves anything. Only descendants in the same project can receive questions; sibling and ancestor requests are rejected.

## Tools

All tools are registered automatically as model-visible native tools, with JSON input schemas and complete descriptions. No manual agent prompt editing is needed.

- `ask_subagent({sessionID, message, timeoutMs?})`: accept a question and return `requestID` and `state: "pending"`. Continue working immediately.
- `reply_request({requestID, message})`: current recipient queues one immutable answer for the original sender; returns `state: "answered"`. Continue your task.
- `forward_question({requestID, targetSessionID})`: pass the same question to your descendant and transfer the right to answer. Returns the same ID and new recipient.
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

Native tool results record sending and forwarding in the invoking session. Incoming synthetic messages have compact descriptions such as:

```text
[ses_A -> ses_B] Are the integration tests passing? (question)
[ses_D -> ses_A] All integration tests pass. (received)
```

Optional toasts announce inbox admission. Toasts are deduplicated within the TUI process and coalesced to at most one per 1.5 seconds; the full durable history remains available even when a toast is suppressed. No sound, pop-up dialog, custom composer or competing layout is installed.

Messages use `delivery: "steer", resume: false`. An active agent sees them at its next safe step; an idle agent is **not woken** and sees pending messages when it next runs. Acceptance is not evidence that a model has read or answered the message. The plugin cannot guarantee a model will choose to reply. `request_status` distinguishes pending, admitted and failed delivery.

SQLite stores the request and outbox atomically. After a restart, pending entries retry automatically. Stable host inbox IDs prevent duplicate transcript insertions, including a crash after host acceptance but before local acknowledgement. The guarantee covers one effective answer admission, not exactly-once model reasoning or arbitrary tool side effects. Cancellation and expiry reject later replies; already admitted or concurrently admitting messages cannot be recalled through the public plugin API.

## Troubleshooting

- **No answer**: the recipient may be idle, blocked by permission approval, finished, or not yet at a safe step. Inspect `request_status` and `subagent_status`. Do not repeatedly ask the same question.
- **Nested agent creation fails**: adjust OpenCode's `experimental.subagent_depth`; the plugin preserves host limits.
- **FORBIDDEN**: select a strict descendant, or reply from the current recipient. Forwarding revokes the previous recipient's right to answer.
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
