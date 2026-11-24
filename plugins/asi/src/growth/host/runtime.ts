/**
 * `asi-growth` Core Host Runtime (L4 Procedural Skill Synthesis & Self-Evolution):
 * - Combines high-retention `asi-sleep` memories (`pitfall`, `decision`, `preference`)
 *   with completed ordinary multi-step troubleshooting trajectories
 * - Registers `id: 'asi-growth', tier: 4` (`autoMaintain: false`) & `growth_synthesize`
 *   sandbox tool into `ctx.asiDrives`
 * - Enforces 20m deep quiet gate + L1–L3 all-comfortable check + <=2 drafts/day quota
 * - Preempts/aborts immediately if any L1–L3 drive activates or `eco` mode turns on
 * - Strict draft -> human one-click approval -> hot-reload in `ctx.skills`
 * - Tracks invocation count, last invoked timestamp, turn completion rate, & 60-day metabolism
 */

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { AsiDrivesSnapshot, DriveAbortSignal, SenseSnapshot } from '@asi/sense-types';
import {
  isValidSkillName,
  maskHomeDir,
  parseSkillMarkdown,
  renderSkillMarkdown,
  sanitizeSkillMarkdownBody,
  sanitizeSkillText,
  toValidSkillSlug,
  validateSkillDocument,
} from '../shared/skill-spec.js';
import type {
  ArchivedSkillViewItem,
  GrowthPanelModel,
  GrowthSynthesisRecord,
  GrowthSynthesisTrigger,
  SkillCreateDraftInput,
  SkillDraftViewItem,
  SkillExportResult,
  SkillScope,
  SkillScopeUpdateInput,
  SkillUpdateMarkdownInput,
  SkillViewItem,
  WorkspaceChoice,
} from '../shared/types.js';
import {
  DAILY_AUTO_DRAFT_QUOTA,
  DEEP_QUIET_IDLE_THRESHOLD_MS,
  detectLowerTierBlock,
  evaluateGrowthState,
  isScreenLockedAt,
  ROLLING_DAY_WINDOW_MS,
} from './evaluator.js';
import { clusterHighEvidenceTopics, extractTroubleshootingTrajectories, HIGH_RETENTION_THRESHOLD } from './evidence.js';
import type { GrowthHostPorts } from './ports.js';
import { synthesizeSkillDraftForCluster } from './synthesizer.js';
import { SkillVault } from './vault.js';

const MAX_REJECTED_SIGNATURES = 500;
const INTERNAL_RUNTIME_CWD_RE =
  /(?:^|[\\/])(?:(?:asi[-_])?(?:needs|sleep|care|sense|growth)[\\/](?:sandbox|vault|skills)|data[\\/]asi-(?:needs|sleep|care|sense|growth))(?:[\\/]|$)/i;

interface PersistedGrowthState {
  autoGrowthPaused?: boolean;
  lastSynthesisAt?: number | null;
  lastOrdinaryActivityAt?: number;
  autoDraftTimestamps?: number[];
  rejectedSignatures?: string[];
}

export interface MountableSkillCandidate {
  name: string;
  description: string;
  whenToUse?: string;
  scope: SkillScope;
  workspacePath?: string;
  version: number;
  filePath: string;
  directoryPath: string;
}

export interface MountableSkillDefinition extends MountableSkillCandidate {
  content: string;
  metadata?: Record<string, string>;
}

export interface GrowthSkillCatalogBridge {
  listCandidates(cwd?: string): MountableSkillCandidate[];
  loadDefinition(name: string, cwd?: string): Promise<MountableSkillDefinition | undefined>;
  onInvalidate(listener: () => void): () => void;
}

export interface GrowthStatusQueryInput {
  status?: 'draft' | 'active' | 'disabled' | 'archived' | 'stale';
  scope?: SkillScope;
}

export interface GrowthActionsApi {
  synthesizeNow(): Promise<GrowthSynthesisRecord>;
  setAutoGrowthPaused(paused: boolean): Promise<void>;
  createManualDraft(input: SkillCreateDraftInput): Promise<SkillDraftViewItem>;
  updateDraft(draftId: string, patch: SkillUpdateMarkdownInput): Promise<SkillDraftViewItem>;
  approveDraft(draftId: string): Promise<SkillViewItem>;
  rejectDraft(draftId: string): Promise<void>;
  updateSkill(name: string, patch: SkillUpdateMarkdownInput): Promise<SkillViewItem>;
  setSkillScope(name: string, input: SkillScopeUpdateInput): Promise<SkillViewItem>;
  setSkillEnabled(name: string, enabled: boolean): Promise<SkillViewItem>;
  archiveSkill(name: string): Promise<ArchivedSkillViewItem>;
  restoreSkill(name: string): Promise<SkillViewItem>;
  deleteArchivedSkill(name: string): Promise<void>;
  exportSkillToWorkspace(name: string, workspacePath: string): Promise<SkillExportResult>;
}

export interface GrowthRuntime {
  readonly vault: SkillVault;
  readonly actions: GrowthActionsApi;
  readonly skillBridge: GrowthSkillCatalogBridge;
  start(): Promise<void>;
  stop(): Promise<void>;
  panelModel(): GrowthPanelModel;
  statusSnapshot(filter?: GrowthStatusQueryInput): Record<string, unknown>;
  subscribe(listener: () => void): () => void;
}

function safeRealpath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return resolve(target);
  }
}

export function matchesWorkspaceScope(lookupCwd: string | undefined, skillWorkspace: string | undefined): boolean {
  if (!lookupCwd || !lookupCwd.trim() || !skillWorkspace || !skillWorkspace.trim()) return false;
  const normCwd = resolve(lookupCwd.trim());
  const normWs = resolve(skillWorkspace.trim());
  const wsPrefix = normWs.endsWith(sep) ? normWs : `${normWs}${sep}`;
  if (normCwd === normWs || normCwd.startsWith(wsPrefix)) return true;

  const realCwd = safeRealpath(normCwd);
  const realWs = safeRealpath(normWs);
  const realPrefix = realWs.endsWith(sep) ? realWs : `${realWs}${sep}`;
  return realCwd === realWs || realCwd.startsWith(realPrefix);
}

