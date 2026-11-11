import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@opencode/plugin/tui/plugin';
import tui from '../src/tui.js';
import { registerSettingsCommands } from '../src/tui-settings.js';
vi.mock('@opentui/core', () => ({ TextRenderable: class {} }));

function harness(known = true) {
  const location = { directory: '/project-b' };
  const pendingQuestions = vi.fn(async () => ({ count: 0 }));
  const setWakeOnReply = vi.fn(async () => ({ rootSessionID: 'ses_b', enabled: true }));
  let layer: Parameters<Context['keymap']['layer']>[0] | undefined;
  const ctx = {
    options: {},
    location: { directory: '/project-a' },
    keymap: {
      layer: (factory: NonNullable<typeof layer>) => {
        layer = factory;
      },
    },
    storage: {
      memory: (_key: string, { initial }: { initial: unknown }) => [
        initial,
        (update: (value: unknown) => void) => update(initial),
      ],
    },
    data: { session: { get: () => (known ? { id: 'ses_b', location } : undefined) } },
    client: { rpc: () => ({ pendingQuestions, setWakeOnReply }) },
    ui: {
      router: { current: () => ({ type: 'session', sessionID: 'ses_b' }) },
      slot: () => vi.fn(),
      toast: { show: vi.fn() },
    },
  } as unknown as Context;
  return { ctx, location, pendingQuestions, setWakeOnReply, commands: () => layer?.().commands ?? [] };
}

describe('TUI session location isolation', () => {
  it('routes pending-question RPC by the visible session, not the plugin loading location', async () => {
    const h = harness();
    const cleanup = await tui.setup(h.ctx);
    try {
      expect(h.pendingQuestions).toHaveBeenCalledWith({ sessionID: 'ses_b' }, { location: h.location });
    } finally {
      await cleanup?.();
    }
  });
  it('makes no RPC call while the visible session is absent from the cache', async () => {
    const h = harness(false);
    const cleanup = await tui.setup(h.ctx);
    try {
      expect(h.pendingQuestions).not.toHaveBeenCalled();
    } finally {
      await cleanup?.();
    }
  });
  it('routes session setting commands to the same session location', async () => {
    const h = harness();
    registerSettingsCommands(h.ctx);
    await h
      .commands()
      .find((command) => command.slash?.name === 'mailbox-wake-on-reply')
      ?.run('on');
    expect(h.setWakeOnReply).toHaveBeenCalledWith(
      { sessionID: 'ses_b', enabled: true },
      { location: h.location },
    );
  });
});
