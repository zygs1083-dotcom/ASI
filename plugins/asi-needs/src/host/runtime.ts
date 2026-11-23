import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
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
import { chooseCryDeliveryMode, formatCryMessage } from './cry.js';
import { evaluateNeeds, NEED_LABELS, type PreviousNeedState } from './evaluator.js';
import { InstinctController } from './instinct.js';
import type { NeedsHostPorts } from './ports.js';
import { cleanSafeCaches, compactIdleContexts, findStuckJobs, stopStuckJobs, upsertHelpCard } from './sandbox.js';

const AUTONOMOUS_COOLDOWN_MS = 120_000;
const MAX_AUTONOMOUS_TURNS_PER_HOUR = 6;
const MAX_MAINTAINER_TURNS_BEFORE_ROTATE = 12;
const MAX_RECORDS = 40;
const LIVENESS_HEARTBEAT_MS = 15_000;

interface PersistedNeedsState {
  helpCards?: HelpCard[];
  records?: MaintenanceRecord[];
  previousStates?: Partial<Record<NeedKey, PreviousNeedState>>;
  criedEpisodes?: NeedKey[];
  handledEpisodeSeverity?: Partial<Record<NeedKey, 'uncomfortable' | 'critical'>>;
  maintSessionId?: string;
  maintTurnCount?: number;
  maintTotalTurns?: number;
  maintLastRunAt?: number;
  internalSessionIds?: string[];
}

export interface MaintenanceToolsApi {
  statusSnapshot(): NeedsSnapshot;
  cleanCache(): Promise<{ deletedEntries: number; freedBytes: number; summary: string }>;
  stopStuckJob(jobId?: string): Promise<{ stoppedIds: string[]; refusedActiveIds: string[]; summary: string }>;
  compactContext(): Promise<{ compactedSessions: number; tokensSaved: number; summary: string }>;
  requestHelp(input: {
    need: NeedKey;
    severity?: 'uncomfortable' | 'critical';
    title: string;
    summary: string;
    proposedAction?: string;
    actionKind?: HelpActionKind;
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
}

export function createNeedsRuntime(ports: NeedsHostPorts): NeedsRuntime {
  const clock = ports.clock ?? { wall: () => Date.now(), mono: () => performance.now() };
  const statePath = join(ports.storageRoot, 'state.json');
  const sandboxDir = join(ports.storageRoot, 'sandbox');

  const instinct = new InstinctController(ports.sense, ports.probeEndpoint);
  const listeners = new Set<() => void>();
  const internalSessions = new Map<string, () => void>();
  const criedEpisodes = new Set<NeedKey>();
  const handledEpisodeSeverity = new Map<NeedKey, 'uncomfortable' | 'critical'>();
  const autonomousTurnMonoTimes: number[] = [];

  let helpCards: HelpCard[] = [];
  let records: MaintenanceRecord[] = [];
  let previousStates: Partial<Record<NeedKey, PreviousNeedState>> = {};
  const escalatedCriticalInTurn = new Set<NeedKey>();

  let maintSessionId: string | undefined;
  let maintStatus: MaintenanceSessionStatus['status'] = 'not-created';
  let maintTurnCount = 0;
  let maintTotalTurns = 0;
  let maintLastRunAt: number | undefined;
  let lastAutoRunMono: number | undefined;
  let rotateMaintainerNext = false;

  let latestSense: SenseSnapshot = ports.sense.snapshot();
  let latestEval = evaluateNeeds({
    snapshot: latestSense,
    modelConnectivity: instinct.modelConnectivity(),
    stuckJobCount: 0,
  });

  let started = false;
  let stopped = false;
  let unsubscribeSense: (() => void) | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let turnAbort = new AbortController();
  let persistChain: Promise<void> = Promise.resolve();
  let reconcileInFlight: Promise<void> | undefined;

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
      criedEpisodes: [...criedEpisodes],
      handledEpisodeSeverity: Object.fromEntries(handledEpisodeSeverity),
      ...(maintSessionId ? { maintSessionId } : {}),
      maintTurnCount,
      maintTotalTurns,
      ...(maintLastRunAt !== undefined ? { maintLastRunAt } : {}),
      internalSessionIds: [...internalSessions.keys()].slice(-20),
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
      action: entry.action,
      summary: entry.summary,
      outcome: entry.outcome,
    };
    records = [rec, ...records].slice(0, MAX_RECORDS);
    void persistState();
  }

