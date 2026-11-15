import type { BodyEvaluation, BodyEvaluator, BodyThresholdSample, BodyThresholdState } from '@asi/sense-types';
import type { Baseline } from './baseline.ts';
import { type BodySignal, readMetrics } from './metrics.ts';

/** A baseline-deviation rule (DESIGN §2.2c, layer `baseline`). */
export interface AnomalyRule {
  id: string;
  metric: string;
  /** Sigma multiplier; default 3. */
  sigma?: number;
  /** Consecutive breaches required to latch warn; default 3. */
  consecutive?: number;
  /** Tuning parameter consulted for the live sigma. */
  param?: string;
}

interface NormalizedRule {
  id: string;
  metric: string;
  sigma: number;
  consecutive: number;
  param?: string;
}

/**
 * Baseline-deviation {@link BodyEvaluator} (DESIGN §2.2c). Compares each
 * sample against the baseline learned *before* it, then trains on it —
 * strictly increasing `at` only, so nothing trains or counts twice. Until
 * `learningProgress` reaches 30% deviations are not evaluated, though
 * training continues. k = sigma*(2-confidence): low-confidence buckets get
 * a wider net. Missing metrics clear the pending streak and keep the latch;
 * un-evaluable buckets do the same — no fabricated recovery.
 */
export class AnomalyEvaluator implements BodyEvaluator {
  private readonly baseline: Baseline;
  private readonly rules: NormalizedRule[];
  private readonly threshold: (param: string, fallback: number) => number;
  private readonly streaks = new Map<string, number>();
  private lastAt: number | undefined;

  constructor(
    baseline: Baseline,
    rules: readonly AnomalyRule[],
    threshold: (param: string, fallback: number) => number = (_p, n) => n,
  ) {
    this.baseline = baseline;
    const seen = new Set<string>();
    this.rules = rules.map((r) => {
      const bad = (w: string) => new TypeError(`anomaly rule ${JSON.stringify(r.id)}: ${w}`);
      if (typeof r.id !== 'string' || r.id === '' || seen.has(r.id)) throw bad('id must be nonempty and unique');
      if (typeof r.metric !== 'string' || r.metric === '') throw bad('metric must be nonempty');
      const sigma = r.sigma ?? 3;
      if (!Number.isFinite(sigma) || sigma <= 0) throw bad('sigma must be positive and finite');
      const consecutive = r.consecutive ?? 3;
      if (!Number.isInteger(consecutive) || consecutive <= 0) throw bad('consecutive must be a positive integer');
      seen.add(r.id);
      return { id: r.id, metric: r.metric, sigma, consecutive, ...(r.param ? { param: r.param } : {}) };
    });
    this.threshold = threshold;
  }

  evaluate(_prev: BodyThresholdSample, next: BodyThresholdSample, state: BodyThresholdState): BodyEvaluation {
    const out: BodyThresholdState = { ...state };
    if (!Number.isFinite(next.at) || (this.lastAt !== undefined && next.at <= this.lastAt)) {
      return { signals: [], state: out };
    }
    this.lastAt = next.at;
    const metrics = readMetrics(next);
    const gated = this.baseline.learningProgress >= 30;
    const signals: BodySignal[] = [];
    for (const rule of this.rules) {
      const key = `baseline:${rule.id}`;
      const metric = metrics.get(rule.metric);
      const stat = metric ? this.baseline.read(rule.metric, next.at) : undefined;
      if (!metric || !stat || !gated) {
        this.streaks.set(rule.id, 0); // no evidence: streak cleared, latch kept
        continue;
      }
      const resolved = rule.param !== undefined ? this.threshold(rule.param, rule.sigma) : rule.sigma;
      const sigma = Number.isFinite(resolved) && resolved > 0 ? resolved : rule.sigma;
      const k = sigma * (2 - stat.confidence);
      const deviation = Math.abs(metric.value - stat.mean) / stat.scale;
      const streak = deviation > k ? (this.streaks.get(rule.id) ?? 0) + 1 : 0;
      this.streaks.set(rule.id, streak);
      const was = out[key] === 'warn';
      const active = streak >= rule.consecutive || (was && deviation >= 0.8 * k);
      out[key] = active ? 'warn' : 'normal';
      if (active === was) continue;
      const severity = active ? 'warn' : 'normal';
      signals.push({
        id: `${next.source.id}:baseline:${rule.id}:${next.at}:${severity}`,
        kind: 'body.anomaly',
        at: next.at,
        source: next.source,
        subject: key,
        layer: 'baseline',
        data: {
          layer: 'baseline',
          severity,
          ruleId: rule.id,
          metric: rule.metric,
          value: metric.value,
          baseline: stat.mean,
          deviation,
          k,
          confidence: stat.confidence,
        },
      });
    }
    // Train on every valid reading, once per accepted sample.
    for (const [name, m] of metrics) this.baseline.observe(name, m.value, next.at);
    return { signals, state: out };
  }
}
