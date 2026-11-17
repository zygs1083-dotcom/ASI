import type {
  Body,
  BodyEvaluation,
  BodyEvaluator,
  BodyThresholdSample,
  BodyThresholdState,
  BodyThresholds,
  Fact,
  Signal,
  ThresholdSeverity,
} from '@asi/sense-types';
import { effectiveDisks, factStatusAt } from '@asi/sense-types';

export type {
  BodyEvaluation,
  BodyEvaluator,
  BodyThresholdSample,
  BodyThresholdState,
  BodyThresholds,
  ThresholdSeverity,
};

/** Approved defaults (DESIGN §2.2b). Any doc examples are illustrative only. */
export const BODY_THRESHOLDS: BodyThresholds = {
  disk: { warn: 0.1, critical: 0.05 },
  context: { warn: 0.15, critical: 0.05 },
  battery: { warn: 0.15, critical: 0.05 },
  hysteresis: 0.05,
};

type Ratio = { warn: number; critical: number };

interface Reading {
  severity: ThresholdSeverity;
  value: number | string;
  /** Lower-is-worse fraction; when present the latch applies hysteresis. */
  ratio?: number;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function okFact<T>(fact: Fact<T>, at: number): T | undefined {
  return factStatusAt(fact, at) === 'ok' && fact.value !== null ? fact.value : undefined;
}

/** Classify a lower-is-worse ratio without hysteresis (used to infer prior latch). */
function classify(v: number, t: Ratio): ThresholdSeverity {
  if (v < t.critical) return 'critical';
  return v < t.warn ? 'warn' : 'normal';
}

/** Latched lower-is-worse transition: recover only past threshold+hysteresis. */
export function latchRatio(prior: ThresholdSeverity, v: number, t: Ratio, hyst: number): ThresholdSeverity {
  // Decimal percentage boundaries can differ by one floating-point ULP.
  const recovered = (threshold: number) => v + Number.EPSILON >= threshold + hyst;
  if (prior === 'critical') {
    if (!recovered(t.critical)) return 'critical';
    return recovered(t.warn) ? 'normal' : 'warn';
  }
  if (prior === 'warn') {
    if (v < t.critical) return 'critical';
    return recovered(t.warn) ? 'normal' : 'warn';
  }
  return classify(v, t);
}

function ratioReading(v: number, t: Ratio): Reading {
  return { severity: classify(v, t), value: v, ratio: v };
}

/** Extracts the raw reading for a metric key, or undefined when invalid/missing. */
function read(body: Body, at: number, key: string, t: BodyThresholds): Reading | undefined {
  const i = key.indexOf(':');
  const metric = i < 0 ? key : key.slice(0, i);
  const arg = i < 0 ? '' : key.slice(i + 1);
  if (metric === 'disk') {
    const d = effectiveDisks(body.disks, at).value?.find((x) => x.mount === arg && x.status === 'ok');
    if (!d || !finite(d.total) || !finite(d.free) || d.total <= 0 || d.free < 0 || d.free > d.total) {
      return undefined;
    }
    return ratioReading(d.free / d.total, t.disk);
  }
  if (metric === 'context') {
    const tok = okFact(body.tokens, at);
    // Only the actual usage counts: contextProjected is a forecast, never a
    // reading, and without contextUsed there is nothing to evaluate.
    const used = tok?.contextUsed;
    // used < 0 is corrupt (retain latch, fabricate nothing); used > window is
    // a real overflow and evaluates to a negative ratio → critical.
    if (!tok || !finite(tok.contextWindow) || tok.contextWindow <= 0 || !finite(used) || used < 0) {
      return undefined;
    }
    return ratioReading((tok.contextWindow - used) / tok.contextWindow, t.context);
  }
  if (metric === 'battery') {
    const b = okFact(body.battery, at);
    if (!b || !finite(b.percent) || b.percent < 0 || b.percent > 100) return undefined;
    if (b.charging) return { severity: 'normal', value: b.percent };
    return ratioReading(b.percent / 100, t.battery);
  }
  if (metric === 'memory') {
    const m = okFact(body.memory, at);
    const p = m?.pressure;
    if (p !== 'normal' && p !== 'warn' && p !== 'critical') return undefined;
    return { severity: p, value: p };
  }
  if (metric === 'thermal') {
    const th = okFact(body.thermal, at);
    if (th === 'nominal' || th === 'fair') return { severity: 'normal', value: th };
    if (th === 'serious') return { severity: 'warn', value: th };
    if (th === 'critical') return { severity: 'critical', value: th };
    return undefined;
  }
  return undefined;
}

function metricKeys(body: Body, at: number): string[] {
  const keys = ['context', 'battery', 'memory', 'thermal'];
  const disks = effectiveDisks(body.disks, at);
  for (const d of disks.value ?? []) if (d.status === 'ok') keys.push(`disk:${d.mount}`);
  return keys;
}

/**
 * Pure threshold evaluator (DESIGN §2.2b). Compares two body samples and emits
 * `body.threshold` signals only on latch transitions: entering/escalating
 * warn or critical, and clearing/reducing after hysteresis (recovery emits
 * `severity: 'normal'`, which the default rules map to record).
 *
 * Latch semantics: the caller feeds back the returned `state` as
 * `prev.state` on the following call. When `prev.state` is absent the prior
 * level is inferred by classifying the previous (valid) sample once, so a
 * condition that pre-dates monitoring does not alert repeatedly. Readings
 * that are missing, stale, non-finite or out of range produce no signal and
 * retain the previous latch — never a fabricated recovery. Charging batteries
 * evaluate as `normal`. Facts are read with {@link factStatusAt} so stale
 * facts are ignored.
 */
export function bodyThresholdSignals(
  prev: BodyThresholdSample,
  next: BodyThresholdSample,
  thresholds: BodyThresholds = BODY_THRESHOLDS,
): { signals: Signal[]; state: BodyThresholdState } {
  const state: BodyThresholdState = { ...prev.state };
  const sessions = (next as BodyThresholdSample & { contextSessions?: string[] }).contextSessions;
  if (sessions) {
    for (const key of Object.keys(state))
      if (key.startsWith('context@') && !sessions.includes(key.slice('context@'.length))) delete state[key];
  }
  const signals: Signal[] = [];
  const keys = new Set([...metricKeys(next.body, next.at), ...Object.keys(state)]);
  for (const key of keys) {
    if (key.startsWith('context@')) continue;
    const nextReading = read(next.body, next.at, key, thresholds);
    if (!nextReading) continue;
    const session = (next as BodyThresholdSample & { contextSession?: string }).contextSession;
    const previousSession = (prev as BodyThresholdSample & { contextSession?: string }).contextSession;
    const latchKey = key === 'context' && session ? `context@${session}` : key;
    let prior = state[latchKey];
    if (prior === undefined) {
      prior =
        key === 'context' && session !== previousSession
          ? 'normal'
          : (read(prev.body, prev.at, key, thresholds)?.severity ?? 'normal');
    }
    const ratioKey = key === 'context' || key === 'battery' ? key : key.split(':')[0];
    const level =
      nextReading.ratio !== undefined
        ? latchRatio(
            prior,
            nextReading.ratio,
            thresholds[ratioKey as 'disk' | 'context' | 'battery'],
            thresholds.hysteresis,
          )
        : nextReading.severity;
    state[key] = level;
    state[latchKey] = level;
    if (level === prior) continue;
    signals.push({
      id: `${next.source.id}:${key}:${next.at}:${level}${key === 'context' && session ? `:${session}` : ''}`,
      kind: 'body.threshold',
      at: next.at,
      source: next.source,
      subject: key,
      data: { severity: level, value: nextReading.value },
    });
  }
  return { signals, state };
}

/**
 * Fixed-threshold {@link BodyEvaluator}; callers own and feed back the latch.
 */
export class FloorEvaluator implements BodyEvaluator {
  private readonly thresholds: BodyThresholds;

  constructor(thresholds: BodyThresholds = BODY_THRESHOLDS) {
    this.thresholds = thresholds;
  }

  evaluate(prev: BodyThresholdSample, next: BodyThresholdSample, state: BodyThresholdState): BodyEvaluation {
    return bodyThresholdSignals({ ...prev, state }, next, this.thresholds);
  }
}
