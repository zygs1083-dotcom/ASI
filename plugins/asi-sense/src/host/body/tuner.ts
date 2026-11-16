import type { TuningValue } from '@asi/sense-types';
import { type BodyPersistence, PersistScheduler } from './persistence.ts';
import { feedback, register } from './tuner-feedback.ts';
import { type TunerActor, TunerGuard, type TuningResult } from './tuner-guard.ts';
import { validateSnapshot } from './tuner-persist.ts';
import { type AlertBinding, finiteNum, type ParameterSpec, type TuningLog, validateSpec } from './tuner-spec.ts';
import { applySnapshot, resetTuner, serializeTuner, TunerStore } from './tuner-state.ts';
import { parameters, safeNotify } from './tuner-view.ts';

export type { AlertBinding, ParameterSpec, TunerActor, TuningLog, TuningResult };
export interface TunerOptions {
  /** Host-supplied trusted actor: 'user' from the sidebar boundary, 'agent' otherwise. */
  actor?: () => TunerActor;
  /** Monotonic ms for budgets; default performance.now. */
  clock?: () => number;
  /** Wall ms for audit stamps + the freeze high-water mark; default Date.now. */
  wallClock?: () => number;
  persistence?: BodyPersistence;
  onChange?: () => void;
}
/**
 * Guarded self-tuning (§2.2c `body_tune`). Callers never supply an actor —
 * the injected resolver decides, and anything it returns that is not a
 * known actor is untrusted. `user` (sidebar only) may lock/unlock and
 * bypasses AI amplitude, direction and budget guards — including the lock
 * on revert — but still hits whitelist type/bounds/no-op checks. `agent`
 * and `auto` are bound by locks, ±50% amplitude vs the CURRENT value,
 * tighten direction and sliding monotonic budgets 2/param/hour,
 * 6/param/day, 24 all-params/day. The 500-entry display log is display
 * only: undoable changes are retained separately so reject floods
 * cannot evict a revertable entry. With persistence configured AI stays
 * blocked until {@link restore}; a corrupt/unknown snapshot sets
 * `tuningDisabled` and a `restore-failed` marker is persisted so a later
 * restart cannot unlock.
 */
export class Tuner {
  private store = new TunerStore();
  private readonly actor: () => TunerActor;
  private readonly clock: () => number;
  private readonly wallClock: () => number;
  private readonly persistence?: BodyPersistence;
  private readonly onChange: () => void;
  private readonly scheduler?: PersistScheduler;
  private commit?: (snapshot: () => string, publish: () => void, context?: unknown, result?: unknown) => Promise<void>;
  private rebaseHost?: { revertChange: (id: string) => Promise<TuningResult> };
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(parameters: Record<string, ParameterSpec>, options: TunerOptions = {}) {
    for (const k of ['actor', 'clock', 'wallClock', 'onChange'] as const) {
      if (options[k] !== undefined && typeof options[k] !== 'function') {
        throw new TypeError(`tuner: options.${k} must be a function`);
      }
    }
    this.actor = options.actor ?? (() => 'agent' as const);
    this.clock = options.clock ?? (() => performance.now());
    this.wallClock = options.wallClock ?? Date.now;
    this.store.restored = options.persistence === undefined;
    this.persistence = options.persistence;
    this.onChange = safeNotify(options.onChange);
    if (options.persistence) {
      const save = options.persistence.save.bind(options.persistence);
      const scheduler = new PersistScheduler(
        () => save(this.serialize()),
        this.clock,
        10_000,
        async () => {
          this.disableStorage();
          await save(this.serialize()).catch(() => {});
        },
      );
      this.scheduler = scheduler;
      this.commit = (snapshot, publish) => scheduler.commit(() => save(snapshot()), publish);
    }
    for (const [name, spec] of Object.entries(parameters)) {
      const s = validateSpec(name, spec);
      this.store.specs.set(name, s);
      this.store.values.set(name, s.value);
    }
  }
  /** Public kill switch: a failed restore disables AI tuning until explicit reset. */
  get tuningDisabled(): 'restore-failed' | 'storage-failed' | undefined {
    return this.store.disabled;
  }
  get(param: string): TuningValue | undefined {
    return this.store.values.get(param);
  }
  hasAlert(id: string): boolean {
    return !this.closed && this.store.restored && !this.store.disabled && this.store.alerts.has(id);
  }
  parameters = () => parameters(this.store);
  /** Positive finite numeric value, else the caller's fallback. */
  number(param: string, fallback: number): number {
    const v = this.store.values.get(param);
    return typeof v === 'number' && finiteNum(v) && v > 0 ? v : fallback;
  }
  /** Display audit log (capped at 500); undoable changes are retained separately. */
  get logs(): TuningLog[] {
    return this.store.log.slice(-500).map((e) => ({ ...e }));
  }

