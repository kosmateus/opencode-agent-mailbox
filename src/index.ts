import { Plugin } from '@opencode/plugin';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { Mailbox } from './application/mailbox.js';
import { Dispatcher } from './application/dispatcher.js';
import { SqliteRepository } from './adapters/sqlite.js';
import { OpenCodeSessions } from './adapters/opencode.js';
import { registerTools, agentInstructions } from './adapters/tools.js';
const Options = z
  .object({
    timeoutMs: z.number().int().min(1000).max(86400000).default(300000),
    pollMs: z.number().int().min(100).max(10000).default(250),
    maxPending: z.number().int().min(10).max(10000).default(1000),
    dataDirectory: z.string().min(1).refine(isAbsolute, 'Must be an absolute path').optional(),
    toasts: z.boolean().default(true),
  })
  .strict();
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
    const sessions = new OpenCodeSessions(ctx, ctx.location.project.id);
    const mailbox = new Mailbox(repo, sessions, undefined, options.timeoutMs);
    const dispatcher = new Dispatcher(repo, sessions);
    try {
      const tools = await registerTools(ctx, mailbox);
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
