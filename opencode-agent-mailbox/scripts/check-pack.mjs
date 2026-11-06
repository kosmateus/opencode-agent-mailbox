import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const pack = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }),
)[0];
const paths = pack.files.map((f) => f.path);
for (const required of [
  'dist/index.js',
  'dist/index.d.ts',
  'dist/tui.js',
  'dist/tui.d.ts',
  'README.md',
  'LICENSE',
  'docs/API.md',
  'package.json',
])
  assert.ok(paths.includes(required), `Missing ${required}`);
for (const file of paths) {
  assert.ok(
    /^(dist\/|docs\/API.md$|README.md$|LICENSE$|package.json$)/.test(file),
    `Unexpected package file ${file}`,
  );
  assert.ok(!/(\.env|\.db|node_modules|\.e2e)/.test(file), `Private file ${file}`);
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
assert.equal(pkg.version, lock.version);
assert.equal(pkg.version, lock.packages[''].version);
assert.equal(pkg.name, lock.name);
console.log(
  `Verified npm package: ${paths.length} files, ${pack.unpackedSize} bytes, version ${pkg.version}`,
);