  get undoableChanges(): TuningLog[] {
    return this.store.applied
      .filter((entry) => {
        if (this.store.lastApplied.get(entry.param) !== entry.id) return false;
        const spec = this.store.specs.get(entry.param);
        return (
          !spec ||
          ((!spec.choices || spec.choices.includes(entry.from)) &&
            (typeof entry.from !== 'number' ||
              ((spec.min === undefined || entry.from >= spec.min) &&
                (spec.max === undefined || entry.from <= spec.max))))
        );
      })
      .map((entry) => ({ ...entry }));
  }

  propose(req: { param: string; to: TuningValue; reason?: string }): Promise<TuningResult> {
    return this.mutate((_store, guard) => guard.attempt('propose', req.param, req.to, String(req.reason ?? '')));
  }

  lock(param: string): Promise<TuningResult> {
    return this.mutate((_store, guard) => guard.setLock(param, true));
  }

  unlock(param: string): Promise<TuningResult> {
    return this.mutate((_store, guard) => guard.setLock(param, false));
  }

  /** Inverse of an applied change; stale IDs (ABA included) are rejected. */
  revert(changeId: string): Promise<TuningResult> {
    const prior = this.store.applied.find((entry) => entry.id === changeId);
    if (prior?.kind === 'rebaseline' && this.rebaseHost) {
      const actor = this.actor();
      if (actor === 'user') return this.rebaseHost.revertChange(changeId);
      return this.mutate(
        (_store, guard) => guard.rebaseline(prior.param, Number(prior.to), Number(prior.from), changeId),
        undefined,
        actor,
      );
    }
    return this.mutate((_store, guard) => guard.revert(changeId));
  }

  registerAlert(alertId: string, ruleId: string, param: string): Promise<boolean> {
    return this.mutate((store) => register(store, this.clock, this.wallClock, alertId, ruleId, param));
  }

  /** Consumes an alert registration once; three noise streaks auto-tune. */
  feedback(alertId: string, verdict: 'useful' | 'noise'): Promise<TuningResult> {
    return this.mutate((store, guard) => feedback(store, guard, this.clock, this.wallClock, alertId, verdict));
  }

  async resumeTuning(): Promise<void> {
    if (this.actor() !== 'user') throw new Error('tuner: resume requires trusted user');
    if (this.store.disabled !== 'storage-failed') throw new Error('tuner: storage recovery unavailable');
    await this.mutate((store) => store.resume(), undefined, 'user', true);
  }
  async resetTuning(): Promise<void> {
    if (this.actor() !== 'user') throw new Error('tuner: reset requires trusted user');
    await this.mutate(resetTuner, undefined, 'user', true);
  }

  setRebaselineHost(host: { revertChange: (id: string) => Promise<TuningResult> }): void {
    if (this.persistence || !this.commit || this.rebaseHost) throw new TypeError('tuner: invalid rebaseline host');
    this.rebaseHost = host;
  }

  rebaseline(
    host: object,
    param: string,
    from: number,
    to: number,
    context: unknown,
    undoId?: string,
  ): Promise<TuningResult> {
    if (host !== this.rebaseHost || !/^baseline:[\w-]+:[\w-]+:\d{1,3}$/.test(param)) {
      return Promise.reject(new TypeError('tuner: invalid rebaseline request'));
    }
    return this.mutate((_store, guard) => guard.rebaseline(param, from, to, undoId), context);
  }

  serialize(): string {
    const mono = this.clock();
    const wall = this.wallClock();
    if (!finiteNum(mono) || !finiteNum(wall)) throw new TypeError('tuner: clocks must be finite');
    return serializeTuner(this.store, mono, wall);
  }

