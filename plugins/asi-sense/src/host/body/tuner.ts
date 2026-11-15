import type { TuningChange, TuningValue } from '@asi/sense-types';
import { type ValidatedState, validateSnapshot } from './tuner-persist.ts';
import {
  ALERT_CAP,
  type AlertBinding,
  finiteNum,
  HOUR_MS,
  HOURLY_CAP,
  LOG_CAP,
  type ParameterSpec,
  safeAuditValue,
  type TuningLog,
  validateSpec,
} from './tuner-spec.ts';

export type { AlertBinding, ParameterSpec, TuningLog };

export interface TuningResult {
  applied: boolean;
  change: TuningLog;
  reason?: string;
}

/** Guarded self-tuning (§2.2c `body_tune`): whitelist type/bounds/choices, ±50%
 * amplitude, tighten direction, locks, 2 applied changes/param/hour. Throttle
 * stamps live outside the 500-entry audit log so truncation can't launder the
 * cap. Specs `tuner-spec.ts`; snapshots `tuner-persist.ts`. */
export class Tuner {
  private readonly clock: () => number;
  private readonly specs = new Map<string, ParameterSpec>();
  private readonly values = new Map<string, TuningValue>();
  private readonly locked = new Set<string>();
  private readonly throttle = new Map<string, number[]>();
  private readonly noise = new Map<string, number>();
  private readonly alerts = new Map<string, AlertBinding>();
  private log: TuningLog[] = [];
  private nextId = 1;

  constructor(parameters: Record<string, ParameterSpec>, clock: () => number) {
    if (typeof clock !== 'function') throw new TypeError('tuner: clock function required');
    this.clock = clock;
    for (const [name, spec] of Object.entries(parameters)) {
      const s = validateSpec(name, spec);
      this.specs.set(name, s);
      this.values.set(name, s.value);
    }
  }

  get(param: string): TuningValue | undefined {
    return this.values.get(param);
  }

  /** Positive finite numeric value, else the caller's fallback. */
  number(param: string, fallback: number): number {
    const v = this.values.get(param);
    return typeof v === 'number' && finiteNum(v) && v > 0 ? v : fallback;
  }

  get logs(): TuningLog[] {
    return this.log.map((e) => ({ ...e }));
  }

  propose(req: { param: string; to: TuningValue; reason?: string }, by: TuningChange['by']): TuningResult {
    return this.attempt('propose', req.param, req.to, String(req.reason ?? ''), by);
  }

  lock(param: string, by: TuningChange['by'] = 'user'): TuningResult {
    return this.setLock(param, true, by);
  }

  unlock(param: string, by: TuningChange['by'] = 'user'): TuningResult {
    return this.setLock(param, false, by);
  }

  /** Inverse of an applied change, through the same guards. */
  revert(changeId: string, by: TuningChange['by'] = 'user'): TuningResult {
    const e = this.log.find(
      (x) => x.id === changeId && x.status === 'applied' && (x.operation === 'propose' || x.operation === 'revert'),
    );
    if (!e) {
      return this.audit({
        param: changeId,
        from: '',
        to: '',
        by,
        reason: 'revert',
        at: this.clock(),
        operation: 'revert',
        status: 'rejected',
        rejectionReason: 'no applied change with that id',
      });
    }
    if (this.values.get(e.param) !== e.to) {
      return this.audit({
        param: e.param,
        from: this.values.get(e.param) ?? '',
        to: e.from,
        by,
        reason: `revert ${changeId}`,
        at: this.clock(),
        operation: 'revert',
        status: 'rejected',
        rejectionReason: 'stale: value moved on',
      });
    }
    return this.attempt('revert', e.param, e.from, `revert ${changeId}`, by);
  }

  registerAlert(alertId: string, ruleId: string, param: string): boolean {
    if (
      typeof alertId !== 'string' ||
      alertId === '' ||
      typeof ruleId !== 'string' ||
      ruleId === '' ||
      !this.specs.has(param) ||
      this.alerts.has(alertId) ||
      this.alerts.size >= ALERT_CAP
    ) {
      return false;
    }
    this.alerts.set(alertId, { ruleId, param });
    return true;
  }

