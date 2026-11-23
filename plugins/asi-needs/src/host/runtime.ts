import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  type ActionMeasurement,
  type AsiDrivesServiceApi,
  type DriveSandboxToolResult,
  type HelpActionKind,
  type HelpCard,
  type MaintenanceOutcome,
  type MaintenanceRecord,
  type MaintenanceSessionStatus,
  NEED_KEYS,
  type NeedKey,
  type NeedsSnapshot,
  type SenseSnapshot,
  sanitizeForModel,
} from '@asi/sense-types';
import {
  ActionOutcomeLedger,
  buildActionMeasurement,
  computeDriveEnvFingerprint,
  EpisodeCircuitBreaker,
  type PersistedCircuitBreakerEntry,
  primaryDiskFreeBytes,
} from './action-memory.js';
import {
  CLEANABLE_EXTERNAL_CACHE_IDS,
  cleanExternalCacheTarget,
  EXTERNAL_CACHE_ACTIVE_PROTECTION_MS,
  type ExternalCacheScanReport,
  getCleanableExternalCacheRule,
  isCleanableExternalCacheId,
  scanExternalCachesAndTrash,
  TRASH_READONLY_RULE,
} from './cache-catalog.js';
import { chooseCryDeliveryMode, formatCryMessage } from './cry.js';
import { MaslowDriveArbiter, type RegisteredSandboxTool } from './drives.js';
import { evaluateNeeds, NEED_LABELS, type PreviousNeedState } from './evaluator.js';
import { InstinctController } from './instinct.js';
import type { NeedsHostPorts } from './ports.js';
import { sampleTopProcesses, type TopProcessesReport } from './process-top.js';
import {
  cleanSafeCaches,
  compactIdleContexts,
  findStuckJobs,
  inspectSafeCaches,
  stopStuckJobs,
  upsertHelpCard,
} from './sandbox.js';

const AUTONOMOUS_COOLDOWN_MS = 120_000;
const MAX_AUTONOMOUS_TURNS_PER_HOUR = 6;
const MAX_MAINTAINER_TURNS_BEFORE_ROTATE = 12;
const MAX_RECORDS = 40;
const LIVENESS_HEARTBEAT_MS = 15_000;

type EpisodeSeverity = 'uncomfortable' | 'critical';

interface PersistedNeedsState {
  helpCards?: HelpCard[];
  records?: MaintenanceRecord[];
  previousStates?: Partial<Record<NeedKey, PreviousNeedState>>;
  criedEpisodes?: NeedKey[];
  criedEpisodeSeverity?: Partial<Record<NeedKey, EpisodeSeverity>>;
  handledEpisodeSeverity?: Partial<Record<NeedKey, EpisodeSeverity>>;
  maintSessionId?: string;
  maintTurnCount?: number;
  maintTotalTurns?: number;
  maintLastRunAt?: number;
  internalSessionIds?: string[];
  actionLedger?: NeedsSnapshot['actionLedger'];
  circuitBreakers?: PersistedCircuitBreakerEntry[];
  dismissedExternalTargets?: string[];
}

export interface SniffCausesReport {
  scannedAt: number;
  activeProtectionWindowMs: number;
  asiInternalCache: {
    totalBytes: number;
    reclaimableBytes: number;
    entryCount: number;
  };
  externalCaches: ExternalCacheScanReport['externalCaches'];
  trash: ExternalCacheScanReport['trash'];
  topProcesses: TopProcessesReport;
  truncated: boolean;
}

export interface MaintenanceToolsApi {
  statusSnapshot(): NeedsSnapshot;
  sniffCauses(): Promise<SniffCausesReport>;
  cleanCache(): Promise<{ deletedEntries: number; freedBytes: number; summary: string; gain: ActionMeasurement }>;
  stopStuckJob(
    jobId?: string,
  ): Promise<{ stoppedIds: string[]; refusedActiveIds: string[]; summary: string; gain: ActionMeasurement }>;
  compactContext(): Promise<{
    compactedSessions: number;
    tokensSaved: number;
    summary: string;
    gain: ActionMeasurement;
  }>;
  requestHelp(input: {
    need: NeedKey;
    severity?: 'uncomfortable' | 'critical';
    title: string;
    summary: string;
    proposedAction?: string;
    actionKind?: HelpActionKind;
    actionTarget?: string;
  }): Promise<{ card: HelpCard; deliveredCry: boolean }>;
}

export interface NeedsActions {
  pause(paused: boolean): Promise<void>;
  setSendTitles(enabled: boolean): Promise<void>;
  openPermissionSettings(): Promise<void>;
  approveHelp(cardId: string): Promise<void>;
  dismissHelp(cardId: string): Promise<void>;
  openMaintenanceSession(): Promise<string>;
  triggerCheck(): Promise<void>;
}

export interface NeedsDrivesRuntimeApi extends AsiDrivesServiceApi {
  onToolsStructureChanged(listener: () => void): () => void;
  registeredSandboxTools(): RegisteredSandboxTool[];
  checkSandboxToolGuard(toolName: string): { allowed: boolean; reason?: string };
  executeSandboxTool(
    tool: RegisteredSandboxTool,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<DriveSandboxToolResult & { gain: ActionMeasurement }>;
}

export interface NeedsRuntime {
  readonly sandboxDir: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): NeedsSnapshot;
  senseSnapshot(): SenseSnapshot;
  factStaleInMs(path: string): number | undefined;
  subscribe(listener: () => void): () => void;
  registerMaintenanceSessionId(sessionId: string): void;
  isMaintenanceSession(sessionId: string): boolean;
  reportTransportResult(reachable: boolean, errorText?: string): void;
  readonly tools: MaintenanceToolsApi;
  readonly actions: NeedsActions;
  readonly drives?: NeedsDrivesRuntimeApi;
}

function formatHumanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

function hasPathCharacters(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value.includes('..') || value.includes('\0');
}

export function validateHelpActionTarget(
  actionKind: HelpActionKind,
  actionTarget: string | undefined,
): string | undefined {
  if (actionKind === 'clean-external-cache') {
    if (!actionTarget || hasPathCharacters(actionTarget) || !isCleanableExternalCacheId(actionTarget)) {
      throw new Error(
        `clean-external-cache requires a whitelisted targetId (${CLEANABLE_EXTERNAL_CACHE_IDS.join(', ')})`,
      );
    }
    return actionTarget;
  }
  if (actionTarget === undefined || actionTarget === '') {
    return undefined;
  }
  const trimmed = actionTarget.trim();
  if (!trimmed) return undefined;
  if (hasPathCharacters(trimmed)) {
    throw new Error('Arbitrary filesystem paths are forbidden in actionTarget');
  }
  if (trimmed === TRASH_READONLY_RULE.id) {
    throw new Error('Trash target is strictly read-only and cannot be attached to an action card');
  }
  return trimmed;
}

