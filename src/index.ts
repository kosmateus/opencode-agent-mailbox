import { Plugin } from '@opencode/plugin';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Mailbox } from './application/mailbox.js';
import { Dispatcher } from './application/dispatcher.js';
import { SqliteRepository } from './adapters/sqlite.js';
import { OpenCodeSessions } from './adapters/opencode.js';
import { SessionModeStore } from './adapters/session-mode.js';
import { registerTools, agentInstructions } from './adapters/tools.js';
import { Options } from './config.js';
import { MailboxError } from './domain/model.js';
import { MailboxControl, PendingQuestionsInput, SetTreeToggleInput } from './rpc.js';
export default Plugin.define({
  id: 'agent-mailbox',
  async setup(ctx) {
    const version = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(ctx.app.version);
    if (
      !version ||
      Number(version[1]) !== 2 ||
      Number(version[2]) < 2 ||
      (Number(version[2]) === 2 && Number(version[3]) < 5)
    )
      throw new Error('agent-mailbox requires OpenCode 2.2.5 or compatible 2.x.');
    const options = Options.parse(ctx.options);
    const directory =
      options.dataDirectory ??
      join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode-agent-mailbox');
    const project = createHash('sha256').update(ctx.location.project.id).digest('hex');
    const repo = await SqliteRepository.open(join(directory, project, 'mailbox.db'), options.maxPending);
    const sessions = new OpenCodeSessions(ctx, ctx.location.project.id, (sessionID): Promise<boolean> =>
      mailbox.shouldWakeOnReply(sessionID),
    );
    const treeSettings = new SessionModeStore(ctx.storage, ctx.location.project.id);
    const mailbox = new Mailbox(repo, sessions, undefined, options.timeoutMs, {
      maxMessageLength: options.maxMessageLength,
      bidirectional: options.bidirectional,
      wakeOnReply: options.wakeOnReply,
      treeSettings,
    });
    const dispatcher = new Dispatcher(repo, sessions);
    try {
      const tools = await registerTools(ctx, mailbox, options.maxMessageLength);
      const rpc = await ctx.rpc.register(MailboxControl, {
        setBidirectional: async (input) => {
          const { sessionID, enabled } = SetTreeToggleInput.parse(input);
          return mailbox.setBidirectional(sessionID, enabled);
        },
        setWakeOnReply: async (input) => {
          const { sessionID, enabled } = SetTreeToggleInput.parse(input);
          return mailbox.setWakeOnReply(sessionID, enabled);
        },
        pendingQuestions: async (input, context) => {
          const { sessionID } = PendingQuestionsInput.parse(input);
          try {
            return await mailbox.pendingQuestions(sessionID);
          } catch (error) {
            if (
              error instanceof MailboxError &&
              (error.code === 'FORBIDDEN' || error.code === 'SESSION_UNAVAILABLE')
            )
              return context.error('session_unavailable', 'Session is unavailable in this project.', {
                code: error.code,
              });
            throw error;
          }
        },
      });
      const hook = await ctx.session.hook('context', (event) => {
        event.system.push({ type: 'text', text: agentInstructions });
      });
      const tick = () =>
        void dispatcher
          .tick()
          .catch(() =>
            console.error(
              '[agent-mailbox] Durable dispatcher failed; retrying. Inspect storage availability.',
            ),
          );
      const timer = setInterval(tick, options.pollMs);
      timer.unref();
      tick();
      return async () => {
        clearInterval(timer);
        await tools.dispose();
        await rpc.dispose();
        await hook.dispose();
        await dispatcher.stop();
        repo.close();
      };
    } catch (error) {
      await dispatcher.stop();
      repo.close();
      throw error;
    }
  },
});
