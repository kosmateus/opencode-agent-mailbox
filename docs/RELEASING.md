# Owner setup and releases

The README is for plugin users. These instructions are for the maintainer.

## One-time setup

1. Choose an available npm name. A scoped public package such as `@your-npm-user/opencode-agent-mailbox` avoids unscoped name collisions. Create an empty **public** GitHub repository; do not initialize another README/license there.
2. Run `node scripts/configure-release.mjs OWNER/REPOSITORY @YOUR_NPM_USER/opencode-agent-mailbox`. It updates package metadata and lockfile names. Update README/example installation commands if you change the default name. The repository URL must match the actual GitHub repository for npm provenance.
3. Run `npm ci && npm run check && npm run test:e2e`.
4. Initialize the repository and push:

   ```sh
   git init -b main
   git add .
   git commit -m "feat: add asynchronous agent mailbox"
   git remote add origin https://github.com/OWNER/REPOSITORY.git
   git push -u origin main
   ```

5. A new package needs a bootstrap publication before its package settings can be configured. Log in locally with an npm account permitted to publish the chosen name, with 2FA. From the checked working tree run:

   ```sh
   npm login
   npm publish --access public --tag bootstrap
   ```

   This publishes development version `0.0.0` on the `bootstrap` tag. No npm token is placed in GitHub. Do not publish a future semantic-release version manually. For an existing package, reconcile its existing release tags/version history instead of bootstrapping it again.

6. In npmjs.com, open the package's **Settings -> Trusted publishing -> GitHub Actions**. Enter the exact GitHub owner, repository and workflow filename `release.yml`. Leave environment blank (the supplied workflow has no deployment environment). Enable **Allow npm publish**; stage-only publishing does not satisfy fully automatic releases. For later dist-tag management, enable **Allow npm dist-tag** as well. Complete the first automated publish within the validity window shown by npm; current documentation gives a new publisher two days before expiry.
7. In GitHub, enable Actions and permit the release job's `contents: write` and `id-token: write`. `GITHUB_TOKEN` is built in; do not create `NPM_TOKEN` or `NODE_AUTH_TOKEN`. The workflow uses GitHub-hosted runners. Branch protection can require the `verify` CI job and PR reviews. The release workflow does not push version commits to main/master and needs no branch-protection bypass. Tag/notes rules must permit the workflow to create `v*` tags and semantic-release notes. If organization policy disallows these writes, grant the workflow the narrow tag/notes permission in the applicable ruleset.
8. Run **Actions -> Release -> Run workflow** on the default branch. An initial push before npm setup may have failed authentication; rerun only after setup. The first semantic-release release is normally `1.0.0` because there is no previous release tag.

After successful OIDC publication you may select npm's "Require two-factor authentication and disallow tokens" option. Do not enable stage-only publishing unless you intentionally want manual approval of every release.

## Automatic releases

Every merged non-Dependabot PR to the default branch (or manual Release dispatch) runs reproducible `npm ci`, typecheck, lint, tests, build, package inspection and real-host E2E. Only then semantic-release evaluates commits since the last reachable release tag:

- breaking change (`!` or `BREAKING CHANGE`) -> MAJOR;
- `feat` -> MINOR;
- `fix` -> PATCH;
- other nonempty changes -> PATCH;
- no new commits -> no release.

The default branch is resolved from GitHub; a repository containing both main and master does not run two release lines. A global release concurrency group prevents overlapping publication jobs. No version commits are pushed, so the workflow cannot loop on its own commits.

`@semantic-release/npm` synchronizes package.json and package-lock.json in the **release workspace and published tarball**. The main branch retains its checked-in baseline version; Git tags are the authoritative release history. This commit-free approach preserves branch protection. A tag's GitHub-generated source archive therefore retains the baseline manifest version; use the attached npm tarball for the versioned, built distribution. Do not expect a bot version commit on main.

The workflow creates a Git tag and GitHub Release with the npm tarball. npm OIDC automatically supplies provenance for a public repository and public package. Publication is immutable; a registry check rejects an already published candidate version. The workflow needs no issue/PR write permission because semantic-release comments and release labels are disabled.

## Local checks and failure recovery

`npm run release:plan -- v1.0.0` performs offline version-bump analysis; `npm run release:dry` performs semantic-release's authenticated dry-run without publication. Run them in your actual Git repository after setting the remote.

Publication across npm and GitHub is not one atomic transaction. If a job fails, inspect its log and both registries before retrying. If a tag exists but npm publication failed, a plain semantic-release rerun may regard that tag as already released. Do not delete/reuse a tag after any successful public publication. Resolve npm permissions, then use a new `fix:` commit for the next release, or deliberately recover the tagged version through a reviewed maintainer workflow. If npm succeeded but GitHub Release creation failed, recreate the missing GitHub Release for the existing immutable tag; do not republish npm.

Sources: https://docs.npmjs.com/trusted-publishers/ and https://semantic-release.gitbook.io/semantic-release/usage/configuration . Verify account-specific npm settings in its UI.
