import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AsiDreamServiceApi,
  AsiDrivesServiceApi,
  AsiIntuitionServiceApi,
  AsiSenseServiceApi,
  AsiSleepServiceApi,
  AsiTomServiceApi,
} from '@asi/sense-types';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-app-boot';
import z from '@deepseek-ai/schemastery';
import { createDshCarePorts } from '../../care/host/dsh/ports.ts';
import { registerCareTools } from '../../care/host/dsh/tools.ts';
import { createCareRuntime } from '../../care/host/runtime.ts';
import { AsiDreamService } from '../../dream/host/dsh/dream-service.ts';
import { createDshDreamPorts } from '../../dream/host/dsh/dsh-ports.ts';
import { registerDreamTools } from '../../dream/host/dsh/tools.ts';
import { createDreamRuntime } from '../../dream/host/runtime.ts';
import { createDshGrowthPorts, registerDshSkillBridge } from '../../growth/host/dsh/dsh-ports.ts';
import { registerGrowthTools } from '../../growth/host/dsh/tools.ts';
import { createGrowthRuntime } from '../../growth/host/runtime.ts';
import { createDshIntuitionPorts } from '../../intuition/host/dsh/dsh-ports.ts';
import { AsiIntuitionService } from '../../intuition/host/dsh/intuition-service.ts';
import { registerIntuitionTools } from '../../intuition/host/dsh/tools.ts';
import { createIntuitionRuntime } from '../../intuition/host/runtime.ts';
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
import { buildUnifiedExcludedInternalRoots } from '../../shared/internal-guards.ts';
import { createDshSleepPorts } from '../../sleep/host/dsh/dsh-ports.ts';
import { AsiSleepService } from '../../sleep/host/dsh/sleep-service.ts';
import { registerSleepTools } from '../../sleep/host/dsh/tools.ts';
import { createSleepRuntime } from '../../sleep/host/runtime.ts';
import { createDshTomPorts } from '../../tom/host/dsh/dsh-ports.ts';
import { AsiTomService } from '../../tom/host/dsh/tom-service.ts';
import { registerTomTools } from '../../tom/host/dsh/tools.ts';
import { createTomRuntime } from '../../tom/host/runtime.ts';
import { createAsiFramesSource } from './frames.ts';
import { AsiRemote } from './remote.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    asiSense: AsiSenseServiceApi;
    asiDrives: AsiDrivesServiceApi;
    asiSleep: AsiSleepServiceApi;
    asiIntuition: AsiIntuitionServiceApi;
    asiTom: AsiTomServiceApi;
    asiDream: AsiDreamServiceApi;
    asi: AsiRemote;
  }
}

export { AsiDreamService } from '../../dream/host/dsh/dream-service.ts';
export { AsiIntuitionService } from '../../intuition/host/dsh/intuition-service.ts';
export { type LegacyMigrationReport, migrateLegacyAsiData } from '../../migration/legacy-migration.ts';
export { AsiDrivesService } from '../../needs/host/dsh/drives-service.ts';
export { AsiSenseService } from '../../sense/host/dsh/index.ts';
export { AsiSleepService } from '../../sleep/host/dsh/sleep-service.ts';
export { AsiTomService } from '../../tom/host/dsh/tom-service.ts';
export { AsiRemote } from './remote.ts';
export type {
  AsiPanelModel,
  JsonObject,
  JsonValue,
  WireArchivedSkillViewItem,
  WireAsiPanelModel,
  WireDreamAdoptMemoryInput,
  WireDreamAdoptResult,
  WireDreamCycleRecord,
  WireDreamInsightKind,
  WireDreamInsightStatus,
  WireDreamInsightViewItem,
  WireDreamPanelModel,
  WireDreamPromoteResult,
  WireFlashbackFeedback,
  WireFlashbackMatch,
  WireFlashbackRecord,
  WireGrowthPanelModel,
  WireGrowthSynthesisRecord,
  WireIntuitionPanelModel,
  WireMemoryCreateInput,
  WireMemoryKind,
  WireMemoryUpdateInput,
  WireMemoryViewItem,
  WireNeedsPanelModel,
  WirePartnerOverrideInput,
  WirePartnerStateKind,
  WireProspectiveCreateInput,
  WireProspectiveIntention,
  WireProspectiveResolveInput,
  WireSkillCreateDraftInput,
  WireSkillDraftViewItem,
  WireSkillExportResult,
  WireSkillScope,
  WireSkillScopeUpdateInput,
  WireSkillUpdateMarkdownInput,
  WireSkillViewItem,
  WireSleepConsolidationRecord,
  WireSleepPanelModel,
  WireTomPanelModel,
} from './wire-types.ts';