  function registerMaintSession(id: string): void {
    if (internalSessions.has(id)) return;
    const unregister = ports.sense.registerInternalSession(id);
    internalSessions.set(id, unregister);
  }

  function isAutoHelpSuppressed(need: NeedKey, severity: 'uncomfortable' | 'critical'): boolean {
    const handled = handledEpisodeSeverity.get(need);
    if (!handled) return false;
    return handled === 'critical' || severity === 'uncomfortable';
  }

  async function ensureMaintenanceSession(forceRotate = false): Promise<string> {
    if (!forceRotate && maintSessionId && ports.sessions.hasSession(maintSessionId)) {
      return maintSessionId;
    }
    await mkdir(sandboxDir, { recursive: true });
    const requested = `asi-maint-${randomUUID()}`;
    registerMaintSession(requested);
    try {
      const createdId = await ports.sessions.createMaintenanceSession(requested, sandboxDir, 'ASI 自维护');
      if (createdId !== requested) {
        const dropRequested = internalSessions.get(requested);
        dropRequested?.();
        internalSessions.delete(requested);
        registerMaintSession(createdId);
      }
      maintSessionId = createdId;
      maintTurnCount = 0;
      if (maintStatus === 'not-created' || maintStatus === 'unavailable') {
        maintStatus = 'idle';
      }
      void persistState();
      notify();
      return createdId;
    } catch (err) {
      const unregister = internalSessions.get(requested);
      unregister?.();
      internalSessions.delete(requested);
      maintStatus = 'unavailable';
      notify();
      throw err;
    }
  }

  async function deliverCryIfNeeded(card: HelpCard): Promise<boolean> {
    if (criedEpisodes.has(card.need)) return false;
    const exclude = new Set(internalSessions.keys());
    const mode = chooseCryDeliveryMode(instinct.modelConnectivity());
    const delivered = await ports.sessions
      .deliverCryToUserSession(latestSense.activeSessionId, exclude, formatCryMessage(card), mode)
      .catch(() => false);
    if (delivered) {
      criedEpisodes.add(card.need);
    }
    return delivered;
  }

