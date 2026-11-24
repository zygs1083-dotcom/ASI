import type { AsiDrivesServiceApi, AsiSenseServiceApi } from '@asi/sense-types';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-app-boot';
import z from '@deepseek-ai/schemastery';
import { createCareRuntime } from '../runtime.js';
import { createDshCarePorts } from './ports.js';
import { registerCareTools } from './tools.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    asiSense: AsiSenseServiceApi;
    asiDrives: AsiDrivesServiceApi;
  }
}

export { createCareRuntime } from '../runtime.js';

export const name = 'asi-care';
export const inject = ['asiSense', 'asiDrives', 'agents', 'jobs', 'sessions', 'tools'];

export interface Config {
  storageRoot: string;
  extraRoots?: string[];
  ignorePaths?: string[];
  fastIntervalMs?: number;
  slowIntervalMs?: number;
}

export const Config: z<Config> = z.object({
  storageRoot: z.string().required(),
  extraRoots: z.array(z.string()),
  ignorePaths: z.array(z.string()),
  fastIntervalMs: z.number().min(5_000).max(3_600_000),
  slowIntervalMs: z.number().min(15_000).max(7_200_000),
});

export async function apply(ctx: Context, config: Config): Promise<void> {
  const ports = createDshCarePorts(ctx, config.storageRoot);
  const runtime = createCareRuntime(ports, {
    ...(config.extraRoots ? { extraRoots: config.extraRoots } : {}),
    ...(config.ignorePaths ? { ignorePaths: config.ignorePaths } : {}),
    ...(config.fastIntervalMs !== undefined ? { fastIntervalMs: config.fastIntervalMs } : {}),
    ...(config.slowIntervalMs !== undefined ? { slowIntervalMs: config.slowIntervalMs } : {}),
  });

  let offTools: (() => void) | undefined;
  let disposed = false;

  const dispose = async () => {
    disposed = true;
    offTools?.();
    await runtime.stop();
  };
  ctx.effect(() => dispose, 'asi-care runtime');

  try {
    offTools = registerCareTools(ctx, runtime);
    await runtime.start();
    if (disposed) {
      await dispose();
    }
  } catch (error) {
    await dispose();
    throw error;
  }
}
