import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Invalid release version');
if (!pkg.repository?.url?.startsWith('https://github.com/'))
  throw new Error('Set package.json repository.url to the public GitHub repository before release.');
try {
  const exists = execFileSync('npm', ['view', `${pkg.name}@${version}`, 'version', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (exists) throw new Error(`Refusing to republish ${pkg.name}@${version}`);
} catch (error) {
  if (!String(error.stderr ?? '').includes('E404')) throw error;
}
