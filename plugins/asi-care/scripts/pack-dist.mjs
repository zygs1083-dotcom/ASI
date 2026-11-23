import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
const dist = join(pkg, 'dist');
const temp = await mkdtemp(join(tmpdir(), 'asi-care-pack-'));
const stage = join(temp, 'package');

try {
  await mkdir(join(stage, 'lib'), { recursive: true });
  await mkdir(join(stage, 'scripts'));
  await copyFile(join(pkg, 'lib', 'index.js'), join(stage, 'lib', 'index.js'));
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
            './package.json': './package.json',
          },
          files: ['lib/index.js', 'cordis.patch.yml', 'scripts/dsh.sh'],
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
