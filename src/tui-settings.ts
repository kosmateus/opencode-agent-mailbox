import type { Context } from '@opencode/plugin/tui/plugin';
import { MailboxControl, SetTreeToggleOutput } from './rpc.js';

export function registerSettingsCommands(ctx: Context): void {
  ctx.keymap.layer(() => ({
    mode: 'global',
    priority: 10,
    commands: [
      command(ctx, 'bidirectional', 'Set mailbox bidirectional mode', 'mailbox-bidirectional'),
      command(ctx, 'wakeOnReply', 'Set wake-on-reply mode', 'mailbox-wake-on-reply'),
    ],
  }));
}

type Setting = 'bidirectional' | 'wakeOnReply';

function command(ctx: Context, setting: Setting, title: string, slashName: string) {
  return {
    id: `agent-mailbox.${setting}`,
    title,
    description: `Set ${setting} for the current session tree without changing plugin configuration.`,
    group: 'Agent Mailbox',
    slash: { name: slashName, arguments: true as const },
    run: async (input?: string) => {
      const route = ctx.ui.router.current();
      const usage = `Usage: /${slashName} [on|off] (no argument toggles this session tree)`;
      if (route.type !== 'session') {
        ctx.ui.toast.show({
          title: 'Agent mailbox',
          message: `Run this command from a session: ${usage}`,
          variant: 'info',
        });
        return;
      }
      const argument = input?.trim().toLowerCase();
      if (argument && argument !== 'on' && argument !== 'off') {
        ctx.ui.toast.show({ title: 'Agent mailbox', message: usage, variant: 'info' });
        return;
      }
      const choice = argument ? { enabled: argument === 'on' } : {};
      try {
        const control = ctx.client.rpc(MailboxControl);
        const result = SetTreeToggleOutput.parse(
          setting === 'bidirectional'
            ? await control.setBidirectional(
                { sessionID: route.sessionID, ...choice },
                { location: ctx.location },
              )
            : await control.setWakeOnReply(
                { sessionID: route.sessionID, ...choice },
                { location: ctx.location },
              ),
        );
        const { enabled } = result;
        const message =
          setting === 'bidirectional'
            ? `Bidirectional questions ${enabled ? 'enabled' : 'disabled'} for this session tree (root ${result.rootSessionID}).`
            : `Replies will ${enabled ? '' : 'not '}wake idle senders in this session tree (root ${result.rootSessionID}).`;
        ctx.ui.toast.show({
          title: 'Agent mailbox',
          message,
          variant: enabled ? 'success' : 'info',
        });
      } catch {
        ctx.ui.toast.show({
          title: 'Agent mailbox',
          message:
            'Could not change this session-tree setting. Check that the session and mailbox plugin are available.',
          variant: 'info',
        });
      }
    },
  };
}
