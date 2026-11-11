import type { Context } from '@opencode/plugin/tui/plugin';
import { TextRenderable } from '@opentui/core';

export type PendingQuestionsSummary = { count: number; nextExpiresAt?: number | undefined };
export interface PendingQuestionsReadModel {
  pendingQuestions(input: { sessionID: string }): Promise<PendingQuestionsSummary>;
}

/** Polls durable request state, never models or execution status. */
export function setupPendingIndicator(
  ctx: Pick<Context, 'storage' | 'ui' | 'renderer' | 'theme'>,
  readModel: PendingQuestionsReadModel,
): () => void {
  const [state, setState] = ctx.storage.memory<{ sessions: Record<string, PendingQuestionsSummary> }>(
    'pending-questions',
    { initial: { sessions: {} } },
  );
  setState((draft) => {
    draft.sessions = {};
  });
  const inFlight = new Set<string>();
  const nextCheck = new Map<string, number>();
  let active = true;

  const refresh = async (sessionID: string) => {
    if (inFlight.has(sessionID) || Date.now() < (nextCheck.get(sessionID) ?? 0)) return;
    inFlight.add(sessionID);
    nextCheck.set(sessionID, Date.now() + 1000);
    try {
      const summary = await readModel.pendingQuestions({ sessionID });
      if (active)
        setState((draft) => {
          if (summary.count) draft.sessions[sessionID] = summary;
          else delete draft.sessions[sessionID];
        });
    } catch {
      nextCheck.set(sessionID, Date.now() + 30000);
      if (active)
        setState((draft) => {
          delete draft.sessions[sessionID];
        });
    } finally {
      inFlight.delete(sessionID);
    }
  };
  const refreshCurrent = () => {
    const route = ctx.ui.router.current();
    if (route.type === 'session') void refresh(route.sessionID);
  };
  const unregister = ctx.ui.slot({
    append: 'session.composer.top',
    render: ({ sessionID }) => {
      void refresh(sessionID);
      const count = state.sessions[sessionID]?.count ?? 0;
      if (!count) return null;
      return new TextRenderable(ctx.renderer, {
        content: count === 1 ? '⏳ Awaiting reply' : `⏳ Awaiting replies (${count})`,
        fg: ctx.theme.text.base,
      });
    },
  });
  const timer = setInterval(refreshCurrent, 1000);
  timer.unref();
  refreshCurrent();
  return () => {
    active = false;
    clearInterval(timer);
    unregister();
  };
}
