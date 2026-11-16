import { randomUUID } from 'node:crypto';
import type { TuningChange, TuningValue } from '@asi/sense-types';
import {
  DAILY_CAP,
  finiteNum,
  GLOBAL_DAILY_CAP,
  HOURLY_CAP,
  type ParameterSpec,
  safeAuditValue,
  type TuningLog,
  VALID_BY,
} from './tuner-spec.ts';
import type { TunerStore } from './tuner-state.ts';

export type TunerActor = TuningChange['by'];

export interface TuningResult {
  applied: boolean;
  change: TuningLog;
  reason?: string;
}

export interface GuardDeps {
  /** Host-supplied trusted actor resolver; anything else is untrusted. */
  actor(): TunerActor;
  mono(): number;
  wall(): number;
  /** Dirties persistence after every audit write. */
  onChange(): void;
}

/**
 * The §2.2c guard pipeline: whitelist/type/bounds/no-op checks for every
 * actor; `user` (trusted sidebar only) may lock/unlock and bypasses the AI
 * guards — amplitude, tighten direction and budgets — with the sole
 * exception that a user REVERT may pass a lock. `agent`/`auto` are bound
 * by locks, amplitude vs the CURRENT value (±50%, or 0.5–2× for merge windows), tighten direction and
 * the monotonic budgets 2/param/hour, 6/param/day, 24 all-params/day.
 */
export class TunerGuard {
  constructor(
    private readonly store: TunerStore,
    private readonly deps: GuardDeps,
  ) {}

  actor(): TunerActor | undefined {
    const a = this.deps.actor();
    return (VALID_BY as readonly string[]).includes(a) ? a : undefined;
  }

  /** Audit/display stamps are WALL time; mono is for budget windows only. */
  auditAt(): number {
    const wall = this.deps.wall();
    return finiteNum(wall) ? wall : 0;
  }

  /** Appends an audit entry (nonfinite scalars JSON-safed) and returns it. */
  audit(fields: Omit<TuningLog, 'id'>): TuningResult {
    const entry = {
      id: fields.status === 'rejected' ? `volatile-${randomUUID()}` : `${this.store.idPrefix}-${this.store.nextId++}`,
      ...fields,
      from: safeAuditValue(fields.from),
      to: safeAuditValue(fields.to),
    } as TuningLog;
    this.store.appendLog(entry);
    this.deps.onChange();
    return { applied: entry.status === 'applied', change: { ...entry }, reason: entry.rejectionReason };
  }

  attempt(
    operation: 'propose' | 'revert',
    param: string,
    to: TuningValue,
    reason: string,
    actorOverride?: TunerActor,
  ): TuningResult {
    const now = this.deps.mono();
    const wall = this.deps.wall();
    if (finiteNum(wall) && wall > this.store.wallHighwater) this.store.wallHighwater = wall;
    const actor = actorOverride ?? this.actor();
    const spec = this.store.specs.get(param);
    const current = this.store.values.get(param);
    let why: string | null = null;
    // Nonfinite clocks reject EVERYTHING — no value/window mutation, ever.
    if (!finiteNum(now) || !finiteNum(wall)) why = 'nonfinite clock';
    else if (!spec) why = 'unknown param';
    else if (typeof to !== typeof current) why = 'type mismatch';
    else if (typeof to === 'number' && !finiteNum(to)) why = 'nonfinite';
    else if (to === current) why = 'no-op';
    else if (spec.choices && !spec.choices.includes(to)) why = 'not in choices';
    else if (
      typeof to === 'number' &&
      typeof current === 'number' &&
      ((spec.min !== undefined && to < spec.min) || (spec.max !== undefined && to > spec.max))
    ) {
      why = 'out of bounds';
    } else if (actor === undefined) why = 'untrusted actor';
    else if (this.store.locked.has(param) && !(actor === 'user' && operation === 'revert')) why = 'param locked';
    else if (actor !== 'user' && param.startsWith('deliveryLevel.') && to === 'wake')
      why = 'wake requires user approval';
    else if (actor !== 'user') why = this.aiGuard(param, spec, to, current as TuningValue, now, wall);
    const result = this.audit({
      param,
      from: current ?? to,
      to,
      by: actor ?? 'agent',
      reason,
      at: this.auditAt(),
      operation,
      status: why ? 'rejected' : 'applied',
      ...(why ? { rejectionReason: why } : {}),
    });
    if (!why) {
      this.store.values.set(param, to);
      if (actor !== 'user' && finiteNum(now)) this.store.recordChange(param, now);
      this.store.applied.push({ ...result.change });
      this.store.lastApplied.set(param, result.change.id);
    }
    return result;
  }

