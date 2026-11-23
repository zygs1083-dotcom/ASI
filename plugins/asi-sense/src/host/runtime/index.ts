import type { MetricKey, PowerMode, SenseSettingsSnapshot, SenseSnapshot } from '@asi/sense-types';
import { BodySource } from '../sources/body.ts';
import { DshSource } from '../sources/dsh.ts';
import { HelperSource } from '../sources/helper.ts';
import { boundedShutdown, guardActions } from './action-guard.ts';
import { SenseBus } from './bus.ts';
import {
  createChanges,
  createSnapshotListeners,
  createStateListeners,
  observableActions,
  settleShutdown,
} from './changes.ts';
import { FactExpiry } from './expiry.ts';
import type { SenseActions, SenseOptions, SensePorts } from './ports.ts';
import { createRingHistory } from './ring.ts';
import { Settings } from './settings.ts';
import { pauseAction, runtimeTools } from './tools.ts';

export type * from './ports.ts';

export function createSenseRuntime(ports: SensePorts, options: SenseOptions = {}) {
  const { clock } = ports;
  const platform = options.platform ?? process.platform;
  const normalIntervalMs = options.intervalMs ?? 2_000;
  const ecoIntervalMs = options.ecoIntervalMs ?? Math.max(10_000, normalIntervalMs * 5);
  const settings = new Settings(ports.storage);
  let running = false;
  let started = false;
  let generation = 0;
  let stopping: Promise<void> | undefined;
  let allowTitles = true;
  let titleIntent = 0;
  let paused = false;
  let powerMode: PowerMode = 'normal';
  let powerModeReason: string | undefined;
  const isPaused = () => paused;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextToken = Number.POSITIVE_INFINITY;

  const sampleIntervals = (): Partial<Record<MetricKey, number>> => {
    const base = powerMode === 'eco' ? ecoIntervalMs : normalIntervalMs;
    return {
      cpu: base,
      memory: Math.max(base, powerMode === 'eco' ? 15_000 : 4_000),
      battery: Math.max(base, powerMode === 'eco' ? 60_000 : 30_000),
      thermal: 30_000,
      networkRx: Math.max(base, powerMode === 'eco' ? 15_000 : 4_000),
      networkTx: Math.max(base, powerMode === 'eco' ? 15_000 : 4_000),
      processCpu: base,
      processRss: base,
      tokens: powerMode === 'eco' ? 15_000 : 5_000,
    };
  };

  const ring = createRingHistory({ thermal: 30_000 });
  const changes = createChanges();
  const snapshotListeners = createSnapshotListeners();
  const listeners = createStateListeners();
  const expiry = new FactExpiry(clock);

  const publishSnapshot = () => {
    if (generation !== 0 || !running) return;
    if (snapshotListeners.size > 0) {
      snapshotListeners.notify(buildSnapshot());
    }
  };

  const changed = () => {
    if (generation === 0) {
      changes.changed();
      publishSnapshot();
    }
  };

  const onChange = (listener: () => void) => (generation === 0 ? changes.subscribe(listener) : () => {});
  const check = (epoch = generation) => {
    if (stopping || epoch !== generation) throw new Error('stopped');
  };

  let helperRef: HelperSource | undefined;
  const bus = new SenseBus(clock, () => allowTitles && Boolean(helperRef?.titlesEnabled()), changed, expiry);

  const body = new BodySource(ports.probe, ports.dsh, clock, bus, expiry, isPaused, changed, (sample, at, mono) => {
    ring.record(sample, at, mono);
  });

  const dsh = new DshSource(ports.dsh, clock, bus, body, isPaused);

  const helper = new HelperSource(ports.helper, options.helperPath, platform, clock, bus, body, schedule, isPaused);
  helperRef = helper;

  const offStore = bus.store.subscribe((state) => {
    const projected = dsh.stateFor(bus.currentSessionId(), state);
    ring.record(projected.self.body, clock.wall(), clock.mono());
    listeners.notify(projected);
    schedule();
  });

  function getSettings(): SenseSettingsSnapshot {
    return {
      paused,
      sendTitles: allowTitles,
      powerMode,
      ...(powerModeReason !== undefined ? { powerModeReason } : {}),
    };
  }

  function buildSnapshot(sessionId?: string): SenseSnapshot {
    const now = clock.wall();
    const mono = clock.mono();
    const target = sessionId !== undefined && !bus.isInternalSession(sessionId) ? sessionId : bus.currentSessionId();
    const state = dsh.stateFor(target, bus.state());
    if (!(allowTitles && helper.titlesEnabled())) {
      state.env.focusedWindow.value = null;
    }
    ring.record(state.self.body, now, mono);
    return {
      now,
      mono,
      ...(bus.currentSessionId() !== undefined ? { activeSessionId: bus.currentSessionId() } : {}),
      state,
      history: ring.snapshot(mono),
      settings: getSettings(),
      sampleIntervalsMs: sampleIntervals(),
    };
  }

  function tokenPollMs(): number {
    return powerMode === 'eco' ? 15_000 : 5_000;
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!running) return;
    const deadline = Math.min(helper.nextDeadline() ?? Infinity, nextToken, expiry.next() ?? Infinity);
    if (!Number.isFinite(deadline)) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        void tick();
      },
      Math.max(0, deadline - clock.mono()),
    );
    timer.unref?.();
  }

  async function tick(): Promise<void> {
    if (!running) return;
    if (expiry.expire()) {
      listeners.notify(dsh.stateFor(bus.currentSessionId(), bus.state()));
      changed();
    }
    if (clock.mono() >= nextToken) {
      nextToken = clock.mono() + tokenPollMs();
      const session = bus.currentSessionId();
      if (session && !paused) void body.tokens(session, () => bus.currentSessionId() === session);
    }
    helper.tick();
    schedule();
  }

  const applyPause = pauseAction(
    settings,
    isPaused,
    async (value) => {
      paused = value;
      if (value) {
        schedule();
        dsh.setRefreshInterval(undefined);
        await settleShutdown([body.setPaused(true), helper.stop()]);
      } else {
        await body.setPaused(false);
        check();
        dsh.setRefreshInterval(powerMode === 'eco' ? 15_000 : 5_000);
        helper.start(settings.sendTitles);
        schedule();
      }
    },
    check,
  );

  const unguarded: SenseActions = {
    pause: async (value) => {
      await applyPause(value);
    },
    setSendTitles: async (enabled) => {
      const epoch = generation;
      const intent = ++titleIntent;
      if (!enabled) {
        allowTitles = false;
        helper.setTitles(false);
        changed();
      }
      await settings.update((draft) => {
        draft.sendTitles = enabled;
      });
      check(epoch);
      if (intent !== titleIntent) return;
      allowTitles = enabled;
      if (enabled) helper.setTitles(true);
      changed();
    },
    setPowerMode: async (mode, reason) => {
      const epoch = generation;
      check(epoch);
      const nextReason = mode === 'eco' ? reason : undefined;
      if (powerMode === mode && powerModeReason === nextReason) return;
      powerMode = mode;
      powerModeReason = nextReason;
      const targetInterval = mode === 'eco' ? ecoIntervalMs : normalIntervalMs;
      await body.setIntervalMs(targetInterval, mode === 'eco');
      check(epoch);
      if (!paused) {
        dsh.setRefreshInterval(mode === 'eco' ? 15_000 : 5_000);
      }
      schedule();
      changed();
    },
    openPermissionSettings: async () => {
      await ports.dsh.openPermissionSettings?.();
    },
  };

  const guarded = guardActions(unguarded, () => generation, check);
  const actions = observableActions(guarded.actions, changed);
  const tools = runtimeTools(bus, helper, () => allowTitles && helper.titlesEnabled(), ports.dsh, dsh);

  function stop(): Promise<void> {
    if (stopping) return stopping;
    generation++;
    started = true;
    running = false;
    if (timer) clearTimeout(timer);
    timer = undefined;
    const busStop = bus.stop();
    const callbacks = dsh.stop();
    offStore();
    listeners.clear();
    snapshotListeners.clear();
    changes.clear();
    const work = settleShutdown([busStop, callbacks, guarded.wait(), helper.stop(), body.stop(), settings.close()]);
    stopping = boundedShutdown(work);
    return stopping;
  }

  return {
    async start(): Promise<void> {
      if (started) throw new Error('runtime cannot be restarted');
      started = true;
      const epoch = generation;
      try {
        await settings.restore();
        check(epoch);
        allowTitles = settings.sendTitles;
        paused = settings.paused;
        await body.start(normalIntervalMs);
        check(epoch);
        running = true;
        dsh.start(paused ? undefined : 5_000);
        if (!paused) helper.start(settings.sendTitles);
        nextToken = clock.mono() + tokenPollMs();
        schedule();
        changed();
      } catch (error) {
        const stoppedEarly = epoch !== generation;
        await stop().catch(() => {});
        if (stoppedEarly) throw new Error('stopped');
        throw error;
      }
    },
    stop,
    currentSessionId: () => bus.currentSessionId(),
    state: () => dsh.stateFor(bus.currentSessionId(), bus.state()),
    snapshot: buildSnapshot,
    subscribeSnapshot: snapshotListeners.subscribe,
    factMeta: (path: string) => expiry.factMeta(path),
    subscribe: listeners.subscribe,
    onChange,
    recentSignals: () => bus.recentSignals(),
    getSettings,
    registerInternalSession: (id: string) => {
      const prev = bus.currentSessionId();
      const off = bus.registerInternalSession(id);
      if (prev !== bus.currentSessionId()) dsh.targetChanged();
      return () => {
        off();
        dsh.targetChanged();
      };
    },
    actions,
    tools,
  };
}
