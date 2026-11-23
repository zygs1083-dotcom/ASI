import type { AsiDrivesServiceApi, AsiSenseServiceApi } from '@asi/sense-types';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-app-boot';
import z from '@deepseek-ai/schemastery';
import { createSleepRuntime } from '../runtime.js';
import { createDshSleepPorts } from './dsh-ports.js';
import { createSleepFramesSource } from './frames.js';
import { AsiSleepRemote } from './remote.js';
import { registerSleepTools } from './tools.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    asiSense: AsiSenseServiceApi;
    asiDrives: AsiDrivesServiceApi;
  }
}

export { AsiSleepRemote } from './remote.js';
export type {
  JsonObject,
  JsonValue,
  WireMemoryCreateInput,
  WireMemoryKind,
  WireMemoryUpdateInput,
  WireMemoryViewItem,
  WireSleepConsolidationRecord,
  WireSleepPanelModel,
} from './wire-types.js';

export const name = 'asi-sleep';
export const inject = ['asiSense', 'asiDrives', 'agents', 'llm', 'sessions', 'tools'];

export interface Config {
  storageRoot: string;
}

export const Config: z<Config> = z.object({
  storageRoot: z.string().required(),
});

export async function apply(ctx: Context, config: Config): Promise<void> {
  const ports = createDshSleepPorts(ctx, config.storageRoot);
  const runtime = createSleepRuntime(ports);

  let offTools: (() => void) | undefined;
  let disposed = false;

  const dispose = async () => {
    disposed = true;
    offTools?.();
    await runtime.stop();
  };
  ctx.effect(() => dispose, 'asi-sleep runtime');

  try {
    offTools = registerSleepTools(ctx, runtime, [config.storageRoot, ctx.asiSense?.storageRoot]);
    await runtime.start();
    if (disposed) return;
    new AsiSleepRemote(ctx, runtime.actions, createSleepFramesSource(runtime));
  } catch (err) {
    await dispose();
    throw err;
  }
}
