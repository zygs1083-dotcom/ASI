import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
const artifact = process.argv[2] ?? join(pkg, 'dist', `${source.name}-${source.version}.tgz`);
const temp = await mkdtemp(join(tmpdir(), 'asi-sense-verify-'));

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
  console.log('Launcher: source tsx, isolated home, environment and argv');
  assertForwarded(run(['plugin', 'two words'], { PATH: `${installed}:${env.PATH}` }), 'installed');
  console.log('Launcher: matching PATH dsh takes priority');
  assert.equal(run(['fail']).status, 17);
  const installedOnly = run(['plugin', 'two words'], {
    PATH: `${installed}:${env.PATH}`,
    DSH_ROOT: '',
    DSH_HOME: undefined,
    TSX_TSCONFIG_PATH: undefined,
  });
  assert.equal(installedOnly.status, 0, installedOnly.stderr);
  assert.deepEqual(JSON.parse(installedOnly.stdout), {
    carrier: 'installed',
    args: ['plugin', 'two words'],
    telemetry: '1',
  });
  console.log('Launcher: installed dsh works without DSH_ROOT or overriding DSH_HOME');
  await writeFile(cli, program('0.2.2-rc.4', 'source'));
  const sourceMismatch = run(['plugin']);
  assert.notEqual(sourceMismatch.status, 0);
  assert.match(sourceMismatch.stderr, /0\.2\.2-rc\.3/);
  console.log('Launcher: source version mismatch rejected');
  await writeFile(cli, program('0.2.2-rc.3', 'source'));
  await writeFile(executable, `#!/usr/bin/env node\n${program('0.2.2-rc.4', 'installed')}`);
  const installedMismatch = run(['plugin'], { PATH: `${installed}:${env.PATH}` });
  assert.notEqual(installedMismatch.status, 0);
  assert.match(installedMismatch.stderr, /0\.2\.2-rc\.3/);
  console.log('Launcher: PATH version mismatch rejected without source fallback');
  const missing = run(['plugin'], { DSH_ROOT: '' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /DSH_ROOT/);
  console.log('Launcher: missing source checkout rejected');
}

try {
  const extracted = spawnSync('tar', ['-xzf', artifact, '-C', temp], { stdio: 'inherit' });
  assert.equal(extracted.status, 0, 'Could not extract the distribution');
  const root = join(temp, 'package');
  assert.deepEqual((await readdir(root)).sort(), ['README.md', 'cordis.patch.yml', 'lib', 'package.json', 'scripts']);
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
  const launcher = join(root, 'scripts/dsh.sh');
  assert.deepEqual(await readdir(join(root, 'scripts')), ['dsh.sh']);
  assert.notEqual((await stat(launcher)).mode & 0o111, 0, 'DSH launcher is not executable');
  await verifyLauncher(launcher);
  console.log(`Distribution verified: ${(await stat(artifact)).size} bytes; arm64, executable, ad-hoc signed`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