  /**
   * Inverse of an applied change: valid only while `changeId` is still the
   * LAST applied change for its parameter — an ABA value coincidence does
   * not revive a superseded entry.
   */
  revert(changeId: string): TuningResult {
    const e = this.store.applied.find((x) => x.id === changeId);
    if (!e) {
      return this.audit({
        param: String(changeId),
        from: '',
        to: '',
        by: this.actor() ?? 'agent',
        reason: 'revert',
        at: this.auditAt(),
        operation: 'revert',
        status: 'rejected',
        rejectionReason: 'no applied change with that id',
      });
    }
    if (this.store.lastApplied.get(e.param) !== changeId) {
      return this.audit({
        param: e.param,
        from: this.store.values.get(e.param) ?? '',
        to: e.from,
        by: this.actor() ?? 'agent',
        reason: `revert ${changeId}`,
        at: this.auditAt(),
        operation: 'revert',
        status: 'rejected',
        rejectionReason: 'stale: superseded by a later change',
      });
    }
    return this.attempt('revert', e.param, e.from, `revert ${changeId}`);
  }

  setLock(param: string, lock: boolean): TuningResult {
    const actor = this.actor();
    const known = this.store.specs.has(param);
    const why =
      !finiteNum(this.deps.mono()) || !finiteNum(this.deps.wall())
        ? 'nonfinite clock'
        : !known
          ? 'unknown param'
          : actor !== 'user'
            ? 'lock requires trusted user'
            : null;
    if (why === null) {
      if (lock) this.store.locked.add(param);
      else this.store.locked.delete(param);
    }
    const current = this.store.values.get(param) ?? '';
    return this.audit({
      param,
      from: current,
      to: current,
      by: actor ?? 'agent',
      reason: lock ? 'locked' : 'unlocked',
      at: this.auditAt(),
      operation: lock ? 'lock' : 'unlock',
      status: why ? 'rejected' : 'applied',
      ...(why ? { rejectionReason: why } : {}),
    });
  }

  rebaseline(param: string, from: number, to: number, undoId?: string): TuningResult {
    const now = this.deps.mono();
    const wall = this.deps.wall();
    const actor = this.actor();
    const prior = undoId ? this.store.applied.find((entry) => entry.id === undoId) : undefined;
    let why: string | undefined;
    if (!Number.isFinite(now) || !Number.isFinite(wall) || !Number.isFinite(from) || !Number.isFinite(to)) {
      why = 'nonfinite';
    } else if (actor !== 'user') {
      why = 'rebaseline requires trusted user';
    } else if (undoId && (!prior || prior.param !== param || this.store.lastApplied.get(param) !== undoId)) {
      why = 'stale rebaseline';
    } else if (!undoId) {
      if (this.store.specs.has(param)) why = 'rebaseline parameter conflicts with whitelist';
    }
    if (wall > this.store.wallHighwater) this.store.wallHighwater = wall;
    const result = this.audit({
      param,
      from,
      to,
      by: actor ?? 'agent',
      reason: undoId ? `revert ${undoId}` : 'user: accept rebaseline suggestion',
      at: this.auditAt(),
      operation: undoId ? 'revert' : 'propose',
      status: why ? 'rejected' : 'applied',
      kind: 'rebaseline',
      ...(why ? { rejectionReason: why } : {}),
    });
    if (!why) {
      this.store.applied.push({ ...result.change });
      this.store.lastApplied.set(param, result.change.id);
    }
    return result;
  }

  /** AI-only guards; the whitelist ran before this and the lock before that. */
  private aiGuard(
    param: string,
    spec: ParameterSpec,
    to: TuningValue,
    current: TuningValue,
    now: number,
    wall: number,
  ): string | null {
    if (!finiteNum(now)) return 'nonfinite clock';
    if (!this.store.restored) return 'restore pending';
    if (this.store.disabled) return `tuning disabled: ${this.store.disabled}`;
    if (typeof to === 'number' && typeof current === 'number') {
      if (param === 'mergeWindowMs' || param === 'fileMergeWindowMs') {
        if (to < current * 0.5 || to > current * 2) return 'exceeds 0.5–2 times';
      } else if (current === 0 || Math.abs(to - current) > Math.abs(current) * 0.5) return 'exceeds ±50%';
      if (spec.tighten === 'up' && to < current) return 'safety: cannot loosen';
      if (spec.tighten === 'down' && to > current) return 'safety: cannot loosen';
    }
    if (this.store.syncWindows(now, wall)) return 'frozen: wall clock behind saved highwater';
    const [hour, day, dayAll] = this.store.counts(param, now);
    if (hour >= HOURLY_CAP) return 'hourly change limit';
    if (day >= DAILY_CAP) return 'daily change limit';
    if (dayAll >= GLOBAL_DAILY_CAP) return 'global daily change limit';
    return null;
  }
}
