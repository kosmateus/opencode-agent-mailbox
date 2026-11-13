import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(number) {
  const origin = `fixture-origin-${number}`;
  const holder = `fixture-holder-${number}`;
  return {
    version: 1,
    id: `req_${number.toString(16).padStart(64, '0')}`,
    origin,
    holder,
    question: '0',
    route: [origin, holder],
    createdAt: number,
    expiresAt: 9999999999999,
    requiresReply: true,
    state: 'pending',
    outbox: [],
  };
}

async function repository(root) {
  return (await import(pathToFileURL(join(root, 'dist/adapters/sqlite.js')).href)).SqliteRepository;
}

export async function writeLane(root, database, lane, allowBusy = false) {
  const Repository = await repository(root);
  let repo = await Repository.open(database);
  const acknowledged = [];
  let updates = 0;
  let rejected = 0;
  const attempt = async (operation) => {
    try {
      await operation();
      return true;
    } catch (error) {
      // Cross-process contention may explicitly reject work. Never count it as
      // accepted, retry it in the harness, or reopen to hide a poisoned client.
      if (!allowBusy || error.code !== 'SQLITE_BUSY') throw error;
      rejected++;
      return false;
    }
  };
  try {
    for (let j = 1; j <= 20; j++) {
      const data = request(lane * 20 + j);
      if (await attempt(() => repo.update(data.id, () => ({ request: data, result: undefined }))))
        acknowledged.push(data.id);
      if (
        await attempt(() =>
          repo.update(request(0).id, (current) => ({
            request: { ...current, question: String(Number(current.question) + 1) },
            result: undefined,
          })),
        )
      )
        updates++;
      await repo.sessionIDs();
      if (rejected) break;
      if (!allowBusy && j % 5 === 0) {
        await repo.close();
        repo = await Repository.open(database);
      }
    }
  } finally {
    await repo.close();
  }
  return { acknowledged, updates, rejected };
}

