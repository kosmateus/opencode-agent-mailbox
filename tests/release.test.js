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
