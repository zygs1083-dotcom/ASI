import { randomUUID } from 'node:crypto';
import type { TuningValue } from '@asi/sense-types';
import type { ValidatedState } from './tuner-persist.ts';
import {
  type AlertBinding,
  DAY_MS,
  finiteNum,
  HOUR_MS,
  LOG_CAP,
  type ParameterSpec,
  type TuningLog,
} from './tuner-spec.ts';

interface RestoredWindows {
  hour: Map<string, number[]>;
  day: Map<string, number[]>;
  dayAll: number[];
}

/**
 * All mutable {@link Tuner} state plus the throttle-window bookkeeping
 * (DESIGN §2.2c). Live stamps are strictly monotonic. Restored windows are
 * kept as REMAINING ms and only age while the wall clock is at or past the
 * saved high-water mark (`thawMono` set) — restart downtime is never
 * credited, a regressed wall clock freezes all AI as full, and windows
 * resume aging from catch-up rather than being re-credited.
 */
export class TunerStore {
  readonly specs = new Map<string, ParameterSpec>();
  readonly values = new Map<string, TuningValue>();
  readonly locked = new Set<string>();
  readonly noise = new Map<string, number>();
  readonly alerts = new Map<string, AlertBinding>();
  log: TuningLog[] = [];
  applied: TuningLog[] = [];
  lastApplied = new Map<string, string>();
  idPrefix: string = randomUUID();
  nextId = 1;
  wallHighwater = 0;
  restored = false;
  disabled: 'restore-failed' | undefined;
  private hour = new Map<string, number[]>();
  private day = new Map<string, number[]>();
  private dayAll: number[] = [];
  private restoredW?: RestoredWindows;
  private thawMono?: number;

  /** Fresh ID lineage after a failed restore — old IDs can never collide. */
  resetIds(): void {
    this.idPrefix = randomUUID();
    this.nextId = 1;
  }

  appendLog(entry: TuningLog): void {
    this.log.push(entry);
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP);
  }

  /** Consumes one AI budget stamp in all three windows. */
  recordChange(param: string, now: number): void {
    const h = this.hour.get(param) ?? [];
    this.hour.set(param, h);
    h.push(now);
    const d = this.day.get(param) ?? [];
    this.day.set(param, d);
    d.push(now);
    this.dayAll.push(now);
  }

  /**
   * Syncs restored windows against the wall clock: a wall that fell behind
   * the high-water mark freezes AI (returns true) and PAUSES restored
   * windows; aging resumes from catch-up — never re-credited.
   */
  syncWindows(now: number, wall: number): boolean {
    const rw = this.restoredW;
    if (!rw) return false;
    if (this.thawMono !== undefined && (!finiteNum(wall) || wall < this.wallHighwater)) {
      const el = now - this.thawMono;
      for (const m of [rw.hour, rw.day]) {
        for (const [k, list] of m)
          m.set(
            k,
            list.map((r) => r - el).filter((r) => r > 0),
          );
      }
      rw.dayAll = rw.dayAll.map((r) => r - el).filter((r) => r > 0);
      this.thawMono = undefined;
    }
    if (this.thawMono === undefined) {
      if (!finiteNum(wall) || wall < this.wallHighwater) return true;
      this.thawMono = now;
    }
    return false;
  }

  private liveCount(stamps: readonly number[] | undefined, now: number, windowMs: number): number {
    return (stamps ?? []).filter((t) => now - t < windowMs).length;
  }

  private restoredCount(list: readonly number[] | undefined, now: number): number {
    if (!this.restoredW || this.thawMono === undefined) return 0;
    return (list ?? []).filter((r) => now - (this.thawMono as number) < r).length;
  }

  /** [hourly, per-param-daily, global-daily] counts, live + restored. */
  counts(param: string, now: number): [number, number, number] {
    const rw = this.restoredW;
    return [
      this.liveCount(this.hour.get(param), now, HOUR_MS) + this.restoredCount(rw?.hour.get(param), now),
      this.liveCount(this.day.get(param), now, DAY_MS) + this.restoredCount(rw?.day.get(param), now),
      this.liveCount(this.dayAll, now, DAY_MS) + this.restoredCount(rw?.dayAll, now),
    ];
  }

  /** Remaining-ms projection of every live + restored window for the snapshot. */
  serializeWindows(now: number): { hour: [string, number[]][]; day: [string, number[]][]; dayAll: number[] } {
    const aged = this.thawMono !== undefined && finiteNum(now) ? now - this.thawMono : 0;
    const rem = (windowMs: number, live: readonly number[], restored: readonly number[]): number[] => {
      const out: number[] = [];
      for (const t of live) {
        const r = windowMs - (now - t);
        if (r > 0) out.push(Math.min(r, windowMs));
      }
      for (const r of restored) {
        const x = r - aged;
        if (x > 0) out.push(x);
      }
      return out;
    };
    const rw = this.restoredW;
    const params = new Set([
      ...this.hour.keys(),
      ...this.day.keys(),
      ...(rw?.hour.keys() ?? []),
      ...(rw?.day.keys() ?? []),
    ]);
    const hour: [string, number[]][] = [];
    const day: [string, number[]][] = [];
    for (const p of params) {
      const h = rem(HOUR_MS, this.hour.get(p) ?? [], rw?.hour.get(p) ?? []);
      if (h.length) hour.push([p, h]);
      const d = rem(DAY_MS, this.day.get(p) ?? [], rw?.day.get(p) ?? []);
      if (d.length) day.push([p, d]);
    }
    return { hour, day, dayAll: rem(DAY_MS, this.dayAll, rw?.dayAll ?? []) };
  }

  /** Adopts restored windows; thaw starts now only when wall >= highwater. */
  applyWindows(s: ValidatedState, now: number, wall: number): void {
    this.restoredW = { hour: new Map(s.hour), day: new Map(s.day), dayAll: [...s.dayAll] };
    this.wallHighwater = s.wallHighwater;
    this.thawMono = finiteNum(wall) && wall >= s.wallHighwater && finiteNum(now) ? now : undefined;
  }
}

/** Full v2 snapshot text; a disabled tuner persists only its marker. */
export function serializeTuner(s: TunerStore, now: number, wall: number): string {
  if (s.disabled) {
    return JSON.stringify({ version: 2, disabled: 'restore-failed', idPrefix: s.idPrefix });
  }
  const w = s.serializeWindows(now);
  const hw = finiteNum(wall) ? Math.max(s.wallHighwater, wall) : s.wallHighwater;
  return JSON.stringify({
    version: 2,
    idPrefix: s.idPrefix,
    nextId: s.nextId,
    wallHighwater: hw,
    values: [...s.values],
    locked: [...s.locked],
    noise: [...s.noise],
    alerts: [...s.alerts],
    hour: w.hour,
    day: w.day,
    dayAll: w.dayAll,
    log: s.log,
    applied: s.applied,
  });
}

/** Applies a fully validated snapshot — caller already checked the marker. */
export function applySnapshot(s: TunerStore, v: ValidatedState, now: number, wall: number): void {
  for (const [k, val] of v.values) s.values.set(k, val);
  for (const k of v.locked) s.locked.add(k);
  for (const [k, n] of v.noise) s.noise.set(k, n);
  for (const [k, a] of v.alerts) s.alerts.set(k, a);
  s.applyWindows(v, now, wall);
  s.log = v.log;
  s.applied = v.applied;
  s.lastApplied = new Map();
  for (const e of v.applied) s.lastApplied.set(e.param, e.id);
  s.idPrefix = v.idPrefix;
  s.nextId = v.nextId;
}