export function createNeedsRuntime(ports: NeedsHostPorts): NeedsRuntime & { readonly drives: NeedsDrivesRuntimeApi } {
  const clock = ports.clock ?? { wall: () => Date.now(), mono: () => performance.now() };
  const statePath = join(ports.storageRoot, 'state.json');
  const sandboxDir = join(ports.storageRoot, 'sandbox');

  const instinct = new InstinctController(ports.sense, ports.probeEndpoint);
  const actionLedger = new ActionOutcomeLedger();
  const circuitBreaker = new EpisodeCircuitBreaker();

  const listeners = new Set<() => void>();
  const internalSessions = new Map<string, () => void>();
  const criedEpisodeSeverity = new Map<NeedKey, EpisodeSeverity>();
  const handledEpisodeSeverity = new Map<NeedKey, EpisodeSeverity>();
  const dismissedExternalTargets = new Set<string>();
  const autonomousTurnMonoTimes: number[] = [];

  let helpCards: HelpCard[] = [];
  let records: MaintenanceRecord[] = [];
  let previousStates: Partial<Record<NeedKey, PreviousNeedState>> = {};
  const escalatedCriticalInTurn = new Set<NeedKey>();
  const activeTurnEffectiveNeeds = new Set<string>();

  let maintSessionId: string | undefined;
  let maintStatus: MaintenanceSessionStatus['status'] = 'not-created';
  let maintTurnCount = 0;
  let maintTotalTurns = 0;
  let maintLastRunAt: number | undefined;
  let lastL1AutoRunMono: number | undefined;
  let lastHigherAutoRunMono: number | undefined;
  let activeRunningTier: 'l1' | 'higher' | null = null;
  let higherOrderTurnAbort: AbortController | undefined;
  let rotateMaintainerNext = false;
  let pendingMaintenanceRecheck = false;
  let sessionCreationInFlight: Promise<string> | undefined;
  let maintCheckLocked = false;
  let activeCheckManual = false;
  let maintCheckPromise: Promise<void> | undefined;
  let queuedManualCheckPromise: Promise<void> | undefined;

  let started = false;
  let stopped = false;
  let unsubscribeSense: (() => void) | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let turnAbort = new AbortController();
  let persistChain: Promise<void> = Promise.resolve();
  let reconcileInFlight: Promise<void> | undefined;

  const arbiter = new MaslowDriveArbiter(() => {
    if (started && !stopped) {
      void scheduleProcess(ports.sense.snapshot());
    }
  });

  let latestSense: SenseSnapshot = ports.sense.snapshot();
  let latestEval = evaluateNeeds({
    snapshot: latestSense,
    modelConnectivity: instinct.modelConnectivity(),
    stuckJobCount: 0,
  });
  let latestHigherOrder = arbiter.reconcile({
    sense: latestSense,
    l1Needs: latestEval.needs,
    powerMode: latestSense.settings.powerMode,
  });

  function notify(): void {
    if (stopped) return;
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        // Isolate subscriber errors
      }
    }
  }

  function persistState(): Promise<void> {
    const payload: PersistedNeedsState = {
      helpCards: helpCards.slice(0, 30),
      records: records.slice(0, MAX_RECORDS),
      previousStates: structuredClone(previousStates),
      criedEpisodeSeverity: Object.fromEntries(criedEpisodeSeverity),
      handledEpisodeSeverity: Object.fromEntries(handledEpisodeSeverity),
      ...(maintSessionId ? { maintSessionId } : {}),
      maintTurnCount,
      maintTotalTurns,
      ...(maintLastRunAt !== undefined ? { maintLastRunAt } : {}),
      internalSessionIds: [...internalSessions.keys()].slice(-20),
      actionLedger: actionLedger.entries(),
      circuitBreakers: circuitBreaker.serialize(),
      ...(dismissedExternalTargets.size > 0 ? { dismissedExternalTargets: [...dismissedExternalTargets] } : {}),
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

  function addRecord(entry: Omit<MaintenanceRecord, 'id' | 'at'> & { at?: number }): void {
    const rec: MaintenanceRecord = {
      id: `maint-${randomUUID().slice(0, 8)}`,
      at: entry.at ?? clock.wall(),
      actor: entry.actor,
      ...(entry.need ? { need: entry.need } : {}),
      ...(entry.driveKey ? { driveKey: entry.driveKey } : {}),
      action: entry.action,
      summary: entry.summary,
      outcome: entry.outcome,
      ...(entry.gain ? { gain: entry.gain } : {}),
    };
    records = [rec, ...records].slice(0, MAX_RECORDS);
    void persistState();
  }

  function registerMaintSession(id: string): void {
    if (stopped || internalSessions.has(id)) return;
    const unregister = ports.sense.registerInternalSession(id);
    internalSessions.set(id, unregister);
  }

  function abortInFlightMaintenanceForPause(): void {
    pendingMaintenanceRecheck = false;
    if (maintCheckLocked || maintStatus === 'running') {
      turnAbort.abort();
      turnAbort = new AbortController();
    }
  }

  function isSeveritySuppressed(recorded: EpisodeSeverity | undefined, severity: EpisodeSeverity): boolean {
    if (!recorded) return false;
    return recorded === 'critical' || severity === 'uncomfortable';
  }

  function recordEpisodeSeverity(map: Map<NeedKey, EpisodeSeverity>, need: NeedKey, severity: EpisodeSeverity): void {
    if (map.get(need) === 'critical') return;
    map.set(need, severity);
  }

  function isAutoHelpSuppressed(need: NeedKey, severity: EpisodeSeverity): boolean {
    return isSeveritySuppressed(handledEpisodeSeverity.get(need), severity);
  }

  function isCrySuppressed(need: NeedKey, severity: EpisodeSeverity): boolean {
    return isSeveritySuppressed(criedEpisodeSeverity.get(need), severity);
  }

  function currentIdleSessionCount(): number {
    try {
      return ports.compaction.listIdleSessionIds(new Set(internalSessions.keys())).length;
    } catch {
      return 0;
    }
  }

  function fingerprintForDrive(
    key: string,
    snap: SenseSnapshot,
    ev: {
      zone: NeedKey extends never ? never : 'comfortable' | 'uncomfortable' | 'critical';
      satisfaction: number;
      evidence: Record<string, string | number | boolean | null>;
    },
    stuckCount?: number,
  ): string {
    return computeDriveEnvFingerprint({
      key,
      snapshot: snap,
      evaluation: ev,
      stuckJobCount: stuckCount ?? findStuckJobs(ports.jobs, snap.now).length,
      idleSessionCount: currentIdleSessionCount(),
    });
  }

  async function createNewMaintenanceSession(): Promise<string> {
    if (stopped) {
      throw new Error('NeedsRuntime is stopped');
    }
    let requested: string | undefined;
    try {
      await mkdir(sandboxDir, { recursive: true });
      if (stopped) {
        throw new Error('NeedsRuntime stopped before maintenance session creation');
      }
      requested = `asi-maint-${randomUUID()}`;
      registerMaintSession(requested);
      const createdId = await ports.sessions.createMaintenanceSession(requested, sandboxDir, 'ASI 自维护');
      if (stopped) {
        for (const id of new Set([requested, createdId])) {
          const drop = internalSessions.get(id);
          drop?.();
          internalSessions.delete(id);
        }
        throw new Error('NeedsRuntime stopped during maintenance session creation');
      }
      if (createdId !== requested) {
        const dropRequested = internalSessions.get(requested);
        dropRequested?.();
        internalSessions.delete(requested);
        registerMaintSession(createdId);
      }
      maintSessionId = createdId;
      maintTurnCount = 0;
      rotateMaintainerNext = false;
      if (maintStatus === 'not-created' || maintStatus === 'unavailable') {
        maintStatus = 'idle';
      }
      void persistState();
      notify();
      return createdId;
    } catch (err) {
      if (requested !== undefined) {
        const unregister = internalSessions.get(requested);
        unregister?.();
        internalSessions.delete(requested);
      }
      if (!stopped && maintSessionId && ports.sessions.hasSession(maintSessionId)) {
        if (maintStatus === 'not-created' || maintStatus === 'unavailable') {
          maintStatus = 'idle';
          notify();
        }
        return maintSessionId;
      }
      if (!stopped) {
        maintStatus = 'unavailable';
        notify();
      }
      throw err;
    }
  }

  async function ensureMaintenanceSession(forceRotate = false): Promise<string> {
    if (sessionCreationInFlight) {
      return await sessionCreationInFlight;
    }
    if (!forceRotate && maintSessionId && ports.sessions.hasSession(maintSessionId)) {
      return maintSessionId;
    }
    const pending = createNewMaintenanceSession();
    sessionCreationInFlight = pending;
    try {
      return await pending;
    } finally {
      if (sessionCreationInFlight === pending) {
        sessionCreationInFlight = undefined;
      }
    }
  }

  function effectiveConnectivity() {
    const raw = instinct.modelConnectivity();
    const evalConn = latestEval.needs.energy.evidence.modelConnectivity;
    if (raw === 'offline' || evalConn === 'offline') return 'offline' as const;
    if (raw === 'degraded' || evalConn === 'degraded') return 'degraded' as const;
    return 'online' as const;
  }

  function mergeEscalatedSummary(evalSummary: string, prevSummary: string): string {
    const fresh = String(sanitizeForModel(evalSummary)).trim();
    const prior = String(sanitizeForModel(prevSummary)).trim();
    if (!prior || prior === fresh || fresh.includes(prior)) {
      return fresh.length > 280 ? `${fresh.slice(0, 279)}…` : fresh;
    }
    const combined = `${fresh}（此前诊断：${prior}）`;
    return combined.length > 280 ? `${combined.slice(0, 279)}…` : combined;
  }

  function upgradeOpenCardsToCritical(key: NeedKey, now: number): HelpCard | undefined {
    const evalSummary = latestEval.needs[key].summary;
    let changed = false;
    helpCards = helpCards.map((card) => {
      if (card.need === key && card.status === 'open' && card.severity === 'uncomfortable') {
        changed = true;
        return {
          ...card,
          severity: 'critical',
          summary: mergeEscalatedSummary(evalSummary, card.summary),
          updatedAt: now,
        };
      }
      return card;
    });
    if (!changed) {
      return helpCards.find((c) => c.need === key && c.status === 'open' && c.severity === 'critical');
    }
    return helpCards.find((c) => c.need === key && c.status === 'open' && c.severity === 'critical');
  }

  async function deliverCryIfNeeded(card: HelpCard): Promise<boolean> {
    if (isCrySuppressed(card.need, card.severity)) return false;
    const exclude = new Set(internalSessions.keys());
    const mode = chooseCryDeliveryMode(effectiveConnectivity());
    const delivered = await ports.sessions
      .deliverCryToUserSession(latestSense.activeSessionId, exclude, formatCryMessage(card), mode)
      .catch(() => false);
    if (delivered) {
      recordEpisodeSeverity(criedEpisodeSeverity, card.need, card.severity);
      await persistState();
    }
    return delivered;
  }

  async function raiseHelp(input: {
    need: NeedKey;
    severity: EpisodeSeverity;
    title: string;
    summary: string;
    proposedAction?: string;
    actionKind?: HelpActionKind;
    actionTarget?: string;
  }): Promise<{ card: HelpCard; deliveredCry: boolean }> {
    const now = clock.wall();
    const actionKind: HelpActionKind = input.actionKind ?? 'acknowledge';
    const validatedTarget = validateHelpActionTarget(actionKind, input.actionTarget);

    let enrichedSummary = input.summary;
    let enrichedProposedAction = input.proposedAction;

    if (actionKind === 'clean-external-cache' && validatedTarget && ports.homeDir) {
      const scan = await scanExternalCachesAndTrash({
        homeDir: ports.homeDir,
        now,
        activeProtectionMs: EXTERNAL_CACHE_ACTIVE_PROTECTION_MS,
      }).catch(() => undefined);
      const matched = scan?.externalCaches.find((c) => c.targetId === validatedTarget);
      const rule = getCleanableExternalCacheRule(validatedTarget);
      if (matched) {
        const sizeBadge = `（总计 ${formatHumanBytes(matched.totalBytes)}，超 1h 可清理 ${formatHumanBytes(matched.reclaimableBytes)}，风险分级 ${matched.risk}）`;
        if (!enrichedSummary.includes(formatHumanBytes(matched.reclaimableBytes))) {
          enrichedSummary = `${enrichedSummary} ${sizeBadge}`;
        }
        if (!enrichedProposedAction) {
          enrichedProposedAction = `点击「批准清理外部缓存」将清理 ${matched.label} 中超过 1 小时未修改的陈旧项，自动跳过 1 小时内活跃子项。${matched.note}`;
        }
      } else if (rule && !enrichedProposedAction) {
        enrichedProposedAction = `点击「批准清理外部缓存」将清理 ${rule.label} 中超过 1 小时未修改的陈旧缓存项，自动保护 1 小时内活跃子项。`;
      }
    }

    const prevSameKind = helpCards.find(
      (c) =>
        c.status === 'open' &&
        c.need === input.need &&
        c.actionKind === actionKind &&
        (c.actionTarget ?? '') === (validatedTarget ?? ''),
    );
    const hadOtherUncomfortable =
      input.severity === 'critical' &&
      helpCards.some(
        (c) =>
          c.status === 'open' &&
          c.need === input.need &&
          (c.actionKind !== actionKind || (c.actionTarget ?? '') !== (validatedTarget ?? '')) &&
          c.severity === 'uncomfortable',
      );
    const res = upsertHelpCard(helpCards, {
      need: input.need,
      severity: input.severity,
      title: input.title,
      summary: enrichedSummary,
      ...(enrichedProposedAction ? { proposedAction: enrichedProposedAction } : {}),
      actionKind,
      ...(validatedTarget ? { actionTarget: validatedTarget } : {}),
      now,
    });
    const sameContent =
      !res.created &&
      prevSameKind !== undefined &&
      prevSameKind.severity === res.card.severity &&
      prevSameKind.title === res.card.title &&
      prevSameKind.summary === res.card.summary &&
      prevSameKind.proposedAction === res.card.proposedAction &&
      prevSameKind.actionTarget === res.card.actionTarget;

    if (!sameContent) {
      helpCards = res.cards;
    }
    if (hadOtherUncomfortable) {
      upgradeOpenCardsToCritical(input.need, now);
    }

    const activeCard =
      helpCards.find((c) => c.id === res.card.id) ?? (sameContent && prevSameKind ? prevSameKind : res.card);
    const deliveredCry = await deliverCryIfNeeded(activeCard);
    if ((!sameContent || hadOtherUncomfortable) && !deliveredCry) {
      await persistState();
    }
    if (!sameContent || hadOtherUncomfortable || deliveredCry) {
      notify();
    }
    return { card: activeCard, deliveredCry };
  }

  async function escalateNeedToCritical(
    key: NeedKey,
    defaultTitle: string,
    defaultProposedAction: string,
  ): Promise<void> {
    const hadUncomfortableOpen = helpCards.some(
      (c) => c.need === key && c.status === 'open' && c.severity === 'uncomfortable',
    );
    const existingOpenCritical = helpCards.find(
      (c) => c.need === key && c.status === 'open' && c.severity === 'critical',
    );

    if (existingOpenCritical) {
      if (hadUncomfortableOpen) {
        upgradeOpenCardsToCritical(key, clock.wall());
      }
      const deliveredCry = await deliverCryIfNeeded(existingOpenCritical);
      if (hadUncomfortableOpen && !deliveredCry) {
        await persistState();
      }
      if (hadUncomfortableOpen || deliveredCry) {
        notify();
      }
      return;
    }

    if (isAutoHelpSuppressed(key, 'critical')) return;

    if (hadUncomfortableOpen) {
      const upgraded = upgradeOpenCardsToCritical(key, clock.wall());
      if (upgraded) {
        const deliveredCry = await deliverCryIfNeeded(upgraded);
        if (!deliveredCry) {
          await persistState();
        }
        notify();
        return;
      }
    }

    await raiseHelp({
      need: key,
      severity: 'critical',
      title: defaultTitle,
      summary: latestEval.needs[key].summary,
      proposedAction: defaultProposedAction,
      actionKind: 'acknowledge',
    });
  }

  function recomputeEval(snap: SenseSnapshot): void {
    latestSense = snap;
    const stuckCount = findStuckJobs(ports.jobs, snap.now).length;
    latestEval = evaluateNeeds({
      snapshot: snap,
      modelConnectivity: instinct.modelConnectivity(),
      stuckJobCount: stuckCount,
      previous: previousStates,
    });

    const nextPrev: Partial<Record<NeedKey, PreviousNeedState>> = {};
    let stateChanged = false;
    const prevTrippedCount = circuitBreaker.trippedNeeds().length;

    for (const key of NEED_KEYS) {
      const ev = latestEval.needs[key];
      const prior = previousStates[key];
      if (prior?.zone !== ev.zone || prior?.driveActive !== ev.driveActive) {
        stateChanged = true;
      }
      nextPrev[key] = {
        zone: ev.zone,
        driveActive: ev.driveActive,
        satisfaction: ev.satisfaction,
        ...(typeof ev.evidence.mount === 'string' ? { mount: ev.evidence.mount } : {}),
        ...(typeof ev.evidence.sessionId === 'string' ? { sessionId: ev.evidence.sessionId } : {}),
        ...(typeof ev.evidence.batteryDriven === 'boolean' ? { batteryDriven: ev.evidence.batteryDriven } : {}),
      };
      const curDiskFree = key === 'space' ? primaryDiskFreeBytes(snap) : undefined;
      circuitBreaker.reconcileNeed({
        need: key,
        driveActive: ev.driveActive,
        zone: ev.zone,
        satisfaction: ev.satisfaction,
        envFingerprint: fingerprintForDrive(key, snap, ev, stuckCount),
        ...(curDiskFree !== undefined ? { diskFreeBytes: curDiskFree } : {}),
      });
      if (!ev.driveActive) {
        if (criedEpisodeSeverity.delete(key)) stateChanged = true;
        if (handledEpisodeSeverity.delete(key)) stateChanged = true;
        if (key === 'space' && dismissedExternalTargets.size > 0) {
          dismissedExternalTargets.clear();
          stateChanged = true;
        }
        escalatedCriticalInTurn.delete(key);
        helpCards = helpCards.map((c) => {
          if (c.need === key && c.status === 'open') {
            stateChanged = true;
            return { ...c, status: 'resolved', updatedAt: snap.now };
          }
          return c;
        });
      }
    }
    previousStates = nextPrev;

    const effPowerMode = ports.sense.getSettings().powerMode;
    latestHigherOrder = arbiter.reconcile({
      sense: snap,
      l1Needs: latestEval.needs,
      powerMode: effPowerMode,
    });
    if (snap.settings.paused) {
      abortInFlightMaintenanceForPause();
    } else if (latestHigherOrder.snapshot.higherOrderSuppressed && activeRunningTier === 'higher') {
      higherOrderTurnAbort?.abort();
      pendingMaintenanceRecheck = true;
    }
    for (const d of latestHigherOrder.higherOrderDrives) {
      circuitBreaker.reconcileNeed({
        need: d.key,
        driveActive: d.driveActive,
        zone: d.zone,
        satisfaction: d.satisfaction,
        envFingerprint: fingerprintForDrive(d.key, snap, d, stuckCount),
      });
    }

    if (circuitBreaker.trippedNeeds().length !== prevTrippedCount) {
      stateChanged = true;
    }
    if (stateChanged) void persistState();
  }

  async function checkImmediateBoundaries(snap: SenseSnapshot): Promise<void> {
    if (snap.settings.paused) return;

    const energy = latestEval.needs.energy;
    if (energy.zone === 'critical' && !isAutoHelpSuppressed('energy', 'critical')) {
      const bat = snap.state.self.body.battery;
      const batPercent = bat.value?.percent ?? 0;
      const batMinutes = bat.value?.minutesLeft;
      const lowMinutesLeft =
        batMinutes !== undefined && Number.isFinite(batMinutes) && batMinutes > 0 && batMinutes <= 15;
      const unpluggedCriticalBat =
        bat.status === 'ok' &&
        bat.value !== null &&
        !bat.value.charging &&
        bat.value.powerState !== 'charging' &&
        bat.value.powerState !== 'charged' &&
        bat.value.powerState !== 'external' &&
        (batPercent < 15 || lowMinutesLeft);
      const gatewayOffline = effectiveConnectivity() === 'offline';

      if (unpluggedCriticalBat || gatewayOffline) {
        await raiseHelp({
          need: 'energy',
          severity: 'critical',
          title:
            unpluggedCriticalBat && gatewayOffline
              ? '电量危急且模型网关失联'
              : unpluggedCriticalBat
                ? lowMinutesLeft && batPercent >= 15
                  ? `续航危急（不足 ${Math.ceil(batMinutes ?? 15)} 分钟），请接通电源`
                  : `电量危急（仅剩 ${Math.round(batPercent)}%），请接通电源`
                : '模型网关失联，无法完成对话与自维护请求',
          summary: energy.summary,
          proposedAction:
            unpluggedCriticalBat && gatewayOffline
              ? '请接通电源适配器，并检查本地网关或网络连通性。'
              : unpluggedCriticalBat
                ? '已自动切换至本能节能降频模式；请尽快连接电源适配器。'
                : '已在后台零 Token 退避探活；请检查模型网关进程或网络连接。',
          actionKind: 'acknowledge',
        });
      }
    }

    const thermals = latestEval.needs.thermals;
    if (
      thermals.zone === 'critical' &&
      snap.state.self.body.thermal.value === 'critical' &&
      !isAutoHelpSuppressed('thermals', 'critical')
    ) {
      await raiseHelp({
        need: 'thermals',
        severity: 'critical',
        title: '设备严重过热，已启动本能降频降温',
        summary: thermals.summary,
        proposedAction: '请检查高负载外部进程或改善设备散热环境。',
        actionKind: 'acknowledge',
      });
    }
  }

  function actionableL1SoftwareNeeds(ignoreCircuitBreaker: boolean): NeedKey[] {
    return latestEval.activeDrives.filter((key) => {
      if (key === 'energy') return false;
      const ev = latestEval.needs[key];
      if (ev.zone !== 'uncomfortable' && ev.zone !== 'critical') return false;
      if (!ignoreCircuitBreaker && circuitBreaker.isTripped(key)) return false;
      return true;
    });
  }

  function actionableHigherOrderDrives(ignoreCircuitBreaker: boolean) {
    return arbiter
      .actionableHigherOrderDrives()
      .filter((d) => ignoreCircuitBreaker || !circuitBreaker.isTripped(d.key));
  }

  function buildMaintenancePrompt(
    distressedL1: readonly NeedKey[],
    distressedHigher: readonly {
      key: string;
      tier: number;
      label: string;
      zone: string;
      satisfaction: number;
      summary: string;
      evidence: Record<string, string | number | boolean | null>;
    }[],
  ): string {
    const lines = [
      '你是 ASI 的后台自维护模块。当前检测到以下需求处于不适或危急状态，请在安全沙盒内嗅探病因并尝试自救：',
      '',
    ];
    for (const key of distressedL1) {
      const ev = latestEval.needs[key];
      const safeSummary = sanitizeForModel(ev.summary);
      const safeEvidence = sanitizeForModel(JSON.stringify(ev.evidence));
      lines.push(
        `- [L1 · ${NEED_LABELS[key]} | ${ev.zone} | 满足度 ${ev.satisfaction}%]: ${safeSummary} (证据: ${safeEvidence})`,
      );
    }
    for (const hd of distressedHigher) {
      const safeSummary = sanitizeForModel(hd.summary);
      const safeEvidence = sanitizeForModel(JSON.stringify(hd.evidence));
      lines.push(
        `- [L${hd.tier} · ${sanitizeForModel(hd.label)} (${sanitizeForModel(hd.key)}) | ${hd.zone} | 满足度 ${hd.satisfaction}%]: ${safeSummary} (证据: ${safeEvidence})`,
      );
    }

    const recommendations = actionLedger.formatPromptRecommendations([
      ...distressedL1,
      ...distressedHigher.map((d) => d.key),
    ]);
    if (recommendations.length > 0) {
      lines.push('', '历史行动效果记忆（Action-Outcome Memory）：', ...recommendations);
    }

    lines.push(
      '',
      '执行准则：',
      '1. 仅使用只读诊断工具（needs_status / needs_sniff_causes / env_state / env_detail）与当前沙盒挂载的白名单维护工具（needs_clean_cache / needs_stop_job / needs_compact_context / needs_request_help 及已授权高阶需求工具）。',
      '2. 无人值守时仅自动清理 ASI 自身临时缓存（needs_clean_cache）；若 needs_sniff_causes 发现外部 safe/caution 开发者缓存大户，请调用 needs_request_help（actionKind="clean-external-cache" 且传入受控 targetId）请求用户一键批准清理。',
      '3. 严禁尝试清空废纸篓、删除用户文件、强杀外部应用进程或修改系统配置。',
    );
    return lines.join('\n');
  }

  async function maybeProposeExternalCacheHelpCard(
    severity: EpisodeSeverity,
    options?: { allowAfterApprovedExternal?: boolean },
  ): Promise<boolean> {
    if (!ports.homeDir) return false;
    if (!options?.allowAfterApprovedExternal && isAutoHelpSuppressed('space', severity)) return false;
    const alreadyOpenExternal = helpCards.some(
      (c) => c.need === 'space' && c.status === 'open' && c.actionKind === 'clean-external-cache',
    );
    if (alreadyOpenExternal) return true;

    const scan = await scanExternalCachesAndTrash({
      homeDir: ports.homeDir,
      now: clock.wall(),
      activeProtectionMs: EXTERNAL_CACHE_ACTIVE_PROTECTION_MS,
    }).catch(() => undefined);
    const topHog = scan?.externalCaches.find(
      (c) => c.approvable && c.reclaimableBytes > 0 && !dismissedExternalTargets.has(c.targetId),
    );
    if (!topHog) return false;

    const trashHint =
      scan && scan.trash.totalBytes > 0
        ? `；另只读统计到废纸篓占用 ${formatHumanBytes(scan.trash.totalBytes)}（仅提示不代清）`
        : '';

    await raiseHelp({
      need: 'space',
      severity,
      title: `发现可清理外部缓存：${topHog.label}（可释放 ${formatHumanBytes(topHog.reclaimableBytes)}）`,
      summary: `扫描到 ${topHog.label} 总计 ${formatHumanBytes(topHog.totalBytes)}，其中修改时间超过 1 小时的可清理项为 ${formatHumanBytes(topHog.reclaimableBytes)}（风险分级：${topHog.risk}）${trashHint}。`,
      proposedAction: `点击「批准清理外部缓存」将直接清除 ${topHog.label} 中超过 1 小时的陈旧缓存项，自动跳过 1 小时内活跃子项。${topHog.note}`,
      actionKind: 'clean-external-cache',
      actionTarget: topHog.targetId,
    });
    return true;
  }

  async function executeMaintenanceCheck(
    manual: boolean,
    initialDistressedL1: NeedKey[],
    monoNow: number,
    initialIsHigherOrderOnly: boolean,
  ): Promise<void> {
    if (effectiveConnectivity() === 'offline') {
      for (const key of initialDistressedL1) {
        if (stopped || latestSense.settings.paused) return;
        if (latestEval.needs[key].zone === 'critical') {
          await escalateNeedToCritical(
            key,
            `${NEED_LABELS[key]}危急（模型网关离线，无法后台自救）`,
            '当前模型网关不可达，无法运行后台安全维护会话；请人工排查或恢复网络连接。',
          );
        }
      }
      return;
    }

    if (!manual && autonomousTurnMonoTimes.length >= MAX_AUTONOMOUS_TURNS_PER_HOUR) {
      for (const key of initialDistressedL1) {
        if (stopped || latestSense.settings.paused) return;
        const ev = latestEval.needs[key];
        if (ev.zone === 'critical') {
          escalatedCriticalInTurn.add(key);
          await escalateNeedToCritical(
            key,
            `${NEED_LABELS[key]}持续危急，后台自救已达每小时上限`,
            '后台安全维护未能解除压力，请人工介入检查。',
          );
        }
      }
      return;
    }

    const shouldRotate = rotateMaintainerNext || maintTurnCount >= MAX_MAINTAINER_TURNS_BEFORE_ROTATE;

    const prevMaintStatus = maintStatus;
    const prevLastL1Mono = lastL1AutoRunMono;
    const prevLastHigherMono = lastHigherAutoRunMono;
    const localTurnAbort = turnAbort;

    activeTurnEffectiveNeeds.clear();
    maintStatus = 'running';
    activeRunningTier = initialIsHigherOrderOnly ? 'higher' : 'l1';
    let localHigherAbort = initialIsHigherOrderOnly ? new AbortController() : undefined;
    higherOrderTurnAbort = localHigherAbort;
    if (!manual) {
      if (initialIsHigherOrderOnly) {
        lastHigherAutoRunMono = monoNow;
      } else {
        lastL1AutoRunMono = monoNow;
      }
    }
    notify();

    const rollbackAutoCooldown = () => {
      if (!manual) {
        lastL1AutoRunMono = prevLastL1Mono;
        lastHigherAutoRunMono = prevLastHigherMono;
      }
    };

    try {
      let sessionId: string;
      try {
        sessionId = await ensureMaintenanceSession(shouldRotate);
      } catch {
        if (maintStatus === 'running') {
          maintStatus = 'unavailable';
        }
        if (stopped || latestSense.settings.paused || localTurnAbort.signal.aborted) {
          rollbackAutoCooldown();
          return;
        }
        const currentDistressedL1 = manual
          ? NEED_KEYS.filter((k) => latestEval.needs[k].driveActive)
          : actionableL1SoftwareNeeds(false);
        for (const critKey of new Set([...initialDistressedL1, ...currentDistressedL1])) {
          if (stopped || latestSense.settings.paused || localTurnAbort.signal.aborted) break;
          if (latestEval.needs[critKey].zone === 'critical') {
            escalatedCriticalInTurn.add(critKey);
            await escalateNeedToCritical(
              critKey,
              `${NEED_LABELS[critKey]}危急且无法创建自维护沙盒会话，需人工协助`,
              '后台自维护会话初始化失败（可能磁盘已满或会话服务受阻），请人工介入处理。',
            );
          }
        }
        return;
      }

      if (stopped || latestSense.settings.paused || localTurnAbort.signal.aborted || localHigherAbort?.signal.aborted) {
        rollbackAutoCooldown();
        return;
      }

      const distressedL1 = manual
        ? NEED_KEYS.filter((k) => latestEval.needs[k].driveActive)
        : actionableL1SoftwareNeeds(false);
      const distressedHigher = distressedL1.length === 0 ? actionableHigherOrderDrives(manual) : [];

      if (!manual && distressedL1.length === 0 && distressedHigher.length === 0) {
        rollbackAutoCooldown();
        pendingMaintenanceRecheck = false;
        return;
      }

      const nowHigherOrderOnly = distressedL1.length === 0 && distressedHigher.length > 0;
      if (!manual && !initialIsHigherOrderOnly && nowHigherOrderOnly) {
        rollbackAutoCooldown();
        pendingMaintenanceRecheck = true;
        return;
      }

      if (nowHigherOrderOnly && !localHigherAbort) {
        localHigherAbort = new AbortController();
        higherOrderTurnAbort = localHigherAbort;
        activeRunningTier = 'higher';
        if (arbiter.snapshot().higherOrderSuppressed) {
          localHigherAbort.abort();
          rollbackAutoCooldown();
          pendingMaintenanceRecheck = true;
          return;
        }
      }

      if (effectiveConnectivity() === 'offline') {
        rollbackAutoCooldown();
        for (const key of distressedL1) {
          if (stopped || latestSense.settings.paused || localTurnAbort.signal.aborted) break;
          if (latestEval.needs[key].zone === 'critical') {
            await escalateNeedToCritical(
              key,
              `${NEED_LABELS[key]}危急（模型网关离线，无法后台自救）`,
              '当前模型网关不可达，无法运行后台安全维护会话；请人工排查或恢复网络连接。',
            );
          }
        }
        return;
      }

      pendingMaintenanceRecheck = false;

      const targetL1 =
        distressedL1.length > 0
          ? distressedL1
          : distressedHigher.length > 0
            ? []
            : (['space', 'memory', 'mind'] as NeedKey[]);
      const beforeSatL1 = Object.fromEntries(targetL1.map((k) => [k, latestEval.needs[k].satisfaction]));
      const beforeSatHigher = Object.fromEntries(distressedHigher.map((d) => [d.key, d.satisfaction]));

      const newlyMarkedCritical: NeedKey[] = [];
      for (const k of targetL1) {
        if (latestEval.needs[k].zone === 'critical' && !escalatedCriticalInTurn.has(k)) {
          escalatedCriticalInTurn.add(k);
          newlyMarkedCritical.push(k);
        }
      }

      const effectiveTurnSignal = localHigherAbort
        ? AbortSignal.any([localTurnAbort.signal, localHigherAbort.signal])
        : localTurnAbort.signal;
      const prevMaintLastRunAt = maintLastRunAt;
      maintLastRunAt = clock.wall();
      let recordedAutonomousQuota = false;
      if (!manual) {
        autonomousTurnMonoTimes.push(monoNow);
        recordedAutonomousQuota = true;
      }
      notify();

      const rollbackInterruptedTurn = () => {
        maintLastRunAt = prevMaintLastRunAt;
        rollbackAutoCooldown();
        if (recordedAutonomousQuota) {
          const idx = autonomousTurnMonoTimes.lastIndexOf(monoNow);
          if (idx !== -1) autonomousTurnMonoTimes.splice(idx, 1);
          recordedAutonomousQuota = false;
        }
        for (const k of newlyMarkedCritical) {
          escalatedCriticalInTurn.delete(k);
        }
      };

      try {
        const prompt =
          manual && distressedL1.length === 0 && distressedHigher.length === 0
            ? '用户触发了一次手动生存需求自检。请调用 needs_status 查看五大生存需求现状，必要时调用 needs_sniff_causes 嗅探本机缓存与负载，确认各项舒适或执行必要的安全整理后简要总结。'
            : buildMaintenancePrompt(targetL1, distressedHigher);

        await ports.sessions.runMaintenanceTurn(sessionId, prompt, effectiveTurnSignal);
        if (stopped || latestSense.settings.paused || localTurnAbort.signal.aborted) {
          rollbackInterruptedTurn();
          return;
        }
        maintTurnCount += 1;
        maintTotalTurns += 1;

        await ports.sense.refresh?.().catch(() => undefined);
        if (stopped || latestSense.settings.paused || localTurnAbort.signal.aborted) {
          return;
        }
        recomputeEval(ports.sense.snapshot());

        const primaryNeed = targetL1[0];
        const primaryDriveKey = distressedHigher[0]?.key;
        let outcome: MaintenanceOutcome = 'info';
        const higherPreempted = Boolean(localHigherAbort?.signal.aborted);

        if (distressedL1.length > 0) {
          if (latestEval.needs.space.driveActive && distressedL1.includes('space')) {
            const spaceSev: EpisodeSeverity = latestEval.needs.space.zone === 'critical' ? 'critical' : 'uncomfortable';
            await maybeProposeExternalCacheHelpCard(spaceSev);
          }

          const allCleared = distressedL1.every((k) => !latestEval.needs[k].driveActive);
          const anyImproved = distressedL1.some(
            (k) => activeTurnEffectiveNeeds.has(k) || latestEval.needs[k].satisfaction > (beforeSatL1[k] ?? 0),
          );
          const stillCritical = distressedL1.filter((k) => latestEval.needs[k].zone === 'critical');

          for (const critKey of stillCritical) {
            if (stopped || latestSense.settings.paused || localTurnAbort.signal.aborted) break;
            await escalateNeedToCritical(
              critKey,
              `${NEED_LABELS[critKey]}自救后仍处危急，需人工协助`,
              '白名单自维护动作未能彻底解除危急状态，请人工排查外部占用或扩容。',
            );
          }

          if (!manual && !stopped && !latestSense.settings.paused && !localTurnAbort.signal.aborted) {
            for (const key of distressedL1) {
              const ev = latestEval.needs[key];
              const keyHadGain = activeTurnEffectiveNeeds.has(key) || ev.satisfaction > (beforeSatL1[key] ?? 0);
              const curSev: EpisodeSeverity = ev.zone === 'critical' ? 'critical' : 'uncomfortable';
              const hasOpenOrHandledCard =
                helpCards.some((c) => c.need === key && c.status === 'open') || isAutoHelpSuppressed(key, curSev);
              if (!keyHadGain && hasOpenOrHandledCard && ev.driveActive && ev.zone !== 'comfortable') {
                const tripDiskFree = key === 'space' ? primaryDiskFreeBytes(latestSense) : undefined;
                circuitBreaker.trip({
                  need: key,
                  trippedAt: clock.wall(),
                  zoneAtTrip: ev.zone,
                  satisfactionAtTrip: ev.satisfaction,
                  envFingerprint: fingerprintForDrive(key, latestSense, ev),
                  ...(tripDiskFree !== undefined ? { diskFreeAtTrip: tripDiskFree } : {}),
                  reason: '安全自救零收益且求助卡已挂出或已处理，静默熔断避免重复唤醒模型',
                });
              }
            }
          }

          outcome = allCleared ? 'relieved' : stillCritical.length > 0 ? 'escalated' : anyImproved ? 'partial' : 'info';
        } else if (distressedHigher.length > 0 && !higherPreempted) {
          const refreshedHigher = distressedHigher.map((d) => ({
            key: d.key,
            current: arbiter.findDrive(d.key),
          }));
          const allCleared = refreshedHigher.every((item) => !item.current?.driveActive);
          const anyImproved = refreshedHigher.some(
            (item) =>
              activeTurnEffectiveNeeds.has(item.key) ||
              (item.current?.satisfaction ?? 0) > (beforeSatHigher[item.key] ?? 0),
          );
          if (
            !manual &&
            !stopped &&
            !latestSense.settings.paused &&
            !localTurnAbort.signal.aborted &&
            !arbiter.snapshot().higherOrderSuppressed
          ) {
            for (const item of refreshedHigher) {
              const cur = item.current;
              if (!cur?.driveActive || cur.suppressed || cur.zone === 'comfortable') continue;
              const hadGain =
                activeTurnEffectiveNeeds.has(item.key) || cur.satisfaction > (beforeSatHigher[item.key] ?? 0);
              if (!hadGain) {
                circuitBreaker.trip({
                  need: item.key,
                  trippedAt: clock.wall(),
                  zoneAtTrip: cur.zone,
                  satisfactionAtTrip: cur.satisfaction,
                  envFingerprint: fingerprintForDrive(item.key, latestSense, cur),
                  reason: '高阶需求自维护本轮无收益，静默熔断等待环境变化',
                });
              }
            }
          }
          outcome = allCleared ? 'relieved' : anyImproved ? 'partial' : 'info';
        }

        if (!stopped && !latestSense.settings.paused && !localTurnAbort.signal.aborted) {
          addRecord({
            actor: 'maintainer',
            ...(primaryNeed ? { need: primaryNeed } : {}),
            ...(primaryDriveKey ? { driveKey: primaryDriveKey } : {}),
            action: manual ? 'manual-check' : 'auto-maintain',
            summary: higherPreempted
              ? 'L1 生理需求或节能模式激活，已挂起并抢占当前高阶维护回合'
              : outcome === 'relieved'
                ? '后台自维护完成，相关需求已恢复舒适区'
                : outcome === 'escalated'
                  ? '后台自维护触及安全边界或仍处危急，已发出求助卡'
                  : '后台自维护巡检已完成',
            outcome,
          });
        }
      } catch {
        if (stopped || latestSense.settings.paused || localTurnAbort.signal.aborted) {
          rollbackInterruptedTurn();
          return;
        }
        const preemptedCatch = Boolean(localHigherAbort?.signal.aborted);
        if (!preemptedCatch) {
          recomputeEval(ports.sense.snapshot());
          for (const critKey of distressedL1) {
            if (stopped || latestSense.settings.paused || localTurnAbort.signal.aborted) break;
            if (latestEval.needs[critKey].zone === 'critical') {
              await escalateNeedToCritical(
                critKey,
                `${NEED_LABELS[critKey]}危急且后台自维护执行中断，需人工协助`,
                '后台自维护会话未能完成自救，请人工排查当前资源压力。',
              );
            }
          }
        }
        if (!stopped && !latestSense.settings.paused && !localTurnAbort.signal.aborted) {
          addRecord({
            actor: 'maintainer',
            ...(targetL1[0] ? { need: targetL1[0] } : {}),
            ...(distressedHigher[0]?.key ? { driveKey: distressedHigher[0].key } : {}),
            action: manual ? 'manual-check' : 'auto-maintain',
            summary: preemptedCatch
              ? 'L1 生理需求或节能模式激活，已抢占中断高阶维护回合'
              : '后台自维护会话执行中断，稍后按退避策略重试',
            outcome: preemptedCatch ? 'info' : 'failed',
          });
        }
      }
    } finally {
      if (maintStatus === 'running') {
        maintStatus = maintSessionId ? 'idle' : prevMaintStatus;
      }
      activeRunningTier = null;
      if (higherOrderTurnAbort === localHigherAbort) {
        higherOrderTurnAbort = undefined;
      }
      activeTurnEffectiveNeeds.clear();
      notify();
    }
  }

  async function runMaintenanceCheck(manual: boolean): Promise<void> {
    if (stopped || latestSense.settings.paused) return;
    if (maintCheckLocked || maintStatus === 'running') {
      if (!manual) {
        pendingMaintenanceRecheck = true;
        if (activeRunningTier === 'higher' && arbiter.snapshot().higherOrderSuppressed) {
          higherOrderTurnAbort?.abort();
        }
        return;
      }
      if (activeCheckManual) {
        if (maintCheckPromise) {
          await maintCheckPromise;
        }
        return;
      }
      if (queuedManualCheckPromise) {
        await queuedManualCheckPromise;
        return;
      }
      const inFlightAuto = maintCheckPromise ?? Promise.resolve();
      let trackedQueued: Promise<void> | undefined;
      const queued = inFlightAuto
        .finally(() => {
          if (queuedManualCheckPromise === trackedQueued) {
            queuedManualCheckPromise = undefined;
          }
        })
        .then(async () => {
          if (stopped || latestSense.settings.paused) return;
          recomputeEval(ports.sense.snapshot());
          await runMaintenanceCheck(true);
        });
      trackedQueued = queued;
      queuedManualCheckPromise = queued;
      await queued;
      return;
    }

    const distressedL1 = manual
      ? NEED_KEYS.filter((k) => latestEval.needs[k].driveActive)
      : actionableL1SoftwareNeeds(false);
    const distressedHigher = distressedL1.length === 0 ? actionableHigherOrderDrives(manual) : [];

    if (!manual && distressedL1.length === 0 && distressedHigher.length === 0) return;

    const connectivityOffline = effectiveConnectivity() === 'offline';
    if (connectivityOffline && !distressedL1.some((k) => latestEval.needs[k].zone === 'critical')) {
      return;
    }

    const monoNow = clock.mono();
    while (autonomousTurnMonoTimes[0] !== undefined && monoNow - autonomousTurnMonoTimes[0] > 3_600_000) {
      autonomousTurnMonoTimes.shift();
    }

    const isHigherOrderOnlyTurn = distressedL1.length === 0 && distressedHigher.length > 0;

    if (!manual && !connectivityOffline) {
      const newlyCritical = distressedL1.some(
        (k) => latestEval.needs[k].zone === 'critical' && !escalatedCriticalInTurn.has(k),
      );
      const relevantLastRunMono = isHigherOrderOnlyTurn
        ? Math.max(lastL1AutoRunMono ?? Number.NEGATIVE_INFINITY, lastHigherAutoRunMono ?? Number.NEGATIVE_INFINITY)
        : lastL1AutoRunMono;
      if (
        !newlyCritical &&
        relevantLastRunMono !== undefined &&
        Number.isFinite(relevantLastRunMono) &&
        monoNow - relevantLastRunMono < AUTONOMOUS_COOLDOWN_MS
      ) {
        return;
      }
      if (
        autonomousTurnMonoTimes.length >= MAX_AUTONOMOUS_TURNS_PER_HOUR &&
        !distressedL1.some((k) => latestEval.needs[k].zone === 'critical')
      ) {
        return;
      }
    }

    maintCheckLocked = true;
    activeCheckManual = manual;
    let trackedLifecycle: Promise<void> | undefined;
    const lifecyclePromise = executeMaintenanceCheck(manual, distressedL1, monoNow, isHigherOrderOnlyTurn).finally(
      () => {
        maintCheckLocked = false;
        activeCheckManual = false;
        if (maintCheckPromise === trackedLifecycle) {
          maintCheckPromise = undefined;
        }
        if (queuedManualCheckPromise) {
          pendingMaintenanceRecheck = false;
        } else if (!stopped && !latestSense.settings.paused && pendingMaintenanceRecheck) {
          pendingMaintenanceRecheck = false;
          void runMaintenanceCheck(false);
        }
      },
    );
    trackedLifecycle = lifecyclePromise;
    maintCheckPromise = lifecyclePromise;
    await lifecyclePromise;
  }

  async function processSnapshot(snap: SenseSnapshot, options?: { skipAutoMaint?: boolean }): Promise<void> {
    if (stopped) return;
    const connectivityChanged = await instinct.probeConnectivity(snap, snap.settings.paused);
    recomputeEval(snap);
    const powerChanged = await instinct.reconcilePower(snap, latestEval.needs, snap.settings.paused);

    if (powerChanged || connectivityChanged) {
      recomputeEval(ports.sense.snapshot());
      if (powerChanged) {
        addRecord({
          actor: 'instinct',
          need: latestEval.needs.energy.driveActive ? 'energy' : 'thermals',
          action: powerChanged.to === 'eco' ? 'eco-mode' : 'normal-mode',
          summary:
            powerChanged.to === 'eco'
              ? `触发零 Token 本能反射：${powerChanged.reason ?? '进入节能降频'}`
              : '生存压力解除，恢复正常采样频率',
          outcome: powerChanged.to === 'eco' ? 'partial' : 'relieved',
        });
      }
      if (connectivityChanged) {
        addRecord({
          actor: 'instinct',
          need: 'energy',
          action: 'gateway-probe',
          summary:
            connectivityChanged.to === 'online'
              ? '静默探活确认模型网关已恢复连通'
              : `静默探活发现模型网关状态变为 ${connectivityChanged.to}`,
          outcome: connectivityChanged.to === 'online' ? 'relieved' : 'partial',
        });
      }
    }

    await checkImmediateBoundaries(latestSense);
    if (!latestSense.settings.paused) {
      for (const openCard of helpCards) {
        if (openCard.status === 'open' && !isCrySuppressed(openCard.need, openCard.severity)) {
          await deliverCryIfNeeded(openCard);
        }
      }
    }
    notify();

    if (!options?.skipAutoMaint && !latestSense.settings.paused) {
      void runMaintenanceCheck(false);
    }
  }

  function scheduleProcess(snap: SenseSnapshot, options?: { skipAutoMaint?: boolean }): Promise<void> {
    const next = (reconcileInFlight ?? Promise.resolve()).then(
      () => processSnapshot(snap, options),
      () => processSnapshot(snap, options),
    );
    reconcileInFlight = next;
    return next;
  }

  function snapshot(): NeedsSnapshot {
    const settings = ports.sense.getSettings();
    const brokenNeeds = circuitBreaker.trippedNeeds();
    const drivesSnap = latestHigherOrder.snapshot;
    return {
      now: latestEval.now,
      paused: settings.paused,
      sendTitles: settings.sendTitles,
      overallSatisfaction: latestEval.overallSatisfaction,
      overallUrgency: latestEval.overallUrgency,
      overallZone: latestEval.overallZone,
      activeDrives: [...latestEval.activeDrives],
      needs: structuredClone(latestEval.needs),
      instinct: instinct.state(),
      helpCards: structuredClone(helpCards),
      maintenanceSession: {
        ...(maintSessionId ? { sessionId: maintSessionId } : {}),
        title: 'ASI 自维护',
        status: maintStatus,
        turnCount: maintTotalTurns,
        ...(maintLastRunAt !== undefined ? { lastRunAt: maintLastRunAt } : {}),
        ...(brokenNeeds.length > 0 ? { circuitBrokenNeeds: brokenNeeds } : {}),
      },
      records: structuredClone(records),
      actionLedger: actionLedger.entries(),
      higherOrderDrives: structuredClone(latestHigherOrder.higherOrderDrives),
      higherOrderSuppressed: drivesSnap.higherOrderSuppressed,
      ...(drivesSnap.suppressionReason ? { higherOrderSuppressionReason: drivesSnap.suppressionReason } : {}),
    };
  }

  const tools: MaintenanceToolsApi = {
    statusSnapshot: () => snapshot(),

    async sniffCauses() {
      const now = clock.wall();
      const [internalCache, externalScan, topProcesses] = await Promise.all([
        inspectSafeCaches({
          needsStorageRoot: ports.storageRoot,
          senseStorageRoot: ports.sense.storageRoot,
        }),
        ports.homeDir
          ? scanExternalCachesAndTrash({
              homeDir: ports.homeDir,
              now,
              activeProtectionMs: EXTERNAL_CACHE_ACTIVE_PROTECTION_MS,
            })
          : Promise.resolve<ExternalCacheScanReport>({
              scannedAt: now,
              activeProtectionWindowMs: EXTERNAL_CACHE_ACTIVE_PROTECTION_MS,
              externalCaches: [],
              trash: {
                exists: false,
                paths: [],
                totalBytes: 0,
                itemCount: 0,
                risk: 'risky',
                cleanable: false,
                note: TRASH_READONLY_RULE.note,
              },
              truncated: false,
            }),
        sampleTopProcesses({
          now,
          exec: ports.execProcessPs,
          signal: turnAbort.signal,
        }),
      ]);

      return {
        scannedAt: now,
        activeProtectionWindowMs: externalScan.activeProtectionWindowMs,
        asiInternalCache: {
          totalBytes: internalCache.totalBytes,
          reclaimableBytes: internalCache.reclaimableBytes,
          entryCount: internalCache.entryCount,
        },
        externalCaches: externalScan.externalCaches,
        trash: externalScan.trash,
        topProcesses,
        truncated: externalScan.truncated,
      };
    },

    async cleanCache() {
      const now = clock.wall();
      const beforeSat = latestEval.needs.space.satisfaction;
      const res = await cleanSafeCaches({
        needsStorageRoot: ports.storageRoot,
        senseStorageRoot: ports.sense.storageRoot,
        now,
      });
      await ports.sense.refresh?.().catch(() => undefined);
      recomputeEval(ports.sense.snapshot());
      const afterSat = latestEval.needs.space.satisfaction;

      const gain = buildActionMeasurement({
        freedBytes: res.freedBytes,
        satisfactionBefore: beforeSat,
        satisfactionAfter: afterSat,
      });
      actionLedger.record({ need: 'space', action: 'needs_clean_cache', at: now, gain });
      if (maintStatus === 'running' && gain.effective) {
        activeTurnEffectiveNeeds.add('space');
      }

      const mb = (res.freedBytes / 1024 ** 2).toFixed(1);
      const summary =
        res.deletedEntries > 0
          ? `清理 ASI 自有临时缓存 ${res.deletedEntries} 项，释放 ${mb} MB`
          : 'ASI 自有临时缓存目录已干净，无可清理项';
      addRecord({
        actor: 'maintainer',
        need: 'space',
        action: 'needs_clean_cache',
        summary,
        outcome: gain.effective ? (latestEval.needs.space.driveActive ? 'partial' : 'relieved') : 'info',
        gain,
      });
      notify();
      return { deletedEntries: res.deletedEntries, freedBytes: res.freedBytes, summary, gain };
    },

    async stopStuckJob(jobId?: string) {
      const now = clock.wall();
      const beforeSat = latestEval.needs.memory.satisfaction;
      const res = stopStuckJobs({
        jobsPort: ports.jobs,
        now,
        ...(jobId ? { targetJobId: jobId } : {}),
      });
      await ports.sense.refresh?.().catch(() => undefined);
      recomputeEval(ports.sense.snapshot());
      const afterSat = latestEval.needs.memory.satisfaction;

      const gain = buildActionMeasurement({
        stoppedJobs: res.stoppedIds.length,
        satisfactionBefore: beforeSat,
        satisfactionAfter: afterSat,
      });
      actionLedger.record({ need: 'memory', action: 'needs_stop_job', at: now, gain });
      if (maintStatus === 'running' && gain.effective) {
        activeTurnEffectiveNeeds.add('memory');
      }

      const summary =
        res.stoppedIds.length > 0
          ? `结束超时/无主后台任务 ${res.stoppedIds.length} 个（${res.stoppedIds.join(', ')}）`
          : res.refusedActiveIds.length > 0
            ? `拒绝结束正常活跃任务（${res.refusedActiveIds.join(', ')}）`
            : '当前无超时或无主的卡死任务';
      addRecord({
        actor: 'maintainer',
        need: 'memory',
        action: 'needs_stop_job',
        summary,
        outcome: gain.effective ? (latestEval.needs.memory.driveActive ? 'partial' : 'relieved') : 'info',
        gain,
      });
      notify();
      return { ...res, summary, gain };
    },

    async compactContext() {
      const now = clock.wall();
      const beforeSat = latestEval.needs.mind.satisfaction;
      const res = await compactIdleContexts({
        compactionPort: ports.compaction,
        excludeSessionIds: new Set(internalSessions.keys()),
        signal: turnAbort.signal,
        rotateMaintainer: async () => {
          if (maintTurnCount >= 4) {
            rotateMaintainerNext = true;
            return true;
          }
          return false;
        },
      });
      await ports.sense.refresh?.().catch(() => undefined);
      recomputeEval(ports.sense.snapshot());
      const afterSat = latestEval.needs.mind.satisfaction;

      const gain = buildActionMeasurement({
        tokensSaved: res.tokensSaved,
        satisfactionBefore: beforeSat,
        satisfactionAfter: afterSat,
      });
      const effectiveOrRotated = gain.effective || res.compactedSessions > 0 || res.rotatedMaintainer;
      const finalGain: ActionMeasurement = effectiveOrRotated ? { ...gain, effective: true } : gain;
      actionLedger.record({ need: 'mind', action: 'needs_compact_context', at: now, gain: finalGain });
      if (maintStatus === 'running' && finalGain.effective) {
        activeTurnEffectiveNeeds.add('mind');
      }

      const summary =
        res.compactedSessions > 0 || res.rotatedMaintainer
          ? `整理空闲会话 ${res.compactedSessions} 个（释放约 ${res.tokensSaved} tokens）${res.rotatedMaintainer ? '，并标记自维护会话轮换' : ''}`
          : '当前无处于空闲且需要压缩的会话';
      addRecord({
        actor: 'maintainer',
        need: 'mind',
        action: 'needs_compact_context',
        summary,
        outcome: finalGain.effective ? 'relieved' : 'info',
        gain: finalGain,
      });
      notify();
      return { compactedSessions: res.compactedSessions, tokensSaved: res.tokensSaved, summary, gain: finalGain };
    },

    async requestHelp(input) {
      const actionKind = input.actionKind ?? 'acknowledge';
      const validatedTarget = validateHelpActionTarget(actionKind, input.actionTarget);
      if (actionKind === 'clean-external-cache' && validatedTarget && ports.homeDir) {
        const scan = await scanExternalCachesAndTrash({
          homeDir: ports.homeDir,
          now: clock.wall(),
          activeProtectionMs: EXTERNAL_CACHE_ACTIVE_PROTECTION_MS,
        });
        const matched = scan.externalCaches.find((c) => c.targetId === validatedTarget);
        if (!matched || matched.reclaimableBytes <= 0) {
          throw new Error(
            `External cache target "${validatedTarget}" has 0 reclaimable bytes older than 1 hour; inspect needs_sniff_causes or use actionKind="acknowledge"`,
          );
        }
      }
      const severity =
        input.severity ?? (latestEval.needs[input.need].zone === 'critical' ? 'critical' : 'uncomfortable');
      const result = await raiseHelp({
        need: input.need,
        severity,
        title: input.title,
        summary: input.summary,
        ...(input.proposedAction ? { proposedAction: input.proposedAction } : {}),
        ...(input.actionKind ? { actionKind: input.actionKind } : {}),
        ...(validatedTarget ? { actionTarget: validatedTarget } : {}),
      });
      addRecord({
        actor: 'maintainer',
        need: input.need,
        action: 'needs_request_help',
        summary: `发起啼哭求助：${result.card.title}`,
        outcome: 'escalated',
      });
      return result;
    },
  };

  const actions: NeedsActions = {
    async pause(paused: boolean) {
      const prevReconcile = reconcileInFlight;
      await ports.sense.setPaused(paused);
      const snap = ports.sense.snapshot();
      recomputeEval(snap);
      if (paused) {
        abortInFlightMaintenanceForPause();
        notify();
        return;
      }
      notify();
      if (reconcileInFlight && reconcileInFlight !== prevReconcile) {
        await reconcileInFlight;
      } else {
        await scheduleProcess(snap);
      }
    },

    async setSendTitles(enabled: boolean) {
      await ports.sense.setSendTitles(enabled);
      recomputeEval(ports.sense.snapshot());
      notify();
    },

    async openPermissionSettings() {
      await ports.sense.openPermissionSettings();
    },

    async approveHelp(cardId: string) {
      const card = helpCards.find((c) => c.id === cardId);
      if (card?.status !== 'open') return;

      const now = clock.wall();
      const beforeSat = latestEval.needs[card.need].satisfaction;
      let actionSummary = `用户确认处理：${card.title}`;
      let ledgerAction: string | undefined;
      let freedBytes = 0;
      let stoppedJobsCount = 0;
      let tokensSaved = 0;

      if (card.actionKind === 'clean-cache') {
        const cleaned = await cleanSafeCaches({
          needsStorageRoot: ports.storageRoot,
          senseStorageRoot: ports.sense.storageRoot,
          now,
        });
        freedBytes = cleaned.freedBytes;
        ledgerAction = 'clean-cache';
        actionSummary = `用户批准清理自有缓存，删除 ${cleaned.deletedEntries} 项（释放 ${formatHumanBytes(cleaned.freedBytes)}）`;
      } else if (card.actionKind === 'clean-external-cache') {
        const targetId = validateHelpActionTarget('clean-external-cache', card.actionTarget);
        if (!targetId) {
          throw new Error('Missing whitelisted targetId for clean-external-cache');
        }
        const cleaned = await cleanExternalCacheTarget({
          homeDir: ports.homeDir ?? '',
          targetId,
          now,
          activeProtectionMs: EXTERNAL_CACHE_ACTIVE_PROTECTION_MS,
        });
        freedBytes = cleaned.freedBytes;
        ledgerAction = `clean-external-cache:${cleaned.targetId}`;
        const activeNote =
          cleaned.skippedActiveEntries > 0 ? `，自动保护跳过 1 小时内活跃子项 ${cleaned.skippedActiveEntries} 项` : '';
        actionSummary = `用户批准清理 ${cleaned.label}：清除陈旧缓存 ${cleaned.deletedEntries} 项，释放 ${formatHumanBytes(cleaned.freedBytes)}${activeNote}`;
      } else if (card.actionKind === 'stop-stuck-jobs') {
        const stoppedJobs = stopStuckJobs({
          jobsPort: ports.jobs,
          now,
          ...(card.actionTarget ? { targetJobId: card.actionTarget } : {}),
        });
        stoppedJobsCount = stoppedJobs.stoppedIds.length;
        ledgerAction = 'stop-stuck-jobs';
        actionSummary = `用户批准结束卡死任务（${stoppedJobs.stoppedIds.length} 个）`;
      } else if (card.actionKind === 'compact-context') {
        const compacted = await compactIdleContexts({
          compactionPort: ports.compaction,
          excludeSessionIds: new Set(internalSessions.keys()),
          signal: turnAbort.signal,
        });
        tokensSaved = compacted.tokensSaved;
        ledgerAction = 'compact-context';
        actionSummary = `用户批准整理上下文（${compacted.compactedSessions} 个空闲会话）`;
      } else if (card.actionKind === 'enable-eco') {
        await ports.sense.setPowerMode('eco', '用户批准节能模式');
        ledgerAction = 'enable-eco';
        actionSummary = '用户批准进入节能降频模式';
      } else if (card.actionKind === 'open-permissions') {
        await ports.sense.openPermissionSettings();
        actionSummary = '用户打开系统权限设置';
      }

      await ports.sense.refresh?.().catch(() => undefined);
      recomputeEval(ports.sense.snapshot());
      const afterSat = latestEval.needs[card.need].satisfaction;

      let gain: ActionMeasurement | undefined;
      if (ledgerAction) {
        gain = buildActionMeasurement({
          freedBytes,
          stoppedJobs: stoppedJobsCount,
          tokensSaved,
          satisfactionBefore: beforeSat,
          satisfactionAfter: afterSat,
        });
        actionLedger.record({ need: card.need, action: ledgerAction, at: now, gain });
      }

      circuitBreaker.clear(card.need);
      recordEpisodeSeverity(criedEpisodeSeverity, card.need, card.severity);
      helpCards = helpCards.map((c) => (c.id === cardId ? { ...c, status: 'approved', updatedAt: now } : c));

      let proposedFollowUpExternal = false;
      if (card.actionKind === 'clean-external-cache' && latestEval.needs.space.driveActive) {
        const nextSev: EpisodeSeverity = latestEval.needs.space.zone === 'critical' ? 'critical' : 'uncomfortable';
        proposedFollowUpExternal = await maybeProposeExternalCacheHelpCard(nextSev, {
          allowAfterApprovedExternal: true,
        });
      }
      if (!proposedFollowUpExternal) {
        recordEpisodeSeverity(handledEpisodeSeverity, card.need, card.severity);
      }

      const recordOutcome: MaintenanceOutcome =
        card.actionKind === 'clean-external-cache' && latestEval.needs[card.need].driveActive
          ? freedBytes > 0
            ? 'partial'
            : 'info'
          : 'relieved';
      addRecord({
        actor: 'user',
        need: card.need,
        action: ledgerAction ?? card.actionKind,
        summary: actionSummary,
        outcome: recordOutcome,
        ...(gain ? { gain } : {}),
      });
      await persistState();
      await scheduleProcess(ports.sense.snapshot());
    },

    async dismissHelp(cardId: string) {
      const card = helpCards.find((c) => c.id === cardId);
      if (card?.status !== 'open') return;
      const now = clock.wall();
      if (card.actionKind === 'clean-external-cache' && card.actionTarget) {
        dismissedExternalTargets.add(card.actionTarget);
      }
      recordEpisodeSeverity(criedEpisodeSeverity, card.need, card.severity);
      recordEpisodeSeverity(handledEpisodeSeverity, card.need, card.severity);
      helpCards = helpCards.map((c) => (c.id === cardId ? { ...c, status: 'dismissed', updatedAt: now } : c));

      const ev = latestEval.needs[card.need];
      if (card.need !== 'energy' && ev.driveActive && ev.zone !== 'comfortable') {
        const tripDiskFree = card.need === 'space' ? primaryDiskFreeBytes(latestSense) : undefined;
        circuitBreaker.trip({
          need: card.need,
          trippedAt: now,
          zoneAtTrip: ev.zone,
          satisfactionAtTrip: ev.satisfaction,
          envFingerprint: fingerprintForDrive(card.need, latestSense, ev),
          ...(tripDiskFree !== undefined ? { diskFreeAtTrip: tripDiskFree } : {}),
          reason: '用户已忽略当前剧集求助卡，静默熔断避免重复唤醒模型',
        });
      }
      await persistState();
      notify();
    },

    async openMaintenanceSession() {
      return await ensureMaintenanceSession(false);
    },

    async triggerCheck() {
      await scheduleProcess(ports.sense.snapshot(), { skipAutoMaint: true });
      await runMaintenanceCheck(true);
    },
  };

  const drives: NeedsDrivesRuntimeApi = {
    snapshot: () => arbiter.snapshot(),
    subscribe: (listener) => arbiter.subscribe(listener),
    registerSource: (registration) => arbiter.registerSource(registration),
    notifySourceChanged: (sourceId) => arbiter.notifySourceChanged(sourceId),
    onToolsStructureChanged: (listener) => arbiter.onToolsStructureChanged(listener),
    registeredSandboxTools: () => arbiter.registeredSandboxTools(),
    checkSandboxToolGuard: (toolName) => arbiter.checkSandboxToolGuard(toolName),

    async executeSandboxTool(tool, args, signal) {
      const guard = arbiter.checkSandboxToolGuard(tool.spec.name);
      if (!guard.allowed) {
        throw new Error(guard.reason ?? 'Sandbox tool is currently suspended');
      }
      const now = clock.wall();
      const targetKey = arbiter.resolveTargetDriveKey(tool) ?? `${tool.sourceId}:default`;
      const beforeSat = arbiter.findDrive(targetKey)?.satisfaction;

      const res = await tool.spec.execute(args, { signal });
      await ports.sense.refresh?.().catch(() => undefined);
      recomputeEval(ports.sense.snapshot());
      const afterSat = arbiter.findDrive(targetKey)?.satisfaction;

      const gain = buildActionMeasurement({
        freedBytes: res.freedBytes,
        stoppedJobs: res.stoppedJobs,
        tokensSaved: res.tokensSaved,
        satisfactionBefore: beforeSat,
        satisfactionAfter: afterSat,
      });
      actionLedger.record({
        need: targetKey,
        action: tool.spec.name,
        at: now,
        gain,
      });
      if (maintStatus === 'running' && gain.effective) {
        activeTurnEffectiveNeeds.add(targetKey);
      }

      const safeSummary = String(sanitizeForModel(res.summary || `${tool.spec.name} completed`)).slice(0, 240);
      addRecord({
        actor: 'maintainer',
        driveKey: targetKey,
        action: tool.spec.name,
        summary: safeSummary,
        outcome: gain.effective ? 'relieved' : 'info',
        gain,
      });
      notify();
      return { ...res, summary: safeSummary, gain };
    },
  };

  return {
    sandboxDir,
    async start() {
      if (started) return;
      started = true;
      stopped = false;
      try {
        const raw = await readFile(statePath, 'utf8');
        const parsed = JSON.parse(raw) as PersistedNeedsState;
        if (Array.isArray(parsed.helpCards)) helpCards = parsed.helpCards.slice(0, 30);
        if (Array.isArray(parsed.records)) records = parsed.records.slice(0, MAX_RECORDS);
        if (parsed.actionLedger) actionLedger.restore(parsed.actionLedger);
        if (parsed.circuitBreakers) circuitBreaker.restore(parsed.circuitBreakers);
        if (Array.isArray(parsed.dismissedExternalTargets)) {
          for (const t of parsed.dismissedExternalTargets) {
            if (typeof t === 'string' && isCleanableExternalCacheId(t)) {
              dismissedExternalTargets.add(t);
            }
          }
        }
        if (parsed.previousStates && typeof parsed.previousStates === 'object') {
          const restored: Partial<Record<NeedKey, PreviousNeedState>> = {};
          for (const key of NEED_KEYS) {
            const entry = parsed.previousStates[key];
            if (
              entry &&
              (entry.zone === 'comfortable' || entry.zone === 'uncomfortable' || entry.zone === 'critical') &&
              typeof entry.driveActive === 'boolean'
            ) {
              restored[key] = {
                zone: entry.zone,
                driveActive: entry.driveActive,
                ...(typeof entry.satisfaction === 'number' && Number.isFinite(entry.satisfaction)
                  ? { satisfaction: entry.satisfaction }
                  : {}),
                ...(typeof entry.mount === 'string' ? { mount: entry.mount } : {}),
                ...(typeof entry.sessionId === 'string' ? { sessionId: entry.sessionId } : {}),
                ...(typeof entry.batteryDriven === 'boolean' ? { batteryDriven: entry.batteryDriven } : {}),
              };
            }
          }
          previousStates = restored;
        }
        for (const card of helpCards) {
          if (card.status === 'open' && (NEED_KEYS as readonly string[]).includes(card.need)) {
            const cur = previousStates[card.need];
            if (!cur?.driveActive) {
              previousStates[card.need] = {
                zone: card.severity === 'critical' ? 'critical' : 'uncomfortable',
                driveActive: true,
                satisfaction: card.severity === 'critical' ? 20 : 45,
              };
            }
          }
        }
        if (parsed.handledEpisodeSeverity && typeof parsed.handledEpisodeSeverity === 'object') {
          for (const key of NEED_KEYS) {
            const sev = parsed.handledEpisodeSeverity[key];
            if (sev === 'uncomfortable' || sev === 'critical') handledEpisodeSeverity.set(key, sev);
          }
        }
        if (parsed.criedEpisodeSeverity && typeof parsed.criedEpisodeSeverity === 'object') {
          for (const key of NEED_KEYS) {
            const sev = parsed.criedEpisodeSeverity[key];
            if (sev === 'uncomfortable' || sev === 'critical') criedEpisodeSeverity.set(key, sev);
          }
        } else if (Array.isArray(parsed.criedEpisodes)) {
          for (const k of parsed.criedEpisodes) {
            if ((NEED_KEYS as readonly string[]).includes(k)) {
              const hasCriticalCard = helpCards.some(
                (c) => c.need === k && c.status === 'open' && c.severity === 'critical',
              );
              const wasHandledCritical = handledEpisodeSeverity.get(k) === 'critical';
              const prevZone = previousStates[k]?.zone;
              const inferred: EpisodeSeverity =
                hasCriticalCard || wasHandledCritical || prevZone === 'critical' || prevZone !== 'uncomfortable'
                  ? 'critical'
                  : 'uncomfortable';
              criedEpisodeSeverity.set(k, inferred);
            }
          }
        }
        if (Array.isArray(parsed.internalSessionIds)) {
          for (const id of parsed.internalSessionIds.slice(-20)) {
            if (typeof id === 'string' && id.trim()) registerMaintSession(id);
          }
        }
        if (typeof parsed.maintTurnCount === 'number' && Number.isFinite(parsed.maintTurnCount)) {
          maintTurnCount = Math.max(0, Math.floor(parsed.maintTurnCount));
        }
        if (typeof parsed.maintTotalTurns === 'number' && Number.isFinite(parsed.maintTotalTurns)) {
          maintTotalTurns = Math.max(0, Math.floor(parsed.maintTotalTurns));
        }
        if (typeof parsed.maintLastRunAt === 'number' && Number.isFinite(parsed.maintLastRunAt)) {
          maintLastRunAt = parsed.maintLastRunAt;
        }
        if (typeof parsed.maintSessionId === 'string' && parsed.maintSessionId.trim()) {
          registerMaintSession(parsed.maintSessionId);
          if (ports.sessions.hasSession(parsed.maintSessionId)) {
            maintSessionId = parsed.maintSessionId;
            maintStatus = 'idle';
          }
        }
      } catch {
        // Fresh or unreadable state file
      }
      await scheduleProcess(ports.sense.snapshot());
      unsubscribeSense = ports.sense.subscribe((snap) => {
        void scheduleProcess(snap);
      });
      heartbeatTimer = setInterval(() => {
        if (!stopped && instinct.modelConnectivity() !== 'online') {
          void scheduleProcess(ports.sense.snapshot());
        }
      }, LIVENESS_HEARTBEAT_MS);
      heartbeatTimer.unref?.();
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      unsubscribeSense?.();
      unsubscribeSense = undefined;
      turnAbort.abort();
      turnAbort = new AbortController();
      higherOrderTurnAbort?.abort();
      higherOrderTurnAbort = undefined;
      activeRunningTier = null;
      instinct.stop();
      for (const unregister of internalSessions.values()) {
        unregister();
      }
      internalSessions.clear();
      await persistChain;
    },

    snapshot,
    senseSnapshot: () => ports.sense.snapshot(),
    factStaleInMs: (path: string) => ports.sense.factStaleInMs?.(path),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    registerMaintenanceSessionId(sessionId: string) {
      registerMaintSession(sessionId);
    },
    isMaintenanceSession: (sessionId: string) => internalSessions.has(sessionId),
    reportTransportResult(reachable: boolean, errorText?: string) {
      const changed = instinct.reportTransportResult(reachable, clock.wall(), errorText);
      if (changed) {
        void scheduleProcess(ports.sense.snapshot());
      }
    },
    tools,
    actions,
    drives,
  };
}
