import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AsiDrivesServiceApi, AsiSenseServiceApi, AsiSleepServiceApi } from '@asi/sense-types';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-app-boot';
import z from '@deepseek-ai/schemastery';
import { createDshCarePorts } from '../../care/host/dsh/ports.ts';
import { registerCareTools } from '../../care/host/dsh/tools.ts';
import { createCareRuntime } from '../../care/host/runtime.ts';
import { createDshGrowthPorts, registerDshSkillBridge } from '../../growth/host/dsh/dsh-ports.ts';
import { registerGrowthTools } from '../../growth/host/dsh/tools.ts';
import { createGrowthRuntime } from '../../growth/host/runtime.ts';
import { migrateLegacyAsiData } from '../../migration/legacy-migration.ts';
import { AsiDrivesService } from '../../needs/host/dsh/drives-service.ts';
import { createDshNeedsPorts } from '../../needs/host/dsh/dsh-ports.ts';
import { registerNeedsTools } from '../../needs/host/dsh/tools.ts';
import { createNeedsRuntime } from '../../needs/host/runtime.ts';
import { AsiSenseService } from '../../sense/host/dsh/index.ts';
import { localPorts } from '../../sense/host/dsh/local-ports.ts';
import { createDshPort } from '../../sense/host/dsh/port.ts';
import { registerSenseTools } from '../../sense/host/dsh/tools.ts';
import { createSenseRuntime } from '../../sense/host/runtime/index.ts';
import { buildExcludedInternalRoots, createDshSleepPorts } from '../../sleep/host/dsh/dsh-ports.ts';
import { AsiSleepService } from '../../sleep/host/dsh/sleep-service.ts';
import { registerSleepTools } from '../../sleep/host/dsh/tools.ts';
import { createSleepRuntime } from '../../sleep/host/runtime.ts';
import { createAsiFramesSource } from './frames.ts';
import { AsiRemote } from './remote.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    asiSense: AsiSenseServiceApi;
    asiDrives: AsiDrivesServiceApi;
    asiSleep: AsiSleepServiceApi;
    asi: AsiRemote;
  }
}

export { type LegacyMigrationReport, migrateLegacyAsiData } from '../../migration/legacy-migration.ts';
export { AsiDrivesService } from '../../needs/host/dsh/drives-service.ts';
export { AsiSenseService } from '../../sense/host/dsh/index.ts';
export { AsiSleepService } from '../../sleep/host/dsh/sleep-service.ts';
export { AsiRemote } from './remote.ts';
export type {
  AsiPanelModel,
  JsonObject,
  JsonValue,
  WireArchivedSkillViewItem,
  WireAsiPanelModel,
  WireGrowthPanelModel,
  WireGrowthSynthesisRecord,
  WireMemoryCreateInput,
  WireMemoryKind,
  WireMemoryUpdateInput,
  WireMemoryViewItem,
  WireNeedsPanelModel,
  WireSkillCreateDraftInput,
  WireSkillDraftViewItem,
  WireSkillExportResult,
  WireSkillScope,
  WireSkillScopeUpdateInput,
  WireSkillUpdateMarkdownInput,
  WireSkillViewItem,
  WireSleepConsolidationRecord,
  WireSleepPanelModel,
} from './wire-types.ts';

export const name = 'asi';
export const inject = [
  'agents',
  'jobs',
  'llm',
  'profileContext',
  'sessionController',
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
  extraRoots?: string[];
  ignorePaths?: string[];
  fastIntervalMs?: number;
  slowIntervalMs?: number;
}

export const Config: z<Config> = z.object({
  storageRoot: z.string().required(),
  helperPath: z.string(),
  intervalMs: z.number().min(250).max(60_000),
  ecoIntervalMs: z.number().min(1_000).max(120_000),
  extraRoots: z.array(z.string()),
  ignorePaths: z.array(z.string()),
  fastIntervalMs: z.number().min(5_000).max(3_600_000),
  slowIntervalMs: z.number().min(15_000).max(7_200_000),
});

