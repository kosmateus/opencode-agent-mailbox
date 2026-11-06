# Test strategy

Run `npm ci`, then `npm run check` and `npm run test:e2e`.

Unit/integration tests cover request lifecycle, authorization, cycles, 500-level ancestry, 20 concurrent recipients, identical/conflicting replies, cancellation, expiry, SQLite rollback, two database connections, crash-after-admission retry, persisted restart, permanent and transient failures, official synthetic input types, host permission propagation, native TUI deduplication/coalescing/cleanup and Conventional Commits version selection.

The real-host E2E test packages and separately installs the npm tarball, starts the actual `@opencode/cli@2.2.5` server with isolated XDG directories, and uses an HTTP OpenAI-compatible deterministic model. Native tools spawn B/C/D and ten background workers. The model invokes the registered mailbox tools while work continues. Assertions inspect the real host transcripts for one direct D -> A answer, successful native tool calls, background creation and D's subsequent work. It then restarts the real server, recovers a saved plugin outbox, verifies actual host inbox deduplication and checks that an idle recipient was not woken.

This is an integration E2E of the real host's model/tool/session loop. It does not measure a commercial model's willingness to follow instructions. No API key is needed. TUI event handling is tested against official event types and a UI contract double; no claim is made that the automated suite performs pixel/screenshot verification of every terminal theme.

Ignored `.e2e/` directories retain local diagnostics. The test never touches the user's normal OpenCode configuration or credentials. CI executes both suites before any publication.

Local release checks:

```sh
npm run release:plan -- v1.0.0
npm run release:dry
```

`release:plan` performs offline Conventional Commits analysis of a Git range, without credentials, writes or publishing. Omit the tag to analyze current history. `release:dry` is semantic-release's full dry-run; it needs a real repository/remote and authentication for its read-only verification, and never publishes. Keep dry-run credentials out of committed files.
