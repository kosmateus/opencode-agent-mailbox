import { it, expect } from 'vitest';
import { analyzeCommits } from '@semantic-release/commit-analyzer';
const logger = { log: () => {} };
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
