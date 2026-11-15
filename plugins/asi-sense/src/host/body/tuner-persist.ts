import type { TuningValue } from '@asi/sense-types';
import {
  ALERT_CAP,
  type AlertBinding,
  finiteNum,
  HOUR_MS,
  HOURLY_CAP,
  isLogEntry,
  isValue,
  LOG_CAP,
  type ParameterSpec,
  type TuningLog,
  validateSpec,
} from './tuner-spec.ts';

/** Fully validated snapshot contents, ready for atomic application. */
export interface ValidatedState {
  values: [string, TuningValue][];
  locked: string[];
  noise: [string, number][];
  alerts: [string, AlertBinding][];
  throttle: [string, number[]][];
  log: TuningLog[];
  nextId: number;
}

const pairs = (v: unknown): [unknown, unknown][] | undefined =>
  Array.isArray(v) && v.every((e) => Array.isArray(e) && e.length === 2) ? (v as [unknown, unknown][]) : undefined;

const uniqueKeys = (entries: [unknown, unknown][]): boolean =>
  new Set(entries.map((e) => e[0])).size === entries.length;

const ID_RE = /^chg-(\d+)$/;

/**
 * Strictly validates a v1 snapshot against the *current* whitelist — every
 * value present exactly once, correct type/bounds/choices, and no safety
 * floor looser than its declared value. All collections must be unique-keyed
 * and well-formed; audit IDs must be unique `chg-N` below `nextId`. ANY
 * malformed piece returns undefined — partial restores are never trusted.
 * Expired throttle stamps are filtered only after everything validates.
 */
export function validateSnapshot(
  json: string,
  parameters: Record<string, ParameterSpec>,
  clock: () => number,
): ValidatedState | undefined {
  try {
    const d = JSON.parse(json) as Record<string, unknown>;
    if (d?.version !== 1 || !Number.isSafeInteger(d.nextId) || (d.nextId as number) <= 0) return undefined;
    const specs = new Map(Object.entries(parameters).map(([k, s]) => [k, validateSpec(k, s)]));
    const st: ValidatedState = {
      values: [],
      locked: [],
      noise: [],
      alerts: [],
      throttle: [],
      log: [],
      nextId: d.nextId as number,
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
        const declared = spec.value as number;
        if ((spec.tighten === 'up' && v < declared) || (spec.tighten === 'down' && v > declared)) return undefined;
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

    const throttle = pairs(d.throttle);
    if (!throttle || !uniqueKeys(throttle)) return undefined;
    const now = clock();
    for (const [k, ts] of throttle) {
      if (
        typeof k !== 'string' ||
        !specs.has(k) ||
        !Array.isArray(ts) ||
        ts.length > HOURLY_CAP ||
        !ts.every(finiteNum)
      ) {
        return undefined;
      }
      st.throttle.push([k, (ts as number[]).filter((x) => now - x < HOUR_MS)]);
    }

    const log = d.log;
    if (!Array.isArray(log) || log.length > LOG_CAP) return undefined;
    const ids = new Set<number>();
    for (const e of log) {
      if (!isLogEntry(e)) return undefined;
      const m = ID_RE.exec(e.id);
      const n = m ? Number(m[1]) : Number.NaN;
      if (!Number.isSafeInteger(n) || n <= 0 || ids.has(n) || n >= st.nextId) return undefined;
      ids.add(n);
      st.log.push({ ...e });
    }
    return st;
  } catch {
    return undefined;
  }
}
