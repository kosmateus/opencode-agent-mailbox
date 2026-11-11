import { Plugin } from '@opencode/plugin/tui';
import { z } from 'zod';
import { registerSettingsCommands } from './tui-settings.js';
import { setupPendingIndicator } from './tui-pending.js';
import { MailboxControl, PendingQuestionsOutput } from './rpc.js';
const Notice = z.object({
  label: z.string(),
  kind: z.enum(['question', 'answer', 'notification']),
  to: z.string(),
});
/** Host transcript renders the synthetic description; toasts are optional and coalesced. */
export default Plugin.define({
  id: 'agent-mailbox',
  setup(ctx) {
    registerSettingsCommands(ctx);
    const stopPending = setupPendingIndicator(ctx, {
      pendingQuestions: async (input) => {
        const session = ctx.data.session.get(input.sessionID);
        if (!session) return { count: 0 };
        return PendingQuestionsOutput.parse(
          await ctx.client.rpc(MailboxControl).pendingQuestions(input, { location: session.location }),
        );
      },
    });
    if (ctx.options.toasts !== true) return stopPending;
    const [state, setState] = ctx.storage.memory<{ seen: string[] }>('notices', { initial: { seen: [] } });
    let lastToast = 0;
    const stopNotices = ctx.data.on('session.inbox.enqueued', (event) => {
      const item = event.data.item;
      if (item.type !== 'synthetic') return;
      const notice = Notice.safeParse(item.payload.metadata?.agentMailbox);
      if (!notice.success) return;
      if (state.seen.includes(event.data.inboxID)) return;
      setState((d) => {
        d.seen.push(event.data.inboxID);
        if (d.seen.length > 2000) d.seen.splice(0, d.seen.length - 2000);
      });
      if (Date.now() - lastToast < 1500) return;
      lastToast = Date.now();
      const message = notice.data.label
        .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 400)
        .trim();
      ctx.ui.toast.show({
        title: 'Agent mailbox',
        message,
        variant: 'info',
        sessionID: notice.data.to,
        duration: 3500,
      });
    });
    return () => {
      stopNotices();
      stopPending();
    };
  },
});
