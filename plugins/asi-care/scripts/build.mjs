import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

async function atomicWrite(target, contents) {
  const tmp = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(tmp, contents);
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lib = join(pkg, 'lib');
await mkdir(lib, { recursive: true });

const host = await build({
  entryPoints: [join(pkg, 'src/host/dsh/index.ts')],
  outfile: join(lib, 'index.js'),
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@deepseek-ai/*'],
});
await atomicWrite(join(lib, 'index.js'), host.outputFiles[0].contents);
