import { Plugin } from '@opencode/plugin/tui';
import { z } from 'zod';
const Notice = z.object({ label: z.string(), kind: z.enum(['question', 'answer']), to: z.string() });
/** Host transcript renders the synthetic description; toasts are optional and coalesced. */
export default Plugin.define({
  id: 'agent-mailbox',
  setup(ctx) {
    if (ctx.options.toasts !== true) return;
    const [state, setState] = ctx.storage.memory<{ seen: string[] }>('notices', { initial: { seen: [] } });
    let lastToast = 0;
    return ctx.data.on('session.inbox.enqueued', (event) => {
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
  },
});
