import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { OpenCode } from '@opencode/client';
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
const traces = [];
const errors = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const role = textOf(user?.content ?? '').match(/ROLE=([A-Z0-9]+)/)?.[1];
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
  const recoveryRepo = await SqliteRepository.open(join(temp, 'mailbox', projectHash, 'mailbox.db'));
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
