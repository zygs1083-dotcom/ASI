import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'darwin' && process.arch !== 'arm64') {
  throw new Error('Build the distribution on an arm64 macOS host');
}

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
const dist = join(pkg, 'dist');
const temp = await mkdtemp(join(tmpdir(), 'asi-pack-'));
const stage = join(temp, 'package');

try {
  await mkdir(join(stage, 'lib'), { recursive: true });
  await mkdir(join(stage, 'scripts'));
  for (const file of ['index.js', 'client.js', 'typert.host.js']) {
    await copyFile(join(pkg, 'lib', file), join(stage, 'lib', file));
  }

  const helperSource = join(pkg, 'lib/asi-sense-helper');
  if (process.platform === 'darwin') {
    await copyFile(helperSource, join(stage, 'lib/asi-sense-helper'));
    const helper = join(stage, 'lib/asi-sense-helper');
    await chmod(helper, 0o755);
    const stripped = spawnSync('strip', ['-S', helper], { stdio: 'inherit' });
    if (stripped.status !== 0) throw new Error('Could not strip helper debug symbols');
    const signed = spawnSync('codesign', ['--force', '--sign', '-', helper], { stdio: 'inherit' });
    if (signed.status !== 0) throw new Error('Could not sign the macOS helper');
  } else if (existsSync(helperSource)) {
    await copyFile(helperSource, join(stage, 'lib/asi-sense-helper'));
    await chmod(join(stage, 'lib/asi-sense-helper'), 0o755);
  } else {
    console.log(
      'Note: Linux JS/manifest verification pack (lib/asi-sense-helper requires darwin arm64 for final release)',
    );
  }

  await Promise.all([
    copyFile(join(pkg, 'cordis.patch.yml'), join(stage, 'cordis.patch.yml')),
    copyFile(join(pkg, '../../LICENSE'), join(stage, 'LICENSE')),
    copyFile(join(pkg, 'scripts/dsh.sh'), join(stage, 'scripts/dsh.sh')).then(() =>
      chmod(join(stage, 'scripts/dsh.sh'), 0o755),
    ),
    writeFile(
      join(stage, 'package.json'),
      `${JSON.stringify(
        {
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          license: manifest.license,
          repository: manifest.repository,
          keywords: manifest.keywords,
          os: manifest.os,
          cpu: manifest.cpu,
          publishConfig: manifest.publishConfig,
          type: manifest.type,
          main: manifest.main,
          engines: manifest.engines,
          exports: {
            '.': './lib/index.js',
            './client': './lib/client.js',
            './typert': './lib/typert.host.js',
            './package.json': './package.json',
          },
          files: [
            'lib/index.js',
            'lib/client.js',
            'lib/typert.host.js',
            'lib/asi-sense-helper',
            'cordis.patch.yml',
            'scripts/dsh.sh',
          ],
          dsh: manifest.dsh,
          peerDependencies: manifest.peerDependencies,
        },
        null,
        2,
      )}\n`,
    ),
  ]);
  await mkdir(dist, { recursive: true });
  const artifact = join(dist, `${manifest.name}-${manifest.version}.tgz`);
  const ownerArgs =
    process.platform === 'darwin'
      ? ['--uid', '0', '--gid', '0', '--numeric-owner']
      : ['--owner=0', '--group=0', '--numeric-owner'];
  const packed = spawnSync('tar', ['-czf', artifact, ...ownerArgs, '-C', temp, 'package'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: 'inherit',
  });
  if (packed.status !== 0) throw new Error('Could not pack the distribution');
  console.log(`Packed ${artifact}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
