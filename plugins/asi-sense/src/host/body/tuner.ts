import type { TuningValue } from '@asi/sense-types';
import { type BodyPersistence, PersistScheduler } from './persistence.ts';
import { type TunerActor, TunerGuard, type TuningResult } from './tuner-guard.ts';
import { validateSnapshot } from './tuner-persist.ts';
import {
  ALERT_CAP,
  type AlertBinding,
  finiteNum,
  type ParameterSpec,
  type TuningLog,
  validateSpec,
} from './tuner-spec.ts';
import { applySnapshot, serializeTuner, TunerStore } from './tuner-state.ts';

export type { AlertBinding, ParameterSpec, TunerActor, TuningLog, TuningResult };

export interface TunerOptions {
  /** Host-supplied trusted actor: 'user' from the sidebar boundary, 'agent' otherwise. */
  actor?: () => TunerActor;
  /** Monotonic ms for budgets; default performance.now. */
  clock?: () => number;
  /** Wall ms for audit stamps + the freeze high-water mark; default Date.now. */
  wallClock?: () => number;
  persistence?: BodyPersistence;
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
 * only: every applied change is retained separately so reject floods
 * cannot evict a revertable entry. With persistence configured AI stays
 * blocked until {@link restore}; a corrupt/unknown snapshot sets
 * `tuningDisabled` and a `restore-failed` marker is persisted so a later
 * restart cannot unlock.
 */
export class Tuner {
  private readonly store = new TunerStore();
  private readonly guard: TunerGuard;
  private readonly clock: () => number;
  private readonly wallClock: () => number;
  private readonly persistence?: BodyPersistence;
  private readonly scheduler?: PersistScheduler;

  constructor(parameters: Record<string, ParameterSpec>, options: TunerOptions = {}) {
    for (const k of ['actor', 'clock', 'wallClock'] as const) {
      if (options[k] !== undefined && typeof options[k] !== 'function') {
        throw new TypeError(`tuner: options.${k} must be a function`);
      }
    }
    const actorFn = options.actor ?? (() => 'agent' as const);
    this.clock = options.clock ?? (() => performance.now());
    this.wallClock = options.wallClock ?? Date.now;
    this.store.restored = options.persistence === undefined;
    this.persistence = options.persistence;
    if (options.persistence) {
      const save = options.persistence.save.bind(options.persistence);
      this.scheduler = new PersistScheduler(() => save(this.serialize()), this.clock);
    }
    this.guard = new TunerGuard(this.store, {
      actor: actorFn,
      mono: this.clock,
      wall: this.wallClock,
      onChange: () => this.schedule(),
    });
    for (const [name, spec] of Object.entries(parameters)) {
      const s = validateSpec(name, spec);
      this.store.specs.set(name, s);
      this.store.values.set(name, s.value);
    }
  }

  /** Public kill switch: a failed restore disables AI tuning permanently. */
  get tuningDisabled(): 'restore-failed' | undefined {
    return this.store.disabled;
  }

  get(param: string): TuningValue | undefined {
    return this.store.values.get(param);
  }

  /** Positive finite numeric value, else the caller's fallback. */
  number(param: string, fallback: number): number {
    const v = this.store.values.get(param);
    return typeof v === 'number' && finiteNum(v) && v > 0 ? v : fallback;
  }

  /** Display audit log (capped at 500); applied changes are never lost. */
  get logs(): TuningLog[] {
    return this.store.log.map((e) => ({ ...e }));
  }

  propose(req: { param: string; to: TuningValue; reason?: string }): TuningResult {
    return this.guard.attempt('propose', req.param, req.to, String(req.reason ?? ''));
  }

  lock(param: string): TuningResult {
    return this.guard.setLock(param, true);
  }

  unlock(param: string): TuningResult {
    return this.guard.setLock(param, false);
  }

  /** Inverse of an applied change; stale IDs (ABA included) are rejected. */
  revert(changeId: string): TuningResult {
    return this.guard.revert(changeId);
  }

