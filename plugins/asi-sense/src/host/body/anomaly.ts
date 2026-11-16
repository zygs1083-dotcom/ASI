import type { BodyEvaluation, BodyEvaluator, BodyThresholdSample, BodyThresholdState } from '@asi/sense-types';
import { BASELINE_MIN_COUNT, BASELINE_MIN_DATES, type Baseline } from './baseline.ts';
import { type BodySignal, readMetrics } from './metrics.ts';
import { type AdaptiveState, BODY_HISTORY } from './state.ts';

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
 * Pure baseline-deviation {@link BodyEvaluator} (DESIGN §2.2c). Everything
 * it remembers — streaks, ordering stamp and the trained baseline — lives
 * in caller-owned {@link BODY_HISTORY} metadata for `next.source.id`, so
 * the same inputs always give the same output and interleaved streams or
 * retries cannot contaminate each other. The constructor `Baseline` is an
 * immutable SEED: each accepted sample is compared against the baseline
 * learned before it, then a fork trained on it is returned in state.
 * Deviation is gated on 24 FULL hours since install (sample clock) AND a
 * bucket with ≥8 samples spanning ≥2 distinct local dates. k =
 * sigma*(2-confidence). Missing metrics clear the streak, keep the latch.
 */
export class AnomalyEvaluator implements BodyEvaluator {
  private readonly seed: Baseline;
  private readonly rules: NormalizedRule[];
  private readonly threshold: (param: string, fallback: number) => number;

  constructor(
    baseline: Baseline,
    rules: readonly AnomalyRule[],
    threshold: (param: string, fallback: number) => number = (_p, n) => n,
  ) {
    this.seed = baseline;
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
    const pub: BodyThresholdState = { ...state };
    const streamId = next.source.id;
    const inHist = (state as AdaptiveState)[BODY_HISTORY]?.[streamId]?.anomaly;
    if (!Number.isFinite(next.at) || (inHist?.lastAt !== undefined && next.at <= inHist.lastAt)) {
      return { signals: [], state: pub };
    }
    const baseline = inHist?.baseline ?? this.seed;
    const metrics = readMetrics(next);
    const gated = baseline.mature(next.at);
    const signals: BodySignal[] = [];
    const streaks: Record<string, number> = {};
    // Per-stream latch (authoritative); `pub` keys are last-writer projections.
    const streamLatch: Record<string, 'normal' | 'warn'> = { ...inHist?.latch };
    // An eligible above-k candidate NEVER trains the baseline — pending or
    // warned — so sustained anomalies cannot contaminate their own mean.
    const contaminating = new Set<string>();
    for (const rule of this.rules) {
      const key = `baseline:${rule.id}`;
      const metric = metrics.get(rule.metric);
      const stat = metric ? baseline.read(rule.metric, next.at) : undefined;
      const eligible = stat !== undefined && stat.count >= BASELINE_MIN_COUNT && stat.dates >= BASELINE_MIN_DATES;
      if (!metric || !stat || !gated || !eligible) {
        streaks[rule.id] = 0; // no evidence: streak cleared, latch kept
        continue;
      }
      const resolved = rule.param !== undefined ? this.threshold(rule.param, rule.sigma) : rule.sigma;
      const sigma = Number.isFinite(resolved) && resolved > 0 ? resolved : rule.sigma;
      const k = sigma * (2 - stat.confidence);
      const deviation = Math.abs(metric.value - stat.mean) / stat.scale;
      const streak = deviation > k ? (inHist?.streaks[rule.id] ?? 0) + 1 : 0;
      streaks[rule.id] = streak;
      const was = streamLatch[key] === 'warn';
      const active = streak >= rule.consecutive || (was && deviation >= 0.8 * k);
      if (deviation > k || active) contaminating.add(rule.metric);
      streamLatch[key] = active ? 'warn' : 'normal';
      pub[key] = active ? 'warn' : 'normal';
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
          dates: stat.dates,
        },
      });
    }
    // Train on every valid non-contaminating reading, once per accepted
    // sample — on a fork, never the seed or the caller's baseline.
    let trained = baseline;
    if (metrics.size > contaminating.size) {
      trained = baseline.clone();
      for (const [name, m] of metrics) if (!contaminating.has(name)) trained.observe(name, m.value, next.at);
    }
    const anomaly = { lastAt: next.at, streaks, latch: streamLatch, baseline: trained };
    const stream = { ...(state as AdaptiveState)[BODY_HISTORY]?.[streamId], anomaly };
    const hist = { ...(state as AdaptiveState)[BODY_HISTORY], [streamId]: stream };
    const out: AdaptiveState = { ...pub, [BODY_HISTORY]: hist };
    return { signals, state: out };
  }
}
