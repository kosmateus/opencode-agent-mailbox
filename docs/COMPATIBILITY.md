# Verified OpenCode integration

Research baseline: 2026-11-06; installed CLI and official npm SDK: **2.2.5**.

The legacy `opencode-ai` and `@opencode-ai/plugin` npm packages resolve to 1.x and are not used. OpenCode 2 uses `@opencode/cli`, `@opencode/plugin`, `Plugin.define`, `tool.transform`, and a `./tui` package export. `opencode plugin add` is verified in the installed CLI help.

Primary sources:

- https://opencode.ai/v2/docs/build/plugins/
- https://opencode.ai/v2/docs/build/plugins/server
- https://opencode.ai/v2/docs/build/plugins/tui
- https://opencode.ai/v2/docs/build/plugins/cli
- https://opencode.ai/v2/docs/build/plugins/rpc
- https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md
- https://github.com/anomalyco/opencode/tree/dev/packages/plugin
- https://github.com/anomalyco/opencode/tree/dev/packages/protocol
- https://www.npmjs.com/package/@opencode/plugin/v/2.2.5
- https://www.npmjs.com/package/@opencode/cli/v/2.2.5

Source checkout examined: `0fdff425ff2ba3e7874321b43709d1e62f539337`. Released npm types, not speculative adapters or a legacy SDK, are the compilation authority.

`session.synthetic` accepts a caller-supplied `id`, `delivery`, `resume`, text, description and metadata. Reusing an ID within the same session/type adopts the original admission. Steer delivery occurs at safe step boundaries, and `resume:false` does not schedule a new execution. The plugin uses `resume:true` for questions and notifications to a direct child or authorized peer subagent, such as a sibling or cousin; non-direct descendants and upward messages do not force a wake. Answers use the request's wake policy or the user's session-tree/global default, so an idle original sender can resume without interrupting an active run.

The plugin session context exposes list/get/context/synthetic and hooks, but does not expose the complete HTTP inbox-management or active-execution APIs. This implementation does not fabricate such methods or bypass the SDK with private HTTP access. Status uses actual paginated list and context reads. Cancellation is a plugin state transition, not host transcript deletion.

Native `subagent(background:true)` remains unchanged. Real-host E2E explicitly sets `experimental.subagent_depth:4` in its isolated test configuration because the host default rejects nested spawning after depth one.

TUI uses the official `session.inbox.enqueued` event (`event.data.item`) and `ctx.ui.toast.show`. Message descriptions render in the native synthetic transcript. User-only session-tree slash commands and the body-free pending-question count use the documented plugin RPC mechanism; models receive no setting-change or pending-count tool.

The awaiting-reply status uses the public `session.composer.top` slot and an OpenTUI `TextRenderable`, not the host's private subagent loader. A real terminal smoke test on 2.2.5 verified it renders without a bare-text slot error. `@opentui/core` is an optional runtime peer supplied by OpenCode and a pinned development dependency for typechecking; the server part does not import it.