  async function raiseHelp(input: {
    need: NeedKey;
    severity: 'uncomfortable' | 'critical';
    title: string;
    summary: string;
    proposedAction?: string;
    actionKind?: HelpActionKind;
  }): Promise<{ card: HelpCard; deliveredCry: boolean }> {
    const res = upsertHelpCard(helpCards, { ...input, now: clock.wall() });
    helpCards = res.cards;
    await persistState();
    const deliveredCry = await deliverCryIfNeeded(res.card);
    notify();
    return { card: res.card, deliveredCry };
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
      if (!ev.driveActive) {
        criedEpisodes.delete(key);
        handledEpisodeSeverity.delete(key);
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
      const gatewayOffline = instinct.modelConnectivity() === 'offline';

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

  function hasSoftwareActionableDistress(): NeedKey[] {
    return latestEval.activeDrives.filter((key) => {
      if (key === 'energy') return false;
      const ev = latestEval.needs[key];
      return ev.zone === 'uncomfortable' || ev.zone === 'critical';
    });
  }

  function buildMaintenancePrompt(distressedKeys: readonly NeedKey[]): string {
    const lines = [
      '你是 ASI 的后台自维护模块。当前检测到以下生存需求处于不适或危急状态，请在安全沙盒内诊断并尝试自救：',
      '',
    ];
    for (const key of distressedKeys) {
      const ev = latestEval.needs[key];
      const safeSummary = sanitizeForModel(ev.summary);
      const safeEvidence = sanitizeForModel(JSON.stringify(ev.evidence));
      lines.push(
        `- [${NEED_LABELS[key]} | ${ev.zone} | 满足度 ${ev.satisfaction}%]: ${safeSummary} (证据: ${safeEvidence})`,
      );
    }
    lines.push(
      '',
      '执行准则：',
      '1. 仅使用你的只读查询工具（needs_status / env_state / env_detail）与白名单维护工具（needs_clean_cache / needs_stop_job / needs_compact_context）。',
      '2. 严禁尝试删除用户文件、结束正常业务任务或修改系统配置。',
      '3. 若安全自救后仍无法缓解，或问题源于用户目录大文件/外部进程/系统权限边界，请调用 needs_request_help 提交简洁清晰的求助卡，随后结束本轮。',
    );
    return lines.join('\n');
  }

  async function runMaintenanceCheck(manual: boolean): Promise<void> {
    if (stopped || latestSense.settings.paused) return;
    if (maintStatus === 'running') return;
    if (instinct.modelConnectivity() === 'offline') return;

    const distressed = manual
      ? NEED_KEYS.filter((k) => latestEval.needs[k].driveActive)
      : hasSoftwareActionableDistress();
    if (!manual && distressed.length === 0) return;

    const monoNow = clock.mono();
    while (autonomousTurnMonoTimes[0] !== undefined && monoNow - autonomousTurnMonoTimes[0] > 3_600_000) {
      autonomousTurnMonoTimes.shift();
    }

    if (!manual) {
      const newlyCritical = distressed.some(
        (k) => latestEval.needs[k].zone === 'critical' && !escalatedCriticalInTurn.has(k),
      );
      if (!newlyCritical && lastAutoRunMono !== undefined && monoNow - lastAutoRunMono < AUTONOMOUS_COOLDOWN_MS) {
        return;
      }
      if (autonomousTurnMonoTimes.length >= MAX_AUTONOMOUS_TURNS_PER_HOUR) {
        for (const key of distressed) {
          const ev = latestEval.needs[key];
          if (ev.zone === 'critical' && !isAutoHelpSuppressed(key, 'critical')) {
            await raiseHelp({
              need: key,
              severity: 'critical',
              title: `${NEED_LABELS[key]}持续危急，后台自救已达每小时上限`,
              summary: ev.summary,
              proposedAction: '后台安全维护未能解除压力，请人工介入检查。',
              actionKind: 'acknowledge',
            });
          }
        }
        return;
      }
    }

    const targetKeys = distressed.length > 0 ? distressed : (['space', 'memory', 'mind'] as NeedKey[]);
    const beforeSat = Object.fromEntries(targetKeys.map((k) => [k, latestEval.needs[k].satisfaction]));
    for (const k of targetKeys) {
      if (latestEval.needs[k].zone === 'critical') escalatedCriticalInTurn.add(k);
    }

    const shouldRotate = rotateMaintainerNext || maintTurnCount >= MAX_MAINTAINER_TURNS_BEFORE_ROTATE;
    rotateMaintainerNext = false;

    let sessionId: string;
    try {
      sessionId = await ensureMaintenanceSession(shouldRotate);
    } catch {
      return;
    }

    maintStatus = 'running';
    maintLastRunAt = clock.wall();
    if (!manual) {
      lastAutoRunMono = monoNow;
      autonomousTurnMonoTimes.push(monoNow);
    }
    notify();

    try {
      const prompt =
        manual && distressed.length === 0
          ? '用户触发了一次手动生存需求自检。请调用 needs_status 查看五大生存需求现状，确认各项舒适或执行必要的安全整理后简要总结。'
          : buildMaintenancePrompt(targetKeys);

      await ports.sessions.runMaintenanceTurn(sessionId, prompt, turnAbort.signal);
      maintTurnCount += 1;
      maintTotalTurns += 1;
      maintStatus = 'idle';

      await ports.sense.refresh?.().catch(() => undefined);
      recomputeEval(ports.sense.snapshot());

      const primaryNeed = targetKeys[0];
      let outcome: MaintenanceOutcome = 'info';
      if (distressed.length > 0) {
        const allCleared = distressed.every((k) => !latestEval.needs[k].driveActive);
        const anyImproved = distressed.some((k) => latestEval.needs[k].satisfaction > (beforeSat[k] ?? 0));
        const stillCritical = distressed.filter((k) => latestEval.needs[k].zone === 'critical');

        for (const critKey of stillCritical) {
          const hasOpenCard = helpCards.some((c) => c.need === critKey && c.status === 'open');
          if (!hasOpenCard && !isAutoHelpSuppressed(critKey, 'critical')) {
            await raiseHelp({
              need: critKey,
              severity: 'critical',
              title: `${NEED_LABELS[critKey]}自救后仍处危急，需人工协助`,
              summary: latestEval.needs[critKey].summary,
              proposedAction: '白名单自维护动作未能彻底解除危急状态，请人工排查外部占用或扩容。',
              actionKind: 'acknowledge',
            });
          } else {
            const openCard = helpCards.find((c) => c.need === critKey && c.status === 'open');
            if (openCard) await deliverCryIfNeeded(openCard);
          }
        }

        outcome = allCleared ? 'relieved' : stillCritical.length > 0 ? 'escalated' : anyImproved ? 'partial' : 'info';
      }

      addRecord({
        actor: 'maintainer',
        ...(primaryNeed ? { need: primaryNeed } : {}),
        action: manual ? 'manual-check' : 'auto-maintain',
        summary:
          outcome === 'relieved'
            ? '后台自维护完成，相关生存需求已恢复舒适区'
            : outcome === 'escalated'
              ? '后台自维护触及安全边界或仍处危急，已发出求助卡'
              : '后台自维护巡检已完成',
        outcome,
      });
    } catch {
      maintStatus = 'idle';
      addRecord({
        actor: 'maintainer',
        ...(targetKeys[0] ? { need: targetKeys[0] } : {}),
        action: 'auto-maintain',
        summary: '后台自维护会话执行中断，稍后按退避策略重试',
        outcome: 'failed',
      });
    } finally {
      notify();
    }
  }

  async function processSnapshot(snap: SenseSnapshot): Promise<void> {
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
    if (!latestSense.settings.paused && latestSense.activeSessionId) {
      for (const openCard of helpCards) {
        if (openCard.status === 'open' && !criedEpisodes.has(openCard.need)) {
          await deliverCryIfNeeded(openCard);
        }
      }
    }
    notify();

    if (!latestSense.settings.paused) {
      void runMaintenanceCheck(false);
    }
  }

  function scheduleProcess(snap: SenseSnapshot): Promise<void> {
    const next = (reconcileInFlight ?? Promise.resolve()).then(
      () => processSnapshot(snap),
      () => processSnapshot(snap),
    );
    reconcileInFlight = next;
    return next;
  }

  function snapshot(): NeedsSnapshot {
    const settings = ports.sense.getSettings();
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
      },
      records: structuredClone(records),
    };
  }