export function createGrowthRuntime(ports: GrowthHostPorts): GrowthRuntime {
  const clock = ports.clock ?? { wall: () => Date.now(), mono: () => performance.now() };
  const statePath = join(ports.storageRoot, 'state.json');
  const vault = new SkillVault(ports.storageRoot, ports.homeDir, ports.excludedInternalRoots ?? []);

  let started = false;
  let stopped = false;
  let autoGrowthPaused = false;
  let lastSynthesisAt: number | null = null;
  let lastOrdinaryActivityAt = clock.wall();
  let autoDraftTimestamps: number[] = [];
  const rejectedSignatures: string[] = [];
  const rejectedSignatureSet = new Set<string>();
  const unclaimedSkillLoads = new Map<string, number>();

  function isExcludedInternalCwd(cwd: string | undefined): boolean {
    if (!cwd?.trim()) return false;
    if (INTERNAL_RUNTIME_CWD_RE.test(cwd)) return true;
    if (matchesWorkspaceScope(cwd, ports.storageRoot)) return true;
    for (const root of ports.excludedInternalRoots ?? []) {
      if (matchesWorkspaceScope(cwd, root)) return true;
    }
    return false;
  }

  let latestSense: SenseSnapshot = ports.sense.snapshot();
  let latestDrives: AsiDrivesSnapshot | undefined;

  let activeSynthesisPromise: Promise<GrowthSynthesisRecord> | undefined;
  let activeSynthesisAbort: AbortController | undefined;
  let activeSynthesisTrigger: GrowthSynthesisTrigger | null = null;
  let manualPreemptPending = false;
  let coldWarmupAbort: AbortController | undefined;

  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let stateWriteChain: Promise<void> = Promise.resolve();

  const subscribers = new Set<() => void>();
  const skillInvalidateListeners = new Set<() => void>();

  let offSense: (() => void) | undefined;
  let offDrives: (() => void) | undefined;
  let offDriveSource: (() => void) | undefined;
  let offConversations: (() => void) | undefined;
  let offSkillTurns: (() => void) | undefined;
  let offSleep: (() => void) | undefined;
  let coldWarmupPromise: Promise<void> = Promise.resolve();

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

  function invalidateSkillRegistry(): void {
    for (const fn of [...skillInvalidateListeners]) {
      try {
        fn();
      } catch {
        // Isolate provider invalidation listener error
      }
    }
  }

  function clearQuietTimer(): void {
    if (quietTimer !== undefined) {
      clearTimeout(quietTimer);
      quietTimer = undefined;
    }
  }

  function pruneOldAutoTimestamps(now: number): void {
    autoDraftTimestamps = autoDraftTimestamps.filter((ts) => now - ts < ROLLING_DAY_WINDOW_MS);
  }

  function addRejectedSignature(sig: string): void {
    if (!sig || rejectedSignatureSet.has(sig)) return;
    rejectedSignatureSet.add(sig);
    rejectedSignatures.push(sig);
    while (rejectedSignatures.length > MAX_REJECTED_SIGNATURES) {
      const evicted = rejectedSignatures.shift();
      if (evicted) rejectedSignatureSet.delete(evicted);
    }
  }

  function persistState(): Promise<void> {
    const run = async () => {
      await mkdir(ports.storageRoot, { recursive: true });
      const payload: PersistedGrowthState = {
        autoGrowthPaused,
        lastSynthesisAt,
        lastOrdinaryActivityAt,
        autoDraftTimestamps: [...autoDraftTimestamps],
        rejectedSignatures: [...rejectedSignatures],
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

  function gatherEvidence() {
    const sleepSvc = ports.getSleep?.();
    let memories = [] as ReturnType<NonNullable<typeof sleepSvc>['listMemories']>;
    if (sleepSvc) {
      try {
        memories = sleepSvc.listMemories({
          kinds: ['pitfall', 'decision', 'preference'],
          minRetention: HIGH_RETENTION_THRESHOLD,
          limit: 500,
        });
      } catch {
        memories = [];
      }
    }

    let rawTurns: ReturnType<typeof ports.conversations.listCompletedOrdinaryTurns> = [];
    try {
      rawTurns = ports.conversations.listCompletedOrdinaryTurns();
    } catch {
      rawTurns = [];
    }
    const trajectories = extractTroubleshootingTrajectories(rawTurns, ports.homeDir);

    const sessionWorkspaces = new Map<string, string>();
    if (ports.conversations.listSessionWorkspaces) {
      try {
        for (const [sid, ws] of ports.conversations.listSessionWorkspaces()) {
          if (sid && ws?.trim() && !isExcludedInternalCwd(ws)) {
            sessionWorkspaces.set(sid, resolve(ws.trim()));
          }
        }
      } catch {
        // Ignore optional session workspace lookup errors
      }
    }
    for (const t of rawTurns) {
      if (t.sessionId && t.cwd?.trim() && !isExcludedInternalCwd(t.cwd)) {
        sessionWorkspaces.set(t.sessionId, resolve(t.cwd.trim()));
      }
    }

    let knownWorkspaces: string[] = [];
    try {
      knownWorkspaces = ports.conversations
        .listKnownWorkspaces()
        .filter((w) => Boolean(w?.trim()) && !isExcludedInternalCwd(w))
        .map((w) => resolve(w.trim()));
    } catch {
      knownWorkspaces = [];
    }

    const existingSkillMap = new Map<
      string,
      {
        name: string;
        version: number;
        topicKey: string;
        markdown: string;
        scope: SkillScope;
        workspacePath?: string;
        evidenceIds: string[];
      }
    >();
    for (const a of vault.listArchivedRecords()) {
      existingSkillMap.set(a.name, {
        name: a.name,
        version: a.version,
        topicKey: a.topicKey,
        markdown: a.markdown,
        scope: a.scope,
        ...(a.workspacePath ? { workspacePath: a.workspacePath } : {}),
        evidenceIds: a.evidenceIds,
      });
    }
    for (const s of vault.listSkillRecords()) {
      existingSkillMap.set(s.name, {
        name: s.name,
        version: s.version,
        topicKey: s.topicKey,
        markdown: s.markdown,
        scope: s.scope,
        ...(s.workspacePath ? { workspacePath: s.workspacePath } : {}),
        evidenceIds: s.evidenceIds,
      });
    }
    const existingSkills = [...existingSkillMap.values()];

    const existingDrafts = vault.listDraftRecords().map((d) => ({
      id: d.id,
      name: d.name,
      topicKey: d.topicKey,
      ...(d.revisesSkillName ? { revisesSkillName: d.revisesSkillName } : {}),
      evidenceIds: d.evidenceIds,
    }));

    return clusterHighEvidenceTopics({
      memories,
      trajectories,
      existingSkills,
      existingDrafts,
      rejectedSignatures: rejectedSignatureSet,
      sessionWorkspaces,
      knownWorkspaces,
      ...(ports.homeDir ? { homeDir: ports.homeDir } : {}),
    });
  }

  function computeEvaluated(senseSnap: SenseSnapshot, options?: { fromDriveArbiter?: boolean }) {
    const now = clock.wall();
    pruneOldAutoTimestamps(now);
    const evidence = gatherEvidence();
    const anyRunning = ports.conversations.anyOrdinarySessionRunning();
    const drivesSnap = options?.fromDriveArbiter ? latestDrives : ports.drives.snapshot();
    if (drivesSnap) latestDrives = drivesSnap;

    const evaluated = evaluateGrowthState({
      now,
      sense: senseSnap,
      ...(drivesSnap ? { drivesSnapshot: drivesSnap } : {}),
      readyClusters: evidence.readyClusters.length,
      highRetentionMemoryCount: evidence.highRetentionMemoryCount,
      recurringTrajectoryCount: evidence.recurringTrajectoryCount,
      lastSynthesisAt,
      lastOrdinaryActivityAt,
      anyOrdinarySessionRunning: anyRunning,
      autoGrowthPaused,
      autoDraftTimestamps,
    });

    return {
      now,
      evidence,
      anyRunning,
      ...evaluated,
    };
  }

  function scheduleQuietWakeTimer(): void {
    clearQuietTimer();
    if (stopped || activeSynthesisPromise) return;
    const ev = computeEvaluated(latestSense);
    if (autoGrowthPaused || latestSense.settings.paused) return;

    if (
      ev.driveView.readyToSynthesize &&
      !ev.driveView.suppressed &&
      !ev.driveView.lowerTierBlocked &&
      ev.remainingAutoQuota > 0 &&
      !ev.driveView.deepQuietWindow &&
      !ev.anyRunning
    ) {
      const remainMs = DEEP_QUIET_IDLE_THRESHOLD_MS - ev.driveView.idleDurationMs;
      if (remainMs > 0) {
        quietTimer = setTimeout(
          () => {
            quietTimer = undefined;
            reconcileAndMaybeSynthesize();
          },
          Math.min(2_147_483_647, Math.ceil(remainMs) + 20),
        );
        quietTimer.unref?.();
      }
    }
  }

  function maybeAbortPreemptedAutoSynthesis(drivesOverride?: AsiDrivesSnapshot): void {
    if (!activeSynthesisAbort) return;
    if (activeSynthesisTrigger === 'manual') return;
    const now = clock.wall();
    const senseSnap = ports.sense.snapshot();
    const senseSettings = ports.sense.getSettings();
    const drivesSnap = drivesOverride ?? ports.drives.snapshot();
    const block = detectLowerTierBlock(senseSnap, drivesSnap);
    const screenLocked = isScreenLockedAt(senseSnap, now);
    const anyRunning = ports.conversations.anyOrdinarySessionRunning();
    const userBecameActive =
      activeSynthesisTrigger === 'auto' &&
      (anyRunning || (!screenLocked && now - lastOrdinaryActivityAt < DEEP_QUIET_IDLE_THRESHOLD_MS));

    if (
      stopped ||
      autoGrowthPaused ||
      senseSettings.paused ||
      senseSettings.powerMode === 'eco' ||
      block.suppressed ||
      block.lowerTierBlocked ||
      userBecameActive
    ) {
      activeSynthesisAbort.abort();
    }
  }

  async function executeSynthesis(
    trigger: GrowthSynthesisTrigger,
    externalSignal?: DriveAbortSignal,
  ): Promise<GrowthSynthesisRecord> {
    if (activeSynthesisPromise) {
      return activeSynthesisPromise;
    }

    const localAbort = new AbortController();
    let pollExternalTimer: ReturnType<typeof setInterval> | undefined;
    if (externalSignal) {
      if (externalSignal.aborted) localAbort.abort();
      else {
        pollExternalTimer = setInterval(() => {
          if (externalSignal.aborted) localAbort.abort();
        }, 25);
        pollExternalTimer.unref?.();
      }
    }
    let autoPreemptWatchdog: ReturnType<typeof setInterval> | undefined;
    if (trigger === 'auto') {
      autoPreemptWatchdog = setInterval(() => {
        maybeAbortPreemptedAutoSynthesis();
      }, 50);
      autoPreemptWatchdog.unref?.();
    }

    const startWall = clock.wall();
    const startMono = clock.mono();
    const reservedTimestamps: number[] = [];

    activeSynthesisAbort = localAbort;
    activeSynthesisTrigger = trigger;
    clearQuietTimer();
    notify();

    const task = (async (): Promise<GrowthSynthesisRecord> => {
      try {
        await vault.syncExternalDiskEdits();
        const ev = computeEvaluated(ports.sense.snapshot());
        if (trigger === 'auto' && !ev.canAutoDraft) {
          const err = new Error('Skill synthesis preempted before drafting');
          err.name = 'AbortError';
          throw err;
        }
        const clustersToProcess =
          trigger === 'auto'
            ? ev.evidence.readyClusters.slice(0, Math.max(0, DAILY_AUTO_DRAFT_QUOTA - ev.driveView.autoDraftsToday))
            : ev.evidence.readyClusters;

        if (trigger === 'auto' && clustersToProcess.length > 0) {
          for (let i = 0; i < clustersToProcess.length; i += 1) {
            const ts = startWall + i;
            autoDraftTimestamps.push(ts);
            reservedTimestamps.push(ts);
          }
        }

        const takenNames = vault.takenSkillNames();
        const synthesizedBatch: Array<{
          cluster: (typeof clustersToProcess)[number];
          draft: Awaited<ReturnType<typeof synthesizeSkillDraftForCluster>>;
        }> = [];

        for (const cluster of clustersToProcess) {
          if (localAbort.signal.aborted || stopped) {
            const err = new Error('Skill synthesis preempted');
            err.name = 'AbortError';
            throw err;
          }

          if (trigger !== 'manual') {
            const postNow = clock.wall();
            const postSense = ports.sense.snapshot();
            const postDrives = ports.drives.snapshot();
            const block = detectLowerTierBlock(postSense, postDrives);
            const postScreenLocked = isScreenLockedAt(postSense, postNow);
            const autoQuietBroken =
              trigger === 'auto' &&
              (autoGrowthPaused ||
                ports.conversations.anyOrdinarySessionRunning() ||
                (!postScreenLocked && postNow - lastOrdinaryActivityAt < DEEP_QUIET_IDLE_THRESHOLD_MS));
            if (block.suppressed || block.lowerTierBlocked || postSense.settings.paused || autoQuietBroken) {
              const err = new Error(block.lowerTierReason ?? 'Skill synthesis preempted');
              err.name = 'AbortError';
              throw err;
            }
          }

          const draft = await synthesizeSkillDraftForCluster({
            cluster,
            takenSkillNames: takenNames,
            signal: localAbort.signal,
            ...(ports.homeDir ? { homeDir: ports.homeDir } : {}),
            ...(ports.llmSynthesize ? { llmSynthesize: ports.llmSynthesize } : {}),
          });
          takenNames.add(draft.name);
          synthesizedBatch.push({ cluster, draft });
        }

        if (localAbort.signal.aborted || stopped) {
          const err = new Error('Skill synthesis preempted');
          err.name = 'AbortError';
          throw err;
        }

        if (trigger !== 'manual') {
          const finalNow = clock.wall();
          const finalSense = ports.sense.snapshot();
          const finalDrives = ports.drives.snapshot();
          const block = detectLowerTierBlock(finalSense, finalDrives);
          const finalScreenLocked = isScreenLockedAt(finalSense, finalNow);
          const autoQuietBroken =
            trigger === 'auto' &&
            (autoGrowthPaused ||
              ports.conversations.anyOrdinarySessionRunning() ||
              (!finalScreenLocked && finalNow - lastOrdinaryActivityAt < DEEP_QUIET_IDLE_THRESHOLD_MS));
          if (block.suppressed || block.lowerTierBlocked || finalSense.settings.paused || autoQuietBroken) {
            const err = new Error(block.lowerTierReason ?? 'Skill synthesis preempted');
            err.name = 'AbortError';
            throw err;
          }
        }

        const commitNow = clock.wall();
        let draftsCreated = 0;
        let revisionsCreated = 0;

        for (const { cluster, draft } of synthesizedBatch) {
          const openDraftsNow = vault.listDraftRecords();
          const duplicateOpenDraft = openDraftsNow.some(
            (d) =>
              d.topicKey === cluster.topicKey ||
              (draft.revisesSkillName !== undefined && d.revisesSkillName === draft.revisesSkillName),
          );
          if (duplicateOpenDraft) continue;

          let finalName = draft.name;
          let finalMarkdown = draft.markdown;
          let finalTargetVersion = draft.targetVersion;
          let finalBaseVersion = draft.baseVersion;
          let finalBaseMarkdown = draft.baseMarkdown;

          if (draft.isRevision && draft.revisesSkillName) {
            const latestTarget =
              vault.getInstalledSkill(draft.revisesSkillName) ??
              vault.listArchivedRecords().find((a) => a.name === draft.revisesSkillName);
            if (latestTarget) {
              finalBaseVersion = latestTarget.version;
              finalBaseMarkdown = latestTarget.markdown;
              finalTargetVersion = Math.max(finalTargetVersion, latestTarget.version + 1);
            }
          } else {
            const freshTaken = vault.takenSkillNames();
            if (freshTaken.has(finalName)) {
              for (let suffix = 2; suffix <= 99; suffix += 1) {
                const suffixStr = `-${suffix}`;
                const candidate = `${finalName.slice(0, Math.max(3, 64 - suffixStr.length)).replace(/-+$/g, '')}${suffixStr}`;
                if (!freshTaken.has(candidate)) {
                  finalName = candidate;
                  break;
                }
              }
              const reparsed = parseSkillMarkdown(finalMarkdown, ports.homeDir);
              if (reparsed.valid && reparsed.document) {
                finalMarkdown = renderSkillMarkdown({ ...reparsed.document, name: finalName }, ports.homeDir);
              }
            }
          }

          const safeRecommendedScope =
            cluster.recommendedScope === 'workspace' &&
            cluster.recommendedWorkspace &&
            !isExcludedInternalCwd(cluster.recommendedWorkspace)
              ? 'workspace'
              : 'global';

          await vault.saveDraft({
            id: `draft_${randomUUID().slice(0, 12)}`,
            name: finalName,
            description: draft.description,
            whenToUse: draft.whenToUse,
            markdown: finalMarkdown,
            scope: safeRecommendedScope,
            ...(safeRecommendedScope === 'workspace' && cluster.recommendedWorkspace
              ? { workspacePath: cluster.recommendedWorkspace }
              : {}),
            targetVersion: finalTargetVersion,
            isRevision: draft.isRevision,
            ...(draft.revisesSkillName ? { revisesSkillName: draft.revisesSkillName } : {}),
            ...(finalBaseVersion !== undefined ? { baseVersion: finalBaseVersion } : {}),
            ...(finalBaseMarkdown ? { baseMarkdown: finalBaseMarkdown } : {}),
            topicKey: cluster.topicKey,
            evidenceIds: cluster.allEvidenceIds,
            memoryCount: cluster.memories.length,
            trajectoryCount: cluster.trajectories.length,
            evidenceSummary: cluster.evidenceSummary,
            evidenceSignature: cluster.evidenceSignature,
            createdAt: commitNow,
            updatedAt: commitNow,
            trigger,
          });
          if (draft.isRevision) revisionsCreated += 1;
          else draftsCreated += 1;
        }

        // Trim unused reserved auto-quota slots if fewer drafts were created
        const actualAutoCount = draftsCreated + revisionsCreated;
        while (reservedTimestamps.length > actualAutoCount) {
          const unused = reservedTimestamps.pop();
          if (unused !== undefined) {
            const idx = autoDraftTimestamps.lastIndexOf(unused);
            if (idx >= 0) autoDraftTimestamps.splice(idx, 1);
          }
        }
        reservedTimestamps.length = 0;

        lastSynthesisAt = commitNow;
        const durationMs = Math.max(1, Math.round(clock.mono() - startMono));
        const totalDrafted = draftsCreated + revisionsCreated;
        const summary =
          totalDrafted === 0
            ? '当前无达标高证据主题可提炼（保持零低证据草稿）'
            : `提炼 ${totalDrafted} 份待审 SKILL.md 草案（新建 ${draftsCreated} / 修订 ${revisionsCreated}），等待人工批准启用`;

        const savedRec = await vault.appendJournal({
          id: `growth_${randomUUID().slice(0, 10)}`,
          at: commitNow,
          trigger,
          clustersInspected: clustersToProcess.length,
          draftsCreated,
          revisionsCreated,
          durationMs,
          summary,
        });
        await persistState();
        return savedRec;
      } catch (err) {
        for (const ts of reservedTimestamps) {
          const idx = autoDraftTimestamps.lastIndexOf(ts);
          if (idx >= 0) autoDraftTimestamps.splice(idx, 1);
        }
        reservedTimestamps.length = 0;
        throw err;
      } finally {
        if (pollExternalTimer !== undefined) clearInterval(pollExternalTimer);
        if (autoPreemptWatchdog !== undefined) clearInterval(autoPreemptWatchdog);
        if (activeSynthesisAbort === localAbort) {
          activeSynthesisAbort = undefined;
          activeSynthesisTrigger = null;
        }
        activeSynthesisPromise = undefined;
        if (!stopped) {
          lastNotifiedDriveFingerprint = undefined;
          ports.drives.notifySourceChanged('asi-growth');
          scheduleQuietWakeTimer();
          notify();
        }
      }
    })();

    activeSynthesisPromise = task;
    return task;
  }

  let lastNotifiedDriveFingerprint: string | undefined;

  function driveFingerprintOf(evaluated: ReturnType<typeof computeEvaluated>): string {
    return [
      evaluated.driveView.satisfaction,
      evaluated.driveView.summary,
      evaluated.driveView.readyClusters,
      evaluated.driveView.highRetentionMemoryCount,
      evaluated.driveView.recurringTrajectoryCount,
      evaluated.driveView.deepQuietWindow ? 1 : 0,
      evaluated.driveView.screenLocked ? 1 : 0,
      evaluated.driveView.lowerTierBlocked ? 1 : 0,
      evaluated.driveView.autoDraftsToday,
      autoGrowthPaused ? 1 : 0,
      vault.listDraftRecords().length,
      vault.listActiveMountableSkills().length,
    ].join('|');
  }

  function flushDriveSourceChanged(): void {
    lastNotifiedDriveFingerprint = undefined;
    ports.drives.notifySourceChanged('asi-growth');
  }

  function reconcileAndMaybeSynthesize(): void {
    if (stopped || !started) return;
    latestSense = ports.sense.snapshot();
    maybeAbortPreemptedAutoSynthesis();

    const evaluated = computeEvaluated(latestSense);
    const nextFingerprint = driveFingerprintOf(evaluated);
    if (nextFingerprint !== lastNotifiedDriveFingerprint) {
      lastNotifiedDriveFingerprint = nextFingerprint;
      ports.drives.notifySourceChanged('asi-growth');
    }

    if (!activeSynthesisPromise && !manualPreemptPending && evaluated.canAutoDraft) {
      void executeSynthesis('auto').catch(() => {
        // Preempted or transient error; finally block reschedules quiet timer
      });
    } else {
      scheduleQuietWakeTimer();
    }
    notify();
  }

  function collectWorkspaceChoices(): WorkspaceChoice[] {
    const rawPaths = new Set<string>();
    try {
      for (const p of ports.conversations.listKnownWorkspaces()) {
        if (p && p.trim()) rawPaths.add(resolve(p.trim()));
      }
    } catch {
      // Ignore workspace listing error
    }
    for (const s of vault.listSkillRecords()) {
      if (s.workspacePath) rawPaths.add(resolve(s.workspacePath));
    }
    for (const d of vault.listDraftRecords()) {
      if (d.workspacePath) rawPaths.add(resolve(d.workspacePath));
    }
    return [...rawPaths]
      .sort()
      .slice(0, 25)
      .map((path) => ({
        path,
        display: sanitizeSkillText(maskHomeDir(path, ports.homeDir), 200, ports.homeDir),
      }));
  }

  const skillBridge: GrowthSkillCatalogBridge = {
    listCandidates(cwd?: string): MountableSkillCandidate[] {
      if (cwd && isExcludedInternalCwd(cwd)) return [];
      const mountable = vault.listActiveMountableSkills();
      const out: MountableSkillCandidate[] = [];
      for (const s of mountable) {
        if (s.scope === 'workspace' && !matchesWorkspaceScope(cwd, s.workspacePath)) {
          continue;
        }
        const filePath = vault.activeSkillFilePath(s.name);
        out.push({
          name: s.name,
          description: sanitizeSkillText(s.description, 1_024, ports.homeDir) || `Procedural skill ${s.name}`,
          ...(s.whenToUse ? { whenToUse: sanitizeSkillText(s.whenToUse, 500, ports.homeDir) } : {}),
          scope: s.scope,
          ...(s.workspacePath ? { workspacePath: s.workspacePath } : {}),
          version: s.version,
          filePath,
          directoryPath: dirname(filePath),
        });
      }
      return out;
    },

    async loadDefinition(name: string, cwd?: string): Promise<MountableSkillDefinition | undefined> {
      if (!isValidSkillName(name)) return undefined;
      if (cwd && isExcludedInternalCwd(cwd)) return undefined;
      const diskChanged = await vault.syncExternalDiskEdits();
      if (diskChanged) {
        invalidateSkillRegistry();
      }
      const active = vault.getActiveSkill(name);
      if (!active) return undefined;
      if (active.scope === 'workspace' && !matchesWorkspaceScope(cwd, active.workspacePath)) {
        return undefined;
      }

      const parsed = parseSkillMarkdown(active.markdown, ports.homeDir);
      if (!parsed.valid || !parsed.document) return undefined;

      const now = clock.wall();
      vault.recordInvocation(name, now);
      unclaimedSkillLoads.set(name, (unclaimedSkillLoads.get(name) ?? 0) + 1);
      notify();

      const filePath = vault.activeSkillFilePath(name);
      return {
        name: parsed.document.name,
        description: sanitizeSkillText(parsed.document.description, 1_024, ports.homeDir),
        ...(parsed.document.whenToUse
          ? { whenToUse: sanitizeSkillText(parsed.document.whenToUse, 500, ports.homeDir) }
          : {}),
        scope: active.scope,
        ...(active.workspacePath ? { workspacePath: active.workspacePath } : {}),
        version: active.version,
        filePath,
        directoryPath: dirname(filePath),
        content: sanitizeSkillMarkdownBody(parsed.document.body, undefined, ports.homeDir),
        ...(parsed.document.metadata ? { metadata: parsed.document.metadata } : {}),
      };
    },

    onInvalidate(listener: () => void): () => void {
      skillInvalidateListeners.add(listener);
      return () => {
        skillInvalidateListeners.delete(listener);
      };
    },
  };

  const actions: GrowthActionsApi = {
    async synthesizeNow(): Promise<GrowthSynthesisRecord> {
      if (stopped) throw new Error('asi-growth runtime is stopped');
      if (activeSynthesisPromise && activeSynthesisTrigger !== 'manual') {
        manualPreemptPending = true;
        try {
          activeSynthesisAbort?.abort();
          await activeSynthesisPromise.catch(() => undefined);
        } finally {
          manualPreemptPending = false;
        }
      }
      if (stopped) throw new Error('asi-growth runtime is stopped');
      return executeSynthesis('manual');
    },

    async setAutoGrowthPaused(paused: boolean): Promise<void> {
      autoGrowthPaused = Boolean(paused);
      if (autoGrowthPaused && activeSynthesisTrigger === 'auto') {
        activeSynthesisAbort?.abort();
      }
      await persistState();
      reconcileAndMaybeSynthesize();
    },

    async createManualDraft(input: SkillCreateDraftInput): Promise<SkillDraftViewItem> {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('Invalid draft input');
      }
      const rawName = typeof input.name === 'string' ? input.name.trim() : '';
      const cleanName = isValidSkillName(rawName) ? rawName : toValidSkillSlug(rawName, 'skill');
      if (!isValidSkillName(cleanName)) {
        throw new Error('技能名称须为小写字母、数字与单连字符（kebab-case）');
      }

      const scope: SkillScope = input.scope === 'workspace' ? 'workspace' : 'global';
      const rawWorkspacePath = scope === 'workspace' ? input.workspacePath?.trim() : undefined;
      if (scope === 'workspace' && !rawWorkspacePath) {
        throw new Error('工作区作用域必须提供目标工作区路径');
      }
      const workspacePath = rawWorkspacePath ? vault.validateScopeWorkspace(rawWorkspacePath) : undefined;

      const existingSkillOrArchived =
        vault.getInstalledSkill(cleanName) ?? vault.listArchivedRecords().find((a) => a.name === cleanName);
      const isRevision = Boolean(existingSkillOrArchived);
      const targetVersion = existingSkillOrArchived ? existingSkillOrArchived.version + 1 : 1;

      const docCandidate = {
        name: cleanName,
        description: sanitizeSkillText(
          typeof input.description === 'string' ? input.description : '',
          1_024,
          ports.homeDir,
        ),
        ...(typeof input.whenToUse === 'string' && input.whenToUse.trim()
          ? { whenToUse: sanitizeSkillText(input.whenToUse, 500, ports.homeDir) }
          : {}),
        license: 'MIT',
        metadata: {
          version: `${targetVersion}.0.0`,
          'synthesized-by': 'manual',
        },
        body: sanitizeSkillMarkdownBody(typeof input.body === 'string' ? input.body : '', undefined, ports.homeDir),
      };

      const check = validateSkillDocument(docCandidate, { expectedDirName: cleanName });
      if (!check.valid || !check.document) {
        throw new Error(`SKILL.md 校验未通过: ${check.errors.join('; ')}`);
      }

      const now = clock.wall();
      const markdown = renderSkillMarkdown(check.document, ports.homeDir);
      const saved = await vault.saveDraft({
        id: `draft_${randomUUID().slice(0, 12)}`,
        name: cleanName,
        description: check.document.description,
        ...(check.document.whenToUse ? { whenToUse: check.document.whenToUse } : {}),
        markdown,
        scope,
        ...(workspacePath ? { workspacePath } : {}),
        targetVersion,
        isRevision,
        ...(existingSkillOrArchived
          ? {
              revisesSkillName: existingSkillOrArchived.name,
              baseVersion: existingSkillOrArchived.version,
              baseMarkdown: existingSkillOrArchived.markdown,
            }
          : {}),
        topicKey: existingSkillOrArchived?.topicKey ?? cleanName,
        evidenceIds: ['manual'],
        memoryCount: 0,
        trajectoryCount: 0,
        evidenceSummary: isRevision
          ? `手动编写 v${existingSkillOrArchived?.version ?? 1} → v${targetVersion} 修订草案`
          : '手动新建待审技能草案',
        evidenceSignature: `manual_${randomUUID().slice(0, 8)}`,
        createdAt: now,
        updatedAt: now,
        trigger: 'manual',
      });

      flushDriveSourceChanged();
      notify();
      return vault.toDraftView(saved);
    },

    async updateDraft(draftId: string, patch: SkillUpdateMarkdownInput): Promise<SkillDraftViewItem> {
      const now = clock.wall();
      const updated = await vault.updateDraft(
        draftId,
        {
          markdown: patch.markdown,
          ...(patch.scope ? { scope: patch.scope } : {}),
          ...(patch.workspacePath !== undefined ? { workspacePath: patch.workspacePath } : {}),
        },
        now,
      );
      notify();
      return vault.toDraftView(updated);
    },

    async approveDraft(draftId: string): Promise<SkillViewItem> {
      const now = clock.wall();
      const approved = await vault.approveDraft(draftId, now);
      await vault.appendJournal({
        id: `approve_${randomUUID().slice(0, 10)}`,
        at: now,
        trigger: 'manual',
        clustersInspected: 1,
        draftsCreated: 0,
        revisionsCreated: 0,
        durationMs: 1,
        summary: `已批准启用技能 ${approved.name} (v${approved.version} · ${approved.scope === 'workspace' ? '工作区' : '全局'})`,
      });
      invalidateSkillRegistry();
      flushDriveSourceChanged();
      scheduleQuietWakeTimer();
      notify();
      return vault.toSkillView(approved, now);
    },

    async rejectDraft(draftId: string): Promise<void> {
      const rejected = await vault.rejectDraft(draftId);
      if (rejected.evidenceSignature && !rejected.evidenceSignature.startsWith('manual_')) {
        addRejectedSignature(rejected.evidenceSignature);
        await persistState();
      }
      flushDriveSourceChanged();
      scheduleQuietWakeTimer();
      notify();
    },

    async updateSkill(name: string, patch: SkillUpdateMarkdownInput): Promise<SkillViewItem> {
      const now = clock.wall();
      const updated = await vault.updateInstalledSkill(
        name,
        {
          markdown: patch.markdown,
          ...(patch.scope ? { scope: patch.scope } : {}),
          ...(patch.workspacePath !== undefined ? { workspacePath: patch.workspacePath } : {}),
        },
        now,
      );
      invalidateSkillRegistry();
      notify();
      return vault.toSkillView(updated, now);
    },

    async setSkillScope(name: string, input: SkillScopeUpdateInput): Promise<SkillViewItem> {
      const now = clock.wall();
      const updated = await vault.updateInstalledSkill(
        name,
        {
          scope: input.scope,
          ...(input.workspacePath !== undefined ? { workspacePath: input.workspacePath } : {}),
        },
        now,
      );
      invalidateSkillRegistry();
      notify();
      return vault.toSkillView(updated, now);
    },

    async setSkillEnabled(name: string, enabled: boolean): Promise<SkillViewItem> {
      const now = clock.wall();
      const updated = await vault.setSkillEnabled(name, Boolean(enabled), now);
      invalidateSkillRegistry();
      notify();
      return vault.toSkillView(updated, now);
    },

    async archiveSkill(name: string): Promise<ArchivedSkillViewItem> {
      const now = clock.wall();
      const archived = await vault.archiveSkill(name, now);
      await vault.appendJournal({
        id: `archive_${randomUUID().slice(0, 10)}`,
        at: now,
        trigger: 'manual',
        clustersInspected: 0,
        draftsCreated: 0,
        revisionsCreated: 0,
        durationMs: 1,
        summary: `已归档技能 ${archived.name}（从 ctx.skills 卸载，文件保留可恢复）`,
      });
      invalidateSkillRegistry();
      flushDriveSourceChanged();
      notify();
      return vault.toArchivedView(archived);
    },

    async restoreSkill(name: string): Promise<SkillViewItem> {
      const now = clock.wall();
      const restored = await vault.restoreArchivedSkill(name, now);
      invalidateSkillRegistry();
      flushDriveSourceChanged();
      notify();
      return vault.toSkillView(restored, now);
    },

    async deleteArchivedSkill(name: string): Promise<void> {
      await vault.deleteArchivedSkill(name);
      notify();
    },

    async exportSkillToWorkspace(name: string, workspacePath: string): Promise<SkillExportResult> {
      const now = clock.wall();
      const res = await vault.exportToWorkspace(name, workspacePath, now);
      await vault.appendJournal({
        id: `export_${randomUUID().slice(0, 10)}`,
        at: now,
        trigger: 'manual',
        clustersInspected: 0,
        draftsCreated: 0,
        revisionsCreated: 0,
        durationMs: 1,
        summary: `已导出技能 ${res.name} 至 ${res.displayPath}`,
      });
      notify();
      return res;
    },
  };

  return {
    vault,
    actions,
    skillBridge,

    async start(): Promise<void> {
      if (started) return;
      started = true;
      stopped = false;

      const initNow = clock.wall();
      await mkdir(ports.storageRoot, { recursive: true });

      try {
        const rawState = await readFile(statePath, 'utf8');
        const parsed = JSON.parse(rawState) as PersistedGrowthState;
        if (typeof parsed.autoGrowthPaused === 'boolean') {
          autoGrowthPaused = parsed.autoGrowthPaused;
        }
        if (typeof parsed.lastSynthesisAt === 'number' && Number.isFinite(parsed.lastSynthesisAt)) {
          lastSynthesisAt = parsed.lastSynthesisAt;
        }
        if (typeof parsed.lastOrdinaryActivityAt === 'number' && Number.isFinite(parsed.lastOrdinaryActivityAt)) {
          lastOrdinaryActivityAt = parsed.lastOrdinaryActivityAt;
        }
        if (Array.isArray(parsed.autoDraftTimestamps)) {
          autoDraftTimestamps = parsed.autoDraftTimestamps.filter(
            (n): n is number => typeof n === 'number' && Number.isFinite(n),
          );
          pruneOldAutoTimestamps(initNow);
        }
        if (Array.isArray(parsed.rejectedSignatures)) {
          for (const sig of parsed.rejectedSignatures) {
            if (typeof sig === 'string') addRejectedSignature(sig);
          }
        }
      } catch {
        // Fresh state
      }

      await vault.load();
      latestSense = ports.sense.snapshot();

      offDriveSource = ports.drives.registerSource({
        id: 'asi-growth',
        tier: 4,
        label: '技能工坊与自进化',
        evaluate: (senseSnap) => {
          const ev = computeEvaluated(senseSnap, { fromDriveArbiter: true });
          return [
            {
              key: 'skill_synthesis',
              label: '技能提炼与自进化',
              satisfaction: ev.driveView.satisfaction,
              autoMaintain: false,
              summary: ev.driveView.summary,
              evidence: {
                readyClusters: ev.driveView.readyClusters,
                highRetentionMemories: ev.driveView.highRetentionMemoryCount,
                recurringTrajectories: ev.driveView.recurringTrajectoryCount,
                deepQuietWindow: ev.driveView.deepQuietWindow,
                screenLocked: ev.driveView.screenLocked,
                lowerTierBlocked: ev.driveView.lowerTierBlocked,
                autoDraftsToday: ev.driveView.autoDraftsToday,
                autoGrowthPaused,
                draftCount: vault.listDraftRecords().length,
                activeSkills: vault.listActiveMountableSkills().length,
              },
            },
          ];
        },
        sandboxTools: [
          {
            name: 'growth_synthesize',
            driveKey: 'skill_synthesis',
            description:
              'Synthesize pending plain-text SKILL.md drafts from high-evidence topic clusters when L1, L2, and L3 drives are all comfortable and the 20-minute deep quiet window is met.',
            parameters: {
              force: {
                type: 'boolean',
                description: 'Bypass 20-minute deep quiet wait when explicitly requested inside maintenance sandbox.',
              },
            },
            execute: async (args, { signal }) => {
              const ev = computeEvaluated(ports.sense.snapshot());
              if (ev.driveView.suppressed || ev.driveView.lowerTierBlocked) {
                throw new Error(
                  ev.driveView.suppressionReason ??
                    ev.driveView.lowerTierReason ??
                    'Skill synthesis is suspended while L1-L3 drives are active',
                );
              }
              const force = args.force === true;
              if (!force && !ev.driveView.deepQuietWindow) {
                return {
                  summary: ev.anyRunning
                    ? '普通对话运行中，等待回合结束并进入 20 分钟深静默窗口'
                    : `等待 20 分钟深静默窗口（当前已空闲 ${Math.floor(ev.driveView.idleDurationMs / 60_000)}/20 分钟且未锁屏）`,
                };
              }
              const rec = await executeSynthesis('sandbox', signal);
              return {
                summary: rec.summary,
                data: {
                  clustersInspected: rec.clustersInspected,
                  draftsCreated: rec.draftsCreated,
                  revisionsCreated: rec.revisionsCreated,
                  at: rec.at,
                },
              };
            },
          },
        ],
      });

      offSense = ports.sense.subscribe((snap) => {
        latestSense = snap;
        reconcileAndMaybeSynthesize();
      });

      offDrives = ports.drives.subscribe((drivesSnap) => {
        const prevBlock = detectLowerTierBlock(latestSense, latestDrives);
        latestDrives = drivesSnap;
        const nextBlock = detectLowerTierBlock(latestSense, drivesSnap);
        maybeAbortPreemptedAutoSynthesis(drivesSnap);

        const unblockedNow =
          (prevBlock.suppressed || prevBlock.lowerTierBlocked) && !nextBlock.suppressed && !nextBlock.lowerTierBlocked;
        if (unblockedNow) {
          reconcileAndMaybeSynthesize();
        } else {
          scheduleQuietWakeTimer();
          notify();
        }
      });

      offConversations = ports.conversations.onOrdinaryActivity(() => {
        lastOrdinaryActivityAt = clock.wall();
        maybeAbortPreemptedAutoSynthesis();
        void persistState();
        reconcileAndMaybeSynthesize();
      });

      offSkillTurns = ports.conversations.onSkillTurnCompleted?.((ev) => {
        for (const name of ev.skillNames) {
          const pendingLoads = unclaimedSkillLoads.get(name) ?? 0;
          if (pendingLoads > 0) {
            if (pendingLoads === 1) unclaimedSkillLoads.delete(name);
            else unclaimedSkillLoads.set(name, pendingLoads - 1);
            vault.recordTurnOutcome(name, ev.completed, ev.at, false);
          } else {
            vault.recordTurnOutcome(name, ev.completed, ev.at, true);
          }
        }
        notify();
      });

      offSleep = ports.onSleepChanged?.(() => {
        reconcileAndMaybeSynthesize();
      });

      invalidateSkillRegistry();
      reconcileAndMaybeSynthesize();

      if (ports.conversations.warmColdSessions) {
        coldWarmupAbort = new AbortController();
        const warmupSignal = coldWarmupAbort.signal;
        coldWarmupPromise = ports.conversations
          .warmColdSessions(warmupSignal)
          .then(() => {
            if (!stopped && !warmupSignal.aborted) {
              reconcileAndMaybeSynthesize();
            }
          })
          .catch(() => {
            // Optional cold-session hydration is best-effort
          });
      }
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      started = false;
      clearQuietTimer();
      coldWarmupAbort?.abort();
      coldWarmupAbort = undefined;
      activeSynthesisAbort?.abort();
      offSleep?.();
      offSleep = undefined;
      offSkillTurns?.();
      offSkillTurns = undefined;
      offConversations?.();
      offConversations = undefined;
      offDrives?.();
      offDrives = undefined;
      offSense?.();
      offSense = undefined;
      offDriveSource?.();
      offDriveSource = undefined;

      await Promise.allSettled([
        activeSynthesisPromise ?? Promise.resolve(),
        coldWarmupPromise,
        stateWriteChain,
        vault.waitForIdle(),
      ]);
      subscribers.clear();
      skillInvalidateListeners.clear();
    },

    panelModel(): GrowthPanelModel {
      const ev = computeEvaluated(ports.sense.snapshot());
      const drafts = vault.listDraftRecords().map((d) => vault.toDraftView(d));
      const skills = vault.listSkillRecords().map((s) => vault.toSkillView(s, ev.now));
      const archivedSkills = vault.listArchivedRecords().map((a) => vault.toArchivedView(a));

      let activeCount = 0;
      let disabledCount = 0;
      let staleCount = 0;
      for (const s of skills) {
        if (s.status === 'active') activeCount += 1;
        else disabledCount += 1;
        if (s.stale) staleCount += 1;
      }

      return {
        now: ev.now,
        autoGrowthPaused,
        synthesizing: Boolean(activeSynthesisPromise),
        drive: ev.driveView,
        draftCount: drafts.length,
        activeCount,
        disabledCount,
        archivedCount: archivedSkills.length,
        staleCount,
        knownWorkspaces: collectWorkspaceChoices(),
        drafts,
        skills,
        archivedSkills,
        recentSyntheses: vault.recentJournal(8),
      };
    },

    statusSnapshot(filter?: GrowthStatusQueryInput): Record<string, unknown> {
      const model = this.panelModel();
      const scopeFilter = filter?.scope;
      const statusFilter = filter?.status;

      const filteredDrafts = model.drafts
        .filter((d) => (!scopeFilter || d.scope === scopeFilter) && (!statusFilter || statusFilter === 'draft'))
        .map((d) => ({
          id: d.id,
          name: d.name,
          targetVersion: d.targetVersion,
          isRevision: d.isRevision,
          ...(d.revisesSkillName ? { revisesSkillName: d.revisesSkillName } : {}),
          scope: d.scope,
          ...(d.workspaceDisplay ? { workspace: d.workspaceDisplay } : {}),
          description: d.description,
          evidenceSummary: d.evidenceSummary,
          updatedAt: d.updatedAt,
        }));

      const filteredSkills = model.skills
        .filter((s) => {
          if (scopeFilter && s.scope !== scopeFilter) return false;
          if (!statusFilter) return true;
          if (statusFilter === 'stale') return s.stale;
          return s.status === statusFilter;
        })
        .map((s) => ({
          name: s.name,
          version: s.version,
          status: s.status,
          scope: s.scope,
          ...(s.workspaceDisplay ? { workspace: s.workspaceDisplay } : {}),
          description: s.description,
          invocationCount: s.invocationCount,
          lastInvokedAt: s.lastInvokedAt,
          turnCompletionRate: s.turnCompletionRate,
          stale: s.stale,
          daysSinceLastUse: s.daysSinceLastUse,
        }));

      const filteredArchived =
        !statusFilter || statusFilter === 'archived'
          ? model.archivedSkills
              .filter((a) => !scopeFilter || a.scope === scopeFilter)
              .map((a) => ({
                name: a.name,
                version: a.version,
                scope: a.scope,
                ...(a.workspaceDisplay ? { workspace: a.workspaceDisplay } : {}),
                description: a.description,
                archivedAt: a.archivedAt,
                invocationCount: a.invocationCount,
              }))
          : [];

      return {
        now: model.now,
        autoGrowthPaused: model.autoGrowthPaused,
        synthesizing: model.synthesizing,
        drive: model.drive,
        counts: {
          drafts: model.draftCount,
          active: model.activeCount,
          disabled: model.disabledCount,
          archived: model.archivedCount,
          stale: model.staleCount,
        },
        drafts: filteredDrafts,
        skills: filteredSkills,
        archivedSkills: filteredArchived,
      };
    },

    subscribe(listener: () => void): () => void {
      if (!stopped) subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
  };
}
