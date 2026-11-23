/** 预览与测试用的确定性夹具；全部为编造数据，不含真实主机名/标题/凭据。 */

import type {
  BodyHistory,
  DisksFact,
  DiskVolume,
  Fact,
  FactStatus,
  InstinctState,
  MaintenanceSessionStatus,
  MetricPoint,
  NeedEvaluation,
  NeedKey,
  NeedsPanelModel,
  NeedZone,
  SenseState,
  SourceRef,
} from '../view-model';

export const T0 = 1_763_300_000_000;

export const src = (api: string): SourceRef => ({ id: api, api, host: 'demo-host' });

const LABELS: Record<NeedKey, string> = {
  energy: '能量',
  space: '空间',
  memory: '内存与进程',
  mind: '心智容量',
  thermals: '体温负荷',
};

export function fact<T>(
  value: T | null,
  opts: { status?: FactStatus; ageMs?: number; ttlMs?: number; reason?: string; api?: string } = {},
): Fact<T> {
  return {
    value,
    status: opts.status ?? 'ok',
    source: src(opts.api ?? 'demo'),
    observedAt: T0 - (opts.ageMs ?? 1_000),
    ttlMs: opts.ttlMs ?? 5_000,
    reason: opts.reason,
  };
}

export function emptyFact<T>(status: FactStatus, reason?: string): Fact<T> {
  return fact<T>(null, { status, reason });
}

export function disksFixture(value: DiskVolume[] | null, opts: Parameters<typeof fact>[1] = {}): DisksFact {
  return { ...fact(value, opts), kind: 'disks' };
}

export const denied = <T>(reason: string): Fact<T> => emptyFact<T>('denied', reason);

export function series(points: number, stepMs: number, fn: (i: number) => number): MetricPoint[] {
  return Array.from({ length: points }, (_, i) => ({
    at: T0 - (points - 1 - i) * stepMs,
    value: fn(i),
  }));
}

const sine = (base: number, amp: number, period: number) => (i: number) =>
  Math.max(0, Math.min(1, base + amp * Math.sin(i / period)));

export function makeHistory(over: Partial<BodyHistory> = {}): BodyHistory {
  return {
    cpu: series(60, 5_000, sine(0.35, 0.15, 9)),
    memory: series(60, 5_000, sine(0.6, 0.05, 14)),
    battery: series(60, 5_000, (i) => 78 - i * 0.04),
    thermal: series(60, 5_000, () => 0),
    networkRx: series(60, 5_000, (i) => 400_000 + 250_000 * Math.sin(i / 7)),
    networkTx: series(60, 5_000, (i) => 90_000 + 50_000 * Math.sin(i / 6)),
    processCpu: series(60, 5_000, sine(0.08, 0.04, 8)),
    processRss: series(60, 5_000, (i) => 480e6 + 20e6 * Math.sin(i / 12)),
    tokens: series(60, 5_000, (i) => 42_000 + i * 60),
    disks: {
      '/': series(60, 5_000, sine(0.62, 0.005, 20)),
      '/demo/vol': series(60, 5_000, sine(0.4, 0.004, 20)),
    },
    diskFree: {
      '/': series(60, 5_000, (i) => 175e9 - i * 50_000),
      '/demo/vol': series(60, 5_000, () => 72e9),
    },
    ...over,
  };
}

export function makeBody(): SenseState['self']['body'] {
  const battery = { percent: 76, charging: false, powerState: 'battery' as const, minutesLeft: 240 };
  return {
    cpu: fact({
      usage: 0.34,
      perCore: [0.3, 0.5, 0.28, 0.42, 0.36, 0.31, 0.4, 0.29],
      load1: 2.1,
      load5: 1.8,
      load15: 1.6,
    }),
    memory: fact({
      total: 32e9,
      used: 19.4e9,
      pressure: 'normal',
      swapUsed: 0.4e9,
      breakdown: { app: 11e9, wired: 5e9, compressed: 3.4e9, cached: 4e9 },
    }),
    disks: disksFixture([
      { mount: '/', total: 460e9, free: 175e9 },
      { mount: '/demo/vol', total: 120e9, free: 72e9 },
    ]),
    battery: fact(battery),
    thermal: fact('nominal'),
    network: fact({ online: true, rxBps: 512_000, txBps: 96_000 }),
    harnessProcess: fact({ rss: 512e6, cpu: 0.07, uptimeSec: 14_200 }),
    tokens: fact({
      contextWindow: 128_000,
      contextWindowSource: 'configured',
      contextUsed: 46_200,
      contextProjected: 52_800,
      sessionUsage: { input: 96_400, output: 12_800, cacheRead: 61_000, cacheWrite: 9_200 },
      balance: { amount: 12.34, currency: 'CNY', source: 'demo-provider' },
      compressionThreshold: 115_200,
      contextGrowthPerMinute: 720,
    }),
  };
}