export async function apply(ctx: Context, config: Config): Promise<void> {
  let disposed = false;

  let senseRuntime: ReturnType<typeof createSenseRuntime> | undefined;
  let needsRuntime: ReturnType<typeof createNeedsRuntime> | undefined;
  let sleepRuntime: ReturnType<typeof createSleepRuntime> | undefined;
  let careRuntime: ReturnType<typeof createCareRuntime> | undefined;
  let growthRuntime: ReturnType<typeof createGrowthRuntime> | undefined;

  let offSenseTools: (() => void) | undefined;
  let offNeedsTools: (() => void) | undefined;
  let offReqErr: (() => void) | undefined;
  let offStream: (() => void) | undefined;
  let offSleepTools: (() => void) | undefined;
  let offCareTools: (() => void) | undefined;
  let offGrowthTools: (() => void) | undefined;
  let offGrowthSkills: (() => void) | undefined;

  const dispose = async () => {
    disposed = true;

    offGrowthSkills?.();
    offGrowthSkills = undefined;
    offGrowthTools?.();
    offGrowthTools = undefined;
    await growthRuntime?.stop();

    offCareTools?.();
    offCareTools = undefined;
    await careRuntime?.stop();

    offSleepTools?.();
    offSleepTools = undefined;
    await sleepRuntime?.stop();

    offStream?.();
    offStream = undefined;
    offReqErr?.();
    offReqErr = undefined;
    offNeedsTools?.();
    offNeedsTools = undefined;
    await needsRuntime?.stop();

    offSenseTools?.();
    offSenseTools = undefined;
    await senseRuntime?.stop();
  };

  ctx.effect(() => dispose, 'asi unified runtime');

  try {
    // 0. Automatic non-destructive migration from legacy sibling `../asi-*` directories
    await migrateLegacyAsiData(config.storageRoot);
    if (disposed) return;

    const senseRoot = join(config.storageRoot, 'sense');
    const needsRoot = join(config.storageRoot, 'needs');
    const sleepRoot = join(config.storageRoot, 'sleep');
    const careRoot = join(config.storageRoot, 'care');
    const growthRoot = join(config.storageRoot, 'growth');

    // 1. L0 Pure Sensory Organ (`ctx.asiSense` + `env_state` / `env_detail`)
    const local = localPorts(ctx, senseRoot);
    senseRuntime = createSenseRuntime(
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
    await senseRuntime.start();
    if (disposed) {
      await dispose();
      return;
    }
    offSenseTools = registerSenseTools(ctx, senseRuntime, local.clock.wall);
    new AsiSenseService(ctx, senseRuntime, senseRoot);

    // 2. L1 Survival Homeostasis & Maslow Arbiter (`ctx.asiDrives` + `needs_status`)
    const needsPorts = createDshNeedsPorts(ctx, needsRoot);
    needsRuntime = createNeedsRuntime(needsPorts);
    offNeedsTools = registerNeedsTools(ctx, needsRuntime);
    offReqErr = ctx.on('agent/request-error', async (payload, next) => {
      const f = payload.failure;
      if (
        f &&
        (f.status === undefined ||
          f.status >= 500 ||
          /network|timeout|connect|refused|fetch/i.test(`${f.code} ${f.message}`))
      ) {
        needsRuntime?.reportTransportResult(false, f.message);
      }
      return next();
    });
    offStream = ctx.on('agent/assistant-stream', ({ frame }) => {
      if (frame.type === 'start') {
        needsRuntime?.reportTransportResult(true);
      }
    });
    await needsRuntime.start();
    if (disposed) {
      await dispose();
      return;
    }
    new AsiDrivesService(ctx, needsRuntime);

    // 3. L2 Biological NREM+REM Sleep Consolidation & Memory Vault (`ctx.asiSleep` + `memory_recall` / `memory_profile`)
    const sleepPorts = createDshSleepPorts(ctx, sleepRoot);
    sleepRuntime = createSleepRuntime(sleepPorts);
    offSleepTools = registerSleepTools(ctx, sleepRuntime, buildExcludedInternalRoots(sleepRoot, senseRoot));
    await sleepRuntime.start();
    if (disposed) {
      await dispose();
      return;
    }
    new AsiSleepService(ctx, sleepRuntime);

    // 4. L3 Workspace, Multi-Worktree Hygiene, Orphan Dev Port & Artifact Care (`care_status`)
    const carePorts = createDshCarePorts(ctx, careRoot);
    careRuntime = createCareRuntime(carePorts, {
      ...(config.extraRoots ? { extraRoots: config.extraRoots } : {}),
      ...(config.ignorePaths ? { ignorePaths: config.ignorePaths } : {}),
      ...(config.fastIntervalMs !== undefined ? { fastIntervalMs: config.fastIntervalMs } : {}),
      ...(config.slowIntervalMs !== undefined ? { slowIntervalMs: config.slowIntervalMs } : {}),
    });
    offCareTools = registerCareTools(ctx, careRuntime);
    await careRuntime.start();
    if (disposed) {
      await dispose();
      return;
    }

    // 5. L4 Procedural Skill Synthesis & Hot Mounting (`ctx.skills.registerProvider` + `growth_status`)
    const growthPorts = createDshGrowthPorts(ctx, growthRoot);
    growthRuntime = createGrowthRuntime(growthPorts);
    offGrowthTools = registerGrowthTools(ctx, growthRuntime);
    offGrowthSkills = registerDshSkillBridge(ctx, growthRuntime.skillBridge, growthRoot);
    await growthRuntime.start();
    if (disposed) {
      await dispose();
      return;
    }

    // 6. Unified TypeRT Remote Service (`ctx.asi`) for the single unified sidebar panel
    new AsiRemote(ctx, {
      needsActions: needsRuntime.actions,
      sleepActions: sleepRuntime.actions,
      growthActions: growthRuntime.actions,
      framesSource: createAsiFramesSource({
        needs: needsRuntime,
        sleep: sleepRuntime,
        growth: growthRuntime,
      }),
    });
  } catch (error) {
    await dispose();
    throw error;
  }
}