async function child(runtime, args) {
  const process = spawn(runtime, [resolve('scripts/sqlite-integrity.mjs'), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  process.stdout.on('data', (data) => (output += data));
  process.stderr.on('data', (data) => (output += data));
  const [code] = await once(process, 'exit');
  assert.equal(code, 0, output);
  return output;
}

async function embedded(roots, temp) {
  const project = join(temp, 'project');
  const plugin = join(temp, 'probe');
  const resultFile = join(temp, 'embedded-result.json');
  await mkdir(project);
  await mkdir(plugin);
  execFileSync('git', ['init', '--quiet', project]);
  await writeFile(
    join(plugin, 'package.json'),
    JSON.stringify({ name: 'sqlite-probe', type: 'module', exports: './index.js' }),
  );
  await writeFile(
    join(plugin, 'index.js'),
    `
import {writeFile} from 'node:fs/promises';
import {runCase} from ${JSON.stringify(import.meta.url)};
export default {id:'sqlite-probe', async setup() {
  try {
    const result = await runCase(${JSON.stringify(roots)}, ${JSON.stringify(join(temp, 'embedded.db'))});
    await writeFile(${JSON.stringify(resultFile)}, JSON.stringify({runtime:process.versions.bun,...result}));
  } catch(error) {
    await writeFile(${JSON.stringify(resultFile)}, JSON.stringify({error:String(error)}));
    throw error;
  }
}};`,
  );
  await writeFile(join(project, 'opencode.json'), JSON.stringify({ update: 'disable', plugins: [plugin] }));
  const password = randomUUID();
  const env = { ...process.env, OPENCODE_PASSWORD: password, OPENCODE_DB: join(temp, 'opencode.db') };
  for (const kind of ['CONFIG', 'DATA', 'STATE', 'CACHE'])
    env[`XDG_${kind}_HOME`] = join(temp, kind.toLowerCase());
  const server = spawn(
    resolve('node_modules/.bin/opencode'),
    ['serve', '--hostname', '127.0.0.1', '--port', '0'],
    {
      cwd: project,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let logs = '';
  server.stdout.on('data', (data) => (logs += data));
  server.stderr.on('data', (data) => (logs += data));
  try {
    const deadline = Date.now() + 60000;
    let url;
    while (Date.now() < deadline) {
      url = logs.match(/server listening on (http:\/\/[^\s]+)/)?.[1];
      if (url) break;
      assert.equal(server.exitCode, null, `private server exited: ${logs}`);
      await delay(50);
    }
    assert.ok(url, 'private server did not start');
    const response = await fetch(`${url}/api/agent?directory=${encodeURIComponent(project)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
      signal: AbortSignal.timeout(60000),
    });
    assert.ok(response.ok, 'private plugin setup request failed');
    await response.arrayBuffer();
    const result = JSON.parse(await readFile(resultFile, 'utf8'));
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.retained, 61);
    console.log(JSON.stringify({ mode: 'embedded-copies', ...result }));
  } finally {
    if (server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      await exited;
    }
  }
}

export async function runCase(roots, database, runtime) {
  const Repository = await repository(roots[0]);
  const seed = await Repository.open(database);
  await seed.update(request(0).id, () => ({ request: request(0), result: undefined }));
  await seed.close();
  // Every acknowledged insertion has a distinct ID; the shared row also checks
  // atomic read/modify/write, not merely the final number of rows.
  assert.equal(new Set(Array.from({ length: 61 }, (_, i) => request(i).id)).size, 61);
  const lanes = await Promise.all(
    roots.map((root, lane) =>
      runtime
        ? child(runtime, ['--lane', root, database, String(lane)]).then(JSON.parse)
        : writeLane(root, database, lane),
    ),
  );
  const acknowledged = lanes.flatMap((lane) => lane.acknowledged);
  const updates = lanes.reduce((sum, lane) => sum + lane.updates, 0);
  const rejected = lanes.reduce((sum, lane) => sum + lane.rejected, 0);
  assert.ok(acknowledged.length > 0);
  for (const root of roots) {
    const Reader = await repository(root);
    const repo = await Reader.open(database);
    try {
      const rows = await repo.active();
      assert.equal(rows.length, acknowledged.length + 1, 'acknowledged records must survive close/reopen');
      assert.equal((await repo.sessionIDs()).length, (acknowledged.length + 1) * 2);
      assert.equal((await repo.get(request(0).id)).question, String(updates), 'updates must be atomic');
      for (const id of acknowledged) assert.ok(await repo.get(id));
    } finally {
      await repo.close();
    }
  }
  if (!runtime) {
    assert.equal(acknowledged.length, 60);
    assert.equal(updates, 60);
    assert.equal(rejected, 0);
  }
  const { createClient } = await import(
    pathToFileURL(join(roots[0], 'node_modules/@libsql/client/lib-esm/node.js')).href
  );
  const check = createClient({ url: pathToFileURL(database).href });
  try {
    assert.equal((await check.execute('PRAGMA integrity_check')).rows[0].integrity_check, 'ok');
  } finally {
    check.close();
  }
  return { retained: acknowledged.length + 1, atomicUpdates: updates, rejected, integrity: 'ok' };
}

async function main() {
  const temp = await mkdtemp(resolve('.e2e/sqlite-'));
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', temp], { encoding: 'utf8' }),
  );
  const roots = [];
  for (let i = 0; i < 3; i++) {
    const root = join(temp, `copy-${i}`);
    roots.push(root);
    await mkdir(root);
    execFileSync('tar', ['-xzf', join(temp, packed[0].filename), '-C', root, '--strip-components=1']);
    const modules = join(root, 'node_modules');
    await mkdir(modules);
    for (const name of await readdir('node_modules')) {
      if (name === '.bin') continue;
      if (name === '@libsql') {
        await mkdir(join(modules, name));
        for (const item of await readdir(join('node_modules', name))) {
          // Physical native copies, not symlinks: identical binaries at distinct
          // paths were the failing production cache topology.
          await cp(resolve('node_modules', name, item), join(modules, name, item), { recursive: true });
        }
      } else if (name === 'libsql') {
        await cp(resolve('node_modules', name), join(modules, name), { recursive: true });
      } else await symlink(resolve('node_modules', name), join(modules, name), 'dir');
    }
  }
  await writeFile(join(temp, 'roots.json'), JSON.stringify(roots));
  for (const runtime of ['node', ...(process.env.SQLITE_TEST_BUN ? [process.env.SQLITE_TEST_BUN] : [])]) {
    for (const mode of ['--copies', '--processes']) {
      const database = join(temp, `${runtime.split('/').at(-1)}-${mode.slice(2)}.db`);
      const output = await child(runtime, [mode, join(temp, 'roots.json'), database]);
      console.log(output.trim());
    }
  }
  await embedded(roots, temp);
  console.log(`SQLite fixture directory: ${temp}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, rootsFile, database, lane] = process.argv.slice(2);
  if (mode === '--lane')
    console.log(JSON.stringify(await writeLane(rootsFile, database, Number(lane), true)));
  else if (mode === '--copies' || mode === '--processes') {
    const roots = JSON.parse(await readFile(rootsFile, 'utf8'));
    const result = await runCase(roots, database, mode === '--processes' ? process.execPath : undefined);
    console.log(JSON.stringify({ runtime: process.versions.bun ?? process.versions.node, mode, ...result }));
  } else {
    await mkdir('.e2e', { recursive: true });
    await main();
  }
}
