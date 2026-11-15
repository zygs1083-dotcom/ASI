/**
 * Bundle src/client.ts + the generated remote client into the module-loader
 * factory artifact at lib/client.js. Externals stay as factory `require`
 * words (react, zod, cordis); everything else is inlined.
 */

import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const dsh = process.env.DSH_ROOT ?? '/Users/wangying/orca/dsh'
const pkg = resolve(root, 'packages/asi-sense-spike')

const pnpmDir = `${dsh}/node_modules/.pnpm`
const esbuildDir = readdirSync(pnpmDir)
  .filter(name => name.startsWith('esbuild@'))
  .sort()
  .pop()
const esbuild = `${pnpmDir}/${esbuildDir}/node_modules/esbuild/bin/esbuild`
if (!existsSync(esbuild)) {
  console.error(`build-client: no esbuild binary under ${pnpmDir}`)
  process.exit(1)
}

const banner = "window.__ModuleLoader__.load({id:'asi-sense-spike',factory:function(require){var module={exports:{}};var exports=module.exports;"
const footer = 'return module.exports}})'

const result = spawnSync(esbuild, [
  `${pkg}/src/client.ts`,
  '--bundle',
  '--format=cjs',
  '--platform=browser',
  '--target=es2024',
  '--external:react',
  '--external:react-dom',
  '--external:zod',
  '--external:@deepseek-ai/cordis',
  `--banner:js=${banner}`,
  `--footer:js=${footer}`,
  `--outfile=${pkg}/lib/client.js`,
], { stdio: 'inherit' })

process.exit(result.status ?? 1)
