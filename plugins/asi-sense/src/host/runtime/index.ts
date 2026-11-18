import type { WatchRule } from '@asi/sense-types';
import { BodySource } from '../sources/body.ts';
import { DshSource } from '../sources/dsh.ts';
import { FileSource } from '../sources/files.ts';
import { HelperSource } from '../sources/helper.ts';
import { boundedShutdown, guardActions } from './action-guard.ts';
import { RuntimeAttention } from './attention.ts';
import { createChanges, createStateListeners, observableActions, settleShutdown } from './changes.ts';
import { deliveryRetry } from './delivery-retry.ts';
import { FactExpiry } from './expiry.ts';
import { HistoryManager } from './history/index.ts';
import type { SenseActions, SenseOptions, SensePorts } from './ports.ts';
import { createSessionTarget } from './session-target.ts';
import { Settings } from './settings.ts';
import { pauseAction, runtimeTools } from './tools.ts';

export type { EventEntry, EventLog } from './attention.ts';
export type * from './ports.ts';
export function createSenseRuntime(ports: SensePorts, options: SenseOptions = {}) {
  if (
    options.selfCauseGraceMs !== undefined &&
    (!Number.isFinite(options.selfCauseGraceMs) || options.selfCauseGraceMs < 0)
  )
    throw new TypeError('selfCauseGraceMs must be a non-negative finite number');
  const { clock } = ports;
  const settings = new Settings(ports.storage, options.rules);
  let running = false;
  let started = false;
  let generation = 0;
  let stopping: Promise<void> | undefined;
  let allowTitles = true;
  let titleIntent = 0;
  let paused = false;
  const isPaused = () => paused;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextToken = Number.POSITIVE_INFINITY;
  let retryAfter = 0;
  let installed = settings.enabled().map((rule) => rule.id);
  const changes = createChanges();
  const changed = () => {
    if (generation === 0) changes.changed();
  };
  const onChange = (listener: () => void) => (generation === 0 ? changes.subscribe(listener) : () => {});
  const check = (epoch = generation) => {
    if (stopping || epoch !== generation) throw new Error('stopped');
  };
  const expiry = new FactExpiry(clock);
  const deliveryPort = deliveryRetry(ports.dsh, clock, () => attention);
  let attentionRef: RuntimeAttention | undefined;
  const history = new HistoryManager({
    port: ports.history,
    clock,
    isPaused,
    titlesAllowed: () => allowTitles,
    restoreEntries: (entries) => attentionRef?.restoreEntries(entries),
    clearMemoryEntries: () => attentionRef?.clearEvents(),
    emitSourceError: (error, extra) => {
      if (!attentionRef || stopping) return;
      void attentionRef
        .accept({
          id: attentionRef.id(),
          kind: 'source.error',
          at: clock.wall(),
          source: { id: 'history', api: 'storage', host: 'local' },
          subject: 'history',
          data: { status: 'error', error, reason: error, ...extra },
        })
        .catch(() => {});
    },
    emitSourceOk: () => {
      if (!attentionRef || stopping) return;
      void attentionRef
        .accept({
          id: attentionRef.id(),
          kind: 'source.status',
          at: clock.wall(),
          source: { id: 'history', api: 'storage', host: 'local' },
          subject: 'history',
          data: { status: 'ok' },
        })
        .catch(() => {});
    },
    timeZone: options.timeZone,
  });
  const attention = new RuntimeAttention(
    clock,
    deliveryPort,
    () => settings.enabled(),
    schedule,
    () => allowTitles && helper.titlesEnabled(),
    changed,
    expiry,
    () => target.ensure(),
    () => target.canEnsure(),
    history,
  );
  attentionRef = attention;
  const listeners = createStateListeners();
  const body = new BodySource(ports.probe, ports.dsh, ports.storage, clock, attention, expiry, isPaused, changed);
  const dsh = new DshSource(deliveryPort, clock, attention, body, isPaused, options.selfCauseGraceMs, (id) => {
    target.unload(id);
    attention.rescheduleDelivery();
  });
  const target = createSessionTarget(
    ports.dsh,
    ports.storage,
    options.targetStorageKey ?? 'session-target',
    async (id) => {
      const transfer = attention.setTarget(id);
      ports.dsh.selectDeliveryTarget?.(attention.currentSessionId());
      await transfer;
      dsh.targetChanged();
    },
    () => attention.recordTargetReset(),
    changed,
    {
      closed: async (id) => {
        await attention.closeSession(id);
        ports.dsh.selectDeliveryTarget?.(attention.currentSessionId());
        dsh.targetChanged();
      },
      refreshed: (rows) => attention.availableSessions(rows.map((row) => row.id)),
    },
  );
  const offStore = attention.store.subscribe((state) => {
    listeners.notify(dsh.stateFor(attention.currentSessionId(), state));
    schedule();
  });
  const files = new FileSource(
    ports.files,
    clock,
    attention,
    dsh,
    () => settings.enabled(),
    isPaused,
    (signal, dirs) => body.burst(signal, dirs),
    (scopes) => body.setScopes(scopes),
  );
  const helper = new HelperSource(
    ports.helper,
    options.helperPath,
    options.platform ?? process.platform,
    clock,
    attention,
    body,
    schedule,
    isPaused,
  );
  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!running) return;
    const due = paused ? undefined : attention.pipeline.nextDeadline();
    const deadline = Math.min(
      due === undefined ? Infinity : Math.max(due, retryAfter),
      helper.nextDeadline() ?? Infinity,
      nextToken,
      expiry.next() ?? Infinity,
      attention.pipeline.retentionDeadline() ?? Infinity,
      history.nextDeadline() ?? Infinity,
    );
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
      listeners.notify(dsh.stateFor(attention.currentSessionId(), attention.state()));
      changed();
    }
    if (clock.mono() >= nextToken) {
      nextToken = clock.mono() + 5_000;
      const session = attention.current();
      if (session && !paused) void body.tokens(session, () => attention.currentSessionId() === session);
    }
    helper.tick();
    attention.pipeline.pruneSessions();
    const due = attention.pipeline.nextDeadline();
    if (!paused && due !== undefined && due <= clock.mono() && clock.mono() >= retryAfter) {
      retryAfter = clock.mono() + 250;
      await attention.flush().catch(() => {});
    }
    await history.tick();
    schedule();
  }
  async function syncRules(): Promise<void> {
    for (const id of installed) attention.pipeline.removeRule(id);
    const rules = settings.enabled();
    for (const rule of rules) attention.pipeline.addRule(rule);
    installed = rules.map((rule) => rule.id);
    if (running) await files.refresh();
  }
  async function update(change: Parameters<Settings['update']>[0]): Promise<void> {
    const epoch = generation;
    check(epoch);
    await settings.update(change);
    check(epoch);
    await syncRules();
    changed();
  }
  function ruleChange(id: string, change: (rule: WatchRule) => void): Promise<void> {
    return update((draft) => {
      const rule = draft.rules.find((item) => item.id === id);
      if (!rule) throw new Error('unknown rule');
      change(rule);
    });
  }
  const applyPause = pauseAction(
    settings,
    isPaused,
    async (value) => {
      paused = value;
      if (value) {
        schedule();
        await settleShutdown([body.setPaused(true), files.refresh(), helper.stop()]);
      } else {
        await body.setPaused(false);
        check();
        await files.refresh();
        check();
        helper.start(settings.sendTitles);
        schedule();
      }
    },
    check,
  );
  const unguarded: SenseActions = {
    selectTarget: (id) => target.select(id),
    dismissTargetNotice: async () => target.dismiss(),
    toggleRule: (id, enabled) =>
      update((draft) => {
        if (!draft.rules.some((rule) => rule.id === id)) throw new Error('unknown rule');
        draft.disabled = draft.disabled.filter((item) => item !== id);
        if (!enabled) draft.disabled.push(id);
      }),
    confirmRule: (id) =>
      ruleChange(id, (rule) => {
        rule.approved = true;
      }),
    deleteRule: (id) =>
      update((draft) => {
        if (!draft.rules.some((rule) => rule.id === id)) throw new Error('unknown rule');
        draft.rules = draft.rules.filter((rule) => rule.id !== id);
        draft.disabled = draft.disabled.filter((item) => item !== id);
      }),
    pause: async (value) => {
      await applyPause(value);
      history.setPaused(paused);
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
    },
    openPermissionSettings: async () => {
      await ports.dsh.openPermissionSettings?.();
    },
    revertTuning: (id) =>
      body.asUser(async () => {
        const result = await body.tuner.revert(id);
        body.sync();
        return result;
      }),
    lockParam: (param, locked) => body.asUser(() => (locked ? body.tuner.lock(param) : body.tuner.unlock(param))),
    feedback: (id, verdict) =>
      body.asUser(async () => {
        const result = await body.tuner.feedback(id, verdict);
        if (result.applied) attention.feedback(id, verdict);
        return result;
      }),
    acceptRebaseline: (id) =>
      body.asUser(async () => {
        const result = await body.monitor.acceptRebaseline(id);
        body.sync();
        return result;
      }),
    resumeTuning: () => body.asUser(() => body.tuner.resumeTuning()),
    resetTuning: () => body.asUser(() => body.tuner.resetTuning()),
    retryTuningBackup: () =>
      body.asUser(async () => {
        await body.monitor.retryBackup();
        body.sync();
      }),
    dismissTuningBackup: () => body.asUser(() => body.monitor.dismissBackup()),
  };
  const guarded = guardActions(unguarded, () => generation, check);
  const actions = guarded.actions;
  const tools = {
    ...runtimeTools(
      attention,
      body,
      settings,
      actions,
      files,
      helper,
      syncRules,
      check,
      () => allowTitles,
      changed,
      deliveryPort,
      dsh,
    ),
    envHistory: (params?: Parameters<HistoryManager['query']>[0]) => history.query(params),
    envSummary: (params?: Parameters<HistoryManager['summary']>[0]) => history.summary(params),
  };
  function stop(): Promise<void> {
    if (stopping) return stopping;
    generation++;
    started = true;
    running = false;
    if (timer) clearTimeout(timer);
    timer = undefined;
    const deliveries = attention.stop();
    const targeting = target.stop();
    const callbacks = dsh.stop();
    offStore();
    listeners.clear();
    changes.clear();
    const work = settleShutdown([
      deliveries,
      targeting,
      callbacks,
      guarded.wait(),
      files.stop(),
      helper.stop(),
      body.stop(),
      history.stop(),
      settings.close(),
    ]);
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
        await history.start(paused);
        check(epoch);
        await syncRules();
        check(epoch);
        await body.start(options.intervalMs ?? 2_000);
        check(epoch);
        running = true;
        dsh.start();
        await target.start();
        check(epoch);
        await files.refresh();
        check(epoch);
        if (!paused) helper.start(settings.sendTitles);
        nextToken = clock.mono() + 5_000;
        schedule();
        changed();
      } catch (error) {
        const stopped = epoch !== generation;
        await stop().catch(() => {});
        if (stopped) throw new Error('stopped');
        throw error;
      }
    },
    stop,
    currentSessionId: () => attention.currentSessionId(),
    targetMode: () => attention.targetMode(),
    target: () => target.snapshot(),
    state: () => dsh.stateFor(attention.currentSessionId(), attention.state()),
    factMeta: (path: string) => expiry.factMeta(path),
    subscribe: listeners.subscribe,
    onChange,
    events: () => attention.events(),
    rules: {
      list: () => settings.list(),
      isEnabled: (id: string) => settings.isEnabled(id),
      settings: () => ({ paused, sendTitles: allowTitles }),
    },
    body: { monitor: body.monitor, tuner: body.tuner },
    actions: observableActions(actions, changed),
    clearHistory: () => history.clear(),
    tools,
  };
}
