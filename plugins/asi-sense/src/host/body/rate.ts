import type { Body, BodyEvaluation, BodyEvaluator, BodyThresholdSample, BodyThresholdState } from '@asi/sense-types';
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
  hardEtaMs?: number;
} & (
  | { maxDelta: number; maxSlope?: never; maxRatio?: never; maxEtaMs?: never }
  | { maxSlope: number; maxDelta?: never; maxRatio?: never; maxEtaMs?: never }
  | { maxRatio: number; maxDelta?: never; maxSlope?: never; maxEtaMs?: never }
  | { maxEtaMs: number; maxDelta?: never; maxSlope?: never; maxRatio?: never }
);

interface Point {
  at: number;
  value: number;
  wall?: number;
}

export type RateTimes = Record<string, { mono: number; wall: number }>;
type RateSample = BodyThresholdSample & {
  rateTimes?: RateTimes;
  evaluatedAt?: { mono: number; wall: number };
  contextSession?: string;
  contextSessions?: string[];
};
type EvaluatedWindow = RateWindow & { evaluationMono?: number };

export function captureRateTimes(body: Body, mono: number, receivedWall: number, previous: RateTimes): RateTimes {
  const next: RateTimes = {};
  const add = (key: string, wall: number, usable: boolean) => {
    if (!usable || !Number.isFinite(wall)) return;
    next[key] = previous[key]?.wall === wall ? previous[key] : { wall, mono: mono - Math.max(0, receivedWall - wall) };
  };
  const fact = (key: string, item: Body[keyof Body]) =>
    add(key, item.observedAt, item.status === 'ok' && item.value !== null);
  fact('cpu', body.cpu);
  fact('rss', body.harnessProcess);
  fact('memory', body.memory);
  fact('context', body.tokens);
  fact('battery', body.battery);
  fact('network.rx', body.network);
  fact('network.tx', body.network);
  for (const disk of body.disks.value ?? []) {
    add(
      `disk:${disk.mount}`,
      disk.observedAt ?? body.disks.observedAt,
      (disk.status ?? body.disks.status) === 'ok' && !body.disks.unavailableMounts?.includes(disk.mount),
    );
  }
  return next;
}

const LIMITS = ['maxDelta', 'maxSlope', 'maxRatio', 'maxEtaMs'] as const;

