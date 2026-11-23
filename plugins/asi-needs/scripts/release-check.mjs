import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowed, auditFiles } from './release-audit.mjs';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
const artifact = join(pkg, 'dist', `${manifest.name}-${manifest.version}.tgz`);
const temp = await mkdtemp(join(tmpdir(), 'asi-needs-release-'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: temp, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return result;
}

try {
  const listing = run('tar', ['-tzf', artifact]);
  assert.equal(listing.status, 0, listing.stderr);
  const entries = listing.stdout
    .trim()
    .split('\n')
    .filter((path) => !path.endsWith('/'));
  assert.deepEqual(entries.sort(), [...allowed].map((path) => `package/${path}`).sort());
  const extracted = run('tar', ['-xzf', artifact]);
  assert.equal(extracted.status, 0, extracted.stderr);
  const stage = join(temp, 'package');
  const contents = new Map(
    await Promise.all([...allowed].map(async (path) => [path, await readFile(join(stage, path))])),
  );
  auditFiles(
    [...allowed].map((path) => ({ path })),
    (path) => contents.get(path),
    userInfo().username,
  );
  console.log(`Release audit passed: ${manifest.name}@${manifest.version} (${(await stat(artifact)).size} bytes)`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
