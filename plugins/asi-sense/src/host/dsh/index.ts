import { fileURLToPath } from 'node:url';
import type { AsiSenseServiceApi, PowerMode, SenseSettingsSnapshot, SenseSnapshot, Signal } from '@asi/sense-types';
import { type Context, Service } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-app-boot';
import z from '@deepseek-ai/schemastery';
import { createSenseRuntime } from '../runtime/index.ts';
import { localPorts } from './local-ports.ts';
import { createDshPort } from './port.ts';
import type { JsonObject, JsonValue } from './tool-output.ts';
import { registerSenseTools } from './tools.ts';

export type { JsonObject, JsonValue };

declare module '@deepseek-ai/cordis' {
  interface Context {
    asiSense: AsiSenseServiceApi;
  }
}

export class AsiSenseService extends Service implements AsiSenseServiceApi {
  readonly storageRoot: string;

  constructor(
    ctx: Context,
    private readonly runtime: ReturnType<typeof createSenseRuntime>,
    storageRoot: string,
  ) {
    super(ctx, 'asiSense');
    this.storageRoot = storageRoot;
  }

  snapshot(sessionId?: string): SenseSnapshot {
    return this.runtime.snapshot(sessionId);
  }

  subscribe(listener: (snapshot: SenseSnapshot) => void): () => void {
    return this.runtime.subscribeSnapshot(listener);
  }

  getSettings(): SenseSettingsSnapshot {
    return this.runtime.getSettings();
  }

  setPaused(paused: boolean): Promise<void> {
    return this.runtime.actions.pause(paused);
  }

  setSendTitles(enabled: boolean): Promise<void> {
    return this.runtime.actions.setSendTitles(enabled);
  }

  setPowerMode(mode: PowerMode, reason?: string): Promise<void> {
    return this.runtime.actions.setPowerMode(mode, reason);
  }

  openPermissionSettings(): Promise<void> {
    return this.runtime.actions.openPermissionSettings();
  }

  registerInternalSession(sessionId: string): () => void {
    return this.runtime.registerInternalSession(sessionId);
  }

  recentSignals(): Signal[] {
    return this.runtime.recentSignals();
  }
}

export const name = 'asi-sense';
export const inject = [
  'agents',
  'jobs',
  'llm',
  'profileContext',
  'sessionProjections',
  'sessions',
  'systemPrompt',
  'tokenMeter',
  'tools',
];

export interface Config {
  storageRoot: string;
  helperPath?: string;
  intervalMs?: number;
  ecoIntervalMs?: number;
}

export const Config: z<Config> = z.object({
  storageRoot: z.string().required(),
  helperPath: z.string(),
  intervalMs: z.number().min(250).max(60_000),
  ecoIntervalMs: z.number().min(1_000).max(120_000),
});

export async function apply(ctx: Context, config: Config): Promise<void> {
  const local = localPorts(ctx, config.storageRoot);
  const runtime = createSenseRuntime(
    {
      ...local,
      dsh: createDshPort(ctx),
    },
    {
      helperPath: config.helperPath ?? fileURLToPath(new URL('./asi-sense-helper', import.meta.url)),
      ...(config.intervalMs === undefined ? {} : { intervalMs: config.intervalMs }),
      ...(config.ecoIntervalMs === undefined ? {} : { ecoIntervalMs: config.ecoIntervalMs }),
    },
  );
  let offTools: (() => void) | undefined;
  let disposed = false;
  const dispose = async () => {
    disposed = true;
    offTools?.();
    await runtime.stop();
  };
  ctx.effect(() => dispose, 'asi-sense runtime');
  try {
    await runtime.start();
    if (disposed) return;
    new AsiSenseService(ctx, runtime, config.storageRoot);
    offTools = registerSenseTools(ctx, runtime, local.clock.wall);
  } catch (error) {
    await dispose();
    throw error;
  }
}
