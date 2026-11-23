import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
const artifact = process.argv[2] ?? join(pkg, 'dist', `${source.name}-${source.version}.tgz`);
const temp = await mkdtemp(join(tmpdir(), 'asi-sleep-verify-'));

async function verifyLauncher(script) {
  const root = join(await realpath(temp), 'dsh source with spaces');
  const bin = join(temp, 'bin');
  const installed = join(temp, 'installed');
  const home = join(temp, 'isolated home');
  await mkdir(join(root, 'apps/cli/src'), { recursive: true });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await mkdir(bin);
  await mkdir(installed);
  await symlink(process.execPath, join(bin, 'node'));
  await symlink(await realpath(join(pkg, 'node_modules/tsx')), join(root, 'node_modules/tsx'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'tsconfig.json'), '{}');
  const program = (version, carrier) => `
if (process.argv[2] === '--version') console.log(${JSON.stringify(version)});
else {
  console.log(JSON.stringify({
    carrier: ${JSON.stringify(carrier)},
    args: process.argv.slice(2),
    home: process.env.DSH_HOME,
    telemetry: process.env.DSH_TELEMETRY_DISABLED,
    tsconfig: process.env.TSX_TSCONFIG_PATH,
  }));
  if (process.argv[2] === 'fail') process.exit(17);
}
`;
  const cli = join(root, 'apps/cli/src/bin.ts');
  const executable = join(installed, 'dsh');
  await writeFile(cli, program('0.2.2-rc.3', 'source'));
  await writeFile(executable, `#!/usr/bin/env node\n${program('0.2.2-rc.3', 'installed')}`, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    DSH_ROOT: root,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '0',
    TSX_TSCONFIG_PATH: 'incorrect',
  };
  const run = (args, extra = {}) => spawnSync(script, args, { env: { ...env, ...extra }, encoding: 'utf8' });
  const assertForwarded = (result, carrier) => {
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      carrier,
      args: ['plugin', 'two words'],
      home,
      telemetry: '1',
      tsconfig: join(root, 'tsconfig.json'),
    });
  };
  assertForwarded(run(['plugin', 'two words']), 'source');
  assertForwarded(run(['plugin', 'two words'], { PATH: `${installed}:${env.PATH}` }), 'installed');
  await writeFile(cli, program('0.2.2-rc.5', 'source'));
  assertForwarded(run(['plugin', 'two words']), 'source');
  await writeFile(executable, `#!/usr/bin/env node\n${program('0.2.2-rc.5', 'installed')}`);
  assertForwarded(run(['plugin', 'two words'], { PATH: `${installed}:${env.PATH}` }), 'installed');
  assert.equal(run(['fail']).status, 17);
  await writeFile(cli, program('0.2.2-rc.4', 'source'));
  assert.notEqual(run(['plugin']).status, 0);
}

try {
  const extracted = spawnSync('tar', ['-xzf', artifact, '-C', temp], { stdio: 'inherit' });
  assert.equal(extracted.status, 0, 'Could not extract the distribution');
  const root = join(temp, 'package');
  assert.deepEqual((await readdir(root)).sort(), ['LICENSE', 'cordis.patch.yml', 'lib', 'package.json', 'scripts']);
  assert.deepEqual((await readdir(join(root, 'lib'))).sort(), ['client.js', 'index.js', 'typert.host.js']);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(source.private, true);
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.engines.dsh, '0.2.2-rc.3 || 0.2.2-rc.5');
  assert.equal(JSON.stringify(manifest).includes('workspace:'), false);
  assert.deepEqual(manifest.dependencies ?? {}, {});
  for (const path of Object.values(manifest.exports)) await stat(join(root, path));
  const launcher = join(root, 'scripts/dsh.sh');
  assert.deepEqual(await readdir(join(root, 'scripts')), ['dsh.sh']);
  assert.notEqual((await stat(launcher)).mode & 0o111, 0, 'DSH launcher is not executable');
  await verifyLauncher(launcher);
  console.log(`Distribution verified: ${(await stat(artifact)).size} bytes`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
