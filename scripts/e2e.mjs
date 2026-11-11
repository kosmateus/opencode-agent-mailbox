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
const traces = [];
const errors = [];
const WAKE_ANSWER_TAIL = 'MAILBOX_WAKE_ANSWER_END';
let wakeOriginAnswerReads = 0;
let wakeAnswerTailRead = false;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const isIdle = ({ time }) => time.busy === undefined || (time.idle !== undefined && time.idle >= time.busy);
const textOf = (content) => (typeof content === 'string' ? content : JSON.stringify(content));
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
  if (role === 'WAKE_ORIGIN' || role === 'WAKE_SILENT_ORIGIN') {
    if (stage === 0) {
      stages.set(role, 1);
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
    if (stage === 1) {
      stages.set(role, 2);
      return { text: 'Origin run finished while its answer was pending.' };
    }
    if (synthetic.includes('"kind":"answer"') || /"kind"\s*:\s*"answer"/.test(synthetic)) {
      wakeOriginAnswerReads++;
      wakeAnswerTailRead = synthetic.includes(WAKE_ANSWER_TAIL);
      stages.set(role, 3);
      return { text: `Read answer ending ${WAKE_ANSWER_TAIL}.` };
    }
    return { text: 'Origin is idle until its answer arrives.' };
  }
  if (role === 'WAKE_RECIPIENT' || role === 'WAKE_SILENT_RECIPIENT') {
    if (stage < 2 && requestID) {
      stages.set(role, stage + 1);
      return {
        tools: [
          call('reply_request', {
            requestID,
            message: `${'x'.repeat((stage === 0 ? 4001 : 4000) - WAKE_ANSWER_TAIL.length)}${WAKE_ANSWER_TAIL}`,
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
    `import { Plugin } from '@opencode/plugin';\nexport default Plugin.define({id:'mailbox-test-fixture',async setup(ctx){await ctx.tool.transform(e=>e.add({name:'mailbox_test_work',options:{codemode:false},description:'Deterministic test work',input:{type:'object',properties:{ms:{type:'number'}},required:['ms'],additionalProperties:false},execute:async(input)=>{await new Promise(r=>setTimeout(r,input.ms));return {content:'work checkpoint'};}}));}});`,
  );
  const config = {
    experimental: { subagent_depth: 4 },
    update: 'disable',
    model: 'mailtest/model',
    plugins: [{ package: packagePath, options: { dataDirectory: join(temp, 'mailbox'), pollMs: 100 } }],
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
  const modeSibling = await client.session.create({
    parentID: modeRoot.id,
    location: { directory: root },
    title: 'Mailbox mode sibling',
  });
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
  const waitForInbox = async (sessionID) => {
    const inboxDeadline = Date.now() + 10000;
    let inbox = [];
    while (Date.now() < inboxDeadline) {
      inbox = await client.session.inbox.list({ sessionID });
      if (inbox.length) return inbox;
      await delay(100);
    }
    return inbox;
  };
  const { result: defaultModeResult, senderID: defaultModeSender } = await runModeRequest(
    'MODE_DEFAULT',
    modeSibling.id,
  );
  assert.equal(defaultModeResult.ok, false, 'Bidirectional mode must be off by default');
  assert.equal(defaultModeResult.error.code, 'FORBIDDEN');
  const modeOn = await client
    .rpc(MailboxControl)
    .setBidirectional({ sessionID: defaultModeSender }, { location: { directory: root } });
  assert.deepEqual(modeOn, { rootSessionID: modeRoot.id, enabled: true });
  const treeWakeOff = await client
    .rpc(MailboxControl)
    .setWakeOnReply({ sessionID: defaultModeSender, enabled: false }, { location: { directory: root } });
  assert.deepEqual(treeWakeOff, { rootSessionID: modeRoot.id, enabled: false });
  const { result: siblingModeResult } = await runModeRequest('MODE_SIBLING', modeSibling.id);
  assert.equal(siblingModeResult.ok, true, 'User-enabled mode must allow sibling questions');
  const siblingInbox = await waitForInbox(modeSibling.id);
  assert.equal(siblingInbox.length, 1);
  assert.equal((await client.session.get({ sessionID: modeSibling.id })).time.busy, undefined);

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
  const acceptedInbox = await waitForInbox(longRecipient.id);
  const acceptedPayload = JSON.parse(acceptedInbox[0].payload.text);
  assert.equal(acceptedPayload.requestID, accepted4000.requestID);
  assert.equal(acceptedPayload.message, message4000);
  assert.ok(
    acceptedPayload.message.endsWith(longTail),
    'The complete message ending must reach the recipient',
  );
  assert.equal((await client.session.get({ sessionID: longRecipient.id })).time.busy, undefined);
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
  const notificationInbox = await waitForInbox(notificationRecipient.id);
  assert.equal(notificationInbox[0].payload.metadata.agentMailbox.kind, 'notification');
  assert.equal((await client.session.get({ sessionID: notificationRecipient.id })).time.busy, undefined);
  const notificationRequestID = notificationResult.requestID;

  const wakeOrigin = await client.session.create({
    location: { directory: root },
    title: 'Idle answer origin',
    permissions: [{ action: '*', resource: '*', effect: 'allow' }],
  });
  const wakeRecipient = await client.session.create({
    parentID: wakeOrigin.id,
    location: { directory: root },
    title: 'Question recipient',
    permissions: [{ action: '*', resource: '*', effect: 'allow' }],
  });
  const wakeTreeOff = await client
    .rpc(MailboxControl)
    .setWakeOnReply({ sessionID: wakeOrigin.id, enabled: false }, { location: { directory: root } });
  assert.deepEqual(wakeTreeOff, { rootSessionID: wakeOrigin.id, enabled: false });
  modeTargets.set('WAKE_ORIGIN', wakeRecipient.id);
  stages.set('WAKE_ORIGIN', 0);
  await client.session.prompt({ sessionID: wakeOrigin.id, text: 'ROLE=WAKE_ORIGIN. Ask and then finish.' });
  await client.experimental.session.wait(
    { sessionID: wakeOrigin.id },
    { signal: AbortSignal.timeout(15000) },
  );
  const wakeQuestionInbox = await waitForInbox(wakeRecipient.id);
  assert.equal(wakeQuestionInbox[0].payload.metadata.agentMailbox.kind, 'question');
  assert.equal((await client.session.get({ sessionID: wakeRecipient.id })).time.busy, undefined);
  await waitUntil(
    'The original run must finish before testing reply wake-up',
    async () =>
      stages.get('WAKE_ORIGIN') === 2 && isIdle(await client.session.get({ sessionID: wakeOrigin.id })),
  );
  assert.equal(isIdle(await client.session.get({ sessionID: wakeOrigin.id })), true);

  stages.set('WAKE_RECIPIENT', 0);
  await client.session.prompt({
    sessionID: wakeRecipient.id,
    text: 'ROLE=WAKE_RECIPIENT. Answer the question.',
  });
  await client.experimental.session.wait(
    { sessionID: wakeRecipient.id },
    { signal: AbortSignal.timeout(15000) },
  );
  await client.experimental.session.wait(
    { sessionID: wakeOrigin.id },
    { signal: AbortSignal.timeout(15000) },
  );
  await waitUntil(
    'The idle origin must consume its answer and finish',
    async () => wakeOriginAnswerReads === 1 && isIdle(await client.session.get({ sessionID: wakeOrigin.id })),
  );
  assert.equal(wakeOriginAnswerReads, 1, 'The answer must wake the idle sender exactly once');
  assert.equal(wakeAnswerTailRead, true, 'The resumed sender must read the answer ending');
  const wakeOriginContext = await client.session.context({ sessionID: wakeOrigin.id });
  const wakeAnswers = wakeOriginContext.filter(
    (item) => item.type === 'synthetic' && item.metadata?.agentMailbox?.kind === 'answer',
  );
  assert.equal(wakeAnswers.length, 1, 'The answer must be admitted once to the sender transcript');
  assert.ok(wakeAnswers[0].text.includes(WAKE_ANSWER_TAIL));
  assert.equal([...JSON.parse(wakeAnswers[0].text).message].length, 4000);
  const recipientContext = await client.session.context({ sessionID: wakeRecipient.id });
  const replyResults = recipientContext
    .filter((item) => item.type === 'assistant')
    .flatMap((item) => item.content.filter((part) => part.type === 'tool' && part.name === 'reply_request'))
    .map((item) => JSON.parse(item.state.content.find((part) => part.type === 'text').text));
  assert.equal(replyResults[0].error.code, 'INVALID_INPUT', '4001-character replies must fail');
  assert.equal(replyResults[1].ok, true, '4000-character replies must succeed');
  assert.equal(isIdle(await client.session.get({ sessionID: wakeOrigin.id })), true);

  const silentOrigin = await client.session.create({
    location: { directory: root },
    title: 'Silent answer origin',
    permissions: [{ action: '*', resource: '*', effect: 'allow' }],
  });
  const silentRecipient = await client.session.create({
    parentID: silentOrigin.id,
    location: { directory: root },
    title: 'Silent answer recipient',
    permissions: [{ action: '*', resource: '*', effect: 'allow' }],
  });
  modeTargets.set('WAKE_SILENT_ORIGIN', silentRecipient.id);
  await client.session.prompt({
    sessionID: silentOrigin.id,
    text: 'ROLE=WAKE_SILENT_ORIGIN. Ask without wake-up.',
  });
  await waitUntil(
    'Silent origin must finish its question run',
    async () =>
      stages.get('WAKE_SILENT_ORIGIN') === 2 &&
      isIdle(await client.session.get({ sessionID: silentOrigin.id })),
  );
  await waitForInbox(silentRecipient.id);
  await client.session.prompt({ sessionID: silentRecipient.id, text: 'ROLE=WAKE_SILENT_RECIPIENT. Answer.' });
  const silentAnswers = await waitForInbox(silentOrigin.id);
  assert.equal(silentAnswers[0].payload.metadata.agentMailbox.kind, 'answer');
  assert.ok(JSON.parse(silentAnswers[0].payload.text).message.endsWith(WAKE_ANSWER_TAIL));
  await delay(300);
  assert.equal(
    stages.get('WAKE_SILENT_ORIGIN'),
    2,
    'Explicit false must override the default wake-on-reply true',
  );
  assert.equal(isIdle(await client.session.get({ sessionID: silentOrigin.id })), true);

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
  recoveryRepo.close();
  client = await startHost();
  await client.plugin.list({ location: { directory: root } });
  let inbox = [];
  const recoveryDeadline = Date.now() + 10000;
  while (Date.now() < recoveryDeadline) {
    inbox = await client.session.inbox.list({ sessionID: idle.id });
    if (inbox.length) break;
    await delay(100);
  }
  assert.equal(inbox.length, 1, 'Restart must recover one pending mailbox entry');
  const entry = inbox[0];
  assert.equal(entry.payload.metadata.agentMailbox.requestID, recovered.requestID);
  await client.session.synthetic({
    sessionID: idle.id,
    id: entry.id,
    text: 'Retry payload must be ignored',
    delivery: 'steer',
    resume: false,
  });
  assert.equal(
    (await client.session.inbox.list({ sessionID: idle.id })).length,
    1,
    'Actual host must deduplicate',
  );
  assert.equal(
    (await client.session.get({ sessionID: idle.id })).time.busy,
    undefined,
    'Idle session must not wake',
  );
  assert.equal(
    (await client.session.context({ sessionID: idle.id })).filter((m) => m.type === 'assistant').length,
    0,
  );
  const report = {
    opencode: execFileSync(resolve('node_modules/.bin/opencode'), ['--version'], { encoding: 'utf8' }).trim(),
    sessions: all.length,
    mailboxAnswers: answers.length,
    restartRecovery: true,
    idleNotWoken: true,
    hostDeduplication: true,
    userControlledBidirectional: true,
    sessionToggleWithoutArguments: true,
    complete4000CharacterQuestionsAndAnswers: true,
    rejected4001CharacterQuestionsAndAnswers: true,
    informationalNotificationSettled: true,
    idleSenderWokenByReply: true,
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
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([once(child, 'exit'), delay(5000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  provider.close();
}
