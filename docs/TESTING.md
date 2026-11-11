# Test strategy

Run `npm ci`, then `npm run check` and `npm run test:e2e`.

Unit/integration tests cover request lifecycle, default descendant-only and opt-in tree-wide authorization (ancestors, siblings, cousins, separate roots and projects), per-tree user overrides, request/tree/global reply wake precedence, body-free pending-question counts, 4000/4001 Unicode-code-point limits, no-reply notifications, cycles, 500-level ancestry, 20 concurrent recipients, identical/conflicting replies, cancellation, expiry, SQLite rollback, two database connections, crash-after-admission retry, persisted restart, permanent and transient failures, official synthetic input types, host permission propagation, user-only slash commands, native TUI deduplication/coalescing/cleanup and Conventional Commits version selection.

The real-host E2E test packages and separately installs the npm tarball, starts the actual `@opencode/cli@2.2.5` server with isolated XDG directories, and uses an HTTP OpenAI-compatible deterministic model. It checks default denial for siblings, user RPC tree toggles and isolation between roots, full 4000-character payload and rejection without outbox/inbox for 4001, and a notification reaching terminal `notified`. It verifies a question does not wake its idle recipient, a per-request wake override resumes an idle origin exactly once and the resumed model reads the answer's ending, then runs native tools that spawn B/C/D and ten background workers. Assertions inspect real host transcripts for one direct D -> A answer, successful native tool calls, background creation and D's subsequent work. It then restarts the real server, recovers a saved plugin outbox, verifies actual host inbox deduplication and checks that a question did not wake an idle recipient.

This is an integration E2E of the real host's model/tool/session loop. It does not measure a commercial model's willingness to follow instructions. No API key is needed. It also verifies that cross-project RPC remains forbidden with a declared error, while the same session works at its own location. TUI regressions cover visible-session location routing, missing cached sessions and backoff after read failures. TUI event handling is tested against official event types and a UI contract double; no claim is made that the automated suite performs pixel/screenshot verification of every terminal theme.

Ignored `.e2e/` directories retain local diagnostics. The test never touches the user's normal OpenCode configuration or credentials. CI executes both suites before any publication.

Deletion tests cover senders, recipients, intermediate hops, settled notifications, unrelated conversations, cross-connection stale writes, restart-persistent content-free guards, in-flight admission acknowledgements and subscription cleanup. Startup reconciliation preserves archived sessions and does not purge on transient lookup errors. The real host test removes both a recipient subtree and a sender, checks that their mailbox records vanish, and verifies unrelated records remain.

Local release checks:

```sh
npm run release:plan -- v1.0.0
npm run release:dry
```

`release:plan` performs offline Conventional Commits analysis of a Git range, without credentials, writes or publishing. Omit the tag to analyze current history. `release:dry` is semantic-release's full dry-run; it needs a real repository/remote and authentication for its read-only verification, and never publishes. Keep dry-run credentials out of committed files.
