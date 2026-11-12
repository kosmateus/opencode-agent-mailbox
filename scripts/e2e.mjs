import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { OpenCode } from '@opencode/client';
import { createClient } from '@libsql/client';
const repo = resolve('.');
await mkdir(join(repo, '.e2e'), { recursive: true });
const temp = await mkdtemp(join(repo, '.e2e/run-'));
const root = join(temp, 'project');
await mkdir(root, { recursive: true });
const password = randomUUID();
let child;
let logs = '';
let finished = false;
let calls = 0;
const stages = new Map();
const modeTargets = new Map();
const modeMessages = new Map();
const modeOptions = new Map();
const idleWakeMessages = new Map();
const traces = [];
const errors = [];
const gates = new Map();
const WAKE_ANSWER_TAIL = 'MAILBOX_WAKE_ANSWER_END';
let wakeOriginAnswerReads = 0;
let wakeAnswerTailRead = false;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const gateFor = (key) => {
  let gate = gates.get(key);
  if (!gate) {
    const entered = deferred();
    const released = deferred();
    gate = {
      entered: entered.promise,
      enter: entered.resolve,
      released: released.promise,
      release: released.resolve,
    };
    gates.set(key, gate);
  }
  return gate;
};
const waitFor = async (promise, description) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(description)), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const isIdle = ({ time }) => time.busy === undefined || (time.idle !== undefined && time.idle >= time.busy);
const traceCount = (role) => traces.filter((trace) => trace.role === role).length;
const textOf = (content) => (typeof content === 'string' ? content : JSON.stringify(content));
const mailboxPayloadOf = (messages) => {
  let latest;
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const candidates = [textOf(message.content)];
    if (Array.isArray(message.content))
      candidates.push(...message.content.map((part) => part.text).filter((text) => typeof text === 'string'));
    for (const candidate of candidates) {
      try {
        const payload = JSON.parse(candidate);
        if (payload?.requestID && ['question', 'notification', 'answer'].includes(payload.kind))
          latest = payload;
      } catch {}
    }
  }
  return latest;
};
const call = (name, args, id) => ({
  id: id ?? `call_${calls++}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const childID = (messages, role) => {
  const result = messages.find((m) => m.role === 'tool' && m.tool_call_id === `spawn_${role}`);
  return textOf(result?.content ?? '').match(/ses_[a-zA-Z0-9]+/)?.[0];
};
function decide(body) {
  const user = body.messages.find((m) => m.role === 'user' && /ROLE=/.test(textOf(m.content)));
  const role = textOf(user?.content ?? '').match(/ROLE=([A-Z0-9_]+)/)?.[1];
  if (!role) return { text: 'Test session' };
  const stage = stages.get(role) ?? 0;
  const tools = body.tools?.map((t) => t.function.name) ?? [];
  if (!tools.includes('ask_subagent')) errors.push(`Mailbox tools unavailable for ${role}`);
  const synthetic = body.messages
    .filter((m) => m.role === 'user')
    .map((m) => textOf(m.content))
    .join('\n');
  const requestID = synthetic.match(/req_[a-f0-9]{64}/)?.[0];
  traces.push({ role, stage, requestID, time: Date.now() });
  if (role === 'MODE_SIBLING_TARGET') {
    if (stage === 0) {
      stages.set(role, 1);
      return { text: `MODE_SIBLING_TARGET_SETUP_COMPLETE` };
    }
    if (stage === 1) {
      const payload = mailboxPayloadOf(body.messages);
      assert.equal(payload?.kind, 'question');
      stages.set(role, 2);
      return { tools: [call('mailbox_test_gate', { key: role })] };
    }
    if (stage === 2) {
      stages.set(role, 3);
      return { text: 'MODE_SIBLING_QUESTION_CONSUMED' };
    }
    if (stage === 3 && mailboxPayloadOf(body.messages)?.kind === 'notification') {
      stages.set(role, 4);
      return { text: 'MODE_SIBLING_NOTIFICATION_CONSUMED' };
    }
    return { text: `UNEXPECTED_DUPLICATE_RUN:${role}` };
  }
  if (role === 'MODE_SIBLING_NOTIFICATION_TARGET') {
    if (stage === 0) {
      stages.set(role, 1);
      return { text: 'MODE_SIBLING_NOTIFICATION_SETUP_COMPLETE' };
    }
    if (stage === 1) {
      assert.equal(mailboxPayloadOf(body.messages)?.kind, 'notification');
      stages.set(role, 2);
      return { tools: [call('mailbox_test_gate', { key: role })] };
    }
    if (stage === 2) {
      stages.set(role, 3);
      return { text: 'MODE_SIBLING_NOTIFICATION_CONSUMED' };
    }
    return { text: `UNEXPECTED_DUPLICATE_RUN:${role}` };
  }
  if (role.startsWith('MODE_')) {
    const target = modeTargets.get(role);
    if (!target) throw new Error(`No mailbox target configured for ${role}`);
    if (stage === 0) {
      stages.set(role, 1);
      return {
        tools: [
          call('ask_subagent', {
            sessionID: target,
            message: modeMessages.get(role),
            ...modeOptions.get(role),
          }),
        ],
      };
    }
    return { text: `${role} completed.` };
  }
  if (role === 'IDLE_QUESTION_SENDER' || role === 'IDLE_NOTIFICATION_SENDER') {
    const childRole = role.replace('_SENDER', '_CHILD');
    const sendPrompt = body.messages.some(
      (message) =>
        message.role === 'user' &&
        textOf(message.content).includes(`MAILBOX_SEND:${idleWakeMessages.get(role)}`),
    );
    if (stage === 0) {
      stages.set(role, 1);
      return {
        tools: [
          call(
            'subagent',
            {
              agent: 'general',
              description: `Mailbox idle wake ${childRole}`,
              prompt: `ROLE=${childRole}. Complete the setup run, then await mailbox delivery.`,
              background: true,
            },
            `spawn_${childRole}`,
          ),
        ],
      };
    }
    if (stage === 1) {
      const target = childID(body.messages, childRole);
      assert.ok(target, 'Native background subagent must return its actual sessionID');
      modeTargets.set(role, target);
      stages.set(role, 2);
      return { text: `MAILBOX_IDLE_PARENT_SETUP_COMPLETE:${role}` };
    }
    if (stage === 2 && sendPrompt) {
      stages.set(role, 3);
      const notification = role === 'IDLE_NOTIFICATION_SENDER';
      return {
        tools: [
          call('ask_subagent', {
            sessionID: modeTargets.get(role),
            message: idleWakeMessages.get(role),
            ...(notification ? { requiresReply: false } : { wakeOnReply: false }),
          }),
        ],
      };
    }
    if (stage === 2) return { text: `MAILBOX_IDLE_PARENT_SETUP_COMPLETE:${role}` };
    return { text: `MAILBOX_IDLE_PARENT_SENT:${role}` };
  }
  if (role === 'IDLE_QUESTION_CHILD' || role === 'IDLE_NOTIFICATION_CHILD') {
    if (stage === 0) {
      stages.set(role, 1);
      return { text: `MAILBOX_IDLE_SETUP_COMPLETE:${role}` };
    }
    if (stage === 1) {
      const payload = mailboxPayloadOf(body.messages);
      assert.ok(payload, `${role} must resume with the mailbox synthetic payload`);
      if (role === 'IDLE_QUESTION_CHILD') {
        assert.equal(payload.kind, 'question');
        stages.set(role, 2);
        return {
          tools: [
            call('reply_request', {
              requestID: payload.requestID,
              message: `MAILBOX_IDLE_QUESTION_REPLY:${payload.message}|END`,
            }),
          ],
        };
      }
      assert.equal(payload.kind, 'notification');
      stages.set(role, 3);
      return { tools: [call('mailbox_test_gate', { key: role })] };
    }
    if (stage === 2) {
      stages.set(role, 3);
      return { tools: [call('mailbox_test_gate', { key: role })] };
    }
    if (stage === 3) {
      stages.set(role, 4);
      return {
        text:
          role === 'IDLE_QUESTION_CHILD'
            ? 'MAILBOX_IDLE_QUESTION_REPLY_COMPLETE'
            : `MAILBOX_NOTIFICATION_CONSUMED:${idleWakeMessages.get('IDLE_NOTIFICATION_SENDER')}`,
      };
    }
    return { text: `UNEXPECTED_DUPLICATE_RUN:${role}` };
  }
  if (role === 'IDLE_RECOVERY_CHILD') {
    if (stage === 0) {
      stages.set(role, 1);
      return { text: 'MAILBOX_RECOVERY_IDLE_SETUP_COMPLETE' };
    }
    if (stage === 1) {
      const payload = mailboxPayloadOf(body.messages);
      assert.equal(payload?.kind, 'question');
      stages.set(role, 2);
      return { text: `MAILBOX_RECOVERY_QUESTION_READ:${payload.message}` };
    }
    return { text: `UNEXPECTED_DUPLICATE_RUN:${role}` };
  }
  if (role === 'WAKE_ORIGIN' || role === 'WAKE_SILENT_ORIGIN') {
    const sendPrompt = body.messages.some(
      (message) => message.role === 'user' && textOf(message.content).includes('MAILBOX_SEND_WAKE_QUESTION'),
    );
    if (stage === 0) {
      stages.set(role, 1);
      return {
        tools: [
          call(
            'subagent',
            {
              agent: 'general',
              description: `Mailbox answer wake ${role}`,
              prompt: `ROLE=${role === 'WAKE_ORIGIN' ? 'WAKE_RECIPIENT' : 'WAKE_SILENT_RECIPIENT'}. Complete setup, then answer mailbox questions.`,
              background: true,
            },
            `spawn_${role === 'WAKE_ORIGIN' ? 'WAKE_RECIPIENT' : 'WAKE_SILENT_RECIPIENT'}`,
          ),
        ],
      };
    }
    if (stage === 1) {
      const recipientRole = role === 'WAKE_ORIGIN' ? 'WAKE_RECIPIENT' : 'WAKE_SILENT_RECIPIENT';
      const target = childID(body.messages, recipientRole);
      assert.ok(target, 'Native answer recipient must return its actual sessionID');
      modeTargets.set(role, target);
      stages.set(role, 2);
      return { text: 'Origin setup run finished before asking.' };
    }
    if (stage === 2 && sendPrompt) {
      stages.set(role, 3);
      return {
        tools: [
          call('ask_subagent', {
            sessionID: modeTargets.get(role),
            message: 'MAILBOX_WAKE_QUESTION',
            timeoutMs: 60000,
            wakeOnReply: role === 'WAKE_ORIGIN',
          }),
        ],
      };
    }
    if (stage === 3) {
      stages.set(role, 4);
      return { text: 'Origin run finished while its answer was pending.' };
    }
    if (mailboxPayloadOf(body.messages)?.kind === 'answer') {
      wakeOriginAnswerReads++;
      wakeAnswerTailRead = synthetic.includes(WAKE_ANSWER_TAIL);
      stages.set(role, 5);
      return { text: `Read answer ending ${WAKE_ANSWER_TAIL}.` };
    }
    return { text: 'Origin is idle until its answer arrives.' };
  }
  if (role === 'WAKE_RECIPIENT' || role === 'WAKE_SILENT_RECIPIENT') {
    if (stage === 0) {
      stages.set(role, 1);
      return { text: `MAILBOX_IDLE_SETUP_COMPLETE:${role}` };
    }
    if (stage === 1 && requestID) {
      stages.set(role, 2);
      return { tools: [call('mailbox_test_gate', { key: role })] };
    }
    if ((stage === 2 || stage === 3) && requestID) {
      stages.set(role, stage + 1);
      return {
        tools: [
          call('reply_request', {
            requestID,
            message: `${'x'.repeat((stage === 2 ? 4001 : 4000) - WAKE_ANSWER_TAIL.length)}${WAKE_ANSWER_TAIL}`,
          }),
        ],
      };
    }
    return { text: 'Recipient completed its answer.' };
  }
  const spawn = (next) =>
    call(
      'subagent',
      {
        agent: 'general',
        description: `Mailbox role ${next}`,
        prompt: `ROLE=${next}. Perform the mailbox test and continue working.`,
        background: true,
      },
      `spawn_${next}`,
    );
  if (stage === 0 && ['A', 'B', 'C'].includes(role)) {
    stages.set(role, 1);
    return {
      tools:
        role === 'A'
          ? [spawn('B'), ...Array.from({ length: 10 }, (_, i) => spawn(`W${i}`))]
          : [spawn(role === 'B' ? 'C' : 'D')],
    };
  }
  if (role === 'A') {
    if (stage === 1) {
      const target = childID(body.messages, 'B');
      assert.ok(target, 'Native subagent must return sessionID');
      stages.set(role, 2);
      return {
        tools: [
          call('ask_subagent', { sessionID: target, message: 'MAILBOX_E2E_QUESTION', timeoutMs: 60000 }),
        ],
      };
    }
    if (stage === 2 && /"kind"\s*:\s*"answer"/.test(synthetic)) {
      stages.set(role, 3);
      finished = true;
      return { tools: [call('subagent_status', {})] };
    }
    if (stage === 3) return { text: 'A received the direct answer and completed.' };
  }
  if (['B', 'C'].includes(role) && stage === 1 && requestID) {
    const target = childID(body.messages, role === 'B' ? 'C' : 'D');
    assert.ok(target);
    stages.set(role, 2);
    return { tools: [call('forward_question', { requestID, targetSessionID: target })] };
  }
  if (role === 'D' && stage === 0 && requestID) {
    stages.set(role, 1);
    return { tools: [call('reply_request', { requestID, message: 'MAILBOX_E2E_ANSWER' })] };
  }
  if (role === 'D' && stage === 1) {
    stages.set(role, 2);
    return { tools: [call('mailbox_test_work', { ms: 400 })] };
  }
  if (finished) return { text: `${role} continued its task and completed.` };
  return {
    tools: [call('mailbox_test_work', { ms: ['B', 'C'].includes(role) && stage === 2 ? 1500 : 150 })],
  };
}
const provider = createServer(async (req, res) => {
  try {
    const gateMatch = req.url?.match(/^\/_test\/gate\/([^/]+)$/);
    if (req.method === 'POST' && gateMatch) {
      const gate = gateFor(decodeURIComponent(gateMatch[1]));
      gate.enter();
      await gate.released;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('gate released');
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const result = decide(body);
    const chunks = result.tools
      ? [
          {
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', tool_calls: result.tools.map((t, index) => ({ index, ...t })) },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ]
      : [
          {
            choices: [{ index: 0, delta: { role: 'assistant', content: result.text }, finish_reason: null }],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n');
  } catch (error) {
    errors.push(String(error));
    res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const port = provider.address().port;
try {
  // Test the actual npm tarball in a separate install, not source paths.
  const pack = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', temp], { cwd: repo, encoding: 'utf8' }),
  )[0];
  const install = join(temp, 'installed');
  await mkdir(install);
  execFileSync(
    'npm',
    ['install', '--prefix', install, '--no-audit', '--no-fund', join(temp, pack.filename)],
    { stdio: 'pipe' },
  );
  const packagePath = join(install, 'node_modules', JSON.parse(await readFile('package.json', 'utf8')).name);
  const fixture = join(root, '.opencode', 'plugins', 'fixture');
  await mkdir(fixture, { recursive: true });
  await writeFile(
    join(fixture, 'index.ts'),
    `import { Plugin } from '@opencode/plugin';
export default Plugin.define({
  id: 'mailbox-test-fixture',
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: 'mailbox_test_work',
        options: { codemode: false },
        description: 'Deterministic test work',
        input: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'], additionalProperties: false },
        execute: async (input) => {
          await new Promise((resolve) => setTimeout(resolve, input.ms));
          return { content: 'work checkpoint' };
        },
      });
      editor.add({
        name: 'mailbox_test_gate',
        options: { codemode: false },
        description: 'Hold this isolated test run until the controller releases it',
        input: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
        execute: async (input) => {
          const response = await fetch('http://127.0.0.1:${port}/_test/gate/' + encodeURIComponent(input.key), { method: 'POST' });
          return { content: await response.text() };
        },
      });
    });
  },
});`,
  );
  const config = {
    experimental: { subagent_depth: 4 },
    update: 'disable',
    model: 'mailtest/model',
    plugins: [
      {
        package: packagePath,
        options: { dataDirectory: join(temp, 'mailbox'), pollMs: 100, wakeOnReply: false },
      },
    ],
    providers: {
      mailtest: {
        name: 'Mailtest',
        package: '@opencode/ai/providers/openai-compatible',
        settings: { apiKey: 'local-test', baseURL: `http://127.0.0.1:${port}/v1` },
        models: {
          model: {
            name: 'Test',
            capabilities: { tools: true, input: ['text'], output: ['text'] },
            cost: { input: 0, output: 0 },
            limit: { context: 100000, output: 10000 },
          },
        },
      },
    },
  };
  await writeFile(join(root, 'opencode.json'), JSON.stringify(config));
  const env = { ...process.env, OPENCODE_PASSWORD: password };
  for (const kind of ['CONFIG', 'DATA', 'STATE', 'CACHE'])
    env[`XDG_${kind}_HOME`] = join(temp, kind.toLowerCase());
  async function startHost() {
    logs = '';
    child = spawn(
      resolve('node_modules/.bin/opencode'),
      ['serve', '--hostname', '127.0.0.1', '--port', '0'],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.on('data', (c) => {
      logs += c;
    });
    child.stderr.on('data', (c) => {
      logs += c;
    });
    const deadline = Date.now() + 90000;
    let serverUrl;
    while (Date.now() < deadline) {
      serverUrl = logs.match(/server listening on (http:\/\/[^\s]+)/)?.[1];
      if (serverUrl) break;
      if (child.exitCode !== null) throw new Error(logs);
      await delay(50);
    }
    assert.ok(serverUrl, 'Server did not start');
    return OpenCode.make({
      baseUrl: serverUrl,
      headers: { Authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') },
    });
  }
  const deadline = Date.now() + 90000;
  let client = await startHost();
  const waitUntil = async (description, condition) => {
    const until = Date.now() + 15000;
    while (!(await condition())) {
      assert.ok(Date.now() < until, description);
      await delay(50);
    }
  };
  const { MailboxControl } = await import(pathToFileURL(join(packagePath, 'dist/rpc.js')).href);
  const modeRoot = await client.session.create({ location: { directory: root }, title: 'Mailbox mode root' });
  const otherProject = join(temp, 'other-project');
  await mkdir(otherProject);
  execFileSync('git', ['init', otherProject], { stdio: 'pipe' });
  execFileSync(
    'git',
    [
      '-C',
      otherProject,
      '-c',
      'user.name=Mailbox Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      `Isolated project ${randomUUID()}`,
    ],
    { stdio: 'pipe' },
  );
  await writeFile(join(otherProject, 'opencode.json'), JSON.stringify(config));
  const foreignSession = await client.session.create({
    location: { directory: otherProject },
    title: 'Foreign project session',
  });
  assert.notEqual(foreignSession.projectID, modeRoot.projectID);
  await assert.rejects(
    client
      .rpc(MailboxControl)
      .pendingQuestions({ sessionID: foreignSession.id }, { location: { directory: root } }),
    (error) => error.type === 'session_unavailable' && error.data.code === 'FORBIDDEN',
    'Cross-project RPC must stay forbidden and return a declared error, not a handler defect',
  );
  assert.deepEqual(
    await client
      .rpc(MailboxControl)
      .pendingQuestions({ sessionID: foreignSession.id }, { location: foreignSession.location }),
    { count: 0 },
    'The same session must work when the RPC is routed to its own location',
  );
  await client.session.remove({ sessionID: foreignSession.id });
  await assert.rejects(
    client
      .rpc(MailboxControl)
      .pendingQuestions({ sessionID: foreignSession.id }, { location: foreignSession.location }),
    (error) => error.type === 'session_unavailable' && error.data.code === 'SESSION_UNAVAILABLE',
    'A deleted session must return a declared error instead of a handler defect',
  );
  const modeSibling = await client.session.create({
    parentID: modeRoot.id,
    location: { directory: root },
    title: 'Mailbox mode sibling',
  });
  stages.set('MODE_SIBLING_TARGET', 0);
  await client.session.prompt({
    sessionID: modeSibling.id,
    text: 'ROLE=MODE_SIBLING_TARGET. Complete setup and await a mailbox question.',
  });
  await client.experimental.session.wait(
    { sessionID: modeSibling.id },
    { signal: AbortSignal.timeout(15000) },
  );
  assert.equal(isIdle(await client.session.get({ sessionID: modeSibling.id })), true);
  const modeNotificationSibling = await client.session.create({
    parentID: modeRoot.id,
    location: { directory: root },
    title: 'Mailbox notification sibling',
  });
  stages.set('MODE_SIBLING_NOTIFICATION_TARGET', 0);
  await client.session.prompt({
    sessionID: modeNotificationSibling.id,
    text: 'ROLE=MODE_SIBLING_NOTIFICATION_TARGET. Complete setup and await a notification.',
  });
  await client.experimental.session.wait(
    { sessionID: modeNotificationSibling.id },
    { signal: AbortSignal.timeout(15000) },
  );
  assert.equal(isIdle(await client.session.get({ sessionID: modeNotificationSibling.id })), true);
  const otherRoot = await client.session.create({
    location: { directory: root },
    title: 'Unrelated mailbox root',
  });
  const runModeRequest = async (role, targetSessionID, message = `MAILBOX_${role}`, options = {}) => {
    const sender = await client.session.create({
      parentID: modeRoot.id,
      location: { directory: root },
      title: `Mailbox ${role} sender`,
      permissions: [{ action: '*', resource: '*', effect: 'allow' }],
    });
    modeTargets.set(role, targetSessionID);
    modeMessages.set(role, message);
    modeOptions.set(role, options);
    stages.set(role, 0);
    await client.session.prompt({ sessionID: sender.id, text: `ROLE=${role}. Test mailbox authorization.` });
    await client.experimental.session.wait({ sessionID: sender.id }, { signal: AbortSignal.timeout(15000) });
    const context = await client.session.context({ sessionID: sender.id });
    const toolCall = context
      .filter((message) => message.type === 'assistant')
      .flatMap((message) => message.content.filter((item) => item.type === 'tool'))
      .find((item) => item.name === 'ask_subagent' && item.state.input.message === message);
    assert.ok(toolCall, `${role} must invoke ask_subagent`);
    const content = toolCall.state.content.find((item) => item.type === 'text')?.text;
    assert.ok(content, `${role} must return JSON tool output`);
    return { result: JSON.parse(content), senderID: sender.id };
  };
  const waitForMailboxItem = async (sessionID, requestID) => {
    let item;
    await waitUntil(`Mailbox transcript item ${requestID} was not admitted to ${sessionID}`, async () => {
      item = (await client.session.context({ sessionID })).find(
        (message) => message.type === 'synthetic' && message.metadata?.agentMailbox?.requestID === requestID,
      );
      return Boolean(item);
    });
    return item;
  };
  const waitForMailboxInboxPayload = async (sessionID, requestID) => {
    let payload;
    await waitUntil(`Mailbox inbox item ${requestID} was not admitted to ${sessionID}`, async () => {
      const entry = (await client.session.inbox.list({ sessionID })).find(
        (item) => item.payload?.metadata?.agentMailbox?.requestID === requestID,
      );
      payload = entry?.payload;
      return Boolean(payload);
    });
    return payload;
  };
  const waitForMailboxConsumption = async (sessionID, requestID) => {
    await waitUntil(`Mailbox item ${requestID} did not resume ${sessionID}`, async () => {
      const context = await client.session.context({ sessionID });
      const mailboxIndex = context.findIndex(
        (item) => item.type === 'synthetic' && item.metadata?.agentMailbox?.requestID === requestID,
      );
      return mailboxIndex >= 0 && context.slice(mailboxIndex + 1).some((item) => item.type === 'assistant');
    });
    await client.experimental.session.wait({ sessionID }, { signal: AbortSignal.timeout(15000) });
    assert.equal(isIdle(await client.session.get({ sessionID })), true);
  };
  const runIdleWakeCase = async (kind) => {
    const senderRole = `IDLE_${kind.toUpperCase()}_SENDER`;
    const recipientRole = `IDLE_${kind.toUpperCase()}_CHILD`;
    const message = `MAILBOX_IDLE_${kind.toUpperCase()}:${randomUUID()}`;
    const sender = await client.session.create({
      location: { directory: root },
      title: `${kind} idle-wake sender`,
      permissions: [{ action: '*', resource: '*', effect: 'allow' }],
    });
    const treeWake = false;
    assert.deepEqual(
      await client
        .rpc(MailboxControl)
        .setWakeOnReply({ sessionID: sender.id, enabled: treeWake }, { location: { directory: root } }),
      { rootSessionID: sender.id, enabled: treeWake },
    );
    stages.set(senderRole, 0);
    idleWakeMessages.set(senderRole, message);
    await client.session.prompt({
      sessionID: sender.id,
      text: `ROLE=${senderRole}. Prepare the idle child.`,
    });
    await client.experimental.session.wait({ sessionID: sender.id }, { signal: AbortSignal.timeout(15000) });

    const recipientID = modeTargets.get(senderRole);
    assert.ok(recipientID, 'The sender must create a real native background child');
    assert.equal((await client.session.get({ sessionID: recipientID })).parentID, sender.id);
    await client.experimental.session.wait(
      { sessionID: recipientID },
      { signal: AbortSignal.timeout(15000) },
    );
    assert.equal(isIdle(await client.session.get({ sessionID: recipientID })), true);
    await client.experimental.session.wait({ sessionID: sender.id }, { signal: AbortSignal.timeout(15000) });
    assert.equal(isIdle(await client.session.get({ sessionID: sender.id })), true);
    const senderTraceBaseline = traceCount(senderRole);
    const recipientTraceBaseline = traceCount(recipientRole);
    const setupTranscript = await client.session.context({ sessionID: recipientID });
    assert.ok(
      setupTranscript.some((item) =>
        JSON.stringify(item).includes(`MAILBOX_IDLE_SETUP_COMPLETE:${recipientRole}`),
      ),
      'Capture the child native setup final before sending the mailbox request',
    );

    await client.session.prompt({
      sessionID: sender.id,
      text: `ROLE=${senderRole}. MAILBOX_SEND:${message}. Send this message now.`,
    });
    await client.experimental.session.wait({ sessionID: sender.id }, { signal: AbortSignal.timeout(15000) });
    const senderContext = await client.session.context({ sessionID: sender.id });
    const askCall = senderContext
      .filter((item) => item.type === 'assistant')
      .flatMap((item) => item.content.filter((part) => part.type === 'tool'))
      .find((item) => item.name === 'ask_subagent' && item.state.input.message === message);
    assert.ok(askCall, `${senderRole} must issue exactly the prepared mailbox message`);
    const askResult = JSON.parse(askCall.state.content.find((part) => part.type === 'text').text);
    assert.equal(askResult.ok, true);
    assert.equal(isIdle(await client.session.get({ sessionID: sender.id })), true);
    assert.equal(traceCount(senderRole), senderTraceBaseline + 2);

    const mailboxItem = await waitForMailboxItem(recipientID, askResult.requestID);
    const payload = JSON.parse(mailboxItem.text);
    assert.equal(payload.kind, kind);
    assert.equal(payload.message, message);
    assert.equal(payload.requestID, askResult.requestID);
    const gate = gateFor(recipientRole);
    await waitFor(gate.entered, `${recipientRole} did not resume into the controlled model phase`);
    assert.equal(isIdle(await client.session.get({ sessionID: recipientID })), false);
    assert.equal(traceCount(recipientRole), recipientTraceBaseline + (kind === 'question' ? 2 : 1));

    const atGate = await client.session.context({ sessionID: recipientID });
    const mailboxItems = atGate.filter(
      (item) => item.type === 'synthetic' && item.metadata?.agentMailbox?.requestID === askResult.requestID,
    );
    assert.equal(mailboxItems.length, 1);
    assert.equal(mailboxItems[0].metadata.agentMailbox.kind, kind);
    assert.ok(mailboxItems[0].text.includes(message), 'The resumed child must receive the complete message');
    const replyCalls = atGate
      .filter((item) => item.type === 'assistant')
      .flatMap((item) =>
        item.content.filter((part) => part.type === 'tool' && part.name === 'reply_request'),
      );
    if (kind === 'question') {
      assert.equal(replyCalls.length, 1);
      assert.equal(
        JSON.parse(replyCalls[0].state.content.find((part) => part.type === 'text').text).ok,
        true,
      );
      const senderAnswer = await waitForMailboxInboxPayload(sender.id, askResult.requestID);
      assert.equal(senderAnswer.metadata.agentMailbox.kind, 'answer');
      assert.equal(JSON.parse(senderAnswer.text).requestID, askResult.requestID);
      assert.ok(JSON.parse(senderAnswer.text).message.endsWith(`${message}|END`));
      assert.equal(isIdle(await client.session.get({ sessionID: sender.id })), true);
      assert.equal(
        traceCount(senderRole),
        senderTraceBaseline + 2,
        'wakeOnReply:false must leave the original sender idle after the answer arrives',
      );
    } else {
      assert.equal(replyCalls.length, 0, 'Notifications must not be answered');
      assert.deepEqual(
        await client
          .rpc(MailboxControl)
          .pendingQuestions({ sessionID: sender.id }, { location: { directory: root } }),
        { count: 0 },
      );
    }

    const childTraceCount = traceCount(recipientRole);
    await client.session.synthetic({
      sessionID: recipientID,
      id: mailboxItem.id,
      text: `RETRY_MUST_NOT_DUPLICATE:${message}`,
      delivery: 'steer',
      resume: true,
    });
    assert.equal(
      traceCount(recipientRole),
      childTraceCount,
      'An active recipient must not start another model run for a retry of the same inbox ID',
    );
    assert.equal(
      (await client.session.context({ sessionID: recipientID })).filter(
        (item) => item.type === 'synthetic' && item.metadata?.agentMailbox?.requestID === askResult.requestID,
      ).length,
      1,
    );

    gate.release();
    await client.experimental.session.wait(
      { sessionID: recipientID },
      { signal: AbortSignal.timeout(15000) },
    );
    assert.equal(isIdle(await client.session.get({ sessionID: recipientID })), true);
    assert.equal(stages.get(recipientRole), 4);
    assert.equal(
      traceCount(recipientRole),
      recipientTraceBaseline + (kind === 'question' ? 3 : 2),
      'One setup execution and exactly one resumed execution are expected',
    );
    const finalContext = await client.session.context({ sessionID: recipientID });
    assert.equal(
      finalContext.filter(
        (item) => item.type === 'synthetic' && item.metadata?.agentMailbox?.requestID === askResult.requestID,
      ).length,
      1,
    );
    if (kind === 'notification') {
      assert.ok(
        finalContext.some((item) =>
          JSON.stringify(item).includes(`MAILBOX_NOTIFICATION_CONSUMED:${message}`),
        ),
        'The idle child must consume the notification after resuming',
      );
    }
    return { senderID: sender.id, recipientID, requestID: askResult.requestID, kind };
  };
  const runWakeAnswerCase = async (role, requestWake, treeWake) => {
    const recipientRole = role === 'WAKE_ORIGIN' ? 'WAKE_RECIPIENT' : 'WAKE_SILENT_RECIPIENT';
    const origin = await client.session.create({
      location: { directory: root },
      title: `${role} answer-wake origin`,
      permissions: [{ action: '*', resource: '*', effect: 'allow' }],
    });
    assert.deepEqual(
      await client
        .rpc(MailboxControl)
        .setWakeOnReply({ sessionID: origin.id, enabled: treeWake }, { location: { directory: root } }),
      { rootSessionID: origin.id, enabled: treeWake },
    );
    stages.set(role, 0);
    await client.session.prompt({ sessionID: origin.id, text: `ROLE=${role}. Prepare before asking.` });
    await client.experimental.session.wait({ sessionID: origin.id }, { signal: AbortSignal.timeout(15000) });
    const recipientID = modeTargets.get(role);
    assert.ok(recipientID, 'The origin must create its native background child');
    assert.equal((await client.session.get({ sessionID: recipientID })).parentID, origin.id);
    await client.experimental.session.wait(
      { sessionID: recipientID },
      { signal: AbortSignal.timeout(15000) },
    );
    assert.equal(isIdle(await client.session.get({ sessionID: recipientID })), true);
    await client.experimental.session.wait({ sessionID: origin.id }, { signal: AbortSignal.timeout(15000) });
    assert.equal(isIdle(await client.session.get({ sessionID: origin.id })), true);
    const originTraceBaseline = traceCount(role);
    const recipientTraceBaseline = traceCount(recipientRole);
    assert.ok(
      (await client.session.context({ sessionID: recipientID })).some((item) =>
        JSON.stringify(item).includes(`MAILBOX_IDLE_SETUP_COMPLETE:${recipientRole}`),
      ),
    );

    await client.session.prompt({
      sessionID: origin.id,
      text: `ROLE=${role}. MAILBOX_SEND_WAKE_QUESTION. Send the question now.`,
    });
    await client.experimental.session.wait({ sessionID: origin.id }, { signal: AbortSignal.timeout(15000) });
    assert.equal(isIdle(await client.session.get({ sessionID: origin.id })), true);
    assert.equal(traceCount(role), originTraceBaseline + 2);
    const originContext = await client.session.context({ sessionID: origin.id });
    const askCall = originContext
      .filter((item) => item.type === 'assistant')
      .flatMap((item) => item.content.filter((part) => part.type === 'tool' && part.name === 'ask_subagent'))
      .find((item) => item.state.input.message === 'MAILBOX_WAKE_QUESTION');
    assert.ok(askCall);
    const askResult = JSON.parse(askCall.state.content.find((part) => part.type === 'text').text);
    assert.equal(askResult.ok, true);
    const questionItem = await waitForMailboxItem(recipientID, askResult.requestID);
    assert.equal(questionItem.metadata.agentMailbox.kind, 'question');
    const gate = gateFor(recipientRole);
    await waitFor(gate.entered, `${recipientRole} did not stop at the answer-control gate`);
    assert.equal(isIdle(await client.session.get({ sessionID: origin.id })), true);
    assert.equal(isIdle(await client.session.get({ sessionID: recipientID })), false);
    assert.equal(traceCount(recipientRole), recipientTraceBaseline + 1);

    gate.release();
    await client.experimental.session.wait(
      { sessionID: recipientID },
      { signal: AbortSignal.timeout(15000) },
    );
    const answerItem = requestWake
      ? await waitForMailboxItem(origin.id, askResult.requestID)
      : await waitForMailboxInboxPayload(origin.id, askResult.requestID);
    assert.equal(answerItem.metadata.agentMailbox.kind, 'answer');
    const answer = JSON.parse(answerItem.text);
    assert.ok(answer.message.endsWith(WAKE_ANSWER_TAIL));
    assert.equal([...answer.message].length, 4000);

    if (requestWake) {
      await client.experimental.session.wait(
        { sessionID: origin.id },
        { signal: AbortSignal.timeout(15000) },
      );
      await waitUntil(
        'The true request wake policy must resume the idle origin once',
        async () => wakeOriginAnswerReads === 1 && isIdle(await client.session.get({ sessionID: origin.id })),
      );
      assert.equal(wakeOriginAnswerReads, 1);
      assert.equal(wakeAnswerTailRead, true);
      assert.equal(
        (await client.session.context({ sessionID: origin.id })).filter(
          (item) => item.type === 'synthetic' && item.metadata?.agentMailbox?.kind === 'answer',
        ).length,
        1,
      );
      assert.equal(traceCount(role), originTraceBaseline + 3);
    } else {
      assert.equal(isIdle(await client.session.get({ sessionID: origin.id })), true);
      assert.equal(stages.get(role), 4);
      assert.equal(
        traceCount(role),
        originTraceBaseline + 2,
        'Explicit request false must override tree true and the configured global default',
      );
    }

    const recipientContext = await client.session.context({ sessionID: recipientID });
    const replyResults = recipientContext
      .filter((item) => item.type === 'assistant')
      .flatMap((item) => item.content.filter((part) => part.type === 'tool' && part.name === 'reply_request'))
      .map((item) => JSON.parse(item.state.content.find((part) => part.type === 'text').text));
    assert.equal(replyResults[0].error.code, 'INVALID_INPUT', '4001-character replies must fail');
    assert.equal(replyResults[1].ok, true, '4000-character replies must succeed');
    assert.equal(stages.get(recipientRole), 4);
    assert.equal(traceCount(recipientRole), recipientTraceBaseline + 4);
    return { originID: origin.id, recipientID, requestWake };
  };
  const { result: defaultModeResult, senderID: defaultModeSender } = await runModeRequest(
    'MODE_DEFAULT',
    modeSibling.id,
  );
  assert.equal(defaultModeResult.ok, false, 'Bidirectional mode must be off by default');
  assert.equal(defaultModeResult.error.code, 'FORBIDDEN');
  assert.equal(isIdle(await client.session.get({ sessionID: modeSibling.id })), true);
  const modeOn = await client
    .rpc(MailboxControl)
    .setBidirectional({ sessionID: defaultModeSender }, { location: { directory: root } });
  assert.deepEqual(modeOn, { rootSessionID: modeRoot.id, enabled: true });
  const treeWakeOff = await client
    .rpc(MailboxControl)
    .setWakeOnReply({ sessionID: defaultModeSender, enabled: false }, { location: { directory: root } });
  assert.deepEqual(treeWakeOff, { rootSessionID: modeRoot.id, enabled: false });
  const { result: siblingModeResult } = await runModeRequest(
    'MODE_SIBLING',
    modeSibling.id,
    'MAILBOX_SIBLING_QUESTION',
    { wakeOnReply: false },
  );
  assert.equal(siblingModeResult.ok, true, 'User-enabled mode must allow sibling questions');
  const siblingItem = await waitForMailboxItem(modeSibling.id, siblingModeResult.requestID);
  const siblingGate = gateFor('MODE_SIBLING_TARGET');
  await waitFor(siblingGate.entered, 'The authorized sibling subagent must resume on its question');
  assert.equal(isIdle(await client.session.get({ sessionID: modeSibling.id })), false);
  const siblingTraceCount = traces.filter((trace) => trace.role === 'MODE_SIBLING_TARGET').length;
  await client.session.synthetic({
    sessionID: modeSibling.id,
    id: siblingItem.id,
    text: 'Duplicate sibling delivery must be ignored',
    delivery: 'steer',
    resume: true,
  });
  assert.equal(
    (await client.session.context({ sessionID: modeSibling.id })).filter(
      (item) =>
        item.type === 'synthetic' && item.metadata?.agentMailbox?.requestID === siblingModeResult.requestID,
    ).length,
    1,
  );
  assert.equal(traces.filter((trace) => trace.role === 'MODE_SIBLING_TARGET').length, siblingTraceCount);
  siblingGate.release();
  await client.experimental.session.wait(
    { sessionID: modeSibling.id },
    { signal: AbortSignal.timeout(15000) },
  );
  assert.equal(stages.get('MODE_SIBLING_TARGET'), 3);
  assert.equal(traces.filter((trace) => trace.role === 'MODE_SIBLING_TARGET').length, 3);

  const siblingNotification = await runModeRequest(
    'MODE_SIBLING_NOTIFICATION',
    modeNotificationSibling.id,
    'MAILBOX_SIBLING_NOTIFICATION',
    { requiresReply: false },
  );
  assert.equal(siblingNotification.result.ok, true);
  const siblingNotificationItem = await waitForMailboxItem(
    modeNotificationSibling.id,
    siblingNotification.result.requestID,
  );
  assert.equal(siblingNotificationItem.metadata.agentMailbox.kind, 'notification');
  const siblingNotificationGate = gateFor('MODE_SIBLING_NOTIFICATION_TARGET');
  await waitFor(
    siblingNotificationGate.entered,
    'The authorized sibling subagent must resume on notification',
  );
  assert.equal(isIdle(await client.session.get({ sessionID: modeNotificationSibling.id })), false);
  const siblingNotificationTraceCount = traces.filter(
    (trace) => trace.role === 'MODE_SIBLING_NOTIFICATION_TARGET',
  ).length;
  await client.session.synthetic({
    sessionID: modeNotificationSibling.id,
    id: siblingNotificationItem.id,
    text: 'Duplicate sibling notification must be ignored',
    delivery: 'steer',
    resume: true,
  });
  assert.equal(
    (await client.session.context({ sessionID: modeNotificationSibling.id })).filter(
      (item) =>
        item.type === 'synthetic' &&
        item.metadata?.agentMailbox?.requestID === siblingNotification.result.requestID,
    ).length,
    1,
  );
  assert.equal(
    traces.filter((trace) => trace.role === 'MODE_SIBLING_NOTIFICATION_TARGET').length,
    siblingNotificationTraceCount,
  );
  assert.equal(
    (
      await client
        .rpc(MailboxControl)
        .pendingQuestions({ sessionID: siblingNotification.senderID }, { location: { directory: root } })
    ).count,
    0,
    'Sibling notifications do not create pending-question counts',
  );
  siblingNotificationGate.release();
  await client.experimental.session.wait(
    { sessionID: modeNotificationSibling.id },
    { signal: AbortSignal.timeout(15000) },
  );
  assert.equal(stages.get('MODE_SIBLING_NOTIFICATION_TARGET'), 3);
  assert.equal(traces.filter((trace) => trace.role === 'MODE_SIBLING_NOTIFICATION_TARGET').length, 3);

  const idleQuestionCase = await runIdleWakeCase('question');
  const idleNotificationCase = await runIdleWakeCase('notification');

  const longRecipient = await client.session.create({
    parentID: modeRoot.id,
    location: { directory: root },
    title: '4000-character recipient',
  });
  const tooLongRecipient = await client.session.create({
    parentID: modeRoot.id,
    location: { directory: root },
    title: '4001-character recipient',
  });
  const notificationRecipient = await client.session.create({
    parentID: modeRoot.id,
    location: { directory: root },
    title: 'Informational notification recipient',
  });
  const longTail = 'MAILBOX_E2E_END_4000';
  const message4000 = `${'x'.repeat(4000 - longTail.length)}${longTail}`;
  const message4001 = `${'x'.repeat(4001 - longTail.length)}${longTail}`;
  assert.equal([...message4000].length, 4000);
  assert.equal([...message4001].length, 4001);
  const { result: accepted4000, senderID: longSender } = await runModeRequest(
    'MODE_LONG',
    longRecipient.id,
    message4000,
  );
  assert.equal(accepted4000.ok, true, 'A 4000-code-point message must be accepted');
  const longPending = await client
    .rpc(MailboxControl)
    .pendingQuestions({ sessionID: longSender }, { location: { directory: root } });
  assert.equal(longPending.count, 1);
  assert.ok(longPending.nextExpiresAt > Date.now());
  assert.deepEqual(Object.keys(longPending).sort(), ['count', 'nextExpiresAt']);
  const acceptedItem = await waitForMailboxItem(longRecipient.id, accepted4000.requestID);
  const acceptedPayload = JSON.parse(acceptedItem.text);
  assert.equal(acceptedPayload.requestID, accepted4000.requestID);
  assert.equal(acceptedPayload.message, message4000);
  assert.ok(
    acceptedPayload.message.endsWith(longTail),
    'The complete message ending must reach the recipient',
  );
  await waitForMailboxConsumption(longRecipient.id, accepted4000.requestID);
  const { result: rejected4001 } = await runModeRequest('MODE_TOO_LONG', tooLongRecipient.id, message4001);
  assert.equal(rejected4001.ok, false);
  assert.equal(rejected4001.error.code, 'INVALID_INPUT');
  assert.deepEqual(await client.session.inbox.list({ sessionID: tooLongRecipient.id }), []);
  assert.equal(
    (await client.session.context({ sessionID: tooLongRecipient.id })).some(
      (item) => item.type === 'synthetic' && item.metadata?.agentMailbox,
    ),
    false,
  );

  const { result: notificationResult, senderID: notificationSender } = await runModeRequest(
    'MODE_NOTIFICATION',
    notificationRecipient.id,
    'MAILBOX_INFORMATION_ONLY',
    { requiresReply: false },
  );
  assert.equal(notificationResult.ok, true);
  assert.deepEqual(
    await client
      .rpc(MailboxControl)
      .pendingQuestions({ sessionID: notificationSender }, { location: { directory: root } }),
    { count: 0 },
    'Informational notifications are excluded from pending-question counts',
  );
  const notificationItem = await waitForMailboxItem(notificationRecipient.id, notificationResult.requestID);
  assert.equal(notificationItem.metadata.agentMailbox.kind, 'notification');
  await waitForMailboxConsumption(notificationRecipient.id, notificationResult.requestID);
  const notificationRequestID = notificationResult.requestID;

  const deletionParent = await client.session.create({
    parentID: modeRoot.id,
    location: { directory: root },
    title: 'Deletion subtree parent',
  });
  const deletionRecipient = await client.session.create({
    parentID: deletionParent.id,
    location: { directory: root },
    title: 'Deletion subtree recipient',
  });
  const { result: deletionResult } = await runModeRequest(
    'MODE_DELETE_RECIPIENT',
    deletionRecipient.id,
    'DELETE_THIS_MAILBOX_RECORD',
    { requiresReply: false },
  );
  assert.equal(deletionResult.ok, true);
  await waitForMailboxItem(deletionRecipient.id, deletionResult.requestID);
  const cleanupDatabase = createClient({
    url: pathToFileURL(
      join(temp, 'mailbox', createHash('sha256').update(modeRoot.projectID).digest('hex'), 'mailbox.db'),
    ).href,
  });
  const hasRequest = async (requestID) =>
    Number(
      (
        await cleanupDatabase.execute({
          sql: 'SELECT COUNT(*) AS n FROM requests WHERE id=?',
          args: [requestID],
        })
      ).rows[0].n,
    ) > 0;
  try {
    await client.session.remove({ sessionID: deletionParent.id });
    await waitUntil(
      'Deleting a subtree must purge its recipient mailbox records',
      async () => !(await hasRequest(deletionResult.requestID)),
    );
    assert.equal(await hasRequest(accepted4000.requestID), true, 'Unrelated mailbox records must remain');
    const { result: senderDeletedResult, senderID: deletedSenderID } = await runModeRequest(
      'MODE_DELETE_SENDER',
      modeSibling.id,
      'DELETE_SENDER_RECORD',
      { requiresReply: false },
    );
    assert.equal(senderDeletedResult.ok, true);
    await client.session.remove({ sessionID: deletedSenderID });
    await waitUntil(
      'Deleting a sender must purge its mailbox records',
      async () => !(await hasRequest(senderDeletedResult.requestID)),
    );
    assert.equal(await hasRequest(accepted4000.requestID), true);
  } finally {
    cleanupDatabase.close();
  }

  const wakeAnswerTrue = await runWakeAnswerCase('WAKE_ORIGIN', true, false);
  const wakeAnswerFalse = await runWakeAnswerCase('WAKE_SILENT_ORIGIN', false, true);

  const { result: otherTreeResult } = await runModeRequest('MODE_OTHER_TREE', otherRoot.id);
  assert.equal(otherTreeResult.ok, false, 'User-enabled mode must not cross session-tree roots');
  assert.equal(otherTreeResult.error.code, 'FORBIDDEN');
  const modeOff = await client
    .rpc(MailboxControl)
    .setBidirectional({ sessionID: modeSibling.id }, { location: { directory: root } });
  assert.deepEqual(modeOff, { rootSessionID: modeRoot.id, enabled: false });
  const { result: disabledModeResult } = await runModeRequest('MODE_DISABLED', modeSibling.id);
  assert.equal(disabledModeResult.ok, false, 'A user can restore descendant-only mode for the whole tree');
  assert.equal(disabledModeResult.error.code, 'FORBIDDEN');

  const session = await client.session.create({
    location: { directory: root },
    title: 'Mailbox E2E A',
    permissions: [{ action: '*', resource: '*', effect: 'allow' }],
  });
  await client.session.prompt({ sessionID: session.id, text: 'ROLE=A. Run the mailbox test.' });
  while (!finished && Date.now() < deadline) {
    await delay(100);
  }
  assert.ok(
    finished,
    `Direct answer not observed. Stages: ${JSON.stringify([...stages])}; errors: ${errors.join(';')}`,
  );
  await client.experimental.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(15000) });
  await delay(2000);
  const all = [];
  const queue = [session.id];
  for (let i = 0; i < queue.length; i++) {
    const s = await client.session.get({ sessionID: queue[i] });
    const messages = await client.session.context({ sessionID: s.id });
    all.push({ session: s, messages });
    const children = await client.session.list({ parentID: s.id, limit: 100 });
    queue.push(...children.data.map((c) => c.id));
  }
  assert.ok(all.length >= 14, `Expected A/B/C/D and ten workers, got ${all.length}`);
  const answers = all.flatMap((s) =>
    s.messages
      .filter((m) => m.type === 'synthetic' && m.metadata?.agentMailbox?.kind === 'answer')
      .map((m) => ({ session: s.session.id, message: m })),
  );
  assert.equal(answers.length, 1, 'Exactly one mailbox answer in all transcripts');
  assert.equal(answers[0].session, session.id);
  assert.match(answers[0].message.text, /MAILBOX_E2E_ANSWER/);
  const toolCalls = all.flatMap((s) =>
    s.messages
      .filter((m) => m.type === 'assistant')
      .flatMap((m) => m.content.filter((c) => c.type === 'tool')),
  );
  for (const name of ['ask_subagent', 'forward_question', 'reply_request', 'subagent_status'])
    assert.ok(
      toolCalls.some((c) => c.name === name && c.state.status === 'completed'),
      `${name} must run on real host`,
    );
  for (const tool of toolCalls.filter((c) =>
    ['ask_subagent', 'reply_request', 'forward_question', 'subagent_status'].includes(c.name),
  )) {
    assert.equal(
      JSON.parse(tool.state.content.find((c) => c.type === 'text').text).ok,
      true,
      `${tool.name} must return successful JSON`,
    );
  }
  const failures = toolCalls.filter((c) => c.state.status === 'error');
  assert.deepEqual(failures, []);
  const d = all.find((s) => s.messages.some((m) => m.type === 'user' && m.text.includes('ROLE=D')));
  assert.ok(d);
  const dTools = d.messages
    .filter((m) => m.type === 'assistant')
    .flatMap((m) => m.content.filter((c) => c.type === 'tool'))
    .map((c) => c.name);
  assert.ok(
    dTools.indexOf('mailbox_test_work', dTools.indexOf('reply_request') + 1) >
      dTools.indexOf('reply_request'),
    'D must continue after replying',
  );
  assert.deepEqual(errors, []);
  // Simulate a persisted outbox left behind by process exit, then let the real host recover it.
  const idle = await client.session.create({
    parentID: session.id,
    location: { directory: root },
    title: 'Idle recovery recipient',
  });
  stages.set('IDLE_RECOVERY_CHILD', 0);
  await client.session.prompt({
    sessionID: idle.id,
    text: 'ROLE=IDLE_RECOVERY_CHILD. Complete setup and wait for recovered mailbox delivery.',
  });
  await client.experimental.session.wait({ sessionID: idle.id }, { signal: AbortSignal.timeout(15000) });
  assert.equal(isIdle(await client.session.get({ sessionID: idle.id })), true);
  assert.ok(
    (await client.session.context({ sessionID: idle.id })).some((item) =>
      JSON.stringify(item).includes('MAILBOX_RECOVERY_IDLE_SETUP_COMPLETE'),
    ),
  );
  child.kill();
  await once(child, 'exit');
  const { SqliteRepository } = await import(pathToFileURL(join(packagePath, 'dist/adapters/sqlite.js')).href);
  const { Mailbox } = await import(pathToFileURL(join(packagePath, 'dist/application/mailbox.js')).href);
  const projectHash = createHash('sha256').update(session.projectID).digest('hex');
  const databasePath = join(temp, 'mailbox', projectHash, 'mailbox.db');
  const database = createClient({ url: pathToFileURL(databasePath).href });
  const records = (await database.execute('SELECT body FROM requests')).rows.map((row) =>
    JSON.parse(String(row.body)),
  );
  database.close();
  const notificationRecord = records.find((request) => request.id === notificationRequestID);
  assert.equal(notificationRecord?.requiresReply, false);
  assert.equal(
    notificationRecord?.state,
    'notified',
    'Informational requests must not remain pending for a reply',
  );
  assert.ok(
    notificationRecord?.outbox.some((item) => item.kind === 'notification' && item.state === 'admitted'),
  );
  const idleNotificationRecord = records.find((request) => request.id === idleNotificationCase.requestID);
  assert.equal(idleNotificationRecord?.state, 'notified');
  assert.ok(
    idleNotificationRecord?.outbox.some((item) => item.kind === 'notification' && item.state === 'admitted'),
  );
  const idleQuestionRecord = records.find((request) => request.id === idleQuestionCase.requestID);
  assert.equal(idleQuestionRecord?.state, 'answered');
  assert.ok(idleQuestionRecord?.outbox.some((item) => item.kind === 'answer' && item.state === 'admitted'));
  assert.ok(
    records.some(
      (request) =>
        request.id === accepted4000.requestID &&
        request.question === message4000 &&
        request.outbox.some((item) => item.text === message4000),
    ),
    'The full 4000-code-point message must be present in the durable request and outbox',
  );
  assert.equal(
    records.some(
      (request) =>
        request.question === message4001 || request.outbox.some((item) => item.text === message4001),
    ),
    false,
    'Rejected 4001-code-point message must leave no request or outbox entry',
  );
  const recoveryRepo = await SqliteRepository.open(databasePath);
  const recoveryMailbox = new Mailbox(recoveryRepo, {
    get: async (id) => {
      const info = id === session.id ? session : idle;
      return {
        id: info.id,
        parentID: info.parentID,
        projectID: info.projectID,
        title: info.title,
        archived: false,
      };
    },
    admit: async () => {
      throw new Error('Server is stopped');
    },
  });
  const recovered = await recoveryMailbox.ask(session.id, idle.id, 'RECOVER_AFTER_RESTART');
  const orphanSessionID = `ses_${randomUUID().replaceAll('-', '')}`;
  const orphanMailbox = new Mailbox(recoveryRepo, {
    get: async (id) => ({
      id,
      projectID: session.projectID,
      title: 'Offline deletion fixture',
      archived: false,
      ...(id === session.id ? {} : { parentID: session.id }),
    }),
    admit: async () => {
      throw new Error('Server is stopped');
    },
  });
  const orphan = await orphanMailbox.ask(session.id, orphanSessionID, 'REMOVE_MISSED_DELETION_ON_STARTUP');
  await recoveryRepo.close();
  client = await startHost();
  await client
    .rpc(MailboxControl)
    .pendingQuestions({ sessionID: idle.id }, { location: { directory: root } });
  const reconciledDatabase = createClient({ url: pathToFileURL(databasePath).href });
  try {
    await waitUntil(
      'Startup must purge a missed-deletion record before dispatching outboxes',
      async () =>
        Number(
          (
            await reconciledDatabase.execute({
              sql: 'SELECT COUNT(*) AS n FROM requests WHERE id=?',
              args: [orphan.requestID],
            })
          ).rows[0].n,
        ) === 0,
    );
  } finally {
    reconciledDatabase.close();
  }
  const entry = await waitForMailboxItem(idle.id, recovered.requestID);
  await client.experimental.session.wait({ sessionID: idle.id }, { signal: AbortSignal.timeout(15000) });
  assert.equal(
    stages.get('IDLE_RECOVERY_CHILD'),
    2,
    'The recovered direct-child question must resume its recipient',
  );
  assert.ok(
    (await client.session.context({ sessionID: idle.id })).some((item) =>
      JSON.stringify(item).includes(`MAILBOX_RECOVERY_QUESTION_READ:RECOVER_AFTER_RESTART`),
    ),
  );
  assert.equal(traces.filter((trace) => trace.role === 'IDLE_RECOVERY_CHILD').length, 2);
  await client.session.synthetic({
    sessionID: idle.id,
    id: entry.id,
    text: 'Retry payload must be ignored',
    delivery: 'steer',
    resume: false,
  });
  const recoveryContext = await client.session.context({ sessionID: idle.id });
  assert.equal(
    recoveryContext.filter(
      (item) => item.type === 'synthetic' && item.metadata?.agentMailbox?.requestID === recovered.requestID,
    ).length,
    1,
    'Actual host must deduplicate the recovered message ID',
  );
  assert.equal(
    recoveryContext.filter((m) => m.type === 'assistant').length,
    2,
    'The native setup and one mailbox-resumed execution must remain distinct',
  );
  assert.equal(traces.filter((trace) => trace.role === 'IDLE_RECOVERY_CHILD').length, 2);
  const report = {
    opencode: execFileSync(resolve('node_modules/.bin/opencode'), ['--version'], { encoding: 'utf8' }).trim(),
    sessions: all.length,
    mailboxAnswers: answers.length,
    restartRecovery: true,
    idleDirectChildQuestionWake: true,
    idleDirectChildNotificationWake: true,
    idleSiblingQuestionWakeWithBidirectional: true,
    idleSiblingNotificationWakeWithBidirectional: true,
    idleAnswerOriginWokenByTrue: wakeAnswerTrue.requestWake,
    idleAnswerOriginStaysIdleByFalse: !wakeAnswerFalse.requestWake,
    activeRetryDoesNotDuplicateRuns: true,
    recoveredIdleChildWoken: true,
    hostDeduplication: true,
    userControlledBidirectional: true,
    rpcSessionLocationIsolation: true,
    sessionDeletionPurgesMailboxData: true,
    startupReconcilesMissingSessions: true,
    sessionToggleWithoutArguments: true,
    complete4000CharacterQuestionsAndAnswers: true,
    rejected4001CharacterQuestionsAndAnswers: true,
    informationalNotificationSettled: true,
    idleSenderWokenByReply: wakeAnswerTrue.requestWake,
    perRequestWakeOverridesTree: true,
    perRequestNoWakeOverridesDefault: true,
    nativeBackgroundCalls: toolCalls.filter((c) => c.name === 'subagent' && c.state.input.background === true)
      .length,
    model: 'deterministic local OpenAI-compatible provider; no external credentials',
    passed: true,
  };
  await writeFile(join(temp, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(
    join(temp, 'failure.log'),
    logs.replaceAll(password, '<redacted>') + '\n' + JSON.stringify(traces, null, 2),
  );
  console.error(`E2E diagnostics: ${temp}`);
  throw error;
} finally {
  for (const gate of gates.values()) gate.release();
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([once(child, 'exit'), delay(5000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  provider.close();
}
