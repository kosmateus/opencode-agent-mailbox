import { execFileSync } from 'node:child_process';
import { analyzeCommits } from './release-policy.mjs';
// Offline analysis only: no authentication, mutation, tags, GitHub calls or publication.
const from = process.argv[2];
const range = from ? `${from}..HEAD` : 'HEAD';
const messages = execFileSync('git', ['log', range, '--format=%B%x00'], { encoding: 'utf8' })
  .split('\0')
  .map((s) => s.trim())
  .filter(Boolean);
const type = await analyzeCommits(
  {},
  { cwd: process.cwd(), commits: messages.map((message) => ({ message })), logger: { log: () => {} } },
);
console.log(JSON.stringify({ releaseType: type, commits: messages.length, publishing: false }, null, 2));
