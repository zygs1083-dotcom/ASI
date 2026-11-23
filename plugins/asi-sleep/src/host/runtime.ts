/**
 * `asi-sleep` Core Host Runtime:
 * - Observes ordinary user conversation turns (skipping internal & subagent sessions)
 * - Registers L2 drive (`id: 'asi-sleep', tier: 2`) & sandbox tool with `ctx.asiDrives`
 * - Enforces dual-factor sleepiness + quiet-window gating + <=6/day auto quota
 * - Preempts/aborts background consolidation immediately upon L1 distress or `eco` mode
 * - Provides memory CRUD, `memory_recall` (with FSRS recall strengthening), and `memory_profile`
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DriveAbortSignal, SenseSnapshot } from '@asi/sense-types';
import { searchMemoryItems } from '../shared/search.js';
import {
  MEMORY_KINDS,
  type MemoryCreateInput,
  type MemoryEntry,
  type MemoryKind,
  type MemoryUpdateInput,
  type MemoryViewItem,
  type SleepConsolidationRecord,
  type SleepConsolidationTrigger,
  type SleepPanelModel,
} from '../shared/types.js';
import { type ConversationTurnInput, runTwoPhaseSleepConsolidation } from './consolidator.js';
import {
  evaluateSleepState,
  QUIET_IDLE_THRESHOLD_MS,
  ROLLING_DAY_WINDOW_MS,
  TIME_DISCOMFORT_THRESHOLD_MS,
} from './evaluator.js';
import { computeMemoryRetention, createInitialFsrsState, strengthenFsrsState } from './fsrs.js';
import type { SleepHostPorts } from './ports.js';
import { MemoryVault, sanitizeMemoryEntry, sanitizeSleepText } from './vault.js';

const MAX_TRACKED_TURN_KEYS = 10_000;
const MAX_TRACKED_SESSION_WATERMARKS = 2_000;
const MAX_PANEL_MEMORIES = 500;

interface PersistedSleepState {
  autoSleepPaused?: boolean;
  lastSleepAt?: number | null;
  firstUnconsolidatedTurnAt?: number | null;
  lastOrdinaryActivityAt?: number;
  autoRunTimestamps?: number[];
  consolidatedTurnKeys?: string[];
  consolidatedSessionWatermarks?: Record<string, number>;
}

export interface RecallQueryInput {
  query: string;
  kind?: MemoryKind;
  limit?: number;
  includeLowRetention?: boolean;
  strengthen?: boolean;
}

export interface RecallHitItem {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string[];
  pinned: boolean;
  retention: number;
  stabilityDays: number;
  recallCount: number;
  updatedAt: number;
  links?: string[];
  score: number;
}

export interface RecallQueryResult {
  now: number;
  query: string;
  totalMemories: number;
  hits: RecallHitItem[];
}

export interface ProfileQueryInput {
  kind?: MemoryKind;
  limitPerKind?: number;
}

export interface ProfileQueryResult {
  now: number;
  totalMemories: number;
  pinnedCount: number;
  lastSleepAt: number | null;
  countsByKind: Record<MemoryKind, number>;
  profile: Partial<Record<MemoryKind, MemoryViewItem[]>>;
}

export interface SleepActionsApi {
  consolidateNow(): Promise<SleepConsolidationRecord>;
  setAutoSleepPaused(paused: boolean): Promise<void>;
  createMemory(input: MemoryCreateInput): Promise<MemoryViewItem>;
  updateMemory(id: string, patch: MemoryUpdateInput): Promise<MemoryViewItem>;
  togglePin(id: string, pinned: boolean): Promise<MemoryViewItem>;
  deleteMemory(id: string): Promise<void>;
  searchMemories(query: string, kind?: MemoryKind): Promise<MemoryViewItem[]>;
}

export interface SleepRuntime {
  readonly vault: MemoryVault;
  readonly actions: SleepActionsApi;
  start(): Promise<void>;
  stop(): Promise<void>;
  panelModel(): SleepPanelModel;
  subscribe(listener: () => void): () => void;
  recall(input: RecallQueryInput): Promise<RecallQueryResult>;
  profile(input?: ProfileQueryInput): ProfileQueryResult;
}

function turnKeyOf(turn: Pick<ConversationTurnInput, 'sessionId' | 'turnId'>): string {
  return `${turn.sessionId}::${turn.turnId}`;
}

function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
}

export function createSleepRuntime(ports: SleepHostPorts): SleepRuntime {
  const clock = ports.clock ?? { wall: () => Date.now(), mono: () => performance.now() };
  const statePath = join(ports.storageRoot, 'state.json');
  const vault = new MemoryVault(ports.storageRoot, ports.homeDir);

  let started = false;
  let stopped = false;
  let autoSleepPaused = false;
  let lastSleepAt: number | null = null;
  let firstUnconsolidatedTurnAt: number | null = null;
  let lastOrdinaryActivityAt = clock.wall();
  let autoRunTimestamps: number[] = [];
  const consolidatedTurnKeys: string[] = [];
  const consolidatedTurnKeySet = new Set<string>();
  const consolidatedSessionWatermarks = new Map<string, number>();

  let latestSense: SenseSnapshot = ports.sense.snapshot();
  let higherOrderSuppressed = false;
  let cachedSuppressionReason: string | undefined;

  let activeConsolidationPromise: Promise<SleepConsolidationRecord> | undefined;
  let activeConsolidationAbort: AbortController | undefined;
  let activeConsolidationTrigger: SleepConsolidationTrigger | null = null;
  let manualPreemptPending = false;
  let coldWarmupAbort: AbortController | undefined;

  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let timeThresholdTimer: ReturnType<typeof setTimeout> | undefined;
  let stateWriteChain: Promise<void> = Promise.resolve();

  const subscribers = new Set<() => void>();
  let offSense: (() => void) | undefined;
  let offDrives: (() => void) | undefined;
  let offDriveSource: (() => void) | undefined;
  let offConversations: (() => void) | undefined;

  function notify(): void {
    if (stopped) return;
    for (const fn of [...subscribers]) {
      try {
        fn();
      } catch {
        // Isolate listener error
      }
    }
  }

  function clearTimers(): void {
    if (quietTimer !== undefined) {
      clearTimeout(quietTimer);
      quietTimer = undefined;
    }
    if (timeThresholdTimer !== undefined) {
      clearTimeout(timeThresholdTimer);
      timeThresholdTimer = undefined;
    }
  }

  function isTurnConsolidated(turn: Pick<ConversationTurnInput, 'sessionId' | 'turnId' | 'seq'>): boolean {
    if (typeof turn.seq === 'number' && Number.isFinite(turn.seq)) {
      const watermark = consolidatedSessionWatermarks.get(turn.sessionId);
      if (watermark !== undefined && turn.seq <= watermark) {
        return true;
      }
    }
    return consolidatedTurnKeySet.has(turnKeyOf(turn));
  }

  function recordConsolidatedKeys(keys: readonly string[], liveProtectedKeys?: ReadonlySet<string>): void {
    for (const key of keys) {
      if (consolidatedTurnKeySet.has(key)) continue;
      consolidatedTurnKeySet.add(key);
      consolidatedTurnKeys.push(key);
    }
    if (consolidatedTurnKeys.length > MAX_TRACKED_TURN_KEYS) {
      let excess = consolidatedTurnKeys.length - MAX_TRACKED_TURN_KEYS;
      if (liveProtectedKeys && liveProtectedKeys.size > 0) {
        let idx = 0;
        while (excess > 0 && idx < consolidatedTurnKeys.length) {
          const candidate = consolidatedTurnKeys[idx];
          if (candidate && !liveProtectedKeys.has(candidate)) {
            consolidatedTurnKeys.splice(idx, 1);
            consolidatedTurnKeySet.delete(candidate);
            excess -= 1;
          } else {
            idx += 1;
          }
        }
      } else {
        while (excess > 0 && consolidatedTurnKeys.length > 0) {
          const evicted = consolidatedTurnKeys.shift();
          if (evicted) consolidatedTurnKeySet.delete(evicted);
          excess -= 1;
        }
      }
      // Hard safety ceiling in case a single process holds >50k non-seq mock turns in RAM
      while (consolidatedTurnKeys.length > 50_000) {
        const evicted = consolidatedTurnKeys.shift();
        if (evicted) consolidatedTurnKeySet.delete(evicted);
      }
    }
  }

  function recordConsolidatedTurns(
    turns: readonly Pick<ConversationTurnInput, 'sessionId' | 'turnId' | 'seq'>[],
    liveTurns?: readonly Pick<ConversationTurnInput, 'sessionId' | 'turnId' | 'seq'>[],
  ): void {
    const keysToRecord: string[] = [];
    for (const t of turns) {
      if (typeof t.seq === 'number' && Number.isFinite(t.seq)) {
        const prev = consolidatedSessionWatermarks.get(t.sessionId);
        const nextSeq = prev !== undefined ? Math.max(prev, Math.trunc(t.seq)) : Math.trunc(t.seq);
        consolidatedSessionWatermarks.delete(t.sessionId);
        consolidatedSessionWatermarks.set(t.sessionId, nextSeq);
      } else {
        keysToRecord.push(turnKeyOf(t));
      }
    }
    while (consolidatedSessionWatermarks.size > MAX_TRACKED_SESSION_WATERMARKS) {
      const oldestSession = consolidatedSessionWatermarks.keys().next().value;
      if (!oldestSession) break;
      consolidatedSessionWatermarks.delete(oldestSession);
    }
    const liveProtected = liveTurns
      ? new Set(liveTurns.filter((t) => !(typeof t.seq === 'number' && Number.isFinite(t.seq))).map(turnKeyOf))
      : undefined;
    recordConsolidatedKeys(keysToRecord, liveProtected);
  }

  function pruneOldAutoTimestamps(now: number): void {
    autoRunTimestamps = autoRunTimestamps.filter((ts) => now - ts < ROLLING_DAY_WINDOW_MS);
  }

  function persistState(): Promise<void> {
    const run = async () => {
      await mkdir(ports.storageRoot, { recursive: true });
      const payload: PersistedSleepState = {
        autoSleepPaused,
        lastSleepAt,
        firstUnconsolidatedTurnAt,
        lastOrdinaryActivityAt,
        autoRunTimestamps: [...autoRunTimestamps],
        consolidatedTurnKeys: [...consolidatedTurnKeys],
        consolidatedSessionWatermarks: Object.fromEntries(consolidatedSessionWatermarks),
      };
      const tmp = `${statePath}.${randomUUID()}.tmp`;
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

  function pendingOrdinaryTurns(now: number): ConversationTurnInput[] {
    let all: ConversationTurnInput[] = [];
    try {
      all = ports.conversations.listCompletedOrdinaryTurns();
    } catch {
      all = [];
    }
    const pending = all.filter((t) => !isTurnConsolidated(t));
    if (pending.length === 0) {
      firstUnconsolidatedTurnAt = null;
    } else {
      let earliest = Number.POSITIVE_INFINITY;
      for (const t of pending) {
        if (typeof t.at === 'number' && Number.isFinite(t.at) && t.at > 0 && t.at < earliest) {
          earliest = t.at;
        }
      }
      firstUnconsolidatedTurnAt = Number.isFinite(earliest) ? earliest : (firstUnconsolidatedTurnAt ?? now);
    }
    return pending;
  }

  function computeEvaluated(senseSnap: SenseSnapshot, options?: { fromDriveArbiter?: boolean }) {
    const now = clock.wall();
    pruneOldAutoTimestamps(now);
    const pending = pendingOrdinaryTurns(now);
    const anyRunning = ports.conversations.anyOrdinarySessionRunning();
    const drivesSnap = options?.fromDriveArbiter ? undefined : ports.drives.snapshot();
    const ecoActive = senseSnap.settings.powerMode === 'eco';
    const effSuppressed = (drivesSnap ? drivesSnap.higherOrderSuppressed : higherOrderSuppressed) || ecoActive;
    const effReason =
      (drivesSnap ? drivesSnap.suppressionReason : cachedSuppressionReason) ??
      (ecoActive ? '当前处于节能降频模式，高阶需求已挂起' : undefined);

    higherOrderSuppressed = effSuppressed;
    cachedSuppressionReason = effReason;

    return {
      now,
      pending,
      anyRunning,
      ...evaluateSleepState({
        now,
        sense: senseSnap,
        unconsolidatedTurns: pending.length,
        lastSleepAt,
        firstUnconsolidatedTurnAt,
        lastOrdinaryActivityAt,
        anyOrdinarySessionRunning: anyRunning,
        autoSleepPaused,
        autoRunTimestamps,
        higherOrderSuppressed: effSuppressed,
        ...(effReason ? { suppressionReason: effReason } : {}),
      }),
    };
  }

  function scheduleWakeTimers(): void {
    clearTimers();
    if (stopped || activeConsolidationPromise) return;
    const evaluated = computeEvaluated(latestSense);
    if (autoSleepPaused || latestSense.settings.paused) return;

    // Schedule 6h elapsed sleepiness timer if turns exist and not yet sleepy
    if (
      evaluated.pending.length > 0 &&
      !evaluated.driveView.sleepy &&
      evaluated.driveView.elapsedSinceSleepMs !== null
    ) {
      const remainSleepyMs = TIME_DISCOMFORT_THRESHOLD_MS - evaluated.driveView.elapsedSinceSleepMs;
      if (remainSleepyMs > 0 && remainSleepyMs <= ROLLING_DAY_WINDOW_MS) {
        timeThresholdTimer = setTimeout(
          () => {
            timeThresholdTimer = undefined;
            reconcileAndMaybeSleep();
          },
          Math.min(2_147_483_647, Math.ceil(remainSleepyMs) + 15),
        );
        timeThresholdTimer.unref?.();
      }
    }

    // Schedule 10m idle quiet-window timer if sleepy and waiting for idle
    if (
      evaluated.driveView.sleepy &&
      !evaluated.driveView.suppressed &&
      evaluated.driveView.autoRunsToday < evaluated.driveView.dailyAutoQuota &&
      !evaluated.driveView.quietWindow &&
      !evaluated.anyRunning
    ) {
      const remainIdleMs = QUIET_IDLE_THRESHOLD_MS - evaluated.driveView.idleDurationMs;
      if (remainIdleMs > 0) {
        quietTimer = setTimeout(
          () => {
            quietTimer = undefined;
            reconcileAndMaybeSleep();
          },
          Math.min(2_147_483_647, Math.ceil(remainIdleMs) + 15),
        );
        quietTimer.unref?.();
      }
    }
  }

  function maybeAbortPreemptedAutoConsolidation(): void {
    if (!activeConsolidationAbort) return;
    if (activeConsolidationTrigger === 'manual') return;
    const senseSettings = ports.sense.getSettings();
    const drivesSnap = ports.drives.snapshot();
    if (
      stopped ||
      autoSleepPaused ||
      senseSettings.paused ||
      senseSettings.powerMode === 'eco' ||
      drivesSnap.higherOrderSuppressed
    ) {
      activeConsolidationAbort.abort();
    }
  }

  async function executeConsolidation(
    trigger: SleepConsolidationTrigger,
    externalSignal?: DriveAbortSignal,
  ): Promise<SleepConsolidationRecord> {
    if (activeConsolidationPromise) {
      return activeConsolidationPromise;
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

    const runTimestamp = clock.wall();
    let reservedAutoSlot = false;
    if (trigger === 'auto') {
      pruneOldAutoTimestamps(runTimestamp);
      autoRunTimestamps.push(runTimestamp);
      reservedAutoSlot = true;
    }

    activeConsolidationAbort = localAbort;
    activeConsolidationTrigger = trigger;
    clearTimers();
    notify();

    const task = (async (): Promise<SleepConsolidationRecord> => {
      try {
        const now = clock.wall();
        await vault.syncExternalChanges(now);
        const turnsToProcess = pendingOrdinaryTurns(now);

        const result = await runTwoPhaseSleepConsolidation({
          turns: turnsToProcess,
          existingMemories: () => vault.list(clock.wall()),
          now,
          trigger,
          signal: localAbort.signal,
          ...(ports.homeDir ? { homeDir: ports.homeDir } : {}),
          ...(ports.llmExtract ? { llmExtract: ports.llmExtract } : {}),
        });

        if (localAbort.signal.aborted || stopped) {
          const err = new Error('Sleep consolidation preempted');
          err.name = 'AbortError';
          throw err;
        }

        if (trigger !== 'manual') {
          const drivesSnap = ports.drives.snapshot();
          const senseSettings = ports.sense.getSettings();
          if (drivesSnap.higherOrderSuppressed || senseSettings.powerMode === 'eco' || senseSettings.paused) {
            const err = new Error('Sleep consolidation preempted by L1 survival distress');
            err.name = 'AbortError';
            throw err;
          }
        }

        const commitNow = clock.wall();
        vault.replaceAll(result.memories);
        const savedRecord = vault.appendJournal({ ...result.record, at: commitNow });
        let latestAllTurns: ConversationTurnInput[] = turnsToProcess;
        try {
          latestAllTurns = ports.conversations.listCompletedOrdinaryTurns();
        } catch {
          latestAllTurns = turnsToProcess;
        }
        recordConsolidatedTurns(turnsToProcess, latestAllTurns);
        lastSleepAt = commitNow;
        pendingOrdinaryTurns(commitNow);

        await Promise.all([vault.flush(commitNow), persistState()]);
        return savedRecord;
      } catch (err) {
        if (reservedAutoSlot) {
          const idx = autoRunTimestamps.lastIndexOf(runTimestamp);
          if (idx >= 0) autoRunTimestamps.splice(idx, 1);
          reservedAutoSlot = false;
        }
        throw err;
      } finally {
        if (pollExternalTimer !== undefined) clearInterval(pollExternalTimer);
        if (activeConsolidationAbort === localAbort) {
          activeConsolidationAbort = undefined;
          activeConsolidationTrigger = null;
        }
        activeConsolidationPromise = undefined;
        if (!stopped) {
          ports.drives.notifySourceChanged('asi-sleep');
          scheduleWakeTimers();
          notify();
        }
      }
    })();

    activeConsolidationPromise = task;
    return task;
  }

  function reconcileAndMaybeSleep(): void {
    if (stopped || !started) return;
    latestSense = ports.sense.snapshot();
    maybeAbortPreemptedAutoConsolidation();

    const evaluated = computeEvaluated(latestSense);
    ports.drives.notifySourceChanged('asi-sleep');

    if (!activeConsolidationPromise && !manualPreemptPending && evaluated.canAutoConsolidate) {
      void executeConsolidation('auto').catch(() => {
        // Preempted or transient failure; timers reschedule in finally
      });
    } else {
      scheduleWakeTimers();
    }
    notify();
  }

  function toViewItem(entry: MemoryEntry, now: number): MemoryViewItem {
    const clean = sanitizeMemoryEntry(entry, ports.homeDir);
    return {
      ...clean,
      retention: computeMemoryRetention(clean.fsrs, clean.pinned, now),
    };
  }

  const actions: SleepActionsApi = {
    async consolidateNow(): Promise<SleepConsolidationRecord> {
      if (stopped) throw new Error('asi-sleep runtime is stopped');
      if (activeConsolidationPromise && activeConsolidationTrigger !== 'manual') {
        manualPreemptPending = true;
        try {
          activeConsolidationAbort?.abort();
          await activeConsolidationPromise.catch(() => undefined);
        } finally {
          manualPreemptPending = false;
        }
      }
      if (stopped) throw new Error('asi-sleep runtime is stopped');
      return executeConsolidation('manual');
    },

    async setAutoSleepPaused(paused: boolean): Promise<void> {
      autoSleepPaused = Boolean(paused);
      if (autoSleepPaused && activeConsolidationTrigger === 'auto') {
        activeConsolidationAbort?.abort();
      }
      await persistState();
      reconcileAndMaybeSleep();
    },

    async createMemory(input: MemoryCreateInput): Promise<MemoryViewItem> {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !isMemoryKind(input.kind)) {
        throw new Error('Invalid memory kind');
      }
      const title = typeof input.title === 'string' ? sanitizeSleepText(input.title, 140, ports.homeDir) : '';
      const content = typeof input.content === 'string' ? sanitizeSleepText(input.content, 1_600, ports.homeDir) : '';
      if (!title || !content) {
        throw new Error('title and content are required');
      }
      if (input.tags !== undefined && !Array.isArray(input.tags)) {
        throw new Error('tags must be an array of strings');
      }
      if (input.topicKey !== undefined && typeof input.topicKey !== 'string') {
        throw new Error('topicKey must be a string');
      }
      const now = clock.wall();
      await vault.syncExternalChanges(now);
      const created = vault.upsert({
        id: `mem_${randomUUID().slice(0, 12)}`,
        kind: input.kind,
        title,
        content,
        tags: Array.isArray(input.tags) ? input.tags : [],
        ...(typeof input.topicKey === 'string' && input.topicKey.trim() ? { topicKey: input.topicKey } : {}),
        pinned: Boolean(input.pinned),
        confidence: 1,
        sourceSessionIds: ['manual'],
        evidenceCount: 1,
        recallCount: 0,
        createdAt: now,
        updatedAt: now,
        fsrs: createInitialFsrsState(input.kind, now),
      });
      await vault.flush(now);
      ports.drives.notifySourceChanged('asi-sleep');
      notify();
      return toViewItem(created, now);
    },

    async updateMemory(id: string, patch: MemoryUpdateInput): Promise<MemoryViewItem> {
      const now = clock.wall();
      await vault.syncExternalChanges(now);
      const safeId = sanitizeSleepText(typeof id === 'string' ? id : '', 64, ports.homeDir);
      const existing = vault.get(id, now);
      if (!existing) throw new Error(`Memory not found: ${safeId || 'unknown'}`);
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('patch must be an object');
      }
      if (patch.kind !== undefined && !isMemoryKind(patch.kind)) {
        throw new Error('Invalid memory kind');
      }
      if (patch.title !== undefined && typeof patch.title !== 'string') {
        throw new Error('title must be a string');
      }
      if (patch.content !== undefined && typeof patch.content !== 'string') {
        throw new Error('content must be a string');
      }
      if (patch.tags !== undefined && !Array.isArray(patch.tags)) {
        throw new Error('tags must be an array of strings');
      }
      if (patch.topicKey !== undefined && typeof patch.topicKey !== 'string') {
        throw new Error('topicKey must be a string');
      }
      const nextTitle = patch.title !== undefined ? sanitizeSleepText(patch.title, 140, ports.homeDir) : existing.title;
      const nextContent =
        patch.content !== undefined ? sanitizeSleepText(patch.content, 1_600, ports.homeDir) : existing.content;
      if (!nextTitle || !nextContent) {
        throw new Error('title and content cannot be empty');
      }
      const unpinning = existing.pinned && patch.pinned === false;
      const nextFsrs = unpinning ? { ...existing.fsrs, lastReview: now } : existing.fsrs;

      const updated = vault.upsert({
        ...existing,
        kind: patch.kind ?? existing.kind,
        title: nextTitle,
        content: nextContent,
        tags: patch.tags ?? existing.tags,
        ...(patch.topicKey !== undefined
          ? patch.topicKey.trim()
            ? { topicKey: patch.topicKey }
            : {}
          : existing.topicKey
            ? { topicKey: existing.topicKey }
            : {}),
        pinned: patch.pinned !== undefined ? Boolean(patch.pinned) : existing.pinned,
        updatedAt: now,
        fsrs: nextFsrs,
      });
      await vault.flush(now);
      notify();
      return toViewItem(updated, now);
    },

    async togglePin(id: string, pinned: boolean): Promise<MemoryViewItem> {
      return actions.updateMemory(id, { pinned: Boolean(pinned) });
    },

    async deleteMemory(id: string): Promise<void> {
      const now = clock.wall();
      await vault.syncExternalChanges(now);
      const safeId = sanitizeSleepText(typeof id === 'string' ? id : '', 64, ports.homeDir);
      const existed = vault.delete(id, now);
      if (!existed) throw new Error(`Memory not found: ${safeId || 'unknown'}`);
      await vault.flush(now);
      ports.drives.notifySourceChanged('asi-sleep');
      notify();
    },

    async searchMemories(query: string, kind?: MemoryKind): Promise<MemoryViewItem[]> {
      const now = clock.wall();
      await vault.syncExternalChanges(now);
      const all = vault.list(now).map((e) => toViewItem(e, now));
      const hits = searchMemoryItems(all, query, {
        ...(kind ? { kind } : {}),
        includeLowRetention: true,
        limit: MAX_PANEL_MEMORIES,
      });
      return hits.map(({ score: _score, ...view }) => view);
    },
  };

  return {
    vault,
    actions,

    async start(): Promise<void> {
      if (started) return;
      started = true;
      stopped = false;

      const initNow = clock.wall();
      await mkdir(ports.storageRoot, { recursive: true });

      try {
        const rawState = await readFile(statePath, 'utf8');
        const parsed = JSON.parse(rawState) as PersistedSleepState;
        if (typeof parsed.autoSleepPaused === 'boolean') {
          autoSleepPaused = parsed.autoSleepPaused;
        }
        if (typeof parsed.lastSleepAt === 'number' && Number.isFinite(parsed.lastSleepAt)) {
          lastSleepAt = parsed.lastSleepAt;
        }
        if (typeof parsed.firstUnconsolidatedTurnAt === 'number' && Number.isFinite(parsed.firstUnconsolidatedTurnAt)) {
          firstUnconsolidatedTurnAt = parsed.firstUnconsolidatedTurnAt;
        }
        if (typeof parsed.lastOrdinaryActivityAt === 'number' && Number.isFinite(parsed.lastOrdinaryActivityAt)) {
          lastOrdinaryActivityAt = parsed.lastOrdinaryActivityAt;
        }
        if (Array.isArray(parsed.autoRunTimestamps)) {
          autoRunTimestamps = parsed.autoRunTimestamps.filter(
            (n): n is number => typeof n === 'number' && Number.isFinite(n),
          );
          pruneOldAutoTimestamps(initNow);
        }
        if (Array.isArray(parsed.consolidatedTurnKeys)) {
          recordConsolidatedKeys(parsed.consolidatedTurnKeys.filter((k): k is string => typeof k === 'string'));
        }
        if (parsed.consolidatedSessionWatermarks && typeof parsed.consolidatedSessionWatermarks === 'object') {
          for (const [sid, seqVal] of Object.entries(parsed.consolidatedSessionWatermarks)) {
            if (sid && typeof seqVal === 'number' && Number.isFinite(seqVal) && seqVal >= 0) {
              consolidatedSessionWatermarks.set(sid, Math.trunc(seqVal));
            }
          }
        }
      } catch {
        // Fresh state
      }

      await vault.load(initNow);
      latestSense = ports.sense.snapshot();

      offDriveSource = ports.drives.registerSource({
        id: 'asi-sleep',
        tier: 2,
        label: '离线睡眠与记忆整合',
        evaluate: (senseSnap) => {
          const ev = computeEvaluated(senseSnap, { fromDriveArbiter: true });
          return [
            {
              key: 'consolidation',
              label: '睡眠记忆整合',
              satisfaction: ev.driveView.satisfaction,
              autoMaintain: false,
              summary: ev.driveView.summary,
              evidence: {
                unconsolidatedTurns: ev.driveView.unconsolidatedTurns,
                quietWindow: ev.driveView.quietWindow,
                screenLocked: ev.driveView.screenLocked,
                autoRunsToday: ev.driveView.autoRunsToday,
                autoSleepPaused,
                totalMemories: vault.size(),
              },
            },
          ];
        },
        sandboxTools: [
          {
            name: 'sleep_consolidate',
            driveKey: 'consolidation',
            description:
              'Run two-phase NREM/REM sleep memory consolidation on unconsolidated ordinary conversation turns when L1 survival needs are comfortable.',
            parameters: {
              force: {
                type: 'boolean',
                description: 'Bypass quiet-window wait when explicitly triggered in maintenance sandbox.',
              },
            },
            execute: async (args, { signal }) => {
              const now = clock.wall();
              const ev = computeEvaluated(ports.sense.snapshot());
              if (ev.driveView.suppressed) {
                throw new Error(ev.driveView.suppressionReason ?? 'Sleep consolidation is suppressed by L1 distress');
              }
              const force = args.force === true;
              if (!force && !ev.driveView.quietWindow) {
                return {
                  summary: `等待静默窗口（当前已空闲 ${Math.floor(ev.driveView.idleDurationMs / 60_000)}/10 分钟且未锁屏）`,
                };
              }
              const rec = await executeConsolidation('sandbox', signal);
              return {
                summary: rec.summary,
                data: {
                  turnsProcessed: rec.turnsProcessed,
                  createdCount: rec.createdCount,
                  mergedCount: rec.mergedCount,
                  conflictsResolved: rec.conflictsResolved,
                  prunedCount: rec.prunedCount,
                  at: now,
                },
              };
            },
          },
        ],
      });

      offSense = ports.sense.subscribe((snap) => {
        latestSense = snap;
        reconcileAndMaybeSleep();
      });

      offDrives = ports.drives.subscribe((drivesSnap) => {
        const prevSuppressed = higherOrderSuppressed;
        higherOrderSuppressed = drivesSnap.higherOrderSuppressed;
        cachedSuppressionReason = drivesSnap.suppressionReason;
        maybeAbortPreemptedAutoConsolidation();
        if (prevSuppressed && !higherOrderSuppressed) {
          reconcileAndMaybeSleep();
        } else {
          notify();
        }
      });

      offConversations = ports.conversations.onOrdinaryActivity(() => {
        lastOrdinaryActivityAt = clock.wall();
        void persistState();
        reconcileAndMaybeSleep();
      });

      reconcileAndMaybeSleep();

      if (ports.conversations.warmColdSessions) {
        coldWarmupAbort = new AbortController();
        const warmupSignal = coldWarmupAbort.signal;
        void ports.conversations
          .warmColdSessions(warmupSignal)
          .then(() => {
            if (!stopped && !warmupSignal.aborted) {
              reconcileAndMaybeSleep();
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
      clearTimers();
      coldWarmupAbort?.abort();
      coldWarmupAbort = undefined;
      activeConsolidationAbort?.abort();
      offConversations?.();
      offConversations = undefined;
      offDrives?.();
      offDrives = undefined;
      offSense?.();
      offSense = undefined;
      offDriveSource?.();
      offDriveSource = undefined;

      await Promise.allSettled([activeConsolidationPromise ?? Promise.resolve(), stateWriteChain, vault.waitForIdle()]);
      subscribers.clear();
    },

    panelModel(): SleepPanelModel {
      const ev = computeEvaluated(ports.sense.snapshot());
      const allEntries = vault.list(ev.now);
      if (!stopped && vault.hasPendingExternalFlush()) {
        void vault.flush(ev.now);
      }
      const countsByKind: Record<MemoryKind, number> = {
        preference: 0,
        decision: 0,
        pitfall: 0,
        episode: 0,
      };
      let pinnedCount = 0;
      const viewItems: MemoryViewItem[] = [];

      for (const entry of allEntries) {
        countsByKind[entry.kind] += 1;
        if (entry.pinned) pinnedCount += 1;
        viewItems.push(toViewItem(entry, ev.now));
      }

      viewItems.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (Math.abs(b.retention - a.retention) > 1e-4) return b.retention - a.retention;
        return b.updatedAt - a.updatedAt;
      });

      return {
        now: ev.now,
        autoSleepPaused,
        consolidating: Boolean(activeConsolidationPromise),
        drive: ev.driveView,
        countsByKind,
        totalMemories: allEntries.length,
        pinnedCount,
        memories: viewItems.slice(0, MAX_PANEL_MEMORIES),
        recentConsolidations: vault.recentJournal(10),
      };
    },

    subscribe(listener: () => void): () => void {
      if (!stopped) subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },

    async recall(input: RecallQueryInput): Promise<RecallQueryResult> {
      const now = clock.wall();
      await vault.syncExternalChanges(now);
      const query = sanitizeSleepText(input.query ?? '', 400, ports.homeDir);
      const allEntries = vault.list(now);
      const views = allEntries.map((e) => toViewItem(e, now));
      const limit = Math.max(1, Math.min(20, Math.trunc(input.limit ?? 8)));
      const ranked = searchMemoryItems(views, query, {
        ...(input.kind ? { kind: input.kind } : {}),
        includeLowRetention: input.includeLowRetention ?? false,
        limit,
      });

      const shouldStrengthen = input.strengthen !== false && Boolean(query.trim()) && ranked.length > 0;
      const hits: RecallHitItem[] = [];

      for (const item of ranked) {
        let finalView = item;
        if (shouldStrengthen) {
          const current = vault.get(item.id);
          if (current) {
            const nextFsrs = current.pinned ? current.fsrs : strengthenFsrsState(current.fsrs, now, 'recall');
            const saved = vault.upsert({
              ...current,
              recallCount: current.recallCount + 1,
              lastRecalledAt: now,
              updatedAt: current.updatedAt,
              fsrs: nextFsrs,
            });
            finalView = { ...toViewItem(saved, now), score: item.score };
          }
        }
        hits.push({
          id: finalView.id,
          kind: finalView.kind,
          title: sanitizeSleepText(finalView.title, 140, ports.homeDir),
          content: sanitizeSleepText(finalView.content, 1_600, ports.homeDir),
          tags: finalView.tags,
          pinned: finalView.pinned,
          retention: finalView.retention,
          stabilityDays: finalView.fsrs.stability,
          recallCount: finalView.recallCount,
          updatedAt: finalView.updatedAt,
          ...(finalView.links && finalView.links.length > 0 ? { links: finalView.links } : {}),
          score: finalView.score,
        });
      }

      if (shouldStrengthen) {
        await vault.flush(now);
        notify();
      }

      return {
        now,
        query,
        totalMemories: allEntries.length,
        hits,
      };
    },

    profile(input?: ProfileQueryInput): ProfileQueryResult {
      const now = clock.wall();
      const limitPerKind = Math.max(1, Math.min(15, Math.trunc(input?.limitPerKind ?? 5)));
      const allEntries = vault.list(now);
      if (!stopped && vault.hasPendingExternalFlush()) {
        void vault.flush(now);
      }
      const countsByKind: Record<MemoryKind, number> = {
        preference: 0,
        decision: 0,
        pitfall: 0,
        episode: 0,
      };
      let pinnedCount = 0;

      const byKind: Record<MemoryKind, MemoryViewItem[]> = {
        preference: [],
        decision: [],
        pitfall: [],
        episode: [],
      };

      for (const entry of allEntries) {
        countsByKind[entry.kind] += 1;
        if (entry.pinned) pinnedCount += 1;
        const view = toViewItem(entry, now);
        if (view.pinned || view.retention >= 0.2) {
          byKind[entry.kind].push(view);
        }
      }

      const targetKinds = input?.kind ? [input.kind] : [...MEMORY_KINDS];
      const profile: Partial<Record<MemoryKind, MemoryViewItem[]>> = {};
      for (const k of targetKinds) {
        const sorted = byKind[k].sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          if (Math.abs(b.retention - a.retention) > 1e-4) return b.retention - a.retention;
          return b.updatedAt - a.updatedAt;
        });
        profile[k] = sorted.slice(0, limitPerKind);
      }

      return {
        now,
        totalMemories: allEntries.length,
        pinnedCount,
        lastSleepAt,
        countsByKind,
        profile,
      };
    },
  };
}
