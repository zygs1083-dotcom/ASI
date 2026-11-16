import type { TuningValue } from '@asi/sense-types';
import {
  ALERT_CAP,
  type AlertBinding,
  DAILY_CAP,
  DAY_MS,
  finiteNum,
  GLOBAL_DAILY_CAP,
  HOUR_MS,
  HOURLY_CAP,
  isLogEntry,
  isValue,
  LOG_CAP,
  type ParameterSpec,
  type TuningLog,
  validateSpec,
} from './tuner-spec.ts';

/** Fully validated v2 snapshot contents, ready for atomic application. */
export interface ValidatedState {
  values: [string, TuningValue][];
  locked: string[];
  noise: [string, number][];
  alerts: [string, AlertBinding][];
  /** Per-window REMAINING times (ms until the stamp expires), never absolute. */
  hour: [string, number[]][];
  day: [string, number[]][];
  dayAll: number[];
  log: TuningLog[];
  applied: TuningLog[];
  idPrefix: string;
  nextId: number;
  wallHighwater: number;
  /** Persisted kill switch: a restore-failed marker can never unlock AI tuning. */
  disabled?: true;
}

const pairs = (v: unknown): [unknown, unknown][] | undefined =>
  Array.isArray(v) && v.every((e) => Array.isArray(e) && e.length === 2) ? (v as [unknown, unknown][]) : undefined;

const uniqueKeys = (entries: [unknown, unknown][]): boolean =>
  new Set(entries.map((e) => e[0])).size === entries.length;

const seqOf = (id: string, prefix: string): number => {
  if (!id.startsWith(`${prefix}-`)) return Number.NaN;
  const n = Number(id.slice(prefix.length + 1));
  return Number.isSafeInteger(n) && n > 0 ? n : Number.NaN;
};

const remainings = (v: unknown, windowMs: number, cap: number): number[] | undefined => {
  if (!Array.isArray(v) || v.length > cap) return undefined;
  if (!v.every((x) => finiteNum(x) && x > 0 && x <= windowMs)) return undefined;
  return v as number[];
};

/**
 * Strictly validates a v2 snapshot against the *current* whitelist — every
 * value present exactly once with correct type/bounds/choices, collections
 * unique-keyed and well-formed, audit IDs `${idPrefix}-${seq}` unique below
 * `nextId`, and tighten-bound values backed by the applied log (a user may
 * legitimately loosen a floor, but a value with no applied change behind it
 * is forged). Throttle data is carried as remaining-window ms, capped per
 * window. ANY malformed piece returns undefined — partial restores are
 * never trusted. A `{version:2, disabled:'restore-failed'}` marker parses
 * to a disabled-only state.
 */
