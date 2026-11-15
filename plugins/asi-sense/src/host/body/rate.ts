import type { BodyEvaluation, BodyEvaluator, BodyThresholdSample, BodyThresholdState } from '@asi/sense-types';
import { type BodySignal, type Metric, readMetrics } from './metrics.ts';
import { TimeWindow } from './window.ts';

/**
 * A rate-of-change rule (DESIGN §2.2c, layer `rate`). Exactly one limit is
 * required: `maxDelta` compares the signed last-first delta over the window,
 * `maxSlope` the OLS slope in units/second. `direction` is the breach side;
 * `floor` overrides the metric's natural exhaustion level for ETA reporting.
 * `param` names a tuning parameter consulted for the live limit.
 */
export type RateRule = {
  id: string;
  metric: string;
  windowMs: number;
  direction: 'up' | 'down';
  floor?: number;
  param?: string;
} & ({ maxDelta: number; maxSlope?: never } | { maxSlope: number; maxDelta?: never });

interface Point {
  at: number;
  value: number;
}

interface History {
  win: TimeWindow<Point>;
  lastAt: number;
}

function validate(rule: RateRule, seen: Set<string>): void {
  const bad = (why: string) => new TypeError(`rate rule ${JSON.stringify(rule.id)}: ${why}`);
  if (typeof rule.id !== 'string' || rule.id === '' || seen.has(rule.id)) throw bad('id must be nonempty and unique');
  if (typeof rule.metric !== 'string' || rule.metric === '') throw bad('metric must be nonempty');
  if (rule.direction !== 'up' && rule.direction !== 'down') throw bad('direction must be up|down');
  if (!Number.isFinite(rule.windowMs) || rule.windowMs <= 0) throw bad('windowMs must be positive and finite');
  if (rule.floor !== undefined && !Number.isFinite(rule.floor)) throw bad('floor must be finite');
  const hasDelta = rule.maxDelta !== undefined;
  const hasSlope = rule.maxSlope !== undefined;
  if (hasDelta === hasSlope) throw bad('exactly one of maxDelta/maxSlope is required');
  const limit = hasDelta ? rule.maxDelta : rule.maxSlope;
  if (!Number.isFinite(limit) || (limit as number) <= 0) throw bad('limit must be positive and finite');
  seen.add(rule.id);
}

/**
 * Rate-of-change {@link BodyEvaluator} (DESIGN §2.2c). Per-metric time
 * windows are seeded from `prev` on first sight and fed by `next`; samples
 * with equal or backward `at` are ignored wholesale. A metric that goes
 * missing breaks its history while the latch is retained — no fabricated
 * recovery. `state` keys are `rate:${rule.id}` with `warn`/`normal` values;
 * signals (`body.rate`, layer `rate`) fire only on latch transitions, with
 * an 80%-of-limit hysteresis band.
 */
export class RateEvaluator implements BodyEvaluator {
  private readonly rules: RateRule[];
  private readonly threshold: (param: string, fallback: number) => number;
  private readonly maxWindow = new Map<string, number>();
  private readonly histories = new Map<string, History>();
  private lastAt: number | undefined;

  constructor(rules: readonly RateRule[], threshold: (param: string, fallback: number) => number = (_p, n) => n) {
    const seen = new Set<string>();
    this.rules = rules.map((r) => {
      validate(r, seen);
      return { ...r };
    });
    for (const r of this.rules) {
      this.maxWindow.set(r.metric, Math.max(this.maxWindow.get(r.metric) ?? 0, r.windowMs));
    }
    this.threshold = threshold;
  }

  evaluate(prev: BodyThresholdSample, next: BodyThresholdSample, state: BodyThresholdState): BodyEvaluation {
    const out: BodyThresholdState = { ...state };
    if (!Number.isFinite(next.at) || (this.lastAt !== undefined && next.at <= this.lastAt)) {
      return { signals: [], state: out };
    }
    this.lastAt = next.at;
    const metrics = readMetrics(next);
    for (const key of [...this.histories.keys()]) {
      if (!metrics.has(key)) this.histories.delete(key);
    }
    const signals: BodySignal[] = [];
    let prevMetrics: Map<string, Metric> | undefined;
    for (const rule of this.rules) {
      const metric = metrics.get(rule.metric);
      if (!metric) continue;
      let hist = this.histories.get(rule.metric);
      if (!hist) {
        hist = { win: new TimeWindow<Point>(), lastAt: Number.NEGATIVE_INFINITY };
        this.histories.set(rule.metric, hist);
        prevMetrics ??= Number.isFinite(prev.at) ? readMetrics(prev) : new Map();
        const seed = prevMetrics.get(rule.metric);
        if (seed && prev.at < next.at) {
          hist.win.push({ at: prev.at, value: seed.value });
          hist.lastAt = prev.at;
        }
      }
      if (next.at > hist.lastAt) {
        hist.win.push({ at: next.at, value: metric.value });
        hist.lastAt = next.at;
      }
      hist.win.prune(next.at - (this.maxWindow.get(rule.metric) ?? rule.windowMs));
      const pts = hist.win.values(next.at - rule.windowMs);
      if (pts.length < 2) continue;
      const first = pts[0];
      const last = pts[pts.length - 1];
      const delta = last.value - first.value;
      const slope = ols(pts);
      if (slope === undefined) continue;
      const measure = rule.maxDelta !== undefined ? delta : slope;
      const magnitude = rule.direction === 'up' ? measure : -measure;
      const fallback = rule.maxDelta ?? rule.maxSlope ?? 0;
      const resolved = rule.param !== undefined ? this.threshold(rule.param, fallback) : fallback;
      // A broken live lookup can never fabricate or loosen the configured limit.
      const limit = Number.isFinite(resolved) && resolved > 0 ? resolved : fallback;
      const key = `rate:${rule.id}`;
      const was = out[key] === 'warn';
      const active = magnitude > limit || (was && magnitude >= limit * 0.8);
      out[key] = active ? 'warn' : 'normal';
      if (active === was) continue;
      signals.push(this.signal(rule, metric, next, delta, slope, last, active));
    }
    return { signals, state: out };
  }

  private signal(
    rule: RateRule,
    metric: Metric,
    next: BodyThresholdSample,
    delta: number,
    slope: number,
    last: Point,
    active: boolean,
  ): BodySignal {
    const severity = active ? 'warn' : 'normal';
    const data: Record<string, unknown> = {
      layer: 'rate',
      severity,
      ruleId: rule.id,
      metric: rule.metric,
      windowMs: rule.windowMs,
      delta,
      slope,
      direction: rule.direction,
    };
    const floor = rule.floor ?? metric.floor;
    if (slope < 0 && floor !== undefined) {
      data.etaToFloorMs = data.timeToFloorMs = Math.max(0, ((last.value - floor) / -slope) * 1000);
    }
    return {
      id: `${next.source.id}:rate:${rule.id}:${next.at}:${severity}`,
      kind: 'body.rate',
      at: next.at,
      source: next.source,
      subject: `rate:${rule.id}`,
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
