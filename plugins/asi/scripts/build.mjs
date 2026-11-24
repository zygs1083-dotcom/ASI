import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
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
const root = resolve(pkg, '../..');
const lib = join(pkg, 'lib');
await mkdir(lib, { recursive: true });
if (!existsSync(join(lib, 'typert.host.js')) || !existsSync(join(lib, 'typert.remote-client.js'))) {
  await import('./generate-typert.mjs');
}

const host = await build({
  entryPoints: [join(pkg, 'src/host/dsh/index.ts')],
  outfile: join(lib, 'index.js'),
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  external: ['@deepseek-ai/*'],
});
await atomicWrite(join(lib, 'index.js'), host.outputFiles[0].contents);

const typert = await build({
  entryPoints: [join(lib, 'typert.host.js')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  external: ['@deepseek-ai/*'],
});
await atomicWrite(join(lib, 'typert.host.js'), typert.outputFiles[0].contents);

const browser = await build({
  entryPoints: [join(pkg, 'src/client/index.ts')],
  outfile: join(lib, 'client.js'),
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  legalComments: 'none',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', 'zod'],
  define: { 'process.env.NODE_ENV': '"production"', ASI_UNIFIED_CSS: '__asiUnifiedStyles' },
});
const js = browser.outputFiles.find((file) => file.path.endsWith('.js'));
const css = browser.outputFiles.find((file) => file.path.endsWith('.css'));
if (!js || !css) throw new Error('Client bundle or stylesheet was not emitted');
await Promise.all([
  atomicWrite(
    join(lib, 'client.js'),
    `window.__ModuleLoader__.load({id:"asi",factory:function(require){var module={exports:{}};var exports=module.exports;const __asiUnifiedStyles=${JSON.stringify(css.text)};\n${js.text}\nreturn module.exports;}});\n`,
  ),
  atomicWrite(join(lib, 'types.js'), 'export {};\n'),
]);

if (process.platform === 'darwin') {
  const native = join(root, 'native/asi-sense-helper');
  const args = ['build', '--package-path', native, '--configuration', 'release'];
  const compiled = spawnSync('swift', [...args, '--product', 'asi-sense-helper'], { stdio: 'inherit' });
  if (compiled.status !== 0) throw new Error('Could not build the macOS helper');
  const binPath = spawnSync('swift', [...args, '--show-bin-path'], { encoding: 'utf8' });
  if (binPath.status !== 0) throw new Error('Could not locate the macOS helper build');
  await copyFile(join(binPath.stdout.trim(), 'asi-sense-helper'), join(lib, 'asi-sense-helper'));
}
