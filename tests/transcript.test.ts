import { describe, expect, it, vi } from 'vitest';
import type { Plugin } from '@opencode/plugin';
import type { OpenCodeEvent } from '@opencode/client';
import type { Context } from '@opencode/plugin/tui/plugin';
import { OpenCodeSessions, summary } from '../src/adapters/opencode.js';
import type { Request } from '../src/domain/model.js';
import tui from '../src/tui.js';

describe('mailbox transcript', () => {
  it.each([
    ['question', 'Question queued'],
    ['answer', 'Reply queued'],
  ])('labels %s messages as queued and removes terminal controls', (kind, label) => {
    const rendered = summary('ses_A\x1b[31m', 'ses_B', 'hello\nworld\x1b[2J\u202e spoof', kind);

    expect(rendered).toBe(`Mailbox · ${label} · ses_A [31m -> ses_B: hello world [2J spoof`);
    expect(rendered).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
  });

  it('keeps the request ID and original message in the synthetic payload', async () => {
    const synthetic = vi.fn<Plugin.Context['session']['synthetic']>();
    const adapter = new OpenCodeSessions(
      { session: { synthetic } as unknown as Plugin.Context['session'] },
      'project',
    );
    const request = { id: `req_${'a'.repeat(64)}`, origin: 'ses_A', expiresAt: 10 } as Request;
    const message = 'preserve\ncontrols\x1b[2J';

    await adapter.admit(request, {
      id: 'msg_1',
      kind: 'question',
      from: 'ses_A',
      to: 'ses_B',
      text: message,
      state: 'pending',
      attempts: 0,
      nextAt: 0,
    });

    const input = synthetic.mock.calls[0]?.[0];
    expect(input?.description).toBe('Mailbox · Question queued · ses_A -> ses_B: preserve controls [2J');
    expect(input?.resume).toBe(false);
    expect(JSON.parse(input!.text)).toMatchObject({ requestID: request.id, message });
  });

  it.each([
    ['unset', {}],
    ['disabled', { toasts: false }],
  ])('does not subscribe for %s toast options', async (_state, options) => {
    const on = vi.fn();
    const toast = vi.fn();
    const ctx = { options, data: { on }, ui: { toast: { show: toast } } } as unknown as Context;

    const cleanup = await tui.setup(ctx);

    expect(cleanup).toBeUndefined();
    expect(on).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('keeps explicit toasts opt-in, informational, sanitized, and deduplicated', async () => {
    type Enqueued = Extract<OpenCodeEvent, { type: 'session.inbox.enqueued' }>;
    let callback: ((event: Enqueued) => void) | undefined;
    const unsubscribe = vi.fn();
    const toast = vi.fn();
    const state = { seen: [] as string[] };
    const ctx = {
      options: { toasts: true },
      storage: {
        memory: () => [state, (update: (draft: typeof state) => void) => update(state)],
      },
      data: {
        on: (_type: string, handler: (event: Enqueued) => void) => {
          callback = handler;
          return unsubscribe;
        },
      },
      ui: { toast: { show: toast } },
    } as unknown as Context;
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
            text: 'reply',
            metadata: {
              agentMailbox: {
                label: 'Mailbox\n\x1b[2J\u202e Reply queued',
                kind: 'answer',
                to: 'ses_A',
              },
            },
          },
        },
      },
    } satisfies Enqueued;

    const cleanup = await tui.setup(ctx);
    callback!(event);
    callback!(event);

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Mailbox [2J Reply queued',
        variant: 'info',
        sessionID: 'ses_A',
      }),
    );
    await cleanup?.();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