export function validateSnapshot(json: string, parameters: Record<string, ParameterSpec>): ValidatedState | undefined {
  try {
    const d = JSON.parse(json) as Record<string, unknown>;
    if (d === null || typeof d !== 'object' || Array.isArray(d) || d.version !== 2) return undefined;
    if (d.disabled === 'restore-failed') {
      return {
        values: [],
        locked: [],
        noise: [],
        alerts: [],
        hour: [],
        day: [],
        dayAll: [],
        log: [],
        applied: [],
        idPrefix: '',
        nextId: 1,
        wallHighwater: 0,
        disabled: true,
      };
    }
    const specs = new Map(Object.entries(parameters).map(([k, s]) => [k, validateSpec(k, s)]));
    if (
      typeof d.idPrefix !== 'string' ||
      d.idPrefix.length === 0 ||
      d.idPrefix.length > 100 ||
      !Number.isSafeInteger(d.nextId) ||
      (d.nextId as number) <= 0 ||
      !finiteNum(d.wallHighwater) ||
      (d.wallHighwater as number) < 0
    ) {
      return undefined;
    }
    const prefix = d.idPrefix;
    const st: ValidatedState = {
      values: [],
      locked: [],
      noise: [],
      alerts: [],
      hour: [],
      day: [],
      dayAll: [],
      log: [],
      applied: [],
      idPrefix: prefix,
      nextId: d.nextId as number,
      wallHighwater: d.wallHighwater as number,
    };

    const values = pairs(d.values);
    if (!values || !uniqueKeys(values) || values.length !== specs.size) return undefined;
    for (const [k, v] of values) {
      const spec = typeof k === 'string' ? specs.get(k) : undefined;
      if (!spec || !isValue(v) || typeof v !== typeof spec.value) return undefined;
      if (spec.choices && !spec.choices.includes(v)) return undefined;
      if (typeof v === 'number') {
        if (!finiteNum(v) || (spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max))
          return undefined;
      }
      st.values.push([k as string, v]);
    }

    if (!Array.isArray(d.locked) || new Set(d.locked).size !== d.locked.length) return undefined;
    for (const k of d.locked as unknown[]) {
      if (typeof k !== 'string' || !specs.has(k)) return undefined;
      st.locked.push(k);
    }

    const noise = pairs(d.noise);
    if (!noise || !uniqueKeys(noise)) return undefined;
    for (const [k, n] of noise) {
      if (typeof k !== 'string' || !Number.isInteger(n) || (n as number) < 0 || (n as number) > HOURLY_CAP)
        return undefined;
      st.noise.push([k, n as number]);
    }

    const alerts = pairs(d.alerts);
    if (!alerts || !uniqueKeys(alerts) || alerts.length > ALERT_CAP) return undefined;
    for (const [k, b] of alerts) {
      const a = b as AlertBinding;
      if (
        typeof k !== 'string' ||
        !a ||
        typeof a.ruleId !== 'string' ||
        a.ruleId === '' ||
        typeof a.param !== 'string' ||
        !specs.has(a.param)
      ) {
        return undefined;
      }
      st.alerts.push([k, { ruleId: a.ruleId, param: a.param }]);
    }

    const throttle = (v: unknown, windowMs: number, cap: number): [string, number[]][] | undefined => {
      const list = pairs(v);
      if (!list || !uniqueKeys(list)) return undefined;
      const out: [string, number[]][] = [];
      for (const [k, ts] of list) {
        const known = typeof k === 'string' && (specs.has(k) || /^baseline:[\w-]+:[\w-]+:\d{1,3}$/.test(k));
        const r = known ? remainings(ts, windowMs, cap) : undefined;
        if (!r) return undefined;
        out.push([k as string, r]);
      }
      return out;
    };
    const hour = throttle(d.hour, HOUR_MS, HOURLY_CAP);
    const day = throttle(d.day, DAY_MS, DAILY_CAP);
    const dayAll = remainings(d.dayAll, DAY_MS, GLOBAL_DAILY_CAP);
    if (!hour || !day || !dayAll) return undefined;
    st.hour = hour;
    st.day = day;
    st.dayAll = dayAll;

    const ids = new Set<number>();
    const readLog = (v: unknown, appliedOnly: boolean): TuningLog[] | undefined => {
      // The display log is capped; applied records are retained in full —
      // a flood of rejects must never evict a revertable change.
      if (!Array.isArray(v) || (!appliedOnly && v.length > LOG_CAP)) return undefined;
      const out: TuningLog[] = [];
      for (const e of v) {
        if (!isLogEntry(e)) return undefined;
        const n = seqOf(e.id, prefix);
        if (!Number.isSafeInteger(n) || ids.has(n) || n >= st.nextId) return undefined;
        if (appliedOnly && (e.status !== 'applied' || (e.operation !== 'propose' && e.operation !== 'revert'))) {
          return undefined;
        }
        ids.add(n);
        out.push({ ...e });
      }
      return out;
    };
    const log = readLog(d.log, false);
    ids.clear(); // Display and durable applied logs legitimately share entries.
    const applied = readLog(d.applied, true);
    if (!log || !applied) return undefined;
    const displayed = new Map(log.map((e) => [e.id, e]));
    if (applied.some((e) => displayed.has(e.id) && JSON.stringify(displayed.get(e.id)) !== JSON.stringify(e))) {
      return undefined;
    }
    st.log = log;
    st.applied = applied;

    // A tighten-bound value must trace to the declared value or an applied
    // change — user changes included, so a persisted user loosening restores.
    for (const [k, v] of st.values) {
      const spec = specs.get(k) as ParameterSpec;
      if (spec.tighten === undefined || v === spec.value) continue;
      if (!applied.some((e) => e.param === k && e.to === v)) return undefined;
    }
    return st;
  } catch {
    return undefined;
  }
}