export const name = 'asi';
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
  let tomRuntime: ReturnType<typeof createTomRuntime> | undefined;
  let intuitionRuntime: ReturnType<typeof createIntuitionRuntime> | undefined;
  let dreamRuntime: ReturnType<typeof createDreamRuntime> | undefined;

  let offSenseTools: (() => void) | undefined;
  let offNeedsTools: (() => void) | undefined;
  let offReqErr: (() => void) | undefined;
  let offStream: (() => void) | undefined;
  let offSleepTools: (() => void) | undefined;
  let offCareTools: (() => void) | undefined;
  let offGrowthTools: (() => void) | undefined;
  let offGrowthSkills: (() => void) | undefined;
  let offTomTools: (() => void) | undefined;
  let offIntuitionTools: (() => void) | undefined;
  let offDreamTools: (() => void) | undefined;

  const dispose = async () => {
    disposed = true;

    offDreamTools?.();
    offDreamTools = undefined;
    offIntuitionTools?.();
    offIntuitionTools = undefined;
    offTomTools?.();
    offTomTools = undefined;
    offGrowthSkills?.();
    offGrowthSkills = undefined;
    offGrowthTools?.();
    offGrowthTools = undefined;
    offCareTools?.();
    offCareTools = undefined;
    offSleepTools?.();
    offSleepTools = undefined;

    // Kick off higher-order runtime stops synchronously in the same tick so all
    // `stopped` flags & probe aborts take effect before Cordis tears down `ctx` proxies.
    await Promise.allSettled([
      dreamRuntime?.stop(),
      intuitionRuntime?.stop(),
      tomRuntime?.stop(),
      growthRuntime?.stop(),
      careRuntime?.stop(),
      sleepRuntime?.stop(),
    ]);

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
    const tomRoot = join(config.storageRoot, 'tom');
    const intuitionRoot = join(config.storageRoot, 'intuition');
    const dreamRoot = join(config.storageRoot, 'dream');
    const allInternalRoots = [senseRoot, needsRoot, sleepRoot, careRoot, growthRoot, tomRoot, intuitionRoot, dreamRoot];

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
    offSleepTools = registerSleepTools(ctx, sleepRuntime, buildUnifiedExcludedInternalRoots(...allInternalRoots));
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
    offGrowthTools = registerGrowthTools(ctx, growthRuntime, allInternalRoots);
    offGrowthSkills = registerDshSkillBridge(ctx, growthRuntime.skillBridge, growthRoot);
    await growthRuntime.start();
    if (disposed) {
      await dispose();
      return;
    }

    // 6. Theory of Mind — Partner State & Collaborative Tact (`ctx.asiTom` + `partner_state`)
    const tomPorts = createDshTomPorts(ctx, tomRoot);
    tomRuntime = createTomRuntime(tomPorts);
    offTomTools = registerTomTools(ctx, tomRuntime, allInternalRoots);
    await tomRuntime.start();
    if (disposed) {
      await dispose();
      return;
    }
    new AsiTomService(ctx, tomRuntime);

    // 7. Prefrontal Gut-Feeling Somatic Markers & Prospective Memory (`ctx.asiIntuition` + `intuition_status` / `prospective_*`)
    const intuitionPorts = createDshIntuitionPorts(ctx, intuitionRoot, {
      excludedRoots: allInternalRoots,
      sleepRuntime,
      tom: ctx.asiTom,
    });
    intuitionRuntime = createIntuitionRuntime(intuitionPorts);
    offIntuitionTools = registerIntuitionTools(ctx, intuitionRuntime, allInternalRoots);
    await intuitionRuntime.start();
    if (disposed) {
      await dispose();
      return;
    }
    new AsiIntuitionService(ctx, intuitionRuntime);

    // 8. DMN Default Mode Network Cross-Repo Insight Dreaming (`ctx.asiDream` + `dream_insights`)
    const dreamPorts = createDshDreamPorts(ctx, dreamRoot, {
      memoryAdoption: sleepRuntime.actions,
      skillDrafts: growthRuntime.actions,
      tom: ctx.asiTom,
    });
    dreamRuntime = createDreamRuntime(dreamPorts);
    offDreamTools = registerDreamTools(ctx, dreamRuntime, allInternalRoots);
    await dreamRuntime.start();
    if (disposed) {
      await dispose();
      return;
    }
    new AsiDreamService(ctx, dreamRuntime);

    // 9. Unified TypeRT Remote Service (`ctx.asi`) for the single unified sidebar panel
    new AsiRemote(ctx, {
      needsActions: needsRuntime.actions,
      sleepActions: sleepRuntime.actions,
      growthActions: growthRuntime.actions,
      intuitionActions: intuitionRuntime.actions,
      tomActions: tomRuntime.actions,
      dreamActions: dreamRuntime.actions,
      framesSource: createAsiFramesSource({
        needs: needsRuntime,
        sleep: sleepRuntime,
        growth: growthRuntime,
        intuition: intuitionRuntime,
        tom: tomRuntime,
        dream: dreamRuntime,
      }),
    });
  } catch (error) {
    await dispose();
    throw error;
  }
}