export function makeState(over: Partial<SenseState> = {}): SenseState {
  const base: SenseState = {
    self: {
      activity: fact('tool'),
      pending: fact({ inbox: 2, jobs: 1 }),
      tools: fact(['env_state', 'env_detail', 'needs_status']),
      permissions: fact({ 辅助功能: 'granted' }),
      body: makeBody(),
    },
    env: {
      where: {
        model: fact({ provider: 'demo-provider', endpoint: 'http://127.0.0.1:3425/v1', local: true }),
        harness: fact({ host: 'demo-host', os: 'macOS 15.2', pid: 40210 }),
        observed: fact({ host: 'demo-host', userSession: 'gui/demo' }),
        toolExec: fact({ host: 'demo-host', cwd: '/demo/project' }),
      },
      frontApp: fact({ name: 'Terminal', bundleId: 'com.demo.terminal' }),
      focusedWindow: fact({ title: 'demo.ts — project' }),
      activeJobs: fact([{ id: 'job-1', name: 'pnpm test', owner: 'fixture-session', status: 'running' }]),
    },
    observation: {
      sources: {
        'macos-helper': { status: 'ok', lastSignalAt: T0 - 2_000 },
        'body-probe': { status: 'ok', lastSignalAt: T0 - 2_000 },
        'dsh-events': { status: 'ok', lastSignalAt: T0 - 1_000 },
      },
    },
  };
  return {
    self: { ...base.self, ...over.self },
    env: {
      ...base.env,
      ...over.env,
      where: { ...base.env.where, ...over.env?.where },
    },
    observation: { ...base.observation, ...over.observation },
  };
}

export function makeNeed(
  key: NeedKey,
  satisfaction: number,
  summary: string,
  over: Partial<NeedEvaluation> = {},
): NeedEvaluation {
  const clamped = Math.max(0, Math.min(100, Math.round(satisfaction)));
  const zone: NeedZone = clamped < 25 ? 'critical' : clamped < 60 ? 'uncomfortable' : 'comfortable';
  return {
    key,
    label: LABELS[key],
    satisfaction: clamped,
    urgency: 100 - clamped,
    zone,
    driveActive: zone !== 'comfortable',
    summary,
    evidence: {},
    updatedAt: T0,
    ...over,
  };
}

export function makeNeeds(over: Partial<Record<NeedKey, NeedEvaluation>> = {}): Record<NeedKey, NeedEvaluation> {
  return {
    energy: makeNeed('energy', 86, '电量 76% · 模型网关连通正常'),
    space: makeNeed('space', 88, '主卷剩余 163.0 GB（38%），空间充裕'),
    memory: makeNeed('memory', 82, '系统内存压力正常，DSH 占用 488 MB'),
    mind: makeNeed('mind', 78, '上下文余量 64%（剩余 81.8k）'),
    thermals: makeNeed('thermals', 92, '设备温度正常，CPU 负载平稳'),
    ...over,
  };
}

export function computeOverallZone(needs: Record<NeedKey, NeedEvaluation>): NeedZone {
  const vals = Object.values(needs);
  if (vals.some((n) => n.zone === 'critical')) return 'critical';
  if (vals.some((n) => n.zone === 'uncomfortable')) return 'uncomfortable';
  return 'comfortable';
}

export function makeInstinct(over: Partial<InstinctState> = {}): InstinctState {
  return {
    powerMode: 'normal',
    modelConnectivity: 'online',
    probeCount: 0,
    lastProbeAt: T0 - 5_000,
    ...over,
  };
}

export function makeMaintenanceSession(over: Partial<MaintenanceSessionStatus> = {}): MaintenanceSessionStatus {
  return {
    sessionId: 'maint-demo-1',
    title: 'ASI 自维护',
    status: 'idle',
    turnCount: 0,
    ...over,
  };
}

export function panelModel(state: SenseState, over: Partial<NeedsPanelModel> = {}): NeedsPanelModel {
  const needs = over.needs ?? makeNeeds();
  return {
    now: T0,
    paused: false,
    sendTitles: true,
    state,
    history: makeHistory(),
    needs,
    overallZone: over.overallZone ?? computeOverallZone(needs),
    instinct: makeInstinct(),
    maintenanceSession: makeMaintenanceSession(),
    helpCards: [],
    recentMaintenance: [],
    ...over,
  };
}
