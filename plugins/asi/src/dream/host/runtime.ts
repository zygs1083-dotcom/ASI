/**
 * Default Mode Network (DMN) Cross-Repo Insight Runtime (`asi-dream`).
 *
 * Coordinates:
 * - Maslow Tier 4 drive registration (`asi-dream:cross_repo_insight`) with immediate
 *   L1–L3 / `eco` suppression & `AbortController` preemption + quota rollback.
 * - 15-minute deep-quiet / lockscreen autonomous dream scheduling (`<= 3` auto cycles/day).
 * - Read-only `AsiDreamServiceApi` (`listInsights`, `subscribe`) and on-demand
 *   `dream_insights` tool queries (with optional `workspacePath` repo-affinity ranking).
 * - Closed-loop user actions: `dreamNow`, `setAutoDreamPaused`, `adoptInsightAsMemory`
 *   (promotes into L2 `MemoryVault`), `promoteInsightToSkillDraft` (drafts pure-text
 *   `SKILL.md` into L4 Skill Studio), and `dismissInsight` (records pair dampening).
 */

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DreamInsightQueryOptions,
  DreamInsightSummary,
  ExternalDriveReading,
  SenseSnapshot,
} from '@asi/sense-types';
import { searchDreamInsights, sortDreamInsights } from '../shared/search.js';
import {
  DREAM_INSIGHT_KIND_LABELS,
  type DreamAdoptMemoryInput,
  type DreamAdoptResult,
  type DreamCycleRecord,
  type DreamCycleTrigger,
  type DreamInsightEntry,
  type DreamInsightKind,
  type DreamInsightStatus,
  type DreamInsightViewItem,
  type DreamPanelModel,
  type DreamPromoteResult,
} from '../shared/types.ts';
import { discoverCandidateCrossRepoBridges, isDreamInsightKind, runDmnDreamCycle } from './dream-engine.ts';
import {
  DAILY_AUTO_DREAM_QUOTA,
  DMN_QUIET_IDLE_THRESHOLD_MS,
  DREAM_ROLLING_DAY_WINDOW_MS,
  detectDreamLowerTierBlock,
  evaluateDreamState,
} from './evaluator.ts';
import type { DreamHostPorts } from './ports.ts';
import {
  collectRepoProfiles,
  type RepoStructuralProfile,
  resolveCanonicalRepoIdentity,
  sanitizeDreamText,
} from './repo-profiler.js';
import { DreamVault } from './vault.js';

const PROFILE_CACHE_TTL_MS = 60_000;
const MAX_TRACKED_SIGNATURES = 600;

interface PersistedDreamState {
  autoDreamPaused: boolean;
  lastDreamAt: number | null;
  lastOrdinaryActivityAt: number;
  autoRunTimestamps: number[];
  dreamedPairSignatures: Record<string, string>;
  dismissedPairPenalties: Record<string, number>;
}

export interface DreamQueryToolInput {
  query?: string;
  kind?: DreamInsightKind;
  status?: DreamInsightStatus | 'all';
  callerWorkspacePath?: string;
  forCurrentWorkspace?: boolean;
  limit?: number;
}

export interface DreamQueryToolResult {
  now: number;
  discoveredRepoCount: number;
  totalInsights: number;
  openCount: number;
  matchedCount: number;
  insights: DreamInsightSummary[];
}

export interface DreamActionsApi {
  dreamNow(): Promise<DreamCycleRecord>;
  setAutoDreamPaused(paused: boolean): Promise<void>;
  adoptInsightAsMemory(input: DreamAdoptMemoryInput): Promise<DreamAdoptResult>;
  promoteInsightToSkillDraft(insightId: string): Promise<DreamPromoteResult>;
  dismissInsight(insightId: string): Promise<DreamInsightViewItem>;
  searchInsights(
    query: string,
    kind?: DreamInsightKind,
    status?: DreamInsightStatus | 'all',
  ): Promise<DreamInsightViewItem[]>;
}

export interface DreamRuntime {
  readonly vault: DreamVault;
  readonly actions: DreamActionsApi;
  start(): Promise<void>;
  stop(): Promise<void>;
  panelModel(): DreamPanelModel;
  listInsights(options?: DreamInsightQueryOptions): DreamInsightSummary[];
  queryForTool(input: DreamQueryToolInput): Promise<DreamQueryToolResult>;
  subscribe(listener: () => void): () => void;
  subscribeInsights(listener: () => void): () => void;
}

