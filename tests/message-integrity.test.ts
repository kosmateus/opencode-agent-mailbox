import { describe, expect, it, vi } from 'vitest';
import type { Plugin } from '@opencode/plugin';
import { OpenCodeSessions } from '../src/adapters/opencode.js';
import type { Delivery, Request } from '../src/domain/model.js';

type DeliveryKind = Delivery['kind'] | 'notification';

function makeRequest(overrides: { wakeOnReply?: boolean; requiresReply?: boolean } = {}): Request {
  return {
    version: 1,
    id: `req_${'a'.repeat(64)}`,
    origin: 'ses_origin',
    holder: 'ses_recipient',
    question: 'Question text',
    route: ['ses_origin', 'ses_recipient'],
    createdAt: 1,
    expiresAt: 1000,
    requiresReply: true,
    state: 'pending',
    outbox: [],
    ...overrides,
  } as Request;
}

function makeDelivery(kind: DeliveryKind, text: string): Delivery {
  const question = kind !== 'answer';
  return {
    id: `msg_${kind}`,
    kind,
    from: question ? 'ses_origin' : 'ses_recipient',
    to: question ? 'ses_recipient' : 'ses_origin',
    text,
    state: 'pending',
    attempts: 0,
    nextAt: 0,
  } as unknown as Delivery;
}

function createSessions(wakeOnReply?: (sessionID: string) => boolean | Promise<boolean>) {
  const synthetic = vi.fn<Plugin.Context['session']['synthetic']>();
  const sessions = new OpenCodeSessions(
    { session: { synthetic } as unknown as Plugin.Context['session'] },
    'project',
    wakeOnReply,
  );
  return { sessions, synthetic };
}

describe('mailbox message integrity', () => {
  it.each(['question', 'answer'] as const)(
    'preserves the full %s in the synthetic payload and transcript description',
    async (kind) => {
      const marker = `END_${kind.toUpperCase()}_MARKER`;
      const message = `${'x'.repeat(4000 - marker.length)}${marker}`;
      const request = makeRequest();
      const delivery = makeDelivery(kind, message);
      const { sessions, synthetic } = createSessions();

      await sessions.admit(request, delivery);

      const input = synthetic.mock.calls[0]![0];
      const payload = JSON.parse(input.text) as { message: string; requestID: string };
      expect(payload.message).toBe(message);
      expect(payload.requestID).toBe(request.id);
      expect(input.description).toBe(
        `Mailbox · ${kind === 'question' ? 'Question queued' : 'Reply queued'} · ${delivery.from} -> ${delivery.to}: ${message}`,
      );
      expect(input.description).toContain(marker);
      expect(input.resume).toBe(kind === 'answer');
    },
  );

  it.each([
    ['unset', undefined, true, true],
    ['enabled override over disabled default', true, false, true],
    ['disabled override over enabled default', false, true, false],
    ['disabled default', undefined, false, false],
  ] as const)(
    'resolves answer wake policy: %s',
    async (_case, requestOverride, defaultValue, expectedResume) => {
      const wakeOnReply = vi.fn(async (sessionID: string) => {
        expect(sessionID).toBe('ses_origin');
        return defaultValue;
      });
      const { sessions, synthetic } = createSessions(wakeOnReply);
      const request = makeRequest(requestOverride === undefined ? {} : { wakeOnReply: requestOverride });

      await sessions.admit(request, makeDelivery('answer', 'Answer'));

      expect(synthetic.mock.calls[0]![0].resume).toBe(expectedResume);
      expect(wakeOnReply).toHaveBeenCalledTimes(requestOverride === undefined ? 1 : 0);
    },
  );

  it.each([
    ['question', true],
    ['notification', false],
  ] as const)('%s delivery is durable but never wakes the target', async (kind, requiresReply) => {
    const wakeOnReply = vi.fn(async () => true);
    const { sessions, synthetic } = createSessions(wakeOnReply);
    const request = makeRequest({ requiresReply, wakeOnReply: true });

    await sessions.admit(request, makeDelivery(kind, 'Information'));

    const input = synthetic.mock.calls[0]![0];
    const payload = JSON.parse(input.text) as { instruction: string; requestID: string; message: string };
    expect(input.resume).toBe(false);
    expect(input.id).toBe(`msg_${kind}`);
    expect(payload).toMatchObject({ requestID: request.id, message: 'Information' });
    expect(wakeOnReply).not.toHaveBeenCalled();
    if (kind === 'notification') {
      expect(input.description).toContain('Information queued');
      expect(payload.instruction).toMatch(/no reply/i);
    }
  });

  it('strips controls from the transcript description but preserves every message character in the payload', async () => {
    const message = 'line one\nline two\u0000\x1b[2J\u202e marker';
    const { sessions, synthetic } = createSessions();

    await sessions.admit(makeRequest(), makeDelivery('question', message));

    const input = synthetic.mock.calls[0]![0];
    const payload = JSON.parse(input.text) as { message: string };
    expect(payload.message).toBe(message);
    expect(input.description).toContain('line one line two [2J marker');
    expect(input.description).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/,
    );
  });
});
