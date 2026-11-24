import type { AsiDrivesServiceApi, AsiSenseServiceApi, AsiSleepServiceApi } from '@asi/sense-types';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-app-boot';
import z from '@deepseek-ai/schemastery';
import { type AsiRemote, ensureAsiRemote } from '../../../host/dsh/remote.js';
import { createSleepRuntime } from '../runtime.js';
import { buildExcludedInternalRoots, createDshSleepPorts } from './dsh-ports.js';
import { AsiSleepService } from './sleep-service.js';
import { registerSleepTools } from './tools.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    asiSense: AsiSenseServiceApi;
    asiDrives: AsiDrivesServiceApi;
    asiSleep: AsiSleepServiceApi;
    asi: AsiRemote;
  }
}

export { AsiRemote } from '../../../host/dsh/remote.js';
export { AsiSleepService } from './sleep-service.js';
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
    (ctx as Context & { get(name: 'asi'): AsiRemote | undefined }).get('asi')?.bindSleepActions(undefined);
    offTools?.();
    await runtime.stop();
  };
  ctx.effect(() => dispose, 'asi-sleep runtime');

  try {
    offTools = registerSleepTools(
      ctx,
      runtime,
      buildExcludedInternalRoots(config.storageRoot, ctx.asiSense?.storageRoot),
    );
    await runtime.start();
    if (disposed) return;
    new AsiSleepService(ctx, runtime);
    ensureAsiRemote(ctx).bindSleepActions(runtime.actions);
  } catch (err) {
    await dispose();
    throw err;
  }
}
