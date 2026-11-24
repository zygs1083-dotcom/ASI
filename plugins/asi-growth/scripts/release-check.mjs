import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowed, auditFiles, registryUrl, registryVersionAvailable } from './release-audit.mjs';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
const registry = registryUrl(process.env.ASI_RELEASE_REGISTRY);
const artifact = join(pkg, 'dist', `${manifest.name}-${manifest.version}.tgz`);
const temp = await mkdtemp(join(tmpdir(), 'asi-growth-release-'));

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
  const packed = run('npm', [
    'pack',
    '--dry-run',
    '--json',
    '--ignore-scripts',
    '--userconfig=/dev/null',
    `--cache=${join(temp, 'npm-cache')}`,
    stage,
  ]);
  assert.equal(packed.status, 0, packed.stderr);
  const [result] = JSON.parse(packed.stdout);
  assert.deepEqual(result.files.map((file) => file.path).sort(), [...allowed].sort());
  const contents = new Map(
    await Promise.all(result.files.map(async ({ path }) => [path, await readFile(join(stage, path))])),
  );
  auditFiles(result.files, (path) => contents.get(path), userInfo().username);
  console.log(`npm pack --dry-run: ${manifest.name}@${manifest.version}`);
  for (const { path, size } of result.files) console.log(`${String(size).padStart(9)} bytes  ${path}`);
  console.log(`Distribution tgz: ${(await stat(artifact)).size} bytes; npm dry-run: ${result.size} bytes`);
  console.log(`Unpacked: ${result.unpackedSize} bytes`);

  const view = run('npm', [
    'view',
    `${manifest.name}@${manifest.version}`,
    'version',
    '--json',
    '--userconfig=/dev/null',
    `--cache=${join(temp, 'npm-cache')}`,
    `--registry=${registry}`,
  ]);
  if (!registryVersionAvailable(view.status, view.stdout))
    throw new Error(`${manifest.name}@${manifest.version} already exists`);
  console.log(`Registry ${registry}: ${manifest.name}@${manifest.version} not found (E404)`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
