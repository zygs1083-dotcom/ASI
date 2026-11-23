import { spawnSync } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(pkg, '../..');
const lib = join(pkg, 'lib');
await mkdir(lib, { recursive: true });

await build({
  entryPoints: [join(pkg, 'src/host/dsh/index.ts')],
  outfile: join(lib, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@deepseek-ai/*'],
});

if (process.platform === 'darwin') {
  const native = join(root, 'native/asi-sense-helper');
  const args = ['build', '--package-path', native, '--configuration', 'release'];
  const compiled = spawnSync('swift', [...args, '--product', 'asi-sense-helper'], { stdio: 'inherit' });
  if (compiled.status !== 0) throw new Error('Could not build the macOS helper');
  const path = spawnSync('swift', [...args, '--show-bin-path'], { encoding: 'utf8' });
  if (path.status !== 0) throw new Error('Could not locate the macOS helper build');
  await copyFile(join(path.stdout.trim(), 'asi-sense-helper'), join(lib, 'asi-sense-helper'));
}