function validate(rule: RateRule, seen: Set<string>): void {
  const bad = (why: string) => new TypeError(`rate rule ${JSON.stringify(rule.id)}: ${why}`);
  if (typeof rule.id !== 'string' || rule.id === '' || seen.has(rule.id)) throw bad('id must be nonempty and unique');
  if (typeof rule.metric !== 'string' || rule.metric === '') throw bad('metric must be nonempty');
  if (rule.direction !== 'up' && rule.direction !== 'down') throw bad('direction must be up|down');
  if (!Number.isFinite(rule.windowMs) || rule.windowMs <= 0) throw bad('windowMs must be positive and finite');
  if (rule.floor !== undefined && !Number.isFinite(rule.floor)) throw bad('floor must be finite');
  if (rule.hardEtaMs !== undefined && (!Number.isFinite(rule.hardEtaMs) || rule.hardEtaMs <= 0)) {
    throw bad('hardEtaMs must be positive and finite');
  }
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
    const evaluation = (next as RateSample).evaluatedAt ?? { mono, wall: next.at };
    const metrics = readMetrics({ ...next, at: next.at + Math.max(0, evaluation.mono - mono) });
    const contextSession = (next as RateSample).contextSession;
    const sessions = (next as RateSample).contextSessions;
    const storageKey = (key: string) => (key === 'context' && contextSession ? `context@${contextSession}` : key);
    const windows: Record<string, EvaluatedWindow> = {};
    for (const [k, w] of Object.entries(inHist?.windows ?? {})) {
      const owner = k.startsWith('context@') ? k.slice('context@'.length) : undefined;
      if (
        (owner !== undefined &&
          (!sessions || sessions.includes(owner)) &&
          (owner !== contextSession || metrics.has('context'))) ||
        metrics.has(k)
      )
        windows[k] = w; // missing metric → window dropped, latch retained
    }
    const updated = new Map<string, EvaluatedWindow>();
    const windowFor = (key: string, metric: Metric): EvaluatedWindow => {
      const stored = storageKey(key);
      const done = updated.get(stored);
      if (done) return done;
      const old = windows[stored];
      const stamp = (next as RateSample).rateTimes?.[key];
      const observedMono = stamp?.mono ?? mono;
      let pts: Point[];
      if (old) {
        pts = old.points.slice();
      } else {
        const seed =
          Number.isFinite(prev.at) && (key !== 'context' || (prev as RateSample).contextSession === contextSession)
            ? readMetrics(prev).get(key)
            : undefined;
        const prior = (prev as RateSample).rateTimes?.[key];
        const pMono = prior?.mono ?? prev.monotonicAt;
        pts =
          seed && Number.isFinite(pMono) && pMono < observedMono
            ? [{ at: pMono, value: seed.value, ...(prior ? { wall: prior.wall } : {}) }]
            : [];
      }
      const fresh = !old || observedMono > old.lastMono;
      if (fresh) {
        pts.push({ at: observedMono, value: metric.value, ...(stamp ? { wall: stamp.wall } : {}) });
      }
      const evaluationMono = fresh ? evaluation.mono : (old.evaluationMono ?? old.lastMono);
      pts = pts.filter((p) => p.at >= evaluationMono - this.retention(key));
      const w: EvaluatedWindow = {
        points: pts,
        lastMono: old ? Math.max(old.lastMono, observedMono) : observedMono,
        evaluationMono,
      };
      updated.set(stored, w);
      return w;
    };
    // Per-stream latch (authoritative, metadata); `pub` keys are projections.
    const streamLatch: RateHistory['latch'] = { ...inHist?.latch };
    if (sessions) {
      for (const key of Object.keys(streamLatch)) {
        const index = key.indexOf('@');
        if (index >= 0 && !sessions.includes(key.slice(index + 1))) delete streamLatch[key];
      }
    }
    const signals: BodySignal[] = [];
    for (const rule of this.rules) {
      for (const key of this.metricKeys(rule, metrics)) {
        const metric = metrics.get(key) as Metric;
        const w = windowFor(key, metric);
        const pts = w.points.filter((p) => p.at >= (w.evaluationMono ?? evaluation.mono) - rule.windowMs);
        const cached = !!windows[storageKey(key)] && w.lastMono === windows[storageKey(key)].lastMono;
        if (rule.maxEtaMs === undefined && rule.hardEtaMs === undefined && cached) continue;
        if (pts.length < 2) continue;
        const sig = this.step(rule, key, metric, pts, next, pub, streamLatch, evaluation, cached);
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
    evaluation: { mono: number; wall: number },
    cached: boolean,
  ): BodySignal | undefined {
    const first = pts[0];
    const last = pts[pts.length - 1];
    const delta = last.value - first.value;
    const slope = ols(pts);
    if (slope === undefined) return undefined; // degenerate x — cannot measure a rate
    const floor = rule.floor ?? metric.floor;
    const observedEta =
      floor !== undefined && slope < 0 ? Math.max(0, ((last.value - floor) / -slope) * 1000) : undefined;
    const eta =
      observedEta === undefined ? undefined : Math.max(0, observedEta - Math.max(0, evaluation.mono - last.at));
    let magnitude: number;
    let limit: number;
    if (rule.maxEtaMs !== undefined) {
      // Inverted: danger rises as eta shrinks; eta = ∞ (stable/rising) → 0.
      magnitude = 1 / (eta ?? Number.POSITIVE_INFINITY);
      limit = 1 / Math.max(rule.hardEtaMs ?? 0, this.liveLimit(rule.maxEtaMs, rule.param));
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
    const contextSession = (next as RateSample).contextSession;
    const suffix = key === 'context' && contextSession ? `@${contextSession}` : '';
    const storedLatch = `${latchKey}${suffix}`;
    const was = streamLatch[storedLatch] === 'warn';
    const softKey = `${latchKey}:soft${suffix}`;
    const hardKey = `${latchKey}:hard${suffix}`;
    const softWas = rule.hardEtaMs === undefined ? was : streamLatch[softKey] === 'warn';
    const hardWas = streamLatch[hardKey] === 'warn';
    const soft =
      (rule.maxEtaMs !== undefined ? magnitude >= limit : magnitude > limit) ||
      (softWas && (cached || magnitude >= limit * 0.8));
    const hard =
      rule.hardEtaMs !== undefined &&
      ((eta !== undefined && eta <= rule.hardEtaMs) ||
        (hardWas && (cached || (eta !== undefined && eta <= rule.hardEtaMs / 0.8))));
    const active = soft || hard;
    if (rule.hardEtaMs !== undefined) {
      streamLatch[softKey] = soft ? 'warn' : 'normal';
      streamLatch[hardKey] = hard ? 'warn' : 'normal';
    }
    streamLatch[storedLatch] = active ? 'warn' : 'normal';
    pub[latchKey] = active ? 'warn' : 'normal';
    if (active === was && !(active && hard && !hardWas)) return undefined;
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
      evidenceAt: last.wall ?? next.at - (next.monotonicAt - last.at),
      evidenceMono: last.at,
      evaluationMono: evaluation.mono,
    };
    if (eta !== undefined) {
      data.etaToFloorMs = data.timeToFloorMs = eta;
    }
    return {
      id: `${next.source.id}:${latchKey}:${next.monotonicAt}:${severity}${key === 'context' && contextSession ? `:${contextSession}` : ''}`,
      kind: 'body.rate',
      at: evaluation.wall,
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
