import type { TuningChange, TuningValue } from '@asi/sense-types';

/** Audit record: a tuning attempt plus its outcome (DESIGN §2.2c). */
export type TuningLog = TuningChange & {
  operation: 'propose' | 'revert' | 'feedback' | 'lock' | 'unlock';
  status: 'applied' | 'rejected';
  rejectionReason?: string;
};

/** Whitelist entry: declared value plus the guard contract for a parameter. */
export interface ParameterSpec {
  value: TuningValue;
  min?: number;
  max?: number;
  choices?: TuningValue[];
  /** 'up' forbids decreases, 'down' forbids increases (safety floors; numeric only). */
  tighten?: 'up' | 'down';
  /** Feedback policy: 'up' widens the limit on noise, 'down' narrows it (numeric only). */
  noiseDirection?: 'up' | 'down';
}

export interface AlertBinding {
  ruleId: string;
  param: string;
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const LOG_CAP = 500;
export const ALERT_CAP = 500;
export const HOURLY_CAP = 2;
export const DAILY_CAP = 6;
export const GLOBAL_DAILY_CAP = 24;
export const VALID_BY = ['user', 'agent', 'auto'] as const;
export const VALID_OPS = ['propose', 'revert', 'feedback', 'lock', 'unlock'] as const;

/** Known safety floors (DESIGN §2.2c): AI may only ever tighten these. */
const KNOWN_FLOOR = /^(disk|context|battery)(\.(warn|critical))?$/;

/**
 * Floor-spec rule: `floor.<known>` must tighten `up`; every other `floor.*`
 * parameter must still declare an explicit tighten direction. Floor specs
 * are required to carry a numeric finite value.
 */
export function floorDirection(name: string): 'up' | 'down' | 'any' | undefined {
  if (!name.startsWith('floor.')) return undefined;
  return KNOWN_FLOOR.test(name.slice('floor.'.length)) ? 'up' : 'any';
}

export const finiteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const isValue = (v: unknown): v is TuningValue =>
  typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean';

/** JSON.stringify(NaN/±Infinity) → null — audit stores those as strings. */
export const safeAuditValue = (v: TuningValue): TuningValue =>
  typeof v === 'number' && !Number.isFinite(v) ? String(v) : v;

export function validateSpec(name: string, spec: ParameterSpec): ParameterSpec {
  const bad = (w: string) => new TypeError(`tuner param ${JSON.stringify(name)}: ${w}`);
  if (spec === null || typeof spec !== 'object') throw bad('spec must be an object');
  const { value } = spec;
  if (!isValue(value)) throw bad('value must be number|string|boolean');
  const floor = floorDirection(name);
  if (floor !== undefined && typeof value !== 'number') throw bad('floor params require a numeric value');
  if (typeof value === 'number') {
    if (!finiteNum(value)) throw bad('value must be finite');
    for (const b of ['min', 'max'] as const)
      if (spec[b] !== undefined && !finiteNum(spec[b])) throw bad(`${b} must be finite`);
    if (spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) throw bad('min > max');
    if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) {
      throw bad('value outside bounds');
    }
  }
  if (spec.choices !== undefined) {
    if (!Array.isArray(spec.choices) || spec.choices.length === 0) throw bad('choices must be a nonempty array');
    if (
      !spec.choices.every((c) => isValue(c) && typeof c === typeof value && (typeof c !== 'number' || finiteNum(c)))
    ) {
      throw bad('choice type mismatch');
    }
    if (!spec.choices.includes(value)) throw bad('value not in choices');
  }
  for (const k of ['tighten', 'noiseDirection'] as const) {
    if (spec[k] === undefined) continue;
    if (spec[k] !== 'up' && spec[k] !== 'down') throw bad(`${k} must be up|down`);
    if (typeof value !== 'number') throw bad(`${k} requires a numeric value`);
  }
  if (floor === 'up' && spec.tighten !== 'up') throw bad("known floor params must declare tighten 'up'");
  if (floor === 'any' && spec.tighten === undefined) throw bad('floor params require an explicit tighten direction');
  return { ...spec, choices: spec.choices ? [...spec.choices] : undefined };
}

/** Full field-level v1 audit-entry validation (id shape checked by caller). */
export const isLogEntry = (e: unknown): e is TuningLog => {
  const l = e as TuningLog;
  return (
    l !== null &&
    typeof l === 'object' &&
    typeof l.id === 'string' &&
    typeof l.param === 'string' &&
    isValue(l.from) &&
    (typeof l.from !== 'number' || finiteNum(l.from)) &&
    isValue(l.to) &&
    (typeof l.to !== 'number' || finiteNum(l.to)) &&
    finiteNum(l.at) &&
    typeof l.reason === 'string' &&
    (l.rejectionReason === undefined || typeof l.rejectionReason === 'string') &&
    (VALID_BY as readonly string[]).includes(l.by) &&
    (VALID_OPS as readonly string[]).includes(l.operation) &&
    (l.status === 'applied' || l.status === 'rejected')
  );
};
