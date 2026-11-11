import { Rpc } from '@opencode/plugin/rpc';
import { z } from 'zod';

export const SetTreeToggleInput = z
  .object({ sessionID: z.string().min(1).max(256), enabled: z.boolean().optional() })
  .strict();
export const SetTreeToggleOutput = z
  .object({ rootSessionID: z.string().min(1).max(256), enabled: z.boolean() })
  .strict();
export const PendingQuestionsInput = z.object({ sessionID: z.string().min(1).max(256) }).strict();
export const PendingQuestionsOutput = z
  .object({ count: z.number().int().nonnegative(), nextExpiresAt: z.number().int().nonnegative().optional() })
  .strict();

export const MailboxControl = Rpc.define({
  id: 'agent-mailbox',
  methods: {
    setBidirectional: {
      input: z.toJSONSchema(SetTreeToggleInput),
      output: z.toJSONSchema(SetTreeToggleOutput),
    },
    setWakeOnReply: {
      input: z.toJSONSchema(SetTreeToggleInput),
      output: z.toJSONSchema(SetTreeToggleOutput),
    },
    pendingQuestions: {
      input: z.toJSONSchema(PendingQuestionsInput),
      output: z.toJSONSchema(PendingQuestionsOutput),
      errors: {
        session_unavailable: {
          schema: z.toJSONSchema(z.object({ code: z.enum(['FORBIDDEN', 'SESSION_UNAVAILABLE']) }).strict()),
        },
      },
    },
  },
  events: {},
});
