import type {
  AsiSenseServiceApi,
  BodyHistory,
  Fact,
  FactStatus,
  PowerMode,
  SenseSettingsSnapshot,
  SenseSnapshot,
  SenseState,
  SourceRef,
} from '@asi/sense-types';

export const T0 = 1_763_300_000_000;

export function demoSrc(api = 'demo'): SourceRef {
  return { id: api, api, host: 'demo-host' };
}

export function fact<T>(
  value: T,
  opts: { status?: FactStatus; observedAt?: number; ttlMs?: number; reason?: string; api?: string } = {},
): Fact<T> {
  return {
    value,
    status: opts.status ?? 'ok',
    source: demoSrc(opts.api),
    observedAt: opts.observedAt ?? T0 - 1_000,
    ttlMs: opts.ttlMs ?? 30_000,
    ...(opts.reason ? { reason: opts.reason } : {}),
  };
}

export function emptyHistory(over: Partial<BodyHistory> = {}): BodyHistory {
  return {
    cpu: [],
    memory: [],
    battery: [],
    thermal: [],
    networkRx: [],
    networkTx: [],
    processCpu: [],
    processRss: [],
    tokens: [],
    disks: {},
    diskFree: {},
    ...over,
  };
}

export function makeCalmState(): SenseState {
  return {
    self: {
      activity: fact('idle'),
      pending: fact({ inbox: 0, jobs: 0 }),
      tools: fact(['env_state', 'env_detail', 'needs_status']),
      permissions: fact({ accessibility: 'granted' }),
      body: {
        cpu: fact({ usage: 0.25, perCore: [0.2, 0.3], load1: 1.2, load5: 1.1, load15: 1.0 }),
        memory: fact({
          total: 32 * 1024 ** 3,
          used: 16 * 1024 ** 3,
          pressure: 'normal',
          swapUsed: 0,
        }),
        disks: {
          kind: 'disks',
          ...fact([{ mount: '/', total: 500 * 1024 ** 3, free: 200 * 1024 ** 3 }]),
        },
        battery: fact({ percent: 82, charging: false, powerState: 'battery', minutesLeft: 240 }),
        thermal: fact('nominal'),
        network: fact({ online: true, rxBps: 10_000, txBps: 4_000 }),
        harnessProcess: fact({ rss: 400 * 1024 ** 2, cpu: 0.05, uptimeSec: 3600 }),
        tokens: fact({
          contextWindow: 128_000,
          contextWindowSource: 'configured',
          contextUsed: 32_000,
          sessionUsage: { input: 40_000, output: 8_000, cacheRead: 20_000, cacheWrite: 4_000 },
        }),
      },
    },
    env: {
      where: {
        model: fact({ provider: 'demo', endpoint: 'http://127.0.0.1:3425', local: true }),
        harness: fact({ host: 'demo-host', os: 'darwin', pid: 1234 }),
        observed: fact({ host: 'demo-host', userSession: 'console' }),
        toolExec: fact({ host: 'demo-host', cwd: '~' }),
      },
      frontApp: fact({ name: 'Editor', bundleId: 'com.demo.editor' }),
      focusedWindow: fact({ title: 'notes.md' }),
      activeJobs: fact([]),
    },
    observation: {
      sources: {
        'body-probe': { status: 'ok', lastSignalAt: T0 - 1_000 },
      },
    },
  };
}

export function makeSnapshot(over: Partial<SenseSnapshot> = {}): SenseSnapshot {
  return {
    now: T0,
    mono: 10_000,
    activeSessionId: 'user-session-1',
    state: makeCalmState(),
    history: emptyHistory(),
    settings: {
      paused: false,
      sendTitles: true,
      powerMode: 'normal',
    },
    sampleIntervalsMs: { cpu: 2_000, thermal: 30_000 },
    ...over,
  };
}

export function createMockSenseService(initial?: Partial<SenseSnapshot>, storageRoot?: string) {
  let current = makeSnapshot(initial);
  const listeners = new Set<(snap: SenseSnapshot) => void>();
  const internalIds = new Set<string>();

  const api: AsiSenseServiceApi & {
    emit(patch: Partial<SenseSnapshot> | ((prev: SenseSnapshot) => SenseSnapshot)): void;
    internalSessions(): ReadonlySet<string>;
  } = {
    storageRoot,
    snapshot: () => structuredClone(current),
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    getSettings(): SenseSettingsSnapshot {
      return { ...current.settings };
    },
    async setPaused(paused: boolean) {
      current = { ...current, settings: { ...current.settings, paused } };
      for (const fn of [...listeners]) fn(structuredClone(current));
    },
    async setSendTitles(sendTitles: boolean) {
      current = { ...current, settings: { ...current.settings, sendTitles } };
      for (const fn of [...listeners]) fn(structuredClone(current));
    },
    async setPowerMode(powerMode: PowerMode, reason?: string) {
      current = {
        ...current,
        settings: {
          ...current.settings,
          powerMode,
          ...(powerMode === 'eco' && reason ? { powerModeReason: reason } : { powerModeReason: undefined }),
        },
      };
    },
    async openPermissionSettings() {},
    registerInternalSession(id: string) {
      internalIds.add(id);
      return () => {
        internalIds.delete(id);
      };
    },
    recentSignals: () => [],
    emit(patch) {
      current = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
      for (const fn of [...listeners]) fn(structuredClone(current));
    },
    internalSessions: () => internalIds,
  };
  return api;
}
