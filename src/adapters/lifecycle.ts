import type { Plugin } from '@opencode/plugin';
import type { SessionCleanup } from '../application/cleanup.js';

/** Events are global; purging by the exact ID in this project's database preserves isolation. */
export function watchSessionDeletion(
  ctx: Pick<Plugin.Context, 'event'>,
  cleanup: SessionCleanup,
): () => Promise<void> {
  const controller = new AbortController();
  const running = (async () => {
    for await (const event of ctx.event.subscribe({ types: ['session.deleted'], signal: controller.signal }))
      await cleanup.remove(event.data.sessionID);
  })().catch(() => {
    if (!controller.signal.aborted)
      console.error(
        '[agent-mailbox] Session deletion cleanup failed; inspect storage and reload to reconcile.',
      );
  });
  return async () => {
    controller.abort();
    await running;
  };
}
