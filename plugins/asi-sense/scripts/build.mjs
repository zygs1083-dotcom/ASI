import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
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

const browser = await build({
  entryPoints: [join(pkg, 'src/client/index.ts')],
  outfile: join(lib, 'client.js'),
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', 'zod'],
  define: { 'process.env.NODE_ENV': '"production"', ASI_SENSE_CSS: '__asiSenseStyles' },
});
const js = browser.outputFiles.find((file) => file.path.endsWith('.js'));
const css = browser.outputFiles.find((file) => file.path.endsWith('.css'));
if (!js || !css) throw new Error('Client bundle or stylesheet was not emitted');
await Promise.all([
  writeFile(
    join(lib, 'client.js'),
    `window.__ModuleLoader__.load({id:"asi-sense",factory:function(require){var module={exports:{}};var exports=module.exports;const __asiSenseStyles=${JSON.stringify(css.text)};\n${js.text}\nreturn module.exports;}});\n`,
  ),
  writeFile(join(lib, 'types.js'), 'export {};\n'),
]);

if (process.platform === 'darwin') {
  const native = join(root, 'native/asi-sense-helper');
  const args = ['build', '--package-path', native, '--configuration', 'release'];
  const compiled = spawnSync('swift', [...args, '--product', 'asi-sense-helper'], { stdio: 'inherit' });
  if (compiled.status !== 0) throw new Error('Could not build the macOS helper');
  const path = spawnSync('swift', [...args, '--show-bin-path'], { encoding: 'utf8' });
  if (path.status !== 0) throw new Error('Could not locate the macOS helper build');
  await copyFile(join(path.stdout.trim(), 'asi-sense-helper'), join(lib, 'asi-sense-helper'));
}
