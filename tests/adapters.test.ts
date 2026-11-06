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

describe('official OpenCode adapter contracts', () => {
  it('admits synthetic steer with stable ID and resume:false', async () => {
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
      expect.objectContaining({ id: 'msg_fixed', sessionID: 'ses_A', delivery: 'steer', resume: false }),
    );
    expect(synthetic.mock.calls[0]?.[0].description).toContain('ses_D -> ses_A');
  });
  it('sanitizes terminal controls in labels', () => {
    expect(summary('A\x1b', 'B', 'hello\nworld', 'sent')).toBe('[A  -> B] hello world (sent)');
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
    const state = { seen: [] as string[] };
    const ctx = {
      options: {},
      storage: { memory: () => [state, (fn: (s: typeof state) => void) => fn(state)] },
      data: {
        on: (_type: string, fn: typeof callback) => {
          callback = fn;
          return dispose;
        },
      },
      ui: { toast: { show } },
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
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'ses_A', variant: 'success' }));
    await cleanup?.();
    expect(dispose).toHaveBeenCalled();
  });
});
