import { readFile } from 'node:fs/promises';
import { it, expect } from 'vitest';
import { analyzeCommits } from '@semantic-release/commit-analyzer';
import releaseConfig from '../release.config.js';
const logger = { log: () => {} };

it('publishes without pushing a release commit to the protected branch', () => {
  const pluginNames = releaseConfig.plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
  expect(pluginNames).not.toContain('@semantic-release/git');
  expect(pluginNames).toContain('@semantic-release/npm');
  expect(pluginNames).toContain('@semantic-release/github');
  expect(
    releaseConfig.plugins.find(
      (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/npm',
    )?.[1],
  ).toMatchObject({ npmPublish: true, tarballDir: 'release-artifacts' });
});

it('builds the package before npm creates the release tarball', () => {
  const pluginNames = releaseConfig.plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
  const execIndex = pluginNames.indexOf('@semantic-release/exec');
  const npmIndex = pluginNames.indexOf('@semantic-release/npm');
  const execPlugin = releaseConfig.plugins[execIndex];
  const npmPlugin = releaseConfig.plugins[npmIndex];
  const githubPlugin = releaseConfig.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/github',
  );

  expect(execIndex).toBeGreaterThan(-1);
  expect(execIndex).toBeLessThan(npmIndex);
  expect(execPlugin).toMatchObject([
    '@semantic-release/exec',
    { prepareCmd: expect.stringContaining('npm run build') },
  ]);
  expect(execPlugin?.[1]).toMatchObject({
    prepareCmd: expect.stringContaining('npm run pack:check'),
  });
  expect(githubPlugin?.[1].assets[0].path).toBe(`${npmPlugin?.[1].tarballDir}/*.tgz`);
});

it('runs releases only for pushes or manual dispatches on the upstream default branch', async () => {
  const workflow = (
    await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  ).replaceAll('\r\n', '\n');

  expect(workflow).toContain('  push:\n    branches:\n      - main\n');
  expect(workflow).toContain('  workflow_dispatch:');
  expect(workflow).not.toMatch(/^  pull_request:/m);
  expect(workflow.match(/github\.repository == 'kosmateus\/opencode-agent-mailbox'/g)).toHaveLength(2);
  expect(workflow.match(/github\.ref_name == github\.event\.repository\.default_branch/g)).toHaveLength(2);
});

it.each([
  ['fix: repair routing', 'patch'],
  ['feat: add routing', 'minor'],
  ['feat!: change API', 'major'],
  ['fix: api\n\nBREAKING CHANGE: remove old input', 'major'],
])('versions %s as %s', async (message, expected) => {
  expect(
    await analyzeCommits(
      { preset: 'conventionalcommits' },
      { cwd: process.cwd(), commits: [{ message }], logger },
    ),
  ).toBe(expected);
});

import { analyzeCommits as policy } from '../scripts/release-policy.mjs';
it.each(['docs: clarify installation', 'chore: update dependencies', 'plain maintenance commit'])(
  'falls back to PATCH for %s',
  async (message) => {
    expect(await policy({}, { cwd: process.cwd(), commits: [{ message }], logger })).toBe('patch');
  },
);
it('does not release an empty commit range', async () => {
  expect(await policy({}, { cwd: process.cwd(), commits: [], logger })).toBeNull();
});
