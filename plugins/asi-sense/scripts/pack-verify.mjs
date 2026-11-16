import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
const artifact = process.argv[2] ?? join(pkg, 'dist', `${source.name}-${source.version}.tgz`);
const temp = await mkdtemp(join(tmpdir(), 'asi-sense-verify-'));

try {
  const extracted = spawnSync('tar', ['-xzf', artifact, '-C', temp], { stdio: 'inherit' });
  assert.equal(extracted.status, 0, 'Could not extract the distribution');
  const root = join(temp, 'package');
  assert.deepEqual((await readdir(root)).sort(), ['README.md', 'cordis.patch.yml', 'lib', 'package.json']);
  assert.deepEqual((await readdir(join(root, 'lib'))).sort(), [
    'asi-sense-helper',
    'client.js',
    'index.js',
    'typert.host.js',
  ]);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.engines.dsh, '0.2.2-rc.3');
  assert.equal(JSON.stringify(manifest).includes('workspace:'), false);
  assert.deepEqual(manifest.dependencies ?? {}, {});
  for (const path of Object.values(manifest.exports)) await stat(join(root, path));
  const helper = join(root, 'lib/asi-sense-helper');
  assert.notEqual((await stat(helper)).mode & 0o111, 0, 'Helper is not executable');
  const file = spawnSync('file', [helper], { encoding: 'utf8' });
  assert.equal(file.status, 0);
  assert.match(file.stdout, /Mach-O.*arm64/);
  const signature = spawnSync('codesign', ['--verify', '--strict', helper], { encoding: 'utf8' });
  assert.equal(signature.status, 0, signature.stderr);
  const details = spawnSync('codesign', ['-dv', helper], { encoding: 'utf8' });
  assert.equal(details.status, 0);
  assert.match(details.stderr, /Signature=adhoc/);
  console.log(`Distribution verified: ${(await stat(artifact)).size} bytes; arm64, executable, ad-hoc signed`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