  /** Consumes an alert registration once; three noise streaks auto-tune. */
  feedback(alertId: string, verdict: 'useful' | 'noise'): TuningResult {
    const binding = this.alerts.get(alertId);
    if (!binding || (verdict !== 'useful' && verdict !== 'noise')) {
      return this.audit({
        param: binding?.param ?? '',
        from: '',
        to: '',
        by: 'auto',
        reason: `feedback ${verdict}`,
        at: this.clock(),
        operation: 'feedback',
        status: 'rejected',
        rejectionReason: 'unknown or consumed alert',
      });
    }
    this.alerts.delete(alertId);
    const result = this.audit({
      param: binding.param,
      from: verdict,
      to: verdict,
      by: 'auto',
      reason: `feedback ${verdict} on ${alertId}`,
      at: this.clock(),
      operation: 'feedback',
      status: 'applied',
    });
    const streak = verdict === 'useful' ? 0 : (this.noise.get(binding.ruleId) ?? 0) + 1;
    this.noise.set(binding.ruleId, streak);
    if (streak < 3) return result;
    this.noise.set(binding.ruleId, 0);
    const spec = this.specs.get(binding.param);
    const current = this.values.get(binding.param);
    const dir = spec?.noiseDirection;
    if (dir && typeof current === 'number' && finiteNum(current)) {
      this.attempt(
        'propose',
        binding.param,
        current * (dir === 'up' ? 1.25 : 0.8),
        `auto: 3 consecutive noise on ${binding.ruleId}`,
        'auto',
      );
    } else {
      this.audit({
        param: binding.param,
        from: current ?? '',
        to: current ?? '',
        by: 'auto',
        reason: `auto: no noise policy for ${binding.param}`,
        at: this.clock(),
        operation: 'propose',
        status: 'rejected',
        rejectionReason: 'no noise policy',
      });
    }
    return result;
  }

  serialize(): string {
    return JSON.stringify({
      version: 1,
      values: [...this.values],
      locked: [...this.locked],
      noise: [...this.noise],
      alerts: [...this.alerts],
      throttle: [...this.throttle],
      log: this.log,
      nextId: this.nextId,
    });
  }

  /** Restores a v1 snapshot; malformed state or loosened floors rebuild empty. */
  static deserialize(json: string, parameters: Record<string, ParameterSpec>, clock: () => number): Tuner {
    const t = new Tuner(parameters, clock);
    const s = validateSnapshot(json, parameters, clock);
    if (s) t.applyRestored(s);
    return t;
  }

  private applyRestored(s: ValidatedState): void {
    for (const [k, v] of s.values) this.values.set(k, v);
    for (const k of s.locked) this.locked.add(k);
    for (const [k, n] of s.noise) this.noise.set(k, n);
    for (const [k, a] of s.alerts) this.alerts.set(k, a);
    for (const [k, ts] of s.throttle) this.throttle.set(k, ts);
    this.log = s.log;
    this.nextId = s.nextId;
  }

  private guard(param: string, to: TuningValue): string | null {
    const spec = this.specs.get(param);
    if (!spec) return 'unknown param';
    const current = this.values.get(param) as TuningValue;
    if (this.locked.has(param)) return 'param locked';
    if (typeof to !== typeof current) return 'type mismatch';
    if (typeof to === 'number' && !finiteNum(to)) return 'nonfinite';
    if (to === current) return 'no-op';
    if (spec.choices && !spec.choices.includes(to)) return 'not in choices';
    if (typeof to === 'number' && typeof current === 'number') {
      if ((spec.min !== undefined && to < spec.min) || (spec.max !== undefined && to > spec.max))
        return 'out of bounds';
      if (current === 0 || Math.abs(to - current) > Math.abs(current) * 0.5) return 'exceeds ±50%';
      if (spec.tighten === 'up' && to < current) return 'safety: cannot loosen';
      if (spec.tighten === 'down' && to > current) return 'safety: cannot loosen';
    }
    const now = this.clock();
    const stamps = (this.throttle.get(param) ?? []).filter((t) => now - t < HOUR_MS);
    this.throttle.set(param, stamps);
    if (stamps.length >= HOURLY_CAP) return 'hourly change limit';
    return null;
  }

  private attempt(
    operation: 'propose' | 'revert',
    param: string,
    to: TuningValue,
    reason: string,
    by: TuningChange['by'],
  ): TuningResult {
    const at = this.clock();
    const why = this.guard(param, to);
    const result = this.audit({
      param,
      from: this.values.get(param) ?? to,
      to,
      by,
      reason,
      at,
      operation,
      status: why ? 'rejected' : 'applied',
      ...(why ? { rejectionReason: why } : {}),
    });
    if (!why) {
      this.values.set(param, to);
      const stamps = this.throttle.get(param) ?? [];
      stamps.push(at);
      this.throttle.set(param, stamps);
    }
    return result;
  }

  private setLock(param: string, lock: boolean, by: TuningChange['by']): TuningResult {
    const known = this.specs.has(param);
    if (known) {
      if (lock) this.locked.add(param);
      else this.locked.delete(param);
    }
    const current = this.values.get(param) ?? '';
    return this.audit({
      param,
      from: current,
      to: current,
      by,
      reason: lock ? 'locked' : 'unlocked',
      at: this.clock(),
      operation: lock ? 'lock' : 'unlock',
      status: known ? 'applied' : 'rejected',
      ...(known ? {} : { rejectionReason: 'unknown param' }),
    });
  }

  /** Appends an audit entry (nonfinite scalars JSON-safed) and returns it. */
  private audit(fields: Omit<TuningLog, 'id'>): TuningResult {
    const entry = {
      id: `chg-${this.nextId++}`,
      ...fields,
      from: safeAuditValue(fields.from),
      to: safeAuditValue(fields.to),
    } as TuningLog;
    this.log.push(entry);
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP);
    const applied = entry.status === 'applied';
    return { applied, change: { ...entry }, reason: entry.rejectionReason };
  }
}