  /** Loads + applies the persisted snapshot; corrupt data disables AI tuning. */
  async restore(): Promise<void> {
    if (!this.persistence || this.store.restored) {
      this.store.restored = true;
      return;
    }
    let data: string | undefined;
    try {
      data = await this.persistence.load();
    } catch {
      data = '\x00load-failed';
    }
    if (data !== undefined && typeof data !== 'string') data = '\x00bad';
    if (this.restoreSnapshot(data) === 'failed') await this.persist().catch(() => {});
  }

  /**
   * Applies snapshot text (undefined = first install) — used by
   * BodyMonitor-managed combined snapshots. On any invalid input AI tuning
   * is disabled and the ID lineage is replaced with a fresh random prefix.
   */
  restoreSnapshot(data: string | undefined): 'fresh' | 'ok' | 'failed' {
    if (data === undefined) {
      this.store.restored = true;
      return 'fresh';
    }
    const v = validateSnapshot(data, Object.fromEntries(this.store.specs));
    if (v === undefined || (v.disabled === 'restore-failed' && v.values.length === 0)) {
      this.store.reset();
      if (this.store.specs.get('deliveryLevel.file.burst')?.choices?.includes('context'))
        this.store.values.set('deliveryLevel.file.burst', 'context');
      this.store.disabled = 'restore-failed';
      this.store.resetIds();
      this.store.restored = true;
      return 'failed';
    }
    applySnapshot(this.store, v, this.clock(), this.wallClock());
    this.store.disabled = v.disabled;
    this.store.restored = true;
    return 'ok';
  }

  /** @internal BodyMonitor marks this tuner as managed before driving restore. */
  expectRestore(): void {
    this.store.restored = false;
  }

  /** Force-flushes the current snapshot (no-op before restore/without persistence). */
  async persist(): Promise<void> {
    await this.tail;
    if (this.store.restored) await this.scheduler?.flush();
  }

  /** Cancels the pending write + timer, then flushes — even before restore. */
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    if (this.store.restored) await this.scheduler?.close();
    else this.scheduler?.cancel();
  }

  setCommit(
    fn: (snapshot: () => string, publish: () => void, context?: unknown, result?: unknown) => Promise<void>,
  ): void {
    if (this.persistence) throw new TypeError('tuner: combined and standalone persistence cannot be mixed');
    this.commit = fn;
  }

  disableStorage(): void {
    if (this.store.disabled !== 'restore-failed') this.store.disabled = 'storage-failed';
    this.onChange();
  }

  private mutate<T>(
    action: (store: TunerStore, guard: TunerGuard) => T,
    context?: unknown,
    identity = this.actor(),
    recovery = false,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('tuner: closed'));
    const operation = this.tail.then(async () => {
      if (!this.store.restored) throw new Error('tuner: restore pending');
      if (!this.commit) throw new Error('tuner: persistence required');
      if (this.store.disabled && !recovery) throw new Error(`tuner: tuning disabled: ${this.store.disabled}`);
      if (!finiteNum(this.clock()) || !finiteNum(this.wallClock())) throw new TypeError('tuner: clocks must be finite');
      const staged = this.store.clone(this.clock(), this.wallClock());
      const guard = new TunerGuard(staged, {
        actor: () => identity,
        mono: this.clock,
        wall: this.wallClock,
        onChange: () => {},
      });
      const result = action(staged, guard);
      if (result === false || (result && typeof result === 'object' && 'applied' in result && !result.applied)) {
        this.store.retainWindowState(staged);
        if (result !== false) this.store.appendLog((result as TuningResult).change);
        return result;
      }
      try {
        await this.commit(
          () => {
            if (this.store.disabled && !recovery) throw new Error(`tuner: tuning disabled: ${this.store.disabled}`);
            const mono = this.clock();
            const wall = this.wallClock();
            if (!finiteNum(mono) || !finiteNum(wall)) throw new TypeError('tuner: clocks must be finite');
            staged.pruneApplied(wall);
            return serializeTuner(staged, mono, wall);
          },
          () => {
            this.store = staged;
          },
          context,
          result,
        );
      } catch (err) {
        this.disableStorage();
        throw err;
      }
      return result;
    });
    this.tail = operation.then(
      () => {},
      () => {},
    );
    return operation.finally(this.onChange);
  }
}
