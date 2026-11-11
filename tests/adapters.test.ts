import { describe, it, expect, vi } from 'vitest';
import type { Info } from '@opencode/plugin/promise/tool';
import type { Plugin } from '@opencode/plugin';
import type { OpenCodeEvent } from '@opencode/client';
import { OpenCodeSessions, summary } from '../src/adapters/opencode.js';
import { Mailbox } from '../src/application/mailbox.js';
import type { Request } from '../src/domain/model.js';
import tui from '../src/tui.js';
import type { Context } from '@opencode/plugin/tui/plugin';
import { registerTools } from '../src/adapters/tools.js';
import { registerSettingsCommands } from '../src/tui-settings.js';
import { SessionModeStore } from '../src/adapters/session-mode.js';
import { Options } from '../src/config.js';
vi.mock('@opentui/core', () => ({ TextRenderable: class {} }));

describe('official OpenCode adapter contracts', () => {
  it('defaults to descendant-only mode, 4000 code points and no toasts; validates configured limits', () => {
    expect(Options.parse({})).toMatchObject({
      bidirectional: false,
      maxMessageLength: 4000,
      wakeOnReply: true,
      toasts: false,
    });
    expect(Options.parse({ wakeOnReply: false }).wakeOnReply).toBe(false);
    expect(Options.parse({ bidirectional: true }).bidirectional).toBe(true);
    expect(() => Options.parse({ maxMessageLength: 0 })).toThrow();
    expect(() => Options.parse({ maxMessageLength: 16001 })).toThrow();
    expect(() => Options.parse({ maxMessageLength: 1.5 })).toThrow();
  });

  it('admits synthetic answers with a stable ID and default wake-up', async () => {
    const synthetic = vi.fn<Plugin.Context['session']['synthetic']>();
    const adapter = new OpenCodeSessions(
      { session: { synthetic } as unknown as Plugin.Context['session'] },
      'p',
    );
    const r = { id: 'req_test', origin: 'ses_A', expiresAt: 10 } as Request;
    await adapter.admit(r, {
      id: 'msg_fixed',
      kind: 'answer',
      from: 'ses_D',
      to: 'ses_A',
      text: 'done',
      state: 'pending',
      attempts: 0,
      nextAt: 0,
    });
    expect(synthetic).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'msg_fixed', sessionID: 'ses_A', delivery: 'steer', resume: true }),
    );
    expect(synthetic.mock.calls[0]?.[0].description).toContain('ses_D -> ses_A');
  });
  it('uses a per-request wake override and never wakes for questions or notifications', async () => {
    const synthetic = vi.fn<Plugin.Context['session']['synthetic']>();
    const wakeOnReply = vi.fn().mockResolvedValue(false);
    const adapter = new OpenCodeSessions(
      { session: { synthetic } as unknown as Plugin.Context['session'] },
      'p',
      wakeOnReply,
    );
    const request = {
      id: 'req_test',
      origin: 'ses_A',
      expiresAt: 10,
      requiresReply: true,
      route: ['ses_A', 'ses_B'],
    } as Request;
    const delivery = (kind: 'question' | 'answer' | 'notification') => ({
      id: `msg_${kind}`,
      kind,
      from: kind === 'answer' ? 'ses_B' : 'ses_A',
      to: kind === 'answer' ? 'ses_A' : 'ses_B',
      text: 'content',
      state: 'pending' as const,
      attempts: 0,
      nextAt: 0,
    });

    await adapter.admit(request, delivery('question'));
    expect(synthetic.mock.calls[0]?.[0].resume).toBe(false);
    expect(wakeOnReply).not.toHaveBeenCalled();
    await adapter.admit({ ...request, wakeOnReply: true }, delivery('answer'));
    expect(synthetic.mock.calls[1]?.[0].resume).toBe(true);
    expect(wakeOnReply).not.toHaveBeenCalled();
    await adapter.admit({ ...request, requiresReply: false }, delivery('notification'));
    expect(synthetic.mock.calls[2]?.[0].resume).toBe(false);
    expect(wakeOnReply).not.toHaveBeenCalled();
    await adapter.admit(request, { ...delivery('answer'), id: 'msg_answer_policy' });
    expect(synthetic.mock.calls[3]?.[0].resume).toBe(false);
    expect(wakeOnReply).toHaveBeenCalledWith('ses_A');
  });
  it('sanitizes terminal controls in labels', () => {
    expect(summary('A\x1b', 'B', 'hello\nworld', 'sent')).toBe('Mailbox · sent · A -> B: hello world');
  });
  it('uses host permission assertion and trusted context identity', async () => {
    const captured = new Map<string, { execute: (input: unknown, context: unknown) => Promise<unknown> }>();
    const assert = vi.fn().mockRejectedValue(new Error('DENIED'));
    const ctx = {
      tool: {
        transform: async (cb: Parameters<Plugin.Context['tool']['transform']>[0]) => {
          cb({
            get: () => undefined,
            add: (tool: Info) => {
              captured.set(tool.name, tool as never);
            },
          } as unknown as Parameters<typeof cb>[0]);
        },
      },
      permission: { assert },
    } as unknown as Plugin.Context;
    const ask = vi.fn();
    await registerTools(ctx, { ask } as unknown as Mailbox);
    expect([...captured.keys()]).not.toContain('setBidirectional');
    expect([...captured.keys()]).not.toContain('setWakeOnReply');
    expect([...captured.keys()]).not.toContain('pendingQuestions');
    await expect(
      captured.get('ask_subagent')!.execute(
        { sessionID: 'ses_B', message: 'Q' },
        {
          sessionID: 'ses_A',
          agent: 'build',
          messageID: 'msg_1',
          id: 'call_1',
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow('DENIED');
    expect(ask).not.toHaveBeenCalled();
    expect(assert).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: 'ses_A', action: 'ask_subagent' }),
    );
  });
  it('TUI deduplicates, coalesces and disposes native notifications', async () => {
    let callback: ((event: OpenCodeEvent) => void) | undefined;
    const show = vi.fn(),
      dispose = vi.fn();
    const states = new Map<string, unknown>();
    const ctx = {
      options: { toasts: true },
      keymap: { layer: vi.fn() },
      storage: {
        memory: (key: string, { initial }: { initial: unknown }) => {
          states.set(key, initial);
          return [initial, (fn: (s: unknown) => void) => fn(states.get(key))];
        },
      },
      client: { rpc: () => ({ pendingQuestions: async () => ({ count: 0 }) }) },
      data: {
        on: (_type: string, fn: typeof callback) => {
          callback = fn;
          return dispose;
        },
      },
      ui: { toast: { show }, router: { current: () => ({ type: 'home' }) }, slot: () => vi.fn() },
    } as unknown as Context;
    const cleanup = await tui.setup(ctx);
    const event = {
      type: 'session.inbox.enqueued',
      id: 'evt_1',
      created: 1,
      durable: { aggregateID: 'ses_A', seq: 1, version: 1 },
      data: {
        sessionID: 'ses_A',
        inboxID: 'msg_1',
        item: {
          type: 'synthetic',
          delivery: 'steer',
          payload: {
            text: 'R',
            metadata: { agentMailbox: { label: '[D -> A] done (received)', kind: 'answer', to: 'ses_A' } },
          },
        },
      },
    } satisfies Extract<OpenCodeEvent, { type: 'session.inbox.enqueued' }>;
    callback!(event);
    callback!(event);
    callback!({ ...event, data: { ...event.data, inboxID: 'msg_2' } });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'ses_A', variant: 'info' }));
    await cleanup?.();
    expect(dispose).toHaveBeenCalled();
  });

  it('exposes an explicit user slash command for the current session tree', async () => {
    let layer: Parameters<Context['keymap']['layer']>[0] | undefined;
    const setBidirectional = vi.fn().mockResolvedValue({ rootSessionID: 'ses_root', enabled: true });
    const setWakeOnReply = vi
      .fn()
      .mockImplementation(async ({ enabled }) => ({ rootSessionID: 'ses_root', enabled }));
    const show = vi.fn();
    const ctx = {
      keymap: { layer: (factory: NonNullable<typeof layer>) => (layer = factory) },
      ui: { router: { current: () => ({ type: 'session', sessionID: 'ses_child' }) }, toast: { show } },
      client: { rpc: () => ({ setBidirectional, setWakeOnReply }) },
    } as unknown as Context;

    registerSettingsCommands(ctx);
    const commands = layer?.().commands ?? [];
    const bidirectional = commands.find((command) => command.slash?.name === 'mailbox-bidirectional');
    const wakeOnReply = commands.find((command) => command.slash?.name === 'mailbox-wake-on-reply');
    expect(bidirectional?.slash).toEqual({ name: 'mailbox-bidirectional', arguments: true });
    expect(wakeOnReply?.slash).toEqual({ name: 'mailbox-wake-on-reply', arguments: true });
    await bidirectional?.run('on');
    expect(setBidirectional).toHaveBeenCalledWith(
      { sessionID: 'ses_child', enabled: true },
      { location: undefined },
    );
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Bidirectional questions enabled for this session tree (root ses_root).',
      }),
    );
    await bidirectional?.run('off');
    expect(setBidirectional).toHaveBeenLastCalledWith(
      { sessionID: 'ses_child', enabled: false },
      { location: undefined },
    );
    await wakeOnReply?.run('off');
    expect(setWakeOnReply).toHaveBeenCalledWith(
      { sessionID: 'ses_child', enabled: false },
      { location: undefined },
    );
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Replies will not wake idle senders in this session tree (root ses_root).',
      }),
    );
    await wakeOnReply?.run('on');
    expect(setWakeOnReply).toHaveBeenLastCalledWith(
      { sessionID: 'ses_child', enabled: true },
      { location: undefined },
    );
    await bidirectional?.run('invalid');
    expect(setBidirectional).toHaveBeenCalledTimes(2);
    expect(show).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Usage: /mailbox-bidirectional [on|off]') }),
    );
    await bidirectional?.run();
    expect(setBidirectional).toHaveBeenLastCalledWith({ sessionID: 'ses_child' }, { location: undefined });
    setWakeOnReply.mockResolvedValueOnce({ rootSessionID: 'ses_root', enabled: false });
    await wakeOnReply?.run();
    expect(setWakeOnReply).toHaveBeenLastCalledWith({ sessionID: 'ses_child' }, { location: undefined });
  });

  it('persists mode by both project and session-tree root', async () => {
    const values = new Map<string, unknown>();
    const storage = {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => {
        values.set(key, value);
      },
    };
    const firstProject = new SessionModeStore(storage as never, 'project-one');
    const sameProject = new SessionModeStore(storage as never, 'project-one');
    const otherProject = new SessionModeStore(storage as never, 'project-two');

    expect(await firstProject.get('ses_root', 'bidirectional')).toBeUndefined();
    await firstProject.set('ses_root', 'bidirectional', true);
    await firstProject.set('ses_root', 'wakeOnReply', false);
    expect(await sameProject.get('ses_root', 'bidirectional')).toBe(true);
    expect(await sameProject.get('ses_root', 'wakeOnReply')).toBe(false);
    expect(await sameProject.get('ses_other_root', 'bidirectional')).toBeUndefined();
    expect(await otherProject.get('ses_root', 'bidirectional')).toBeUndefined();
  });
});
