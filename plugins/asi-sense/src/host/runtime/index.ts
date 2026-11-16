import type { SenseState, WatchRule } from '@asi/sense-types';
import { BodySource } from '../sources/body.ts';
import { DshSource } from '../sources/dsh.ts';
import { FileSource } from '../sources/files.ts';
import { HelperSource } from '../sources/helper.ts';
import { boundedShutdown, guardActions } from './action-guard.ts';
import { RuntimeAttention } from './attention.ts';
import { createChanges, observableActions } from './changes.ts';
import { FactExpiry } from './expiry.ts';
import type { SenseActions, SenseOptions, SensePorts } from './ports.ts';
import { Settings } from './settings.ts';
import { runtimeTools } from './tools.ts';

export type { EventEntry, EventLog } from './attention.ts';
export type * from './ports.ts';

export function createSenseRuntime(ports: SensePorts, options: SenseOptions = {}) {
  const { clock } = ports;
  const settings = new Settings(ports.storage, options.rules);
  let running = false;
  let started = false;
  let generation = 0;
  let stopping: Promise<void> | undefined;
  let allowTitles = true;
  let titleIntent = 0;
  let paused = false;
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
  const attention = new RuntimeAttention(
    clock,
    ports.dsh,
    () => settings.enabled(),
    schedule,
    () => allowTitles && helper.titlesEnabled(),
    changed,
    expiry,
  );
  const listeners = new Set<(state: SenseState) => void>();
  const notify = (state: SenseState) => {
    for (const listener of listeners) {
      try {
        listener(structuredClone(state));
      } catch {}
    }
  };
  const offStore = attention.store.subscribe((state) => {
    notify(state);
    schedule();
  });
  const body = new BodySource(ports.probe, ports.dsh, ports.storage, clock, attention, () => paused, changed);
  const dsh = new DshSource(
    ports.dsh,
    clock,
    attention,
    (id) => body.tokens(id),
    () => paused,
  );
  const files = new FileSource(
    ports.files,
    clock,
    attention,
    dsh,
    () => settings.enabled(),
    () => paused,
    (signal) => body.burst(signal),
    (roots) => body.setRoots(roots),
  );
  const helper = new HelperSource(
    ports.helper,
    options.helperPath,
    options.platform ?? process.platform,
    clock,
    attention,
    body,
    schedule,
    () => paused,
  );
  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!running) return;
    const due = paused || !attention.current() ? undefined : attention.pipeline.nextDeadline();
    const deadline = Math.min(
      due === undefined ? Infinity : Math.max(due, retryAfter),
      helper.nextDeadline() ?? Infinity,
      nextToken,
      expiry.next() ?? Infinity,
      attention.pipeline.retentionDeadline() ?? Infinity,
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
      notify(attention.state());
      changed();
    }
    if (clock.mono() >= nextToken) {
      nextToken = clock.mono() + 5_000;
      const session = attention.current();
      if (session && !paused) void body.tokens(session);
    }
    helper.tick();
    attention.pipeline.pruneSessions();
    const due = attention.pipeline.nextDeadline();
    if (!paused && due !== undefined && due <= clock.mono() && clock.mono() >= retryAfter) {
      retryAfter = clock.mono() + 250;
      await attention.flush().catch(() => {});
    }
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
  const unguarded: SenseActions = {
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
      const epoch = generation;
      if (value && !paused) {
        paused = true;
        schedule();
        await Promise.all([body.setPaused(true), files.refresh(), helper.stop()]);
        check(epoch);
      }
      await settings.update((draft) => {
        draft.paused = value;
      });
      check(epoch);
      if (!value && paused) {
        paused = false;
        await body.setPaused(false);
        check(epoch);
        await files.refresh();
        check(epoch);
        helper.start(settings.sendTitles);
        schedule();
      }
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
  };
  const guarded = guardActions(unguarded, () => generation, check);
  const actions = guarded.actions;
  const tools = runtimeTools(attention, body, settings, actions, syncRules, check, () => allowTitles, changed);
  function stop(): Promise<void> {
    if (stopping) return stopping;
    generation++;
    started = true;
    running = false;
    if (timer) clearTimeout(timer);
    timer = undefined;
    const deliveries = attention.stop();
    const callbacks = dsh.stop();
    offStore();
    listeners.clear();
    changes.clear();
    const work = Promise.allSettled([
      deliveries,
      callbacks,
      guarded.wait(),
      files.stop(),
      helper.stop(),
      body.stop(),
      settings.close(),
    ]).then((results) => {
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (errors.length === 1) throw errors[0]?.reason;
      if (errors.length > 1)
        throw new AggregateError(
          errors.map((result) => result.reason),
          'runtime shutdown failed',
        );
    });
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
        await syncRules();
        check(epoch);
        await body.start(options.intervalMs ?? 2_000);
        check(epoch);
        running = true;
        dsh.start();
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
    state: () => attention.state(),
    subscribe: (listener: (state: SenseState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onChange,
    events: () => attention.events(),
    rules: {
      list: () => settings.list(),
      isEnabled: (id: string) => settings.isEnabled(id),
      settings: () => ({ paused, sendTitles: allowTitles }),
    },
    body: { monitor: body.monitor, tuner: body.tuner },
    actions: observableActions(actions, changed),
    tools,
  };
}