  registerAlert(alertId: string, ruleId: string, param: string): boolean {
    if (
      typeof alertId !== 'string' ||
      alertId === '' ||
      typeof ruleId !== 'string' ||
      ruleId === '' ||
      !finiteNum(this.clock()) ||
      !finiteNum(this.wallClock()) ||
      !this.store.specs.has(param) ||
      this.store.alerts.has(alertId) ||
      this.store.alerts.size >= ALERT_CAP
    ) {
      return false;
    }
    this.store.alerts.set(alertId, { ruleId, param });
    this.schedule();
    return true;
  }

  /** Consumes an alert registration once; three noise streaks auto-tune. */
  feedback(alertId: string, verdict: 'useful' | 'noise'): TuningResult {
    const by = this.guard.actor() ?? 'agent';
    const binding = this.store.alerts.get(alertId);
    const badClock = !finiteNum(this.clock()) || !finiteNum(this.wallClock());
    if (!binding || (verdict !== 'useful' && verdict !== 'noise') || badClock) {
      return this.guard.audit({
        param: binding?.param ?? '',
        from: '',
        to: '',
        by,
        reason: `feedback ${String(verdict)}`,
        at: this.guard.auditAt(),
        operation: 'feedback',
        status: 'rejected',
        rejectionReason: badClock ? 'nonfinite clock' : 'unknown or consumed alert',
      });
    }
    this.store.alerts.delete(alertId);
    const result = this.guard.audit({
      param: binding.param,
      from: verdict,
      to: verdict,
      by,
      reason: `feedback ${verdict} on ${alertId}`,
      at: this.guard.auditAt(),
      operation: 'feedback',
      status: 'applied',
    });
    const streak = verdict === 'useful' ? 0 : (this.store.noise.get(binding.ruleId) ?? 0) + 1;
    this.store.noise.set(binding.ruleId, streak);
    if (streak < 3) return result;
    this.store.noise.set(binding.ruleId, 0);
    const spec = this.store.specs.get(binding.param);
    const current = this.store.values.get(binding.param);
    const dir = spec?.noiseDirection;
    if (dir && typeof current === 'number' && finiteNum(current)) {
      this.guard.attempt(
        'propose',
        binding.param,
        current * (dir === 'up' ? 1.25 : 0.8),
        `auto: 3 consecutive noise on ${binding.ruleId}`,
        'auto',
      );
    } else {
      this.guard.audit({
        param: binding.param,
        from: current ?? '',
        to: current ?? '',
        by: 'auto',
        reason: `auto: no noise policy for ${binding.param}`,
        at: this.guard.auditAt(),
        operation: 'propose',
        status: 'rejected',
        rejectionReason: 'no noise policy',
      });
    }
    return result;
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
    if (v === undefined || v.disabled) {
      this.store.disabled = 'restore-failed';
      this.store.resetIds();
      this.store.restored = true;
      return 'failed';
    }
    applySnapshot(this.store, v, this.clock(), this.wallClock());
    this.store.restored = true;
    return 'ok';
  }

  /** @internal BodyMonitor marks this tuner as managed before driving restore. */
  expectRestore(): void {
    this.store.restored = false;
  }

  /** Force-flushes the current snapshot (no-op before restore/without persistence). */
  persist(): Promise<void> {
    return this.store.restored && this.scheduler ? this.scheduler.flush() : Promise.resolve();
  }

  /** Cancels the pending write + timer, then flushes — even before restore. */
  async close(): Promise<void> {
    if (this.store.restored) await this.scheduler?.close();
    else this.scheduler?.cancel();
  }

  /** Host hook (e.g. a BodyMonitor managing a combined store): fires on
   *  every post-restore mutation even without own persistence. */
  setOnChange(fn: (() => void) | undefined): void {
    this.onChanged = fn;
  }

  private onChanged?: () => void;

  private schedule(): void {
    if (!this.store.restored) return;
    this.scheduler?.schedule();
    this.onChanged?.();
  }
}
