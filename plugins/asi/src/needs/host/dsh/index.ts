import type { AsiDrivesServiceApi, AsiSenseServiceApi } from '@asi/sense-types';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-app-boot';
import z from '@deepseek-ai/schemastery';
import { type AsiRemote, ensureAsiRemote } from '../../../host/dsh/remote.js';
import { createNeedsRuntime } from '../runtime.js';
import { AsiDrivesService } from './drives-service.js';
import { createDshNeedsPorts } from './dsh-ports.js';
import { registerNeedsTools } from './tools.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    asiSense: AsiSenseServiceApi;
    asiDrives: AsiDrivesServiceApi;
    asi: AsiRemote;
  }
}

export { AsiRemote } from '../../../host/dsh/remote.js';
export { AsiDrivesService } from './drives-service.js';
export type { JsonObject, JsonValue, WireNeedsPanelModel } from './wire-types.js';

export const name = 'asi-needs';
export const inject = ['asiSense', 'agents', 'jobs', 'llm', 'sessionController', 'sessions', 'systemPrompt', 'tools'];

export interface Config {
  storageRoot: string;
}

export const Config: z<Config> = z.object({
  storageRoot: z.string().required(),
});

export async function apply(ctx: Context, config: Config): Promise<void> {
  const ports = createDshNeedsPorts(ctx, config.storageRoot);
  const runtime = createNeedsRuntime(ports);

  let offTools: (() => void) | undefined;
  let offReqErr: (() => void) | undefined;
  let offStream: (() => void) | undefined;
  let disposed = false;

  const dispose = async () => {
    disposed = true;
    (ctx as Context & { get(name: 'asi'): AsiRemote | undefined }).get('asi')?.bindNeedsActions(undefined);
    offStream?.();
    offReqErr?.();
    offTools?.();
    await runtime.stop();
  };
  ctx.effect(() => dispose, 'asi-needs runtime');

  try {
    offTools = registerNeedsTools(ctx, runtime);
    offReqErr = ctx.on('agent/request-error', async (payload, next) => {
      const f = payload.failure;
      if (
        f &&
        (f.status === undefined ||
          f.status >= 500 ||
          /network|timeout|connect|refused|fetch/i.test(`${f.code} ${f.message}`))
      ) {
        runtime.reportTransportResult(false, f.message);
      }
      return next();
    });
    offStream = ctx.on('agent/assistant-stream', ({ frame }) => {
      if (frame.type === 'start') {
        runtime.reportTransportResult(true);
      }
    });

    await runtime.start();
    if (disposed) return;
    new AsiDrivesService(ctx, runtime);
    ensureAsiRemote(ctx).bindNeedsActions(runtime.actions);
  } catch (error) {
    await dispose();
    throw error;
  }
}
