import type { BodyEvaluation, BodyEvaluator, BodyThresholdSample, BodyThresholdState } from '@asi/sense-types';
import { type BodySignal, type Metric, readMetrics } from './metrics.ts';
import { type AdaptiveState, BODY_HISTORY, type RateHistory, type RateWindow } from './state.ts';

/**
 * A rate-of-change rule (DESIGN §2.2c, layer `rate`). Exactly one limit is
 * required: `maxDelta` compares the signed last-first delta over the window,
 * `maxSlope` the OLS slope in units/second, `maxRatio` the delta over the
 * initial magnitude (a zero start with nonzero delta always breaches), and
 * `maxEtaMs` breaches when the projected time to the floor drops below the
 * limit — the comparison is INVERTED (1/eta vs 1/limit) so the usual 80%
 * hysteresis requires eta to climb 25% above the limit before rearming.
 * `direction` is the breach side (`up`/`down`); for `maxEtaMs` the metric
 * must be falling, so `direction` is descriptive only. `floor` overrides
 * the metric's natural exhaustion level for ETA reporting. `param` names a
 * tuning parameter consulted for the live limit. `metric` may end in `:*`
 * to match every metric with that prefix (e.g. `disk:*`); wildcard hits get
 * per-metric latches `rate:<id>:<metric>`.
 */
export type RateRule = {
  id: string;
  metric: string;
  windowMs: number;
  direction: 'up' | 'down';
  floor?: number;
  param?: string;
} & (
  | { maxDelta: number; maxSlope?: never; maxRatio?: never; maxEtaMs?: never }
  | { maxSlope: number; maxDelta?: never; maxRatio?: never; maxEtaMs?: never }
  | { maxRatio: number; maxDelta?: never; maxSlope?: never; maxEtaMs?: never }
  | { maxEtaMs: number; maxDelta?: never; maxSlope?: never; maxRatio?: never }
);

interface Point {
  at: number;
  value: number;
}

const LIMITS = ['maxDelta', 'maxSlope', 'maxRatio', 'maxEtaMs'] as const;

function validate(rule: RateRule, seen: Set<string>): void {
  const bad = (why: string) => new TypeError(`rate rule ${JSON.stringify(rule.id)}: ${why}`);
  if (typeof rule.id !== 'string' || rule.id === '' || seen.has(rule.id)) throw bad('id must be nonempty and unique');
  if (typeof rule.metric !== 'string' || rule.metric === '') throw bad('metric must be nonempty');
  if (rule.direction !== 'up' && rule.direction !== 'down') throw bad('direction must be up|down');
  if (!Number.isFinite(rule.windowMs) || rule.windowMs <= 0) throw bad('windowMs must be positive and finite');
  if (rule.floor !== undefined && !Number.isFinite(rule.floor)) throw bad('floor must be finite');
  const limits = LIMITS.filter((k) => rule[k] !== undefined);
  if (limits.length !== 1) throw bad(`exactly one of ${LIMITS.join('/')} is required`);
  const limit = rule[limits[0]] as number;
  if (!Number.isFinite(limit) || limit <= 0) throw bad('limit must be positive and finite');
  seen.add(rule.id);
}

/**
 * Pure rate-of-change {@link BodyEvaluator} (DESIGN §2.2c): ALL history
 * lives in the caller-threaded `{@link BODY_HISTORY}` metadata for
 * `next.source.id` — identical inputs give identical outputs, so replay
 * and retry are safe. Time is measured on the monotonic `monotonicAt`
 * stamp; the `at` fallback exists only for direct logical-replay callers
 * and must never be fed live wall time. A metric that goes missing clears
 * its window while the latch is retained — no fabricated recovery.
 * Signals (`body.rate`, layer `rate`) fire only on latch transitions.
 */
export class RateEvaluator implements BodyEvaluator {
  private readonly rules: RateRule[];
  private readonly threshold: (param: string, fallback: number) => number;

  constructor(rules: readonly RateRule[], threshold: (param: string, fallback: number) => number = (_p, n) => n) {
    const seen = new Set<string>();
    this.rules = rules.map((r) => {
      validate(r, seen);
      return { ...r };
    });
    this.threshold = threshold;
  }

  /** Max retention window for one concrete metric key. */
  private retention(key: string): number {
    let max = 0;
    for (const r of this.rules) {
      const match = r.metric.endsWith(':*') ? key.startsWith(r.metric.slice(0, -1)) : r.metric === key;
      if (match) max = Math.max(max, r.windowMs);
    }
    return max;
  }

  /** Concrete metric keys a rule evaluates (`prefix:*` wildcard or exact). */
  private metricKeys(rule: RateRule, metrics: Map<string, Metric>): string[] {
    if (!rule.metric.endsWith(':*')) return metrics.has(rule.metric) ? [rule.metric] : [];
    const prefix = rule.metric.slice(0, -1);
    const out: string[] = [];
    for (const k of metrics.keys()) if (k.startsWith(prefix)) out.push(k);
    return out;
  }

  private liveLimit(configured: number, param?: string): number {
    if (param === undefined) return configured;
    const v = this.threshold(param, configured);
    return Number.isFinite(v) && v > 0 ? v : configured;
  }