  const tools: MaintenanceToolsApi = {
    statusSnapshot: () => snapshot(),

    async cleanCache() {
      const now = clock.wall();
      const res = await cleanSafeCaches({
        needsStorageRoot: ports.storageRoot,
        senseStorageRoot: ports.sense.storageRoot,
        now,
      });
      const mb = (res.freedBytes / 1024 ** 2).toFixed(1);
      const summary =
        res.deletedEntries > 0
          ? `清理白名单临时缓存 ${res.deletedEntries} 项，释放 ${mb} MB`
          : '白名单临时缓存目录已干净，无可清理项';
      addRecord({
        actor: 'maintainer',
        need: 'space',
        action: 'needs_clean_cache',
        summary,
        outcome: res.deletedEntries > 0 ? 'partial' : 'info',
      });
      notify();
      return { deletedEntries: res.deletedEntries, freedBytes: res.freedBytes, summary };
    },

    async stopStuckJob(jobId?: string) {
      const res = stopStuckJobs({
        jobsPort: ports.jobs,
        now: clock.wall(),
        ...(jobId ? { targetJobId: jobId } : {}),
      });
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
        outcome: res.stoppedIds.length > 0 ? 'partial' : 'info',
      });
      notify();
      return { ...res, summary };
    },

    async compactContext() {
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
      const summary =
        res.compactedSessions > 0 || res.rotatedMaintainer
          ? `整理空闲会话 ${res.compactedSessions} 个（释放约 ${res.tokensSaved} tokens）${res.rotatedMaintainer ? '，并标记自维护会话轮换' : ''}`
          : '当前无处于空闲且需要压缩的会话';
      addRecord({
        actor: 'maintainer',
        need: 'mind',
        action: 'needs_compact_context',
        summary,
        outcome: res.compactedSessions > 0 || res.rotatedMaintainer ? 'relieved' : 'info',
      });
      await ports.sense.refresh?.().catch(() => undefined);
      notify();
      return { compactedSessions: res.compactedSessions, tokensSaved: res.tokensSaved, summary };
    },

    async requestHelp(input) {
      const severity =
        input.severity ?? (latestEval.needs[input.need].zone === 'critical' ? 'critical' : 'uncomfortable');
      const result = await raiseHelp({
        need: input.need,
        severity,
        title: input.title,
        summary: input.summary,
        ...(input.proposedAction ? { proposedAction: input.proposedAction } : {}),
        ...(input.actionKind ? { actionKind: input.actionKind } : {}),
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
      await ports.sense.setPaused(paused);
      recomputeEval(ports.sense.snapshot());
      notify();
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
      let actionSummary = `用户确认处理：${card.title}`;
      if (card.actionKind === 'clean-cache') {
        const cleaned = await cleanSafeCaches({
          needsStorageRoot: ports.storageRoot,
          senseStorageRoot: ports.sense.storageRoot,
          now,
        });
        actionSummary = `用户批准清理缓存，删除 ${cleaned.deletedEntries} 项`;
      } else if (card.actionKind === 'stop-stuck-jobs') {
        const stoppedJobs = stopStuckJobs({
          jobsPort: ports.jobs,
          now,
          ...(card.actionTarget ? { targetJobId: card.actionTarget } : {}),
        });
        actionSummary = `用户批准结束卡死任务（${stoppedJobs.stoppedIds.length} 个）`;
      } else if (card.actionKind === 'compact-context') {
        const compacted = await compactIdleContexts({
          compactionPort: ports.compaction,
          excludeSessionIds: new Set(internalSessions.keys()),
          signal: turnAbort.signal,
        });
        actionSummary = `用户批准整理上下文（${compacted.compactedSessions} 个空闲会话）`;
      } else if (card.actionKind === 'enable-eco') {
        await ports.sense.setPowerMode('eco', '用户批准节能模式');
        actionSummary = '用户批准进入节能降频模式';
      } else if (card.actionKind === 'open-permissions') {
        await ports.sense.openPermissionSettings();
        actionSummary = '用户打开系统权限设置';
      }

      criedEpisodes.add(card.need);
      handledEpisodeSeverity.set(card.need, card.severity);
      helpCards = helpCards.map((c) => (c.id === cardId ? { ...c, status: 'approved', updatedAt: now } : c));
      addRecord({
        actor: 'user',
        need: card.need,
        action: card.actionKind,
        summary: actionSummary,
        outcome: 'relieved',
      });
      await ports.sense.refresh?.().catch(() => undefined);
      await persistState();
      await scheduleProcess(ports.sense.snapshot());
    },

    async dismissHelp(cardId: string) {
      const card = helpCards.find((c) => c.id === cardId);
      if (card?.status !== 'open') return;
      const now = clock.wall();
      criedEpisodes.add(card.need);
      handledEpisodeSeverity.set(card.need, card.severity);
      helpCards = helpCards.map((c) => (c.id === cardId ? { ...c, status: 'dismissed', updatedAt: now } : c));
      await persistState();
      notify();
    },

    async openMaintenanceSession() {
      return await ensureMaintenanceSession(false);
    },

    async triggerCheck() {
      await scheduleProcess(ports.sense.snapshot());
      await runMaintenanceCheck(true);
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
        if (Array.isArray(parsed.criedEpisodes)) {
          for (const k of parsed.criedEpisodes) {
            if ((NEED_KEYS as readonly string[]).includes(k)) criedEpisodes.add(k);
          }
        }
        if (parsed.handledEpisodeSeverity && typeof parsed.handledEpisodeSeverity === 'object') {
          for (const key of NEED_KEYS) {
            const sev = parsed.handledEpisodeSeverity[key];
            if (sev === 'uncomfortable' || sev === 'critical') handledEpisodeSeverity.set(key, sev);
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
  };
}
