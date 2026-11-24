import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceTypertGenerator, writeWorkspaceArtifacts } from '@deepseek-ai/dsh-typert-generator';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(pkg, '../..');
const protocol = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-typert-protocol/package.json')));
const root = await mkdtemp(join(tmpdir(), 'asi-sleep-typert-'));
const staged = join(root, 'packages', 'asi-sleep');
const stagedProtocol = join(root, 'packages', 'typert-protocol');
const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));

try {
  await Promise.all([mkdir(staged, { recursive: true }), mkdir(stagedProtocol, { recursive: true })]);
  await Promise.all([
    cp(join(pkg, 'src'), join(staged, 'src'), { recursive: true }),
    writeFile(
      join(staged, 'package.json'),
      JSON.stringify({
        ...manifest,
        files: [
          ...manifest.files,
          'lib/typert.host.d.ts',
          'lib/typert.remote-client.js',
          'lib/typert.remote-client.d.ts',
          'lib/typert.remote-client.d.ts.map',
        ],
        exports: {
          ...manifest.exports,
          '.': { ...manifest.exports['.'], types: './src/host/dsh/remote.ts' },
        },
      }),
    ),
    cp(join(protocol, 'src'), join(stagedProtocol, 'src'), { recursive: true }),
    cp(join(protocol, 'package.json'), join(stagedProtocol, 'package.json')),
    cp(join(repo, 'tsconfig.base.json'), join(root, 'tsconfig.base.json')),
    symlink(join(pkg, 'node_modules'), join(staged, 'node_modules'), 'dir'),
    symlink(dirname(dirname(protocol)), join(stagedProtocol, 'node_modules'), 'dir'),
    symlink(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir'),
    writeFile(
      join(root, 'tsconfig.host.json'),
      JSON.stringify({
        extends: './tsconfig.base.json',
        compilerOptions: {
          jsx: 'react-jsx',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          types: ['node'],
          paths: {
            '@deepseek-ai/dsh-typert-protocol': ['./packages/typert-protocol/src/index.ts'],
            '@deepseek-ai/dsh-typert-protocol/*': ['./packages/typert-protocol/src/*'],
          },
        },
        files: [],
        references: [
          { path: './packages/asi-sleep/tsconfig.host.json' },
          { path: './packages/typert-protocol/tsconfig.host.json' },
        ],
      }),
    ),
    writeFile(
      join(staged, 'tsconfig.host.json'),
      JSON.stringify({
        extends: '../../tsconfig.base.json',
        compilerOptions: { jsx: 'react-jsx', lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: ['node'] },
        files: ['src/shared/types.ts', 'src/host/dsh/remote.ts', 'src/host/dsh/wire-types.ts', 'src/client/css.d.ts'],
      }),
    ),
    writeFile(
      join(stagedProtocol, 'tsconfig.host.json'),
      JSON.stringify({
        extends: '../../tsconfig.base.json',
        include: ['src'],
      }),
    ),
  ]);
  const artifacts = new WorkspaceTypertGenerator(root, { checkDiagnostics: false }).generateContributors(['host']);
  if (artifacts.length !== 1 || !artifacts[0]?.remote) throw new Error('Expected one host and Remote artifact');
  writeWorkspaceArtifacts(root, artifacts);
  await mkdir(join(pkg, 'lib'), { recursive: true });
  for (const file of [
    'typert.host.d.ts',
    'typert.remote-client.js',
    'typert.remote-client.d.ts',
    'typert.remote-client.d.ts.map',
    'typert.host.js',
  ]) {
    const dest = join(pkg, 'lib', file);
    const tmp = `${dest}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    await cp(join(staged, 'lib', file), tmp);
    await rename(tmp, dest);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
