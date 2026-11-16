import * as fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import type { Context } from '@deepseek-ai/cordis';
import { presenterFrames } from '../src/host/dsh/presenter-frames.ts';
import { FileStoragePort } from '../src/host/dsh/storage.ts';
import { createPresenter } from '../src/host/presenter/index.ts';
import { createSenseRuntime } from '../src/host/runtime/index.ts';
import type { SensePorts } from '../src/host/runtime/ports.ts';

export async function syntheticDanger(ctx: Context, storageRoot: string) {
  const clock = { wall: Date.now, mono: () => performance.now() };
  const ports: SensePorts = {
    clock,
    dsh: {
      onAgentEvent: () => () => {},
      onTool: () => () => {},
      onJob: () => () => {},
      deliver: async () => {},
      tokenSnapshot: async () => undefined,
    },
    storage: new FileStoragePort(storageRoot, fs, () => ctx.logger.warn('fixture storage sync failed')),
    helper: { spawn: () => undefined },
    probe: { create: () => ({ onSample: () => () => {}, start: () => {}, stop: async () => {} }) },
    files: { watch: () => ({ close: () => {} }) },
  };
  const runtime = createSenseRuntime(ports, { platform: 'linux', rules: [] });
  await runtime.start();
  const presenter = createPresenter(runtime, { clock });
  ctx.effect(() => async () => {
    presenter.close();
    await runtime.stop();
  });
  return { actions: runtime.actions, frames: presenterFrames(presenter) };
}
