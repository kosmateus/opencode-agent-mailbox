import { analyzeCommits as conventional } from '@semantic-release/commit-analyzer';

const releaseRank = {
  patch: 1,
  minor: 2,
  major: 3,
};

export async function analyzeCommits(_config, context) {
  const requested = process.env.RELEASE_TYPE || 'auto';

  if (requested !== 'auto' && !(requested in releaseRank)) {
    throw new Error(`Invalid RELEASE_TYPE "${requested}". Use auto, patch, minor or major.`);
  }

  const detected = await conventional({ preset: 'conventionalcommits' }, context);

  if (requested === 'auto') {
    return detected ?? (context.commits.length > 0 ? 'patch' : null);
  }

  if (!detected) {
    return requested;
  }

  return releaseRank[requested] >= releaseRank[detected] ? requested : detected;
}