function toSummary(entry: DreamInsightEntry): DreamInsightSummary {
  return {
    id: entry.id,
    kind: entry.kind,
    status: entry.status,
    title: entry.title,
    summary: entry.summary,
    bridgeMechanism: entry.bridgeMechanism,
    actionableHypothesis: entry.actionableHypothesis,
    sourceRepos: [...entry.sourceRepos],
    ...(entry.targetRepo ? { targetRepo: entry.targetRepo } : {}),
    sourceMemoryIds: [...entry.sourceMemoryIds],
    sourceSessionIds: [...entry.sourceSessionIds],
    tags: [...entry.tags],
    topicKey: entry.topicKey,
    noveltyScore: entry.noveltyScore,
    structuralSimilarity: entry.structuralSimilarity,
    confidence: entry.confidence,
    ...(entry.adoptedMemoryId ? { adoptedMemoryId: entry.adoptedMemoryId } : {}),
    ...(entry.promotedDraftId ? { promotedDraftId: entry.promotedDraftId } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function deriveSkillSlugFromInsight(entry: DreamInsightEntry): string {
  const raw = `dmn-${entry.topicKey.replace(/^(?:dmn|bridge|tension):/i, '')}-${entry.id.slice(-4)}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const trimmed = raw.slice(0, 48).replace(/-+$/g, '');
  return trimmed.length >= 3 ? trimmed : `dmn-insight-${entry.id.slice(-6).toLowerCase()}`;
}

export function createDreamRuntime(ports: DreamHostPorts): DreamRuntime {
  const clock = ports.clock ?? { wall: () => Date.now(), mono: () => performance.now() };
  const statePath = join(ports.storageRoot, 'state.json');
  const vault = new DreamVault(ports.storageRoot, ports.homeDir);

  let started = false;
  let stopped = false;
  let autoDreamPaused = false;
  let lastDreamAt: number | null = null;
  let lastOrdinaryActivityAt = clock.wall();
  let autoRunTimestamps: number[] = [];
  let dreamedPairSignatures: Record<string, string> = {};
  let dismissedPairPenalties: Record<string, number> = {};

  let latestSense: SenseSnapshot = ports.sense.snapshot();
  let cachedProfiles: RepoStructuralProfile[] = [];
  let cachedCwdToRepoKey = new Map<string, string>();
  let cachedProfilesAt = Number.NEGATIVE_INFINITY;
  let cachedCandidateCount = 0;
  let profileRefreshInFlight: Promise<void> | undefined;

  let activeDreamPromise: Promise<DreamCycleRecord> | undefined;
  let activeDreamAbort: AbortController | undefined;
  let activeDreamTrigger: DreamCycleTrigger | null = null;
  let activeAutoTimestamp: number | null = null;
  let coldWarmupAbort: AbortController | undefined;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let stateWriteChain: Promise<void> = Promise.resolve();

  const subscribers = new Set<() => void>();
  const insightSubscribers = new Set<() => void>();
  let offSense: (() => void) | undefined;
  let offDrives: (() => void) | undefined;
  let offDriveSource: (() => void) | undefined;
  let offConversations: (() => void) | undefined;
  let offSleep: (() => void) | undefined;

  function notify(): void {
    if (stopped) return;
    for (const fn of [...subscribers]) {
      try {
        fn();
      } catch {
        // Isolate subscriber error
      }
    }
  }

  function notifyInsightsChanged(): void {
    if (stopped) return;
    for (const fn of [...insightSubscribers]) {
      try {
        fn();
      } catch {
        // Isolate subscriber error
      }
    }
  }

  function clearQuietTimer(): void {
    if (quietTimer !== undefined) {
      clearTimeout(quietTimer);
      quietTimer = undefined;
    }
  }

  function pruneOldTimestamps(now: number): void {
    autoRunTimestamps = autoRunTimestamps.filter((ts) => now - ts < DREAM_ROLLING_DAY_WINDOW_MS);
  }

  function trimSignatureMap(map: Record<string, string>): Record<string, string> {
    const entries = Object.entries(map);
    if (entries.length <= MAX_TRACKED_SIGNATURES) return map;
    return Object.fromEntries(entries.slice(entries.length - MAX_TRACKED_SIGNATURES));
  }

  function persistState(): Promise<void> {
    const run = async () => {
      await mkdir(ports.storageRoot, { recursive: true });
      const existing = await lstat(statePath).catch(() => undefined);
      if (existing?.isSymbolicLink()) {
        throw new Error('Refusing to write symlinked dream state.json');
      }
      const payload: PersistedDreamState = {
        autoDreamPaused,
        lastDreamAt,
        lastOrdinaryActivityAt,
        autoRunTimestamps: [...autoRunTimestamps],
        dreamedPairSignatures: trimSignatureMap(dreamedPairSignatures),
        dismissedPairPenalties: { ...dismissedPairPenalties },
      };
      const tmp = `${statePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      try {
        await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        await rename(tmp, statePath);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
    };
    const next = stateWriteChain.then(run, run);
    stateWriteChain = next.catch(() => undefined);
    return next;
  }

  function recomputeCandidateCountSync(): void {
    if (cachedProfiles.length < 2) {
      cachedCandidateCount = 0;
      return;
    }
    const sleepSvc = ports.getSleep();
    const memories = sleepSvc ? sleepSvc.listMemories({ minRetention: 0.3, limit: 240 }) : [];
    let turns: ReturnType<DreamHostPorts['conversations']['listCompletedOrdinaryTurns']> = [];
    let sessionWorkspaces: ReadonlyMap<string, string> = new Map();
    try {
      turns = ports.conversations.listCompletedOrdinaryTurns();
      sessionWorkspaces = ports.conversations.listSessionWorkspaces();
    } catch {
      turns = [];
    }
    const candidates = discoverCandidateCrossRepoBridges({
      repoProfiles: cachedProfiles,
      cwdToRepoKey: cachedCwdToRepoKey,
      sessionWorkspaces,
      memories,
      turns,
      dreamedPairSignatures,
      dismissedPairPenalties,
      homeDir: ports.homeDir,
    });
    cachedCandidateCount = candidates.length;
  }

  async function refreshRepoProfiles(force = false): Promise<void> {
    const nowMono = clock.mono();
    if (!force && nowMono - cachedProfilesAt < PROFILE_CACHE_TTL_MS && cachedProfiles.length > 0) {
      recomputeCandidateCountSync();
      return;
    }
    if (profileRefreshInFlight) {
      await profileRefreshInFlight;
      return;
    }
    const task = (async () => {
      try {
        const known = ports.conversations.listKnownWorkspaces();
        const sessionMap = ports.conversations.listSessionWorkspaces();
        const allPaths = [...known, ...sessionMap.values()];
        const collected = await collectRepoProfiles(allPaths, {
          homeDir: ports.homeDir,
          excludedRoots: [ports.storageRoot, ...(ports.excludedInternalRoots ?? [])],
        });
        if (stopped) return;
        cachedProfiles = collected.profiles;
        cachedCwdToRepoKey = collected.cwdToRepoKey;
        cachedProfilesAt = clock.mono();
        recomputeCandidateCountSync();
      } catch {
        // Keep previous cached profiles on transient FS error
      }
    })();
    profileRefreshInFlight = task.finally(() => {
      profileRefreshInFlight = undefined;
    });
    await profileRefreshInFlight;
  }

  function currentEvaluatedState(senseSnap?: SenseSnapshot) {
    const now = clock.wall();
    pruneOldTimestamps(now);
    const sense = senseSnap ?? latestSense;
    const drivesSnap = ports.drives.snapshot();
    const openInsightCount = vault.list().filter((i) => i.status === 'open').length;
    return evaluateDreamState({
      now,
      sense,
      drivesSnapshot: drivesSnap,
      discoveredRepoCount: cachedProfiles.length,
      candidateBridgeCount: cachedCandidateCount,
      openInsightCount,
      lastDreamAt,
      lastOrdinaryActivityAt,
      anyOrdinarySessionRunning: ports.conversations.anyOrdinarySessionRunning(),
      autoDreamPaused,
      autoDreamTimestamps: autoRunTimestamps,
    });
  }

  function preemptAutoDreamIfNeeded(): void {
    if (!activeDreamAbort || activeDreamTrigger !== 'auto') return;
    const block = detectDreamLowerTierBlock(latestSense, ports.drives.snapshot());
    if (
      block.suppressed ||
      block.lowerTierBlocked ||
      latestSense.settings.paused ||
      autoDreamPaused ||
      ports.conversations.anyOrdinarySessionRunning()
    ) {
      activeDreamAbort.abort();
    }
  }

  function scheduleQuietCheck(): void {
    clearQuietTimer();
    if (!started || stopped || activeDreamPromise) return;
    const ev = currentEvaluatedState();
    if (ev.canAutoDream) {
      void executeDreamCycle('auto').catch(() => undefined);
      return;
    }
    if (
      ev.driveView.readyToDream &&
      !autoDreamPaused &&
      !latestSense.settings.paused &&
      !ev.driveView.suppressed &&
      !ev.driveView.lowerTierBlocked &&
      ev.remainingAutoQuota > 0 &&
      !ev.driveView.deepQuietWindow &&
      !ports.conversations.anyOrdinarySessionRunning()
    ) {
      const waitMs = Math.max(250, DMN_QUIET_IDLE_THRESHOLD_MS - ev.driveView.idleDurationMs + 50);
      quietTimer = setTimeout(
        () => {
          quietTimer = undefined;
          if (!stopped) {
            void refreshRepoProfiles(false).then(() => {
              ports.drives.notifySourceChanged('asi-dream');
              scheduleQuietCheck();
              notify();
            });
          }
        },
        Math.min(waitMs, 60 * 60_000),
      );
      quietTimer.unref?.();
    }
  }

  async function executeDreamCycle(
    trigger: DreamCycleTrigger,
    externalSignal?: AbortSignal,
  ): Promise<DreamCycleRecord> {
    if (stopped) {
      throw new Error('Dream runtime is stopped');
    }
    if (activeDreamPromise) {
      if (trigger !== 'auto' && activeDreamTrigger === 'auto' && activeDreamAbort) {
        activeDreamAbort.abort();
        await activeDreamPromise.catch(() => undefined);
      } else {
        return activeDreamPromise;
      }
    }

    const abortController = new AbortController();
    const onExternalAbort = () => abortController.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        abortController.abort();
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    const nowStart = clock.wall();
    let recordedTs: number | null = null;
    if (trigger === 'auto') {
      pruneOldTimestamps(nowStart);
      if (autoRunTimestamps.length >= DAILY_AUTO_DREAM_QUOTA) {
        throw new Error('Daily auto dream quota reached');
      }
      recordedTs = nowStart;
      autoRunTimestamps.push(recordedTs);
      activeAutoTimestamp = recordedTs;
    }

    activeDreamAbort = abortController;
    activeDreamTrigger = trigger;
    notify();

    const run = (async (): Promise<DreamCycleRecord> => {
      try {
        await refreshRepoProfiles(true);
        if (abortController.signal.aborted) {
          const err = new Error('DMN dream cycle aborted');
          err.name = 'AbortError';
          throw err;
        }

        const sleepSvc = ports.getSleep();
        const memories = sleepSvc ? sleepSvc.listMemories({ minRetention: 0.3, limit: 240 }) : [];
        const turns = ports.conversations.listCompletedOrdinaryTurns();
        const sessionWorkspaces = ports.conversations.listSessionWorkspaces();

        const result = await runDmnDreamCycle({
          now: clock.wall(),
          trigger,
          signal: abortController.signal,
          homeDir: ports.homeDir,
          repoProfiles: cachedProfiles,
          cwdToRepoKey: cachedCwdToRepoKey,
          sessionWorkspaces,
          memories,
          turns,
          existingInsights: vault.list(),
          dreamedPairSignatures,
          dismissedPairPenalties,
          ...(ports.llmDream ? { llmDream: ports.llmDream } : {}),
        });

        if (abortController.signal.aborted) {
          const err = new Error('DMN dream cycle aborted');
          err.name = 'AbortError';
          throw err;
        }

        dreamedPairSignatures = trimSignatureMap(result.updatedDreamedSignatures);
        lastDreamAt = result.record.at;
        vault.replaceAll(result.insights);
        const savedRecord = vault.appendJournal(result.record);
        recomputeCandidateCountSync();

        await Promise.all([vault.flush(), persistState()]);
        ports.drives.notifySourceChanged('asi-dream');
        notifyInsightsChanged();
        notify();
        return savedRecord;
      } catch (err) {
        if (recordedTs !== null) {
          autoRunTimestamps = autoRunTimestamps.filter((t) => t !== recordedTs);
        }
        throw err;
      } finally {
        externalSignal?.removeEventListener('abort', onExternalAbort);
        if (activeDreamAbort === abortController) {
          activeDreamAbort = undefined;
          activeDreamTrigger = null;
          activeDreamPromise = undefined;
          activeAutoTimestamp = null;
        }
        if (!stopped) {
          ports.drives.notifySourceChanged('asi-dream');
          scheduleQuietCheck();
          notify();
        }
      }
    })();

    activeDreamPromise = run;
    return run;
  }

  const actions: DreamActionsApi = {
    async dreamNow(): Promise<DreamCycleRecord> {
      return await executeDreamCycle('manual');
    },

    async setAutoDreamPaused(paused: boolean): Promise<void> {
      autoDreamPaused = Boolean(paused);
      if (autoDreamPaused) {
        preemptAutoDreamIfNeeded();
        clearQuietTimer();
      } else {
        scheduleQuietCheck();
      }
      await persistState();
      ports.drives.notifySourceChanged('asi-dream');
      notify();
    },

    async adoptInsightAsMemory(input: DreamAdoptMemoryInput): Promise<DreamAdoptResult> {
      const id = String(input.insightId ?? '').trim();
      if (!id) throw new Error('insightId is required');
      const existing = vault.get(id);
      if (!existing) throw new Error(`未找到顿悟记录: ${id}`);
      if (!ports.memoryAdoption) {
        throw new Error('L2 记忆库桥接未就绪，无法固化记忆');
      }

      const kind = existing.kind === 'preventive-warning' ? 'pitfall' : 'decision';
      const created = await ports.memoryAdoption.createMemory({
        kind,
        title: existing.title,
        content: `${existing.summary}\n同构机制：${existing.bridgeMechanism}\n迁移行动：${existing.actionableHypothesis}`,
        tags: [...new Set([...existing.tags, 'dmn-insight'])].slice(0, 10),
        topicKey: existing.topicKey,
        pinned: input.pinned ?? true,
      });

      const updated = vault.upsert({
        ...existing,
        status: 'adopted',
        adoptedMemoryId: created.id,
        updatedAt: clock.wall(),
      });
      await vault.flush();
      notifyInsightsChanged();
      notify();
      return {
        insight: updated,
        memoryId: created.id,
      };
    },

    async promoteInsightToSkillDraft(insightId: string): Promise<DreamPromoteResult> {
      const id = String(insightId ?? '').trim();
      if (!id) throw new Error('insightId is required');
      const existing = vault.get(id);
      if (!existing) throw new Error(`未找到顿悟记录: ${id}`);
      if (!ports.skillDrafts) {
        throw new Error('L4 技能工坊桥接未就绪，无法生成草案');
      }

      const skillName = deriveSkillSlugFromInsight(existing);
      const kindLabel = DREAM_INSIGHT_KIND_LABELS[existing.kind];
      const bodyLines = [
        `# ${existing.title}`,
        '',
        `## 跨项目顿悟背景（${kindLabel}）`,
        '',
        existing.summary,
        '',
        '## 底层同构机制',
        '',
        existing.bridgeMechanism,
        '',
        '## 标准执行与检查步骤',
        '',
        `1. 识别当前仓库是否涉及上述机制面或关联栈（来源参考：${existing.sourceRepos.join('、')}）。`,
        `2. 落实跨仓验证结论：${existing.actionableHypothesis}`,
        '3. 变更完成后运行对应工作区的类型检查与单元测试验证回归。',
      ];

      const draft = await ports.skillDrafts.createManualDraft({
        name: skillName,
        description: sanitizeDreamText(`${kindLabel}：${existing.title}`, 140, ports.homeDir),
        whenToUse: sanitizeDreamText(
          `当涉及 ${
            existing.tags
              .filter((t) => t !== 'cross-repo')
              .slice(0, 4)
              .join(' / ') || existing.topicKey
          } 相关跨仓架构设计或排障避坑时调用。`,
          160,
          ports.homeDir,
        ),
        body: bodyLines.join('\n'),
        scope: 'global',
      });

      const updated = vault.upsert({
        ...existing,
        status: 'promoted',
        promotedDraftId: draft.id,
        updatedAt: clock.wall(),
      });
      await vault.flush();
      notifyInsightsChanged();
      notify();
      return {
        insight: updated,
        draftId: draft.id,
        skillName: draft.name,
      };
    },

    async dismissInsight(insightId: string): Promise<DreamInsightViewItem> {
      const id = String(insightId ?? '').trim();
      if (!id) throw new Error('insightId is required');
      const existing = vault.get(id);
      if (!existing) throw new Error(`未找到顿悟记录: ${id}`);

      if (existing.pairSignature) {
        dismissedPairPenalties[existing.pairSignature] = (dismissedPairPenalties[existing.pairSignature] ?? 0) + 1;
      }
      const updated = vault.upsert({
        ...existing,
        status: 'dismissed',
        updatedAt: clock.wall(),
      });
      recomputeCandidateCountSync();
      await Promise.all([vault.flush(), persistState()]);
      ports.drives.notifySourceChanged('asi-dream');
      notifyInsightsChanged();
      notify();
      return updated;
    },

    async searchInsights(
      query: string,
      kind?: DreamInsightKind,
      status?: DreamInsightStatus | 'all',
    ): Promise<DreamInsightViewItem[]> {
      const statuses: readonly DreamInsightStatus[] | undefined = !status || status === 'all' ? undefined : [status];
      return searchDreamInsights(vault.list(), query, {
        ...(kind ? { kind } : {}),
        ...(statuses ? { statuses } : {}),
        limit: 100,
      });
    },
  };

  return {
    vault,
    actions,

    async start(): Promise<void> {
      if (started) return;
      started = true;
      stopped = false;

      await mkdir(ports.storageRoot, { recursive: true });
      await vault.load();

      try {
        const st = await lstat(statePath).catch(() => undefined);
        if (st?.isFile() && !st.isSymbolicLink()) {
          const raw = JSON.parse(await readFile(statePath, 'utf8')) as Partial<PersistedDreamState>;
          if (typeof raw.autoDreamPaused === 'boolean') autoDreamPaused = raw.autoDreamPaused;
          if (typeof raw.lastDreamAt === 'number' && Number.isFinite(raw.lastDreamAt)) lastDreamAt = raw.lastDreamAt;
          if (typeof raw.lastOrdinaryActivityAt === 'number' && Number.isFinite(raw.lastOrdinaryActivityAt)) {
            lastOrdinaryActivityAt = raw.lastOrdinaryActivityAt;
          }
          if (Array.isArray(raw.autoRunTimestamps)) {
            autoRunTimestamps = raw.autoRunTimestamps.filter(
              (n): n is number => typeof n === 'number' && Number.isFinite(n),
            );
          }
          if (raw.dreamedPairSignatures && typeof raw.dreamedPairSignatures === 'object') {
            dreamedPairSignatures = Object.fromEntries(
              Object.entries(raw.dreamedPairSignatures).filter(
                (kv): kv is [string, string] => typeof kv[0] === 'string' && typeof kv[1] === 'string',
              ),
            );
          }
          if (raw.dismissedPairPenalties && typeof raw.dismissedPairPenalties === 'object') {
            dismissedPairPenalties = Object.fromEntries(
              Object.entries(raw.dismissedPairPenalties).filter(
                (kv): kv is [string, number] =>
                  typeof kv[0] === 'string' && typeof kv[1] === 'number' && Number.isFinite(kv[1]),
              ),
            );
          }
        }
      } catch {
        // Fresh or unreadable state defaults cleanly
      }

      latestSense = ports.sense.snapshot();
      await refreshRepoProfiles(true);
      if (stopped) return;

      offDriveSource = ports.drives.registerSource({
        id: 'asi-dream',
        tier: 4,
        label: 'DMN 跨项目睡眠做梦',
        evaluate: (snap: SenseSnapshot): readonly ExternalDriveReading[] => {
          latestSense = snap;
          const ev = currentEvaluatedState(snap);
          return [
            {
              key: 'cross_repo_insight',
              label: 'DMN 跨项目睡眠做梦',
              satisfaction: ev.driveView.satisfaction,
              autoMaintain: false,
              summary: ev.driveView.summary,
              evidence: {
                discoveredRepoCount: ev.driveView.discoveredRepoCount,
                candidateBridgeCount: ev.driveView.candidateBridgeCount,
                openInsightCount: ev.driveView.openInsightCount,
                deepQuietWindow: ev.driveView.deepQuietWindow,
                autoDreamsToday: ev.driveView.autoDreamsToday,
              },
            },
          ];
        },
        sandboxTools: [
          {
            name: 'dream_synthesize_cross_repo',
            description:
              'Run a read-only Default Mode Network (DMN) cross-repository insight dream synthesis cycle inside ASI storage.',
            driveKey: 'asi-dream:cross_repo_insight',
            execute: async (_args, context) => {
              const ctrl = new AbortController();
              const checkAbort = setInterval(() => {
                if (context.signal.aborted) ctrl.abort();
              }, 100);
              checkAbort.unref?.();
              try {
                const rec = await executeDreamCycle('sandbox', ctrl.signal);
                return {
                  summary: rec.summary,
                  data: {
                    reposScanned: rec.reposScanned,
                    bridgesEvaluated: rec.bridgesEvaluated,
                    insightsCreated: rec.insightsCreated,
                  },
                };
              } finally {
                clearInterval(checkAbort);
              }
            },
          },
        ],
      });

      offSense = ports.sense.subscribe((snap) => {
        latestSense = snap;
        preemptAutoDreamIfNeeded();
        scheduleQuietCheck();
        notify();
      });

      offDrives = ports.drives.subscribe(() => {
        preemptAutoDreamIfNeeded();
        scheduleQuietCheck();
        notify();
      });

      offConversations = ports.conversations.onOrdinaryActivity(() => {
        lastOrdinaryActivityAt = clock.wall();
        preemptAutoDreamIfNeeded();
        void refreshRepoProfiles(false).then(() => {
          ports.drives.notifySourceChanged('asi-dream');
          scheduleQuietCheck();
          notify();
        });
      });

      if (ports.onSleepChanged) {
        offSleep = ports.onSleepChanged(() => {
          recomputeCandidateCountSync();
          ports.drives.notifySourceChanged('asi-dream');
          scheduleQuietCheck();
          notify();
        });
      }

      if (ports.conversations.warmColdSessions) {
        coldWarmupAbort = new AbortController();
        void ports.conversations
          .warmColdSessions(coldWarmupAbort.signal)
          .then(() => {
            if (!stopped) {
              return refreshRepoProfiles(true).then(() => {
                ports.drives.notifySourceChanged('asi-dream');
                scheduleQuietCheck();
                notify();
              });
            }
          })
          .catch(() => undefined);
      }

      ports.drives.notifySourceChanged('asi-dream');
      scheduleQuietCheck();
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearQuietTimer();
      coldWarmupAbort?.abort();
      coldWarmupAbort = undefined;
      if (activeDreamAbort) {
        activeDreamAbort.abort();
      }
      if (activeAutoTimestamp !== null) {
        autoRunTimestamps = autoRunTimestamps.filter((t) => t !== activeAutoTimestamp);
        activeAutoTimestamp = null;
      }
      offSleep?.();
      offSleep = undefined;
      offConversations?.();
      offConversations = undefined;
      offDrives?.();
      offDrives = undefined;
      offSense?.();
      offSense = undefined;
      offDriveSource?.();
      offDriveSource = undefined;

      await activeDreamPromise?.catch(() => undefined);
      await Promise.all([vault.waitForIdle(), stateWriteChain]);
      subscribers.clear();
      insightSubscribers.clear();
    },

    panelModel(): DreamPanelModel {
      const now = clock.wall();
      const all = vault.list();
      let openCount = 0;
      let adoptedCount = 0;
      let promotedCount = 0;
      let dismissedCount = 0;
      for (const item of all) {
        if (item.status === 'open') openCount += 1;
        else if (item.status === 'adopted') adoptedCount += 1;
        else if (item.status === 'promoted') promotedCount += 1;
        else if (item.status === 'dismissed') dismissedCount += 1;
      }
      const ev = currentEvaluatedState();
      return {
        now,
        autoDreamPaused,
        dreaming: Boolean(activeDreamPromise),
        drive: ev.driveView,
        openCount,
        adoptedCount,
        promotedCount,
        dismissedCount,
        totalInsights: all.length,
        insights: all.slice(0, 80),
        recentDreams: vault.recentJournal(15),
      };
    },

    listInsights(options?: DreamInsightQueryOptions): DreamInsightSummary[] {
      const limit = Math.max(1, Math.min(200, Math.trunc(options?.limit ?? 50)));
      const statusSet = options?.statuses && options.statuses.length > 0 ? new Set(options.statuses) : undefined;
      const kindSet =
        options?.kinds && options.kinds.length > 0
          ? new Set(options.kinds.filter((k) => isDreamInsightKind(k)))
          : undefined;
      const minConf = typeof options?.minConfidence === 'number' ? options.minConfidence : 0;
      const wsRaw = options?.workspacePath?.trim();
      const targetRepoKey = wsRaw ? cachedCwdToRepoKey.get(wsRaw) : undefined;
      const wsLower = wsRaw?.toLowerCase();

      const filtered = vault.list().filter((entry) => {
        if (statusSet && !statusSet.has(entry.status)) return false;
        if (kindSet && !kindSet.has(entry.kind)) return false;
        if (entry.confidence < minConf) return false;
        if (wsRaw) {
          if (targetRepoKey && entry.repoKeys.includes(targetRepoKey)) return true;
          if (
            wsLower &&
            (entry.sourceRepos.some((r) => r.toLowerCase().includes(wsLower)) ||
              entry.targetRepo?.toLowerCase().includes(wsLower))
          ) {
            return true;
          }
          return false;
        }
        return true;
      });

      return sortDreamInsights(filtered).slice(0, limit).map(toSummary);
    },

    async queryForTool(input: DreamQueryToolInput): Promise<DreamQueryToolResult> {
      await refreshRepoProfiles(false);
      const all = vault.list();
      const openCount = all.filter((i) => i.status === 'open').length;
      const limit = Math.max(1, Math.min(20, Math.trunc(input.limit ?? 8)));
      const statuses: readonly DreamInsightStatus[] =
        input.status === 'all'
          ? ['open', 'adopted', 'promoted', 'dismissed']
          : input.status
            ? [input.status]
            : ['open', 'adopted', 'promoted'];

      let callerRepoKey: string | undefined;
      let callerDisplay: string | undefined;
      if (input.callerWorkspacePath?.trim()) {
        callerRepoKey = cachedCwdToRepoKey.get(input.callerWorkspacePath.trim());
        if (!callerRepoKey) {
          const resolved = await resolveCanonicalRepoIdentity(input.callerWorkspacePath.trim(), ports.homeDir);
          if (resolved) {
            callerRepoKey = resolved.repoKey;
            callerDisplay = resolved.displayPath;
          }
        } else {
          callerDisplay = cachedProfiles.find((p) => p.repoKey === callerRepoKey)?.displayPath;
        }
      }

      let searched = searchDreamInsights(all, input.query ?? '', {
        ...(input.kind ? { kind: input.kind } : {}),
        statuses,
        limit: 100,
      });

      if (input.forCurrentWorkspace && (callerRepoKey || callerDisplay)) {
        const lowerDisp = callerDisplay?.toLowerCase();
        const matching = searched.filter(
          (item) =>
            (callerRepoKey ? item.repoKeys.includes(callerRepoKey) : false) ||
            (lowerDisp
              ? item.sourceRepos.some((r) => r.toLowerCase() === lowerDisp) ||
                item.targetRepo?.toLowerCase() === lowerDisp
              : false),
        );
        searched = matching;
      } else if (callerRepoKey) {
        // Boost insights relevant to caller workspace while keeping global insights accessible
        searched = [...searched].sort((a, b) => {
          const aAff = a.repoKeys.includes(callerRepoKey) ? 1 : 0;
          const bAff = b.repoKeys.includes(callerRepoKey) ? 1 : 0;
          return bAff - aAff;
        });
      }

      return {
        now: clock.wall(),
        discoveredRepoCount: cachedProfiles.length,
        totalInsights: all.length,
        openCount,
        matchedCount: searched.length,
        insights: searched.slice(0, limit).map(toSummary),
      };
    },

    subscribe(listener: () => void): () => void {
      if (stopped) return () => {};
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },

    subscribeInsights(listener: () => void): () => void {
      if (stopped) return () => {};
      insightSubscribers.add(listener);
      return () => {
        insightSubscribers.delete(listener);
      };
    },
  };
}
