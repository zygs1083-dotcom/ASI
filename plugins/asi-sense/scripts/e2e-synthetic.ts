import { copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SensePanelModel } from '@asi/sense-ui';
import { initialState } from '../src/host/state/facts.ts';

export function syntheticFrame(): SensePanelModel {
  const now = Date.now();
  const state = initialState(now, 86_400_000);
  const fact = <T>(value: T) => ({
    value,
    status: 'ok' as const,
    source: { id: 'fixture', api: 'fixture', host: 'demo-host' },
    observedAt: now,
    ttlMs: 86_400_000,
  });
  state.self.body.cpu = fact({ usage: 0.34, perCore: [0.3, 0.4], load1: 1, load5: 1, load15: 1 });
  state.self.body.memory = fact({ total: 32e9, used: 19e9, pressure: 'normal', swapUsed: 0 });
  state.self.body.disks = { ...fact([{ mount: '/demo/volume', total: 120e9, free: 72e9 }]), kind: 'disks' };
  state.env.frontApp = fact({ name: 'Demo Editor', bundleId: 'example.demo.editor' });
  state.env.focusedWindow = fact({ title: 'example.ts — demo' });
  state.env.where.toolExec = fact({ host: 'demo-host', cwd: '/demo/project' });
  return {
    state: { ...state, env: { ...state.env, activeJobs: { ...state.env.activeJobs, value: [] } } },
    events: [],
    rules: [],
    paused: false,
    sendTitles: false,
    now,
    history: {
      cpu: [],
      memory: [],
      battery: [],
      thermal: [],
      networkRx: [],
      networkTx: [],
      processCpu: [],
      processRss: [],
      tokens: [],
      disks: {},
    },
  };
}

export async function syntheticBundle(root: string, pkg: string, dangerStorage?: string): Promise<string> {
  const bundle = join(root, 'synthetic-bundle');
  const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
  manifest.main = './fixture.js';
  manifest.exports['.'].default = './fixture.js';
  await mkdir(bundle);
  await Promise.all([
    symlink(join(pkg, 'lib'), join(bundle, 'lib'), 'dir'),
    copyFile(join(pkg, 'cordis.patch.yml'), join(bundle, 'cordis.patch.yml')),
    writeFile(join(bundle, 'package.json'), JSON.stringify(manifest)),
    writeFile(join(bundle, 'frame.json'), JSON.stringify(syntheticFrame())),
    writeFile(
      join(bundle, 'fixture.js'),
      dangerStorage
        ? `import { AsiSenseRemote } from ${JSON.stringify(pathToFileURL(join(pkg, 'lib/index.js')).href)};
import { syntheticDanger } from ${JSON.stringify(pathToFileURL(join(pkg, 'scripts/e2e-synthetic-runtime.ts')).href)};
export const name = 'asi-sense';
export async function apply(ctx) {
  const { actions, frames } = await syntheticDanger(ctx, ${JSON.stringify(dangerStorage)});
  new AsiSenseRemote(ctx, actions, frames);
}
`
        : `import { readFileSync } from 'node:fs';
import { AsiSenseRemote } from ${JSON.stringify(pathToFileURL(join(pkg, 'lib/index.js')).href)};
export const name = 'asi-sense';
export function apply(ctx) {
  const frame = JSON.parse(readFileSync(new URL('./frame.json', import.meta.url), 'utf8'));
  new AsiSenseRemote(ctx, {}, async function* (signal) {
    yield frame;
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  });
}
`,
    ),
  ]);
  return bundle;
}
