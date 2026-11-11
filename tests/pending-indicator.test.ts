import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@opencode/plugin/tui/plugin';
import { setupPendingIndicator, type PendingQuestionsSummary } from '../src/tui-pending.js';

vi.mock('@opentui/core', () => ({
  TextRenderable: class {
    constructor(
      _renderer: unknown,
      readonly contentOptions: { content: string },
    ) {}
  },
}));

function harness() {
  vi.useFakeTimers();
  const summaries: Record<string, PendingQuestionsSummary> = {};
  const state = { sessions: { ses_origin: { count: 99 } } as Record<string, PendingQuestionsSummary> };
  let route: { type: 'home' } | { type: 'session'; sessionID: string } = { type: 'home' };
  let render: (input: { sessionID: string }) => unknown = () => null;
  const unregister = vi.fn();
  const pendingQuestions = vi.fn(
    async ({ sessionID }: { sessionID: string }) => summaries[sessionID] ?? { count: 0 },
  );
  const ctx = {
    renderer: {},
    theme: { text: { base: 'white' } },
    storage: { memory: () => [state, (fn: (draft: typeof state) => void) => fn(state)] },
    ui: {
      router: { current: () => route },
      slot: (claim: { render: typeof render }) => {
        render = claim.render;
        return unregister;
      },
    },
  } as unknown as Context;
  const cleanup = setupPendingIndicator(ctx, { pendingQuestions });
  return {
    summaries,
    pendingQuestions,
    cleanup,
    unregister,
    state,
    render: (sessionID: string) => {
      const output = render({ sessionID });
      return (output as { contentOptions: { content: string } } | null)?.contentOptions.content ?? output;
    },
    select: (sessionID: string) => {
      route = { type: 'session', sessionID };
    },
  };
}
afterEach(() => vi.useRealTimers());

describe('pending reply indicator', () => {
  it('shows pending questions for the selected origin and clears after settlement', async () => {
    const h = harness();
    h.summaries.ses_origin = { count: 1 };
    h.select('ses_origin');
    expect(h.render('ses_origin')).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.render('ses_origin')).toBe('⏳ Awaiting reply');
    expect(h.render('ses_other')).toBeNull();
    h.summaries.ses_origin = { count: 2 };
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.render('ses_origin')).toBe('⏳ Awaiting replies (2)');
    h.summaries.ses_origin = { count: 0 };
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.render('ses_origin')).toBeNull();
    h.cleanup();
    expect(h.unregister).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('discards reload state and never polls from the home screen', async () => {
    const h = harness();
    expect(h.state.sessions).toEqual({});
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.pendingQuestions).not.toHaveBeenCalled();
    h.cleanup();
  });
  it('deduplicates reads and never invokes a model', async () => {
    const h = harness();
    h.select('ses_origin');
    h.render('ses_origin');
    h.render('ses_origin');
    await vi.advanceTimersByTimeAsync(0);
    h.render('ses_origin');
    expect(h.pendingQuestions).toHaveBeenCalledOnce();
    expect(h.pendingQuestions).toHaveBeenCalledWith({ sessionID: 'ses_origin' });
    h.cleanup();
  });
  it('hides stale status when the read model becomes unavailable', async () => {
    const h = harness();
    h.select('ses_origin');
    h.summaries.ses_origin = { count: 1 };
    h.render('ses_origin');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.render('ses_origin')).toBe('⏳ Awaiting reply');
    h.pendingQuestions.mockRejectedValueOnce(new Error('disconnected'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.render('ses_origin')).toBeNull();
    h.cleanup();
  });
});
