import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-app-boot';
import z from '@deepseek-ai/schemastery';
import { createPresenter } from '../presenter/index.ts';
import { createSenseRuntime } from '../runtime/index.ts';
import { localPorts } from './local-ports.ts';
import { createDshPort } from './port.ts';
import { presenterFrames } from './presenter-frames.ts';
import { AsiSenseRemote } from './remote.ts';
import { registerSenseTools } from './tools.ts';

export { AsiSenseRemote } from './remote.ts';
export type { JsonObject, JsonValue, WirePanelModel, WireSenseEvent, WireSenseRule, WireSignal } from './wire-types.ts';

export const name = 'asi-sense';
export const inject = [
  'agents',
  'jobs',
  'llm',
  'profileContext',
  'sessionController',
  'sessionProjections',
  'sessionQuery',
  'sessions',
  'systemPrompt',
  'tokenMeter',
  'tools',
  'workspaceRegistry',
];

export interface Config {
  storageRoot: string;
  helperPath?: string;
  intervalMs?: number;
  selfCauseGraceMs?: number;
}

export const Config: z<Config> = z.object({
  storageRoot: z.string().required(),
  helperPath: z.string(),
  intervalMs: z.number().min(250).max(60_000),
  selfCauseGraceMs: z.number().min(0),
});

export async function apply(ctx: Context, config: Config): Promise<void> {
  const local = localPorts(ctx, config.storageRoot);
  const runtime = createSenseRuntime(
    {
      ...local,
      dsh: createDshPort(
        ctx,
        () => runtime.rules.settings().sendTitles,
        undefined,
        () => runtime.targetMode() === 'pinned',
      ),
    },
    {
      helperPath: config.helperPath ?? fileURLToPath(new URL('./asi-sense-helper', import.meta.url)),
      targetStorageKey: `session-target-${createHash('sha256').update(ctx.profileContext.dir).digest('hex')}`,
      ...(config.intervalMs === undefined ? {} : { intervalMs: config.intervalMs }),
      ...(config.selfCauseGraceMs === undefined ? {} : { selfCauseGraceMs: config.selfCauseGraceMs }),
    },
  );
  let presenter: ReturnType<typeof createPresenter> | undefined;
  let offTools: (() => void) | undefined;
  let disposed = false;
  const dispose = async () => {
    disposed = true;
    offTools?.();
    presenter?.close();
    await runtime.stop();
  };
  ctx.effect(() => dispose, 'asi-sense runtime');
  try {
    await runtime.start();
    if (disposed) return;
    presenter = createPresenter(runtime, { clock: local.clock, sampleIntervalsMs: { thermal: 30_000 } });
    new AsiSenseRemote(ctx, runtime.actions, presenterFrames(presenter));
    offTools = registerSenseTools(ctx, runtime, local.clock.wall);
  } catch (error) {
    await dispose();
    throw error;
  }
}
