import { analyzeCommits as conventional } from '@semantic-release/commit-analyzer';
/** Preserve Conventional Commits precedence; release other real changes as PATCH. */
export async function analyzeCommits(_config, context) {
  return (
    (await conventional({ preset: 'conventionalcommits' }, context)) ??
    (context.commits.length ? 'patch' : null)
  );
}
