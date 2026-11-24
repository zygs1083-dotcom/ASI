/**
 * Core Runtime for `asi-care` (`tier: 3` Local Workspace & Project Care).
 *
 * - Fast Probe (default 3m): workspace/worktree discovery + Git hygiene + local orphan ports.
 * - Slow Probe (default 30m): idle worktree build artifact bloat scan (`WalkBudget` + event-loop yields).
 * - Automatic Homeostatic Yielding: pauses when `asi-sense` is paused and suspends
 *   expensive probes / unattended effectors / card proposals whenever `ctx.asiDrives`
 *   reports `higherOrderSuppressed = true` (`L1` distress or `eco` mode).
 * - Zero Foreground Interruption: all HelpCards proposed via `ctx.asiDrives.proposeHelpCard`
 *   are strictly sidebar-only (`silent: true`, zero `<asi-cry>` injection).
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  type DriveAbortSignal,
  type DriveEvaluation,
  type DriveHelpActionInput,
  type DriveHelpActionResult,
  type DriveSandboxToolSpec,
  type ExternalDriveReading,
  sanitizeForModel,
} from '@asi/sense-types';
import {
  ARTIFACT_IDLE_THRESHOLD_MS,
  BLOAT_CRITICAL_BYTES,
  BLOAT_UNCOMFORTABLE_BYTES,
  cleanApprovedWorkspaceArtifact,
  type ScannedWorkspaceArtifact,
  scanWorkspaceArtifacts,
  type WorkspaceBloatReport,
} from './artifact-scanner.js';
import { defaultCareExec } from './command.js';
import { ACTIVE_EXEMPTION_MS, type DiscoveryReport, discoverWorkspacesAndWorktrees } from './discovery.js';
import { CARE_DRIVE_KEYS, type CareDriveKey, evaluateCareDrives } from './evaluator.js';
import {
  type CleanMergedWorktreeCandidate,
  CONFLICT_UNCOMFORTABLE_MS,
  cleanDeadGitLocks,
  DEAD_LOCK_MIN_AGE_MS,
  DIRTY_UNCOMFORTABLE_MS,
  inspectRepoHygiene,
  MERGED_WORKTREE_IDLE_MS,
  pruneDanglingWorktrees,
  type RepoHygieneReport,
  removeApprovedMergedWorktree,
} from './git-inspector.js';
import {
  inspectOrphanRuntime,
  ORPHAN_PORT_IDLE_MS,
  type OrphanDevPortItem,
  type OrphanRuntimeReport,
  terminateApprovedOrphanPort,
} from './port-inspector.js';
import type { CareHostPorts } from './ports.js';
import { formatBytesCompact, formatDurationCompact, makeTargetToken, tryRealpath } from './safety.js';

export const DEFAULT_FAST_INTERVAL_MS = 3 * 60_000; // 3 minutes
export const DEFAULT_SLOW_INTERVAL_MS = 30 * 60_000; // 30 minutes
const TOOL_REFRESH_MIN_COOLDOWN_MS = 5_000;

export interface CareRuntimeOptions {
  extraRoots?: readonly string[];
  ignorePaths?: readonly string[];
  fastIntervalMs?: number;
  slowIntervalMs?: number;
  activeExemptionMs?: number;
  deadLockMinAgeMs?: number;
  conflictUncomfortableMs?: number;
  dirtyUncomfortableMs?: number;
  mergedWorktreeIdleMs?: number;
  orphanPortIdleMs?: number;
  artifactIdleThresholdMs?: number;
  bloatUncomfortableBytes?: number;
  bloatCriticalBytes?: number;
}

interface PersistedCareState {
  dismissedTargets?: string[];
  lastFastProbeAt?: number;
  lastSlowProbeAt?: number;
}

export interface CareStatusSnapshot {
  now: number;
  paused: boolean;
  suppressed: boolean;
  suppressionReason?: string;
  lastFastProbeAt?: number;
  lastSlowProbeAt?: number;
  drives: DriveEvaluation[];
  discovery: {
    repoCount: number;
    worktreeCount: number;
    activeExemptCount: number;
    worktrees: {
      displayPath: string;
      kind: 'git-worktree' | 'plain-workspace';
      branch?: string;
      isMainWorktree: boolean;
      activeExempt: boolean;
      exemptReason?: string;
      idleMs: number;
    }[];
  };
  repoHygiene?: {
    prunableRepos: { displayMainPath: string; prunableCount: number }[];
    deadLocks: { displayLockPath: string; displayWorktreePath: string; ageMs: number }[];
    cleanMergedWorktrees: {
      targetId: string;
      displayWorktreePath: string;
      branch: string;
      baseRef: string;
      idleMs: number;
    }[];
    conflictWorktrees: { displayPath: string; conflictKind?: string; conflictIdleMs?: number }[];
    staleDirtyWorktrees: { displayPath: string; branch?: string; dirtyTotal: number; dirtyIdleMs?: number }[];
    unpushedWorktrees: { displayPath: string; branch?: string; ahead: number }[];
  };
  orphanRuntime?: {
    orphanPorts: {
      targetId: string;
      port: number;
      command: string;
      pid: number;
      rssBytes: number;
      elapsedMs: number;
      displayWorktreePath: string;
    }[];
    orphanDshJobCount: number;
    zombieCount: number;
  };
  workspaceBloat?: {
    totalIdleBytes: number;
    idleArtifacts: {
      targetId: string;
      displayArtifactPath: string;
      displayWorktreePath: string;
      dirName: string;
      label: string;
      totalBytes: number;
      idleMs: number;
    }[];
  };
}

export interface CareRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  runFastProbe(): Promise<void>;
  runSlowProbe(): Promise<void>;
  statusSnapshot(options?: {
    aspect?: 'all' | 'repos' | 'runtime' | 'bloat';
    refresh?: boolean;
  }): Promise<CareStatusSnapshot>;
}

export function createCareRuntime(ports: CareHostPorts, options: CareRuntimeOptions = {}): CareRuntime {
  const clock = ports.clock ?? { wall: () => Date.now(), mono: () => performance.now() };
  const exec = ports.exec ?? defaultCareExec;
  const statePath = join(ports.storageRoot, 'state.json');

  const fastIntervalMs = Math.max(5_000, options.fastIntervalMs ?? DEFAULT_FAST_INTERVAL_MS);
  const slowIntervalMs = Math.max(15_000, options.slowIntervalMs ?? DEFAULT_SLOW_INTERVAL_MS);
  const activeExemptionMs = options.activeExemptionMs ?? ACTIVE_EXEMPTION_MS;
  const bloatUncomfortableBytes = options.bloatUncomfortableBytes ?? BLOAT_UNCOMFORTABLE_BYTES;
  const bloatCriticalBytes = options.bloatCriticalBytes ?? BLOAT_CRITICAL_BYTES;

  const dismissedTargets = new Set<string>();
  const activeKnownTargetIds = new Set<string>();
  const executingTargets = new Set<string>();
  const customAckTargetsByDrive = new Map<CareDriveKey, Set<string>>();
  const artifactTargets = new Map<string, ScannedWorkspaceArtifact>();
  const worktreeTargets = new Map<string, CleanMergedWorktreeCandidate>();
  const portTargets = new Map<string, OrphanDevPortItem>();

  let latestDiscovery: DiscoveryReport = { scannedAt: 0, repos: [], worktrees: [] };
  let latestHygiene: RepoHygieneReport | undefined;
  let latestOrphan: OrphanRuntimeReport | undefined;
  let latestBloat: WorkspaceBloatReport | undefined;
  let latestReadings: readonly ExternalDriveReading[] = evaluateCareDrives({
    discovery: latestDiscovery,
    bloatUncomfortableBytes,
    bloatCriticalBytes,
  });

  let lastFastProbeAt: number | undefined;
  let lastSlowProbeAt: number | undefined;
  let lastToolRefreshMono = Number.NEGATIVE_INFINITY;

  let started = false;
  let stopped = false;
  let fastTimer: ReturnType<typeof setInterval> | undefined;
  let slowTimer: ReturnType<typeof setInterval> | undefined;
  let unregisterDriveSource: (() => void) | undefined;
  let unsubscribeSense: (() => void) | undefined;
  let unsubscribeDrives: (() => void) | undefined;
  interface CoalescedProbeState {
    promise: Promise<void>;
    signal: AbortSignal;
    force: boolean;
    addWaiter: (sig: AbortSignal | undefined) => () => void;
  }

  let probeAbort = new AbortController();
  let fastInFlight: CoalescedProbeState | undefined;
  let slowInFlight: CoalescedProbeState | undefined;
  const inFlightProbes = new Set<Promise<void>>();
  let persistChain: Promise<void> = Promise.resolve();

  function isSuppressedSnapshot(dSnap: { higherOrderSuppressed: boolean; powerMode: string }): boolean {
    return dSnap.higherOrderSuppressed || dSnap.powerMode === 'eco';
  }

  function isPausedOrSuppressed(): boolean {
    if (stopped) return true;
    if (ports.sense.getSettings().paused) return true;
    return isSuppressedSnapshot(ports.drives.snapshot());
  }

  function abortInFlightProbes(): void {
    probeAbort.abort();
    probeAbort = new AbortController();
    fastInFlight = undefined;
    slowInFlight = undefined;
  }

  function createCareAbortError(
    message = 'ASI care sandbox operation aborted due to L1/eco preemption or cancellation',
  ): Error {
    const err = new Error(message);
    err.name = 'AbortError';
    return err;
  }

  function persistState(): Promise<void> {
    const payload: PersistedCareState = {
      ...(dismissedTargets.size > 0 ? { dismissedTargets: [...dismissedTargets].slice(-64) } : {}),
      ...(lastFastProbeAt !== undefined ? { lastFastProbeAt } : {}),
      ...(lastSlowProbeAt !== undefined ? { lastSlowProbeAt } : {}),
    };
    persistChain = persistChain
      .then(async () => {
        await mkdir(ports.storageRoot, { recursive: true });
        const tmp = `${statePath}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`;
        await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        await rename(tmp, statePath);
      })
      .catch(() => undefined);
    return persistChain;
  }

  async function currentActiveSessionCwds(): Promise<string[]> {
    const out: string[] = [];
    for (const s of ports.listSessions()) {
      if (s.internal || !s.active || !s.cwd) continue;
      const real = await tryRealpath(s.cwd);
      if (real) out.push(real);
    }
    return out;
  }

  async function currentExcludedReals(): Promise<string[]> {
    const out: string[] = [];
    for (const raw of [...(options.ignorePaths ?? []), ...ports.listInternalRoots(), ports.storageRoot]) {
      if (!raw?.trim()) continue;
      const expanded = raw.startsWith('~/') ? join(ports.homeDir, raw.slice(2)) : raw;
      out.push((await tryRealpath(expanded)) ?? resolve(expanded));
    }
    return out;
  }

  function resolveActionSignal(
    inputSignal: DriveAbortSignal | undefined,
    runtimeSignal: AbortSignal,
  ): { signal: AbortSignal; dispose: () => void } {
    if (!inputSignal) {
      return { signal: runtimeSignal, dispose: () => {} };
    }
    if (inputSignal instanceof AbortSignal) {
      return { signal: AbortSignal.any([runtimeSignal, inputSignal]), dispose: () => {} };
    }
    if (inputSignal.aborted) {
      return { signal: AbortSignal.abort(), dispose: () => {} };
    }
    const bridge = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      if (inputSignal.aborted) {
        bridge.abort();
        timer = undefined;
        return;
      }
      if (!runtimeSignal.aborted && !bridge.signal.aborted) {
        timer = setTimeout(poll, 15);
        timer.unref?.();
      }
    };
    timer = setTimeout(poll, 15);
    timer.unref?.();
    const dispose = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    return { signal: AbortSignal.any([runtimeSignal, bridge.signal]), dispose };
  }

  function resolveSandboxToolGuard(inputSignal: DriveAbortSignal | undefined): {
    signal: AbortSignal;
    throwIfAborted: () => void;
    dispose: () => void;
  } {
    const runtimeSig = probeAbort.signal;
    const bridged = resolveActionSignal(inputSignal, runtimeSig);
    const throwIfAborted = () => {
      if (stopped || inputSignal?.aborted || bridged.signal.aborted || isPausedOrSuppressed()) {
        throw createCareAbortError();
      }
    };
    return { signal: bridged.signal, throwIfAborted, dispose: bridged.dispose };
  }

  function attachWaiterToProbe(state: CoalescedProbeState, callerSignal?: AbortSignal): Promise<void> {
    if (callerSignal?.aborted) {
      return Promise.reject(createCareAbortError());
    }
    const detach = state.addWaiter(callerSignal);
    const wrapped = state.promise.finally(detach);
    if (!callerSignal) return wrapped;
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const onAbort = () => {
        detach();
        rejectPromise(createCareAbortError());
      };
      callerSignal.addEventListener('abort', onAbort, { once: true });
      wrapped.then(
        () => {
          callerSignal.removeEventListener('abort', onAbort);
          if (callerSignal.aborted) {
            rejectPromise(createCareAbortError());
          } else {
            resolvePromise();
          }
        },
        (err) => {
          callerSignal.removeEventListener('abort', onAbort);
          rejectPromise(err);
        },
      );
    });
  }

  function startCoalescedProbe(
    force: boolean,
    runner: (forceFlag: boolean, sig: AbortSignal) => Promise<void>,
  ): CoalescedProbeState {
    const callersAbort = new AbortController();
    const waiters = new Set<{ sig?: AbortSignal; off?: () => void }>();

    const checkAllWaitersAborted = () => {
      if (waiters.size === 0 || callersAbort.signal.aborted) return;
      for (const w of waiters) {
        if (!w.sig?.aborted) return;
      }
      callersAbort.abort();
    };

    const addWaiter = (sig: AbortSignal | undefined): (() => void) => {
      const entry: { sig?: AbortSignal; off?: () => void } = { ...(sig ? { sig } : {}) };
      if (sig) {
        const listener = () => checkAllWaitersAborted();
        sig.addEventListener('abort', listener, { once: true });
        entry.off = () => sig.removeEventListener('abort', listener);
      }
      waiters.add(entry);
      return () => {
        if (!waiters.delete(entry)) return;
        entry.off?.();
        checkAllWaitersAborted();
      };
    };

    const probeSig = AbortSignal.any([probeAbort.signal, callersAbort.signal]);
    const p = runner(force, probeSig).finally(() => {
      for (const w of [...waiters]) {
        w.off?.();
      }
      waiters.clear();
    });

    return {
      promise: p,
      signal: probeSig,
      force,
      addWaiter,
    };
  }

  function rebuildTargetRegistry(): void {
    artifactTargets.clear();
    worktreeTargets.clear();
    portTargets.clear();
    const nextKnown = new Set<string>();

    for (const wt of latestHygiene?.cleanMergedWorktrees ?? []) {
      worktreeTargets.set(wt.targetId, wt);
      nextKnown.add(wt.targetId);
    }
    for (const c of latestHygiene?.conflictWorktrees ?? []) {
      const tok = c.conflictTargetId ?? makeTargetToken('conflict', `${c.path}:${c.conflictKind ?? 'unmerged'}`);
      nextKnown.add(tok);
    }
    for (const d of latestHygiene?.staleDirtyWorktrees ?? []) {
      const tok = d.dirtyTargetId ?? makeTargetToken('dirty', d.path);
      nextKnown.add(tok);
    }
    for (const p of latestOrphan?.orphanPorts ?? []) {
      portTargets.set(p.targetId, p);
      nextKnown.add(p.targetId);
    }
    for (const a of latestBloat?.idleArtifacts ?? []) {
      artifactTargets.set(a.targetId, a);
      nextKnown.add(a.targetId);
    }
    for (const r of latestReadings) {
      const k = r.key as CareDriveKey;
      if (r.satisfaction >= 70) {
        customAckTargetsByDrive.delete(k);
      } else {
        for (const customTok of customAckTargetsByDrive.get(k) ?? []) {
          nextKnown.add(customTok);
        }
      }
    }

    // Clear dismissed memory for targets that have since been cleaned/resolved
    let prunedDismissed = false;
    for (const t of [...dismissedTargets]) {
      if (!nextKnown.has(t) && activeKnownTargetIds.has(t)) {
        dismissedTargets.delete(t);
        prunedDismissed = true;
      }
    }
    activeKnownTargetIds.clear();
    for (const t of nextKnown) activeKnownTargetIds.add(t);
    if (prunedDismissed) {
      void persistState();
    }
  }

  function recomputeReadings(): void {
    latestReadings = evaluateCareDrives({
      discovery: latestDiscovery,
      hygiene: latestHygiene,
      orphanRuntime: latestOrphan,
      bloat: latestBloat,
      bloatUncomfortableBytes,
      bloatCriticalBytes,
    });
    rebuildTargetRegistry();
    ports.drives.notifySourceChanged('asi-care');
  }

  async function reconcileSilentHelpCards(): Promise<void> {
    if (stopped || !ports.drives.proposeHelpCard || !ports.drives.resolveHelpCards) return;

    const conflictTokens = (latestHygiene?.conflictWorktrees ?? []).map(
      (c) => c.conflictTargetId ?? makeTargetToken('conflict', `${c.path}:${c.conflictKind ?? 'unmerged'}`),
    );
    const dirtyTokens = (latestHygiene?.staleDirtyWorktrees ?? []).map(
      (d) => d.dirtyTargetId ?? makeTargetToken('dirty', d.path),
    );
    const customAckTokens = [...customAckTargetsByDrive.values()].flatMap((set) => [...set]);

    const validTargets: string[] = [
      ...worktreeTargets.keys(),
      ...conflictTokens,
      ...dirtyTokens,
      ...portTargets.keys(),
      ...(latestBloat && latestBloat.totalIdleBytes >= bloatUncomfortableBytes ? [...artifactTargets.keys()] : []),
      ...customAckTokens,
    ];

    // Always resolve stale cards whose underlying target was cleaned or became activeExempt (even across restarts)
    await ports.drives.resolveHelpCards('asi-care', { exceptActionTargets: validTargets }).catch(() => undefined);

    // Propose or refresh top actionable Level-2 / Level-3 silent cards only when not paused or suppressed
    if (isPausedOrSuppressed()) return;

    const topWorktree = latestHygiene?.cleanMergedWorktrees.find((w) => !dismissedTargets.has(w.targetId));
    if (topWorktree) {
      await ports.drives
        .proposeHelpCard('asi-care', {
          driveKey: 'repo_hygiene',
          severity: 'uncomfortable',
          title: `闲置已合入工作树可移除：${topWorktree.displayWorktreePath}`,
          summary: `分支 ${topWorktree.branch} 已合入 ${topWorktree.baseRef}，工作树完全干净且已闲置 ${formatDurationCompact(topWorktree.idleMs)}。`,
          proposedAction: `点击「批准移除闲置工作树」将复核无未提交/未推送改动后执行 git worktree remove（不带 --force）。`,
          actionKind: 'run-drive-action',
          actionTarget: topWorktree.targetId,
          approveLabel: '批准移除闲置工作树',
        })
        .catch(() => undefined);
    }

    const topConflict = latestHygiene?.conflictWorktrees.find((c) => {
      const tok = c.conflictTargetId ?? makeTargetToken('conflict', `${c.path}:${c.conflictKind ?? 'unmerged'}`);
      return !dismissedTargets.has(tok);
    });
    if (topConflict) {
      const conflictToken =
        topConflict.conflictTargetId ??
        makeTargetToken('conflict', `${topConflict.path}:${topConflict.conflictKind ?? 'unmerged'}`);
      await ports.drives
        .proposeHelpCard('asi-care', {
          driveKey: 'repo_hygiene',
          severity: (topConflict.conflictIdleMs ?? 0) >= 48 * 3_600_000 ? 'critical' : 'uncomfortable',
          title: `检测到 Git 冲突残留超 2h：${topConflict.displayPath}`,
          summary: `${topConflict.displayPath} 处于 ${topConflict.conflictKind ?? 'unmerged'} 冲突状态已静置 ${formatDurationCompact(topConflict.conflictIdleMs ?? topConflict.idleMs)}（只读提示，ASI 绝不自动 reset/stash）。`,
          proposedAction: '请前往对应工作树手工完成或中止合并/变基。',
          actionKind: 'acknowledge',
          actionTarget: conflictToken,
        })
        .catch(() => undefined);
    }

    const topStaleDirty = latestHygiene?.staleDirtyWorktrees.find((d) => {
      const tok = d.dirtyTargetId ?? makeTargetToken('dirty', d.path);
      return !dismissedTargets.has(tok);
    });
    if (topStaleDirty) {
      const dirtyToken = topStaleDirty.dirtyTargetId ?? makeTargetToken('dirty', topStaleDirty.path);
      await ports.drives
        .proposeHelpCard('asi-care', {
          driveKey: 'repo_hygiene',
          severity: 'uncomfortable',
          title: `检测到未提交改动静置超 24h：${topStaleDirty.displayPath}`,
          summary: `${topStaleDirty.displayPath}${topStaleDirty.branch ? `（分支 ${topStaleDirty.branch}）` : ''} 存在 ${topStaleDirty.status.dirtyTotal} 项未提交改动已静置 ${formatDurationCompact(topStaleDirty.dirtyIdleMs ?? topStaleDirty.idleMs)}（只读提示，ASI 绝不自动 stash/commit/reset）。`,
          proposedAction: '请前往对应工作树检查并手工提交、暂存或清理改动。',
          actionKind: 'acknowledge',
          actionTarget: dirtyToken,
        })
        .catch(() => undefined);
    }

    const topPort = latestOrphan?.orphanPorts.find((p) => !dismissedTargets.has(p.targetId));
    if (topPort) {
      await ports.drives
        .proposeHelpCard('asi-care', {
          driveKey: 'orphan_runtime',
          severity:
            (latestOrphan?.orphanPorts.length ?? 0) >= 3 || topPort.rssBytes >= 2 * 1024 ** 3
              ? 'critical'
              : 'uncomfortable',
          title: `发现孤儿开发端口：${topPort.command}:${topPort.port}（运行 ${formatDurationCompact(topPort.elapsedMs)}）`,
          summary: `PID ${topPort.pid} 归属非活跃工作树 ${topPort.displayWorktreePath}，占用内存 ${formatBytesCompact(topPort.rssBytes)}。`,
          proposedAction: '点击「批准释放孤儿端口」将在复核进程身份与端口归属后发送 SIGTERM 优雅退出信号。',
          actionKind: 'run-drive-action',
          actionTarget: topPort.targetId,
          approveLabel: '批准释放孤儿端口',
        })
        .catch(() => undefined);
    }

    const topArtifact =
      latestBloat && latestBloat.totalIdleBytes >= bloatUncomfortableBytes
        ? latestBloat.idleArtifacts.find((a) => !dismissedTargets.has(a.targetId))
        : undefined;
    if (topArtifact && latestBloat) {
      await ports.drives
        .proposeHelpCard('asi-care', {
          driveKey: 'workspace_bloat',
          severity: latestBloat.totalIdleBytes >= bloatCriticalBytes ? 'critical' : 'uncomfortable',
          title: `发现闲置构建产物：${topArtifact.displayArtifactPath}（${formatBytesCompact(topArtifact.totalBytes)}）`,
          summary: `${topArtifact.label} 所在工作树已闲置 ${formatDurationCompact(topArtifact.idleMs)}；全部非活跃工作树可重生成产物合计 ${formatBytesCompact(latestBloat.totalIdleBytes)}。`,
          proposedAction: '点击「批准清理构建产物」将在二次确认 2h 内无新修改后安全删除该可重生成产物目录。',
          actionKind: 'run-drive-action',
          actionTarget: topArtifact.targetId,
          approveLabel: '批准清理构建产物',
        })
        .catch(() => undefined);
    }
  }

  async function executeFastProbeInternal(forceWhenSuppressed: boolean, signal: AbortSignal): Promise<void> {
    if (stopped || ports.sense.getSettings().paused || signal.aborted) return;
    if (!forceWhenSuppressed && isPausedOrSuppressed()) return;
    const now = clock.wall();

    const discovery = await discoverWorkspacesAndWorktrees({
      now,
      homeDir: ports.homeDir,
      workspacePaths: ports.listWorkspacePaths(),
      sessions: ports.listSessions(),
      extraRoots: options.extraRoots,
      ignorePaths: options.ignorePaths,
      internalRoots: [...ports.listInternalRoots(), ports.storageRoot],
      activeExemptionMs,
      exec,
      signal,
    });
    if (stopped || signal.aborted || (!forceWhenSuppressed && isPausedOrSuppressed())) return;

    const [orphanJobCount, protectedPidList, excludedReals] = [
      ports.jobs.listOrphanJobs().length,
      ports.jobs.listProtectedJobPids(),
      await currentExcludedReals(),
    ];
    if (stopped || signal.aborted || (!forceWhenSuppressed && isPausedOrSuppressed())) return;
    const protectedPids = new Set<number>(protectedPidList);

    // Run Git hygiene first so refined dirty-file activity propagates `activeExempt` onto `discovery`
    const hygiene = await inspectRepoHygiene({
      now,
      homeDir: ports.homeDir,
      discovery,
      exec,
      activeExemptionMs,
      deadLockMinAgeMs: options.deadLockMinAgeMs ?? DEAD_LOCK_MIN_AGE_MS,
      conflictUncomfortableMs: options.conflictUncomfortableMs ?? CONFLICT_UNCOMFORTABLE_MS,
      dirtyUncomfortableMs: options.dirtyUncomfortableMs ?? DIRTY_UNCOMFORTABLE_MS,
      mergedWorktreeIdleMs: options.mergedWorktreeIdleMs ?? MERGED_WORKTREE_IDLE_MS,
      signal,
    });
    if (stopped || signal.aborted || (!forceWhenSuppressed && isPausedOrSuppressed())) return;

    const orphan = await inspectOrphanRuntime({
      now,
      discovery,
      protectedPids,
      excludedReals,
      orphanDshJobCount: orphanJobCount,
      minPortIdleMs: options.orphanPortIdleMs ?? ORPHAN_PORT_IDLE_MS,
      exec,
      signal,
    });
    if (stopped || signal.aborted || (!forceWhenSuppressed && isPausedOrSuppressed())) return;

    latestDiscovery = discovery;
    latestHygiene = hygiene;
    latestOrphan = orphan;
    // Prune stale bloat entries belonging to worktrees that just became activeExempt
    if (latestBloat) {
      const activeSet = new Set(discovery.worktrees.filter((w) => w.activeExempt).map((w) => w.path));
      if (activeSet.size > 0) {
        const filteredIdle = latestBloat.idleArtifacts.filter((a) => !activeSet.has(a.worktreePath));
        const filteredAll = latestBloat.allArtifacts.filter((a) => !activeSet.has(a.worktreePath));
        latestBloat = {
          ...latestBloat,
          idleArtifacts: filteredIdle,
          allArtifacts: filteredAll,
          totalIdleBytes: filteredIdle.reduce((acc, x) => acc + x.totalBytes, 0),
        };
      }
    }

    lastFastProbeAt = now;
    recomputeReadings();
    await reconcileSilentHelpCards();
    void persistState();
  }

  async function executeSlowProbeInternal(forceWhenSuppressed: boolean, signal: AbortSignal): Promise<void> {
    if (stopped || ports.sense.getSettings().paused || signal.aborted) return;
    if (!forceWhenSuppressed && isPausedOrSuppressed()) return;
    const now = clock.wall();

    if (latestDiscovery.scannedAt === 0) {
      await runFastProbe({ forceWhenSuppressed, signal });
      if (stopped || signal.aborted || (!forceWhenSuppressed && isPausedOrSuppressed())) return;
    }

    const excludedReals = await currentExcludedReals();
    if (stopped || signal.aborted || (!forceWhenSuppressed && isPausedOrSuppressed())) return;

    const bloat = await scanWorkspaceArtifacts({
      now,
      homeDir: ports.homeDir,
      discovery: latestDiscovery,
      excludedReals,
      minArtifactIdleMs: options.artifactIdleThresholdMs ?? ARTIFACT_IDLE_THRESHOLD_MS,
      signal,
    });
    if (stopped || signal.aborted || (!forceWhenSuppressed && isPausedOrSuppressed())) return;

    latestBloat = bloat;
    lastSlowProbeAt = now;
    recomputeReadings();
    await reconcileSilentHelpCards();
    void persistState();
  }

  function runFastProbe(req?: { forceWhenSuppressed?: boolean; signal?: AbortSignal }): Promise<void> {
    const force = req?.forceWhenSuppressed === true;
    const callerSignal = req?.signal;
    if (fastInFlight && !fastInFlight.signal.aborted && (fastInFlight.force || !force || !isPausedOrSuppressed())) {
      return attachWaiterToProbe(fastInFlight, callerSignal);
    }
    const state = startCoalescedProbe(force, executeFastProbeInternal);
    const p = state.promise.finally(() => {
      inFlightProbes.delete(p);
      if (fastInFlight === state) {
        fastInFlight = undefined;
      }
    });
    state.promise = p;
    fastInFlight = state;
    inFlightProbes.add(p);
    return attachWaiterToProbe(state, callerSignal);
  }

  function runSlowProbe(req?: { forceWhenSuppressed?: boolean; signal?: AbortSignal }): Promise<void> {
    const force = req?.forceWhenSuppressed === true;
    const callerSignal = req?.signal;
    if (slowInFlight && !slowInFlight.signal.aborted && (slowInFlight.force || !force || !isPausedOrSuppressed())) {
      return attachWaiterToProbe(slowInFlight, callerSignal);
    }
    const state = startCoalescedProbe(force, executeSlowProbeInternal);
    const p = state.promise.finally(() => {
      inFlightProbes.delete(p);
      if (slowInFlight === state) {
        slowInFlight = undefined;
      }
    });
    state.promise = p;
    slowInFlight = state;
    inFlightProbes.add(p);
    return attachWaiterToProbe(state, callerSignal);
  }

  async function executeApprovedHelpAction(input: DriveHelpActionInput): Promise<DriveHelpActionResult> {
    const targetId = input.actionTarget?.trim() ?? '';
    if (!targetId) {
      throw new Error('Missing controlled actionTarget for asi-care help action');
    }
    if (executingTargets.has(targetId)) {
      throw new Error(`Action target "${targetId}" is already executing`);
    }
    executingTargets.add(targetId);
    const bridgedAction = resolveActionSignal(input.signal, probeAbort.signal);
    const actionSignal = bridgedAction.signal;

    try {
      if (targetId.startsWith('art_')) {
        let candidate = artifactTargets.get(targetId);
        if (!candidate && latestBloat === undefined) {
          await runSlowProbe({ forceWhenSuppressed: true, signal: actionSignal });
          candidate = artifactTargets.get(targetId);
          if (!candidate) {
            return {
              ledgerAction: 'clean-workspace-artifact:already-absent',
              summary: '目标闲置构建产物已不存在，已自动归档历史求助卡',
              freedBytes: 0,
            };
          }
        }
        if (!candidate) {
          throw new Error(`Artifact target "${targetId}" is no longer pending or was already cleaned`);
        }
        const [activeSessionCwds, excludedReals] = await Promise.all([
          currentActiveSessionCwds(),
          currentExcludedReals(),
        ]);
        const effectiveNow = clock.wall();
        const cleaned = await cleanApprovedWorkspaceArtifact({
          candidate,
          now: effectiveNow,
          homeDir: ports.homeDir,
          excludedReals,
          activeSessionCwds,
          activeExemptionMs,
          exec,
          signal: actionSignal,
        });
        // Immediately update local bloat snapshot and re-evaluate so satisfaction gain is measured accurately
        if (latestBloat) {
          const remainingIdle = latestBloat.idleArtifacts.filter((a) => a.targetId !== targetId);
          const remainingAll = latestBloat.allArtifacts.filter((a) => a.targetId !== targetId);
          latestBloat = {
            scannedAt: input.now,
            idleArtifacts: remainingIdle,
            allArtifacts: remainingAll,
            totalIdleBytes: remainingIdle.reduce((acc, x) => acc + x.totalBytes, 0),
          };
        }
        if (!actionSignal.aborted && !isPausedOrSuppressed()) {
          await runFastProbe({ forceWhenSuppressed: false, signal: actionSignal });
        } else {
          recomputeReadings();
          await reconcileSilentHelpCards();
        }
        return {
          ledgerAction: `clean-workspace-artifact:${candidate.dirName}`,
          summary: `用户批准清理闲置构建产物 ${cleaned.deletedPath}（释放 ${formatBytesCompact(cleaned.freedBytes)}）`,
          freedBytes: cleaned.freedBytes,
        };
      }

      if (targetId.startsWith('wt_')) {
        let candidate = worktreeTargets.get(targetId);
        if (!candidate && latestDiscovery.scannedAt === 0) {
          await runFastProbe({ forceWhenSuppressed: true, signal: actionSignal });
          candidate = worktreeTargets.get(targetId);
          if (!candidate) {
            return {
              ledgerAction: 'remove-merged-worktree:already-absent',
              summary: '目标闲置工作树已不存在或状态已变更，已自动归档历史求助卡',
              stoppedJobs: 0,
            };
          }
        }
        if (!candidate) {
          throw new Error(`Worktree target "${targetId}" is no longer pending or was already removed`);
        }
        const activeSessionCwds = await currentActiveSessionCwds();
        const removed = await removeApprovedMergedWorktree({
          candidate,
          now: clock.wall(),
          activeSessionCwds,
          activeExemptionMs,
          exec,
          signal: actionSignal,
        });
        if (latestHygiene) {
          latestHygiene = {
            ...latestHygiene,
            cleanMergedWorktrees: latestHygiene.cleanMergedWorktrees.filter((w) => w.targetId !== targetId),
            worktrees: latestHygiene.worktrees.filter((w) => w.path !== candidate.worktreePath),
          };
        }
        latestDiscovery = {
          ...latestDiscovery,
          worktrees: latestDiscovery.worktrees.filter((w) => w.path !== candidate.worktreePath),
        };
        if (!actionSignal.aborted && !isPausedOrSuppressed()) {
          await runFastProbe({ forceWhenSuppressed: false, signal: actionSignal }).catch(() => undefined);
        } else {
          recomputeReadings();
          await reconcileSilentHelpCards();
        }
        return {
          ledgerAction: 'remove-merged-worktree',
          summary: `用户批准移除干净已合入闲置工作树 ${removed.displayPath}（分支 ${candidate.branch}）`,
          stoppedJobs: 1,
        };
      }

      if (targetId.startsWith('port_')) {
        let candidate = portTargets.get(targetId);
        if (!candidate && latestDiscovery.scannedAt === 0) {
          await runFastProbe({ forceWhenSuppressed: true, signal: actionSignal });
          candidate = portTargets.get(targetId);
          if (!candidate) {
            return {
              ledgerAction: 'stop-orphan-port:already-absent',
              summary: '目标孤儿开发端口已退出，已自动归档历史求助卡',
              stoppedJobs: 0,
            };
          }
        }
        if (!candidate) {
          throw new Error(`Orphan port target "${targetId}" is no longer active`);
        }
        const activeSessionCwds = await currentActiveSessionCwds();
        const protectedPids = new Set<number>(ports.jobs.listProtectedJobPids());
        const res = await terminateApprovedOrphanPort({
          candidate,
          now: clock.wall(),
          activeSessionCwds,
          protectedPids,
          activeExemptionMs,
          exec,
          killFn: ports.killProcess,
          signal: actionSignal,
        });
        if (latestOrphan) {
          latestOrphan = {
            ...latestOrphan,
            orphanPorts: latestOrphan.orphanPorts.filter((p) => p.targetId !== targetId),
          };
        }
        recomputeReadings();
        await reconcileSilentHelpCards();
        return {
          ledgerAction: `stop-orphan-port:${res.command}`,
          summary: `用户批准向孤儿开发端口 ${res.command}:${res.port}（PID ${res.pid}）发送 SIGTERM 释放信号`,
          stoppedJobs: 1,
        };
      }

      throw new Error(`Unrecognized asi-care controlled actionTarget: ${targetId}`);
    } finally {
      bridgedAction.dispose();
      executingTargets.delete(targetId);
    }
  }

  function buildStatusObject(aspect: 'all' | 'repos' | 'runtime' | 'bloat' = 'all'): CareStatusSnapshot {
    const now = clock.wall();
    const settings = ports.sense.getSettings();
    const drivesSnap = ports.drives.snapshot();
    const careDrives = drivesSnap.drives.filter((d) => d.sourceId === 'asi-care');

    const base: CareStatusSnapshot = {
      now,
      paused: settings.paused,
      suppressed: drivesSnap.higherOrderSuppressed,
      ...(drivesSnap.suppressionReason ? { suppressionReason: drivesSnap.suppressionReason } : {}),
      ...(lastFastProbeAt !== undefined ? { lastFastProbeAt } : {}),
      ...(lastSlowProbeAt !== undefined ? { lastSlowProbeAt } : {}),
      drives: careDrives,
      discovery: {
        repoCount: latestDiscovery.repos.length,
        worktreeCount: latestDiscovery.worktrees.length,
        activeExemptCount: latestDiscovery.worktrees.filter((w) => w.activeExempt).length,
        worktrees: latestDiscovery.worktrees.map((w) => ({
          displayPath: w.displayPath,
          kind: w.kind,
          ...(w.branch ? { branch: w.branch } : {}),
          isMainWorktree: w.isMainWorktree,
          activeExempt: w.activeExempt,
          ...(w.exemptReason ? { exemptReason: w.exemptReason } : {}),
          idleMs: w.idleMs,
        })),
      },
    };

    if ((aspect === 'all' || aspect === 'repos') && latestHygiene) {
      base.repoHygiene = {
        prunableRepos: latestHygiene.prunableRepos.map((r) => ({
          displayMainPath: r.displayMainPath,
          prunableCount: r.prunablePaths.length,
        })),
        deadLocks: latestHygiene.deadLocks.map((l) => ({
          displayLockPath: l.displayLockPath,
          displayWorktreePath: l.displayWorktreePath,
          ageMs: l.ageMs,
        })),
        cleanMergedWorktrees: latestHygiene.cleanMergedWorktrees.map((w) => ({
          targetId: w.targetId,
          displayWorktreePath: w.displayWorktreePath,
          branch: w.branch,
          baseRef: w.baseRef,
          idleMs: w.idleMs,
        })),
        conflictWorktrees: latestHygiene.conflictWorktrees.map((w) => ({
          displayPath: w.displayPath,
          ...(w.conflictKind ? { conflictKind: w.conflictKind } : {}),
          ...(w.conflictIdleMs !== undefined ? { conflictIdleMs: w.conflictIdleMs } : {}),
        })),
        staleDirtyWorktrees: latestHygiene.staleDirtyWorktrees.map((w) => ({
          displayPath: w.displayPath,
          ...(w.branch ? { branch: w.branch } : {}),
          dirtyTotal: w.status.dirtyTotal,
          ...(w.dirtyIdleMs !== undefined ? { dirtyIdleMs: w.dirtyIdleMs } : {}),
        })),
        unpushedWorktrees: latestHygiene.unpushedWorktrees.map((w) => ({
          displayPath: w.displayPath,
          ...(w.branch ? { branch: w.branch } : {}),
          ahead: w.status.ahead,
        })),
      };
    }

    if ((aspect === 'all' || aspect === 'runtime') && latestOrphan) {
      base.orphanRuntime = {
        orphanPorts: latestOrphan.orphanPorts.map((p) => ({
          targetId: p.targetId,
          port: p.port,
          command: p.command,
          pid: p.pid,
          rssBytes: p.rssBytes,
          elapsedMs: p.elapsedMs,
          displayWorktreePath: p.displayWorktreePath,
        })),
        orphanDshJobCount: latestOrphan.orphanDshJobCount,
        zombieCount: latestOrphan.zombieCount,
      };
    }

    if ((aspect === 'all' || aspect === 'bloat') && latestBloat) {
      base.workspaceBloat = {
        totalIdleBytes: latestBloat.totalIdleBytes,
        idleArtifacts: latestBloat.idleArtifacts.slice(0, 15).map((a) => ({
          targetId: a.targetId,
          displayArtifactPath: a.displayArtifactPath,
          displayWorktreePath: a.displayWorktreePath,
          dirName: a.dirName,
          label: a.label,
          totalBytes: a.totalBytes,
          idleMs: a.idleMs,
        })),
      };
    }

    return base;
  }

  function buildSandboxTools(): readonly DriveSandboxToolSpec[] {
    return [
      {
        name: 'care_sniff_workspaces',
        description:
          'Read-only workspace & project care sniffer for the internal maintenance session: inspects discovered local Git repos/sibling worktrees, 2h active exemptions, dead Git locks, prunable worktrees, orphan dev ports, and >=7d idle build artifacts.',
        parameters: {
          refreshSlowBloat: {
            type: 'boolean',
            description: 'Set true to also refresh the idle build-artifact scan when investigating workspace_bloat.',
          },
        },
        execute: async (args, context) => {
          const guard = resolveSandboxToolGuard(context?.signal);
          try {
            guard.throwIfAborted();
            await runFastProbe({ forceWhenSuppressed: false, signal: guard.signal });
            guard.throwIfAborted();
            if (args.refreshSlowBloat === true || latestBloat === undefined) {
              await runSlowProbe({ forceWhenSuppressed: false, signal: guard.signal });
              guard.throwIfAborted();
            }
            const snap = buildStatusObject('all');
            return {
              summary: `已巡检 ${snap.discovery.worktreeCount} 个本地工作树（${snap.discovery.activeExemptCount} 个享 2h 活跃豁免）`,
              data: {
                worktrees: snap.discovery.worktreeCount,
                activeExempt: snap.discovery.activeExemptCount,
                deadLocks: snap.repoHygiene?.deadLocks.length ?? 0,
                prunableRepos: snap.repoHygiene?.prunableRepos.length ?? 0,
                cleanMergedWorktrees: snap.repoHygiene?.cleanMergedWorktrees.length ?? 0,
                orphanPorts: snap.orphanRuntime?.orphanPorts.length ?? 0,
                orphanDshJobs: snap.orphanRuntime?.orphanDshJobCount ?? 0,
                idleArtifactBytes: snap.workspaceBloat?.totalIdleBytes ?? 0,
                topWorktreeTarget: snap.repoHygiene?.cleanMergedWorktrees[0]?.targetId ?? null,
                topPortTarget: snap.orphanRuntime?.orphanPorts[0]?.targetId ?? null,
                topArtifactTarget: snap.workspaceBloat?.idleArtifacts[0]?.targetId ?? null,
              },
            };
          } finally {
            guard.dispose();
          }
        },
      },
      {
        name: 'care_prune_worktrees',
        description:
          'Level-1 unattended zero-loss cleanup: run `git worktree prune` on local repositories that have dangling metadata for already-deleted worktree directories. Never touches existing directories.',
        driveKey: 'repo_hygiene',
        execute: async (_args, context) => {
          const guard = resolveSandboxToolGuard(context?.signal);
          try {
            guard.throwIfAborted();
            if (!latestHygiene || latestHygiene.prunableRepos.length === 0) {
              await runFastProbe({ forceWhenSuppressed: false, signal: guard.signal });
              guard.throwIfAborted();
            }
            const prunable = latestHygiene?.prunableRepos ?? [];
            if (prunable.length === 0) {
              return { summary: '当前无悬空的 Git 工作树元数据需要清理' };
            }
            const res = await pruneDanglingWorktrees({
              repos: prunable,
              exec,
              signal: guard.signal,
            });
            guard.throwIfAborted();
            await runFastProbe({ forceWhenSuppressed: false, signal: guard.signal });
            guard.throwIfAborted();
            return {
              summary:
                res.prunedEntryCount > 0
                  ? `已安全执行 git worktree prune，清理 ${res.prunedRepoCount} 个仓库中的 ${res.prunedEntryCount} 条悬空工作树元数据`
                  : '悬空工作树元数据未产生变更',
              stoppedJobs: res.prunedEntryCount,
            };
          } finally {
            guard.dispose();
          }
        },
      },
      {
        name: 'care_clean_git_locks',
        description:
          'Level-1 unattended zero-loss cleanup: remove stale controlled Git lock files (.git/index.lock, HEAD.lock, etc.) ONLY in non-active worktrees after `lsof` positively verifies zero open process holders.',
        driveKey: 'repo_hygiene',
        execute: async (_args, context) => {
          const guard = resolveSandboxToolGuard(context?.signal);
          try {
            guard.throwIfAborted();
            if (!latestHygiene) {
              await runFastProbe({ forceWhenSuppressed: false, signal: guard.signal });
              guard.throwIfAborted();
            }
            const locks = latestHygiene?.deadLocks ?? [];
            if (locks.length === 0) {
              return { summary: '当前未发现无进程持有的陈旧 Git 死锁文件' };
            }
            const res = await cleanDeadGitLocks({
              locks,
              now: clock.wall(),
              deadLockMinAgeMs: options.deadLockMinAgeMs ?? DEAD_LOCK_MIN_AGE_MS,
              activeExemptionMs,
              exec,
              signal: guard.signal,
            });
            guard.throwIfAborted();
            await runFastProbe({ forceWhenSuppressed: false, signal: guard.signal });
            guard.throwIfAborted();
            return {
              summary:
                res.removedLocks.length > 0
                  ? `经 lsof 复核零进程占用，已安全移除陈旧死锁：${res.removedLocks.join('、')}`
                  : '复核发现锁文件存在新活动或无法确认零占用，已安全跳过',
              stoppedJobs: res.removedLocks.length,
            };
          } finally {
            guard.dispose();
          }
        },
      },
      {
        name: 'care_stop_orphan_jobs',
        description:
          'Level-1 unattended zero-loss cleanup: stop DSH-owned background jobs whose owning session no longer exists. Never touches live user sessions or external OS processes.',
        driveKey: 'orphan_runtime',
        execute: async (_args, context) => {
          const guard = resolveSandboxToolGuard(context?.signal);
          try {
            guard.throwIfAborted();
            const orphans = ports.jobs.listOrphanJobs();
            if (orphans.length === 0) {
              return { summary: '当前无 DSH 自有无主孤儿后台任务' };
            }
            let stoppedCount = 0;
            for (const job of orphans) {
              guard.throwIfAborted();
              const r = ports.jobs.killOrphanJob(job.id, job.owner, 'ASI 工作区看护清理无主孤儿后台任务');
              if (r === 'requested') stoppedCount += 1;
            }
            guard.throwIfAborted();
            await runFastProbe({ forceWhenSuppressed: false, signal: guard.signal });
            guard.throwIfAborted();
            return {
              summary:
                stoppedCount > 0 ? `已回收 ${stoppedCount} 个无主 DSH 后台孤儿任务` : '无主 DSH 任务已在结束过程中',
              stoppedJobs: stoppedCount,
            };
          } finally {
            guard.dispose();
          }
        },
      },
      {
        name: 'care_request_help',
        description:
          'File a silent sidebar-only HelpCard (zero <asi-cry> foreground chat interruption) for Level-2 user-approved actions (cleaning >=7d idle build artifact `art_*`, removing clean merged idle worktree `wt_*`, SIGTERMing local orphan dev port `port_*`) or Level-3 read-only conflict/uncommitted advisories.',
        parameters: {
          driveKey: {
            type: 'string',
            enum: [...CARE_DRIVE_KEYS],
            required: true,
            description: 'Target L3 care drive key.',
          },
          title: {
            type: 'string',
            required: true,
            description: 'Concise actionable card title (<=80 chars).',
          },
          summary: {
            type: 'string',
            required: true,
            description: 'Factual explanation of the workspace issue.',
          },
          proposedAction: {
            type: 'string',
            description: 'Recommended action description.',
          },
          actionKind: {
            type: 'string',
            enum: ['acknowledge', 'run-drive-action'],
            description:
              'Use run-drive-action with a controlled targetId from care_sniff_workspaces, or acknowledge for read-only advisories.',
          },
          targetId: {
            type: 'string',
            description:
              'Controlled target identifier (`art_*`, `wt_*`, or `port_*`) required when actionKind="run-drive-action".',
          },
        },
        execute: async (args, context) => {
          const guard = resolveSandboxToolGuard(context?.signal);
          try {
            guard.throwIfAborted();
            if (!ports.drives.proposeHelpCard) {
              throw new Error('Host asiDrives does not support proposeHelpCard');
            }
            const rawDrive = String(args.driveKey ?? '').trim() as CareDriveKey;
            if (!(CARE_DRIVE_KEYS as readonly string[]).includes(rawDrive)) {
              throw new Error(`Invalid care driveKey: ${String(args.driveKey)}`);
            }
            const actionKind = args.actionKind === 'run-drive-action' ? 'run-drive-action' : 'acknowledge';
            let targetId = typeof args.targetId === 'string' && args.targetId.trim() ? args.targetId.trim() : undefined;
            let approveLabel: string | undefined;

            if (actionKind === 'run-drive-action') {
              if (!targetId) {
                throw new Error('targetId is required when actionKind="run-drive-action"');
              }
              if (targetId.startsWith('art_') && artifactTargets.has(targetId)) {
                approveLabel = '批准清理构建产物';
              } else if (targetId.startsWith('wt_') && worktreeTargets.has(targetId)) {
                approveLabel = '批准移除闲置工作树';
              } else if (targetId.startsWith('port_') && portTargets.has(targetId)) {
                approveLabel = '批准释放孤儿端口';
              } else {
                throw new Error(
                  `Unknown or expired controlled targetId "${targetId}"; inspect care_sniff_workspaces first`,
                );
              }
            } else {
              if (!targetId) {
                targetId = makeTargetToken('dirty', `advisory:${rawDrive}:${String(args.title ?? '').trim()}`);
              }
              let set = customAckTargetsByDrive.get(rawDrive);
              if (!set) {
                set = new Set<string>();
                customAckTargetsByDrive.set(rawDrive, set);
              }
              set.add(targetId);
              activeKnownTargetIds.add(targetId);
            }

            guard.throwIfAborted();
            const card = await ports.drives.proposeHelpCard('asi-care', {
              driveKey: rawDrive,
              title: String(args.title ?? ''),
              summary: String(args.summary ?? ''),
              ...(typeof args.proposedAction === 'string' && args.proposedAction.trim()
                ? { proposedAction: args.proposedAction }
                : {}),
              actionKind,
              ...(targetId ? { actionTarget: targetId } : {}),
              ...(approveLabel ? { approveLabel } : {}),
            });
            guard.throwIfAborted();
            return {
              summary: `已在侧栏置顶静默求助卡（零前台打扰）：${String(sanitizeForModel(card.title))}`,
              data: {
                cardId: card.id,
                silent: true,
                actionKind: card.actionKind,
                targetId: card.actionTarget ?? null,
              },
            };
          } finally {
            guard.dispose();
          }
        },
      },
    ];
  }

  return {
    async start() {
      if (started) return;
      started = true;
      stopped = false;
      probeAbort = new AbortController();

      try {
        const raw = await readFile(statePath, 'utf8');
        const parsed = JSON.parse(raw) as PersistedCareState;
        if (Array.isArray(parsed.dismissedTargets)) {
          for (const t of parsed.dismissedTargets.slice(0, 64)) {
            if (typeof t === 'string' && t.trim()) dismissedTargets.add(t.trim());
          }
        }
      } catch {
        // Fresh state
      }

      if (stopped) return;

      unregisterDriveSource = ports.drives.registerSource({
        id: 'asi-care',
        tier: 3,
        label: '工作区与项目看护',
        evaluate: () => latestReadings,
        sandboxTools: buildSandboxTools(),
        executeHelpAction: (input) => executeApprovedHelpAction(input),
        onHelpAcknowledged: async ({ actionTarget }) => {
          if (!isPausedOrSuppressed()) {
            await runFastProbe({ forceWhenSuppressed: false });
          }
          if (actionTarget && activeKnownTargetIds.has(actionTarget)) {
            dismissedTargets.add(actionTarget);
            await reconcileSilentHelpCards();
            void persistState();
          }
        },
        onHelpDismissed: ({ actionTarget }) => {
          if (actionTarget) {
            dismissedTargets.add(actionTarget);
            void persistState();
          }
        },
      });

      let wasPaused = ports.sense.getSettings().paused;
      unsubscribeSense = ports.sense.subscribe((snap) => {
        if (snap.settings.paused && !wasPaused) {
          wasPaused = true;
          abortInFlightProbes();
        } else if (!snap.settings.paused && wasPaused) {
          wasPaused = false;
          if (!isPausedOrSuppressed()) {
            void runFastProbe({ forceWhenSuppressed: false });
          }
        }
      });

      let wasSuppressed = isSuppressedSnapshot(ports.drives.snapshot());
      unsubscribeDrives = ports.drives.subscribe((dSnap) => {
        const nowSuppressed = isSuppressedSnapshot(dSnap);
        if (!wasSuppressed && nowSuppressed) {
          wasSuppressed = true;
          abortInFlightProbes();
          return;
        }
        if (wasSuppressed && !nowSuppressed) {
          wasSuppressed = false;
          if (!stopped && !ports.sense.getSettings().paused) {
            void (async () => {
              if (latestDiscovery.scannedAt > 0) {
                await reconcileSilentHelpCards();
              }
              if (stopped || isPausedOrSuppressed()) return;
              await runFastProbe({ forceWhenSuppressed: false });
              if (!stopped && !isPausedOrSuppressed() && latestBloat === undefined) {
                await runSlowProbe({ forceWhenSuppressed: false });
              }
            })();
          }
          return;
        }
        wasSuppressed = nowSuppressed;
      });

      if (!isPausedOrSuppressed()) {
        await runFastProbe({ forceWhenSuppressed: false });
        if (stopped) return;
        if (!isPausedOrSuppressed()) {
          void runSlowProbe({ forceWhenSuppressed: false });
        }
      }

      fastTimer = setInterval(() => {
        if (!stopped && !isPausedOrSuppressed()) {
          void runFastProbe({ forceWhenSuppressed: false });
        }
      }, fastIntervalMs);
      fastTimer.unref?.();

      slowTimer = setInterval(() => {
        if (!stopped && !isPausedOrSuppressed()) {
          void runSlowProbe({ forceWhenSuppressed: false });
        }
      }, slowIntervalMs);
      slowTimer.unref?.();
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      if (fastTimer) {
        clearInterval(fastTimer);
        fastTimer = undefined;
      }
      if (slowTimer) {
        clearInterval(slowTimer);
        slowTimer = undefined;
      }
      unsubscribeSense?.();
      unsubscribeSense = undefined;
      unsubscribeDrives?.();
      unsubscribeDrives = undefined;
      const pending = [...inFlightProbes];
      abortInFlightProbes();
      unregisterDriveSource?.();
      unregisterDriveSource = undefined;
      await Promise.allSettled(pending);
      await persistChain;
    },

    runFastProbe: () => runFastProbe({ forceWhenSuppressed: true }),
    runSlowProbe: () => runSlowProbe({ forceWhenSuppressed: true }),

    async statusSnapshot(req) {
      if (req?.refresh && !stopped && !ports.sense.getSettings().paused) {
        const mono = clock.mono();
        if (mono - lastToolRefreshMono >= TOOL_REFRESH_MIN_COOLDOWN_MS || latestDiscovery.scannedAt === 0) {
          lastToolRefreshMono = mono;
          await runFastProbe({ forceWhenSuppressed: true });
          if (
            (req.aspect === 'bloat' || req.aspect === 'all') &&
            latestBloat === undefined &&
            !isPausedOrSuppressed()
          ) {
            await runSlowProbe({ forceWhenSuppressed: false });
          }
        }
      } else if (latestDiscovery.scannedAt === 0 && !stopped && !ports.sense.getSettings().paused) {
        await runFastProbe({ forceWhenSuppressed: true });
      }
      return buildStatusObject(req?.aspect ?? 'all');
    },
  };
}