  evaluate(prev: BodyThresholdSample, next: BodyThresholdSample, state: BodyThresholdState): BodyEvaluation {
    if (!Number.isFinite(prev.monotonicAt) || !Number.isFinite(next.monotonicAt)) {
      throw new TypeError('rate: monotonicAt must be finite');
    }
    const pub: BodyThresholdState = { ...state };
    const inHist = (state as AdaptiveState)[BODY_HISTORY]?.[next.source.id]?.rate;
    const mono = next.monotonicAt; // logical-replay fallback — never live wall time
    if (!Number.isFinite(mono) || (inHist?.lastMono !== undefined && mono <= inHist.lastMono)) {
      return { signals: [], state: pub };
    }
    const metrics = readMetrics(next);
    const windows: Record<string, RateWindow> = {};
    for (const [k, w] of Object.entries(inHist?.windows ?? {})) {
      if (metrics.has(k)) windows[k] = w; // missing metric → window dropped, latch retained
    }
    const updated = new Map<string, RateWindow>();
    const windowFor = (key: string, metric: Metric): RateWindow => {
      const done = updated.get(key);
      if (done) return done;
      const old = windows[key];
      let pts: Point[];
      if (old) {
        pts = old.points.slice();
      } else {
        const seed = Number.isFinite(prev.at) ? readMetrics(prev).get(key) : undefined;
        const pMono = prev.monotonicAt;
        pts = seed && Number.isFinite(pMono) && pMono < mono ? [{ at: pMono as number, value: seed.value }] : [];
      }
      pts.push({ at: mono, value: metric.value });
      pts = pts.filter((p) => p.at >= mono - this.retention(key));
      const w: RateWindow = { points: pts, lastMono: mono };
      updated.set(key, w);
      return w;
    };
    // Per-stream latch (authoritative, metadata); `pub` keys are projections.
    const streamLatch: RateHistory['latch'] = { ...inHist?.latch };
    const signals: BodySignal[] = [];
    for (const rule of this.rules) {
      for (const key of this.metricKeys(rule, metrics)) {
        const metric = metrics.get(key) as Metric;
        const w = windowFor(key, metric);
        const pts = w.points.filter((p) => p.at >= mono - rule.windowMs);
        if (pts.length < 2) continue;
        const sig = this.step(rule, key, metric, pts, next, pub, streamLatch);
        if (sig) signals.push(sig);
      }
    }
    const history: RateHistory = {
      lastMono: mono,
      windows: { ...windows, ...Object.fromEntries(updated) },
      latch: streamLatch,
    };
    const stream = { ...(state as AdaptiveState)[BODY_HISTORY]?.[next.source.id], rate: history };
    const hist = { ...(state as AdaptiveState)[BODY_HISTORY], [next.source.id]: stream };
    const out: AdaptiveState = { ...pub, [BODY_HISTORY]: hist };
    return { signals, state: out };
  }

  /** Evaluates one rule against one metric's points; emits on latch transitions. */
  private step(
    rule: RateRule,
    key: string,
    metric: Metric,
    pts: Point[],
    next: BodyThresholdSample,
    pub: BodyThresholdState,
    streamLatch: Record<string, 'normal' | 'warn'>,
  ): BodySignal | undefined {
    const first = pts[0];
    const last = pts[pts.length - 1];
    const delta = last.value - first.value;
    const slope = ols(pts);
    if (slope === undefined) return undefined; // degenerate x — cannot measure a rate
    const floor = rule.floor ?? metric.floor;
    const eta = floor !== undefined && slope < 0 ? Math.max(0, ((last.value - floor) / -slope) * 1000) : undefined;
    let magnitude: number;
    let limit: number;
    if (rule.maxEtaMs !== undefined) {
      // Inverted: danger rises as eta shrinks; eta = ∞ (stable/rising) → 0.
      magnitude = 1 / (eta ?? Number.POSITIVE_INFINITY);
      limit = 1 / this.liveLimit(rule.maxEtaMs, rule.param);
    } else {
      const measure =
        rule.maxDelta !== undefined
          ? delta
          : rule.maxSlope !== undefined
            ? slope
            : first.value === 0
              ? delta === 0
                ? 0
                : Math.sign(delta) * Number.POSITIVE_INFINITY
              : delta / Math.abs(first.value);
      magnitude = rule.direction === 'up' ? measure : -measure;
      limit = this.liveLimit((rule.maxDelta ?? rule.maxSlope ?? rule.maxRatio) as number, rule.param);
    }
    const latchKey = rule.metric.endsWith(':*') ? `rate:${rule.id}:${key}` : `rate:${rule.id}`;
    const was = streamLatch[latchKey] === 'warn';
    const active =
      (rule.maxEtaMs !== undefined ? magnitude >= limit : magnitude > limit) || (was && magnitude >= limit * 0.8);
    streamLatch[latchKey] = active ? 'warn' : 'normal';
    pub[latchKey] = active ? 'warn' : 'normal';
    if (active === was) return undefined;
    const severity = active ? 'warn' : 'normal';
    const data: Record<string, unknown> = {
      layer: 'rate',
      severity,
      ruleId: rule.id,
      metric: key,
      windowMs: rule.windowMs,
      delta,
      slope,
      direction: rule.direction,
    };
    if (eta !== undefined) {
      data.etaToFloorMs = data.timeToFloorMs = eta;
    }
    return {
      id: `${next.source.id}:${latchKey}:${next.monotonicAt}:${severity}`,
      kind: 'body.rate',
      at: next.at,
      source: next.source,
      subject: latchKey,
      layer: 'rate',
      data,
    };
  }
}

/** OLS slope in units/second, x measured relative to the first point. */
function ols(pts: Point[]): number | undefined {
  const n = pts.length;
  const t0 = pts[0].at;
  let meanX = 0;
  let meanY = 0;
  for (const p of pts) {
    meanX += (p.at - t0) / 1000;
    meanY += p.value;
  }
  meanX /= n;
  meanY /= n;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    const dx = (p.at - t0) / 1000 - meanX;
    sxx += dx * dx;
    sxy += dx * (p.value - meanY);
  }
  return sxx === 0 ? undefined : sxy / sxx;
}
