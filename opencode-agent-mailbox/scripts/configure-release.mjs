import { readFile, writeFile } from 'node:fs/promises';
const [repository, name] = process.argv.slice(2);
if (
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') ||
  !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*$/.test(name ?? '')
)
  throw new Error('Usage: node scripts/configure-release.mjs OWNER/REPOSITORY PACKAGE_NAME');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
pkg.name = name;
pkg.repository = { type: 'git', url: `https://github.com/${repository}.git` };
pkg.homepage = `https://github.com/${repository}#readme`;
pkg.bugs = { url: `https://github.com/${repository}/issues` };
await writeFile('package.json', JSON.stringify(pkg, null, 2) + '\n');
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
lock.name = name;
lock.packages[''].name = name;
await writeFile('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
console.log(
  `Configured ${name} for ${repository}. Update the installation examples to the chosen package name.`,
);
