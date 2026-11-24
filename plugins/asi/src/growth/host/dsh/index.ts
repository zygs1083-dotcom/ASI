import type { AsiDrivesServiceApi, AsiSenseServiceApi } from '@asi/sense-types';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-app-boot';
import z from '@deepseek-ai/schemastery';
import { type AsiRemote, ensureAsiRemote } from '../../../host/dsh/remote.js';
import { createGrowthRuntime } from '../runtime.js';
import { createDshGrowthPorts, registerDshSkillBridge } from './dsh-ports.js';
import { registerGrowthTools } from './tools.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    asiSense: AsiSenseServiceApi;
    asiDrives: AsiDrivesServiceApi;
    asi: AsiRemote;
  }
}

export { AsiRemote } from '../../../host/dsh/remote.js';
export type {
  JsonObject,
  JsonValue,
  WireArchivedSkillViewItem,
  WireGrowthPanelModel,
  WireGrowthSynthesisRecord,
  WireSkillCreateDraftInput,
  WireSkillDraftViewItem,
  WireSkillExportResult,
  WireSkillScope,
  WireSkillScopeUpdateInput,
  WireSkillUpdateMarkdownInput,
  WireSkillViewItem,
} from './wire-types.js';

export const name = 'asi-growth';
export const inject = ['asiSense', 'asiDrives', 'agents', 'llm', 'sessions', 'tools'];

export interface Config {
  storageRoot: string;
}

export const Config: z<Config> = z.object({
  storageRoot: z.string().required(),
});

export async function apply(ctx: Context, config: Config): Promise<void> {
  const ports = createDshGrowthPorts(ctx, config.storageRoot);
  const runtime = createGrowthRuntime(ports);

  let offTools: (() => void) | undefined;
  let offSkills: (() => void) | undefined;
  let disposed = false;

  const dispose = async () => {
    disposed = true;
    (ctx as Context & { get(name: 'asi'): AsiRemote | undefined }).get('asi')?.bindGrowthActions(undefined);
    offSkills?.();
    offSkills = undefined;
    offTools?.();
    offTools = undefined;
    await runtime.stop();
  };
  ctx.effect(() => dispose, 'asi-growth runtime');

  try {
    offTools = registerGrowthTools(ctx, runtime);
    offSkills = registerDshSkillBridge(ctx, runtime.skillBridge, config.storageRoot);
    await runtime.start();
    if (disposed) {
      await dispose();
      return;
    }
    ensureAsiRemote(ctx).bindGrowthActions(runtime.actions);
  } catch (err) {
    await dispose();
    throw err;
  }
}
