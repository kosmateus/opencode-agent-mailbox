import type { Plugin } from '@opencode/plugin';
import { MailboxError } from '../domain/model.js';
/** Iterative traversal: no arbitrary nesting limit, paginated host reads, no model work. */
export async function subtreeStatus(ctx: Pick<Plugin.Context, 'session'>, actor: string) {
  const root = await ctx.session.get({ sessionID: actor });
  const queue = [{ id: actor, depth: 0 }];
  const seen = new Set<string>();
  const rows = [];
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index];
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    const info = await ctx.session.get({ sessionID: item.id });
    if (info.projectID !== root.projectID) throw new MailboxError('FORBIDDEN', 'Cross-project subtree.');
    if (item.depth > 0) {
      const history = await ctx.session.context({ sessionID: item.id });
      const last = history.at(-1);
      const assistant = history.findLast((m) => m.type === 'assistant');
      const toolError =
        assistant?.type === 'assistant'
          ? assistant.content.findLast((p) => p.type === 'tool' && p.state.status === 'error')
          : undefined;
      const activeTools =
        assistant?.type === 'assistant'
          ? assistant.content
              .filter((p) => p.type === 'tool' && ['running', 'streaming'].includes(p.state.status))
              .map((p) => (p.type === 'tool' ? p.name : ''))
          : [];
      rows.push({
        sessionID: info.id,
        parentID: info.parentID,
        depth: item.depth,
        title: info.title,
        outcome: info.outcome,
        archived: info.time.archived !== undefined,
        activity:
          info.time.busy !== undefined && (info.time.idle === undefined || info.time.busy > info.time.idle)
            ? 'running'
            : 'idle',
        activeTools,
        lastAction: last?.type,
        lastActionAt: last?.time.created,
        lastError:
          (assistant?.type === 'assistant' ? assistant.error : undefined) ??
          (toolError?.type === 'tool' && toolError.state.status === 'error'
            ? toolError.state.error
            : undefined),
        elapsedMs:
          info.time.busy === undefined
            ? 0
            : Math.max(
                0,
                (info.time.idle !== undefined && info.time.idle >= info.time.busy
                  ? info.time.idle
                  : Date.now()) - info.time.busy,
              ),
      });
    }
    let cursor: string | undefined;
    do {
      const page = await ctx.session.list(
        cursor ? { cursor, limit: 100 } : { parentID: item.id, limit: 100 },
      );
      for (const child of page.data) queue.push({ id: child.id, depth: item.depth + 1 });
      cursor = page.cursor.next ?? undefined;
    } while (cursor);
  }
  return {
    rootSessionID: actor,
    observedAt: Date.now(),
    agents: rows,
    note: 'Snapshot from persisted host state; running state can be stale during recovery. No model was invoked.',
  };
}
