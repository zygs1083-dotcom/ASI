import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
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
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', 'zod'],
  define: { 'process.env.NODE_ENV': '"production"', ASI_NEEDS_CSS: '__asiNeedsStyles' },
});
const js = browser.outputFiles.find((file) => file.path.endsWith('.js'));
const css = browser.outputFiles.find((file) => file.path.endsWith('.css'));
if (!js || !css) throw new Error('Client bundle or stylesheet was not emitted');
await Promise.all([
  atomicWrite(
    join(lib, 'client.js'),
    `window.__ModuleLoader__.load({id:"asi-needs",factory:function(require){var module={exports:{}};var exports=module.exports;const __asiNeedsStyles=${JSON.stringify(css.text)};\n${js.text}\nreturn module.exports;}});\n`,
  ),
  atomicWrite(join(lib, 'types.js'), 'export {};\n'),
]);
