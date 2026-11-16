import type { AnomalyRule } from './anomaly.ts';
import type { Baseline } from './baseline.ts';
import { parseBucket } from './baseline-parse.ts';
import { advanceBucket, type Bucket } from './baseline-stat.ts';
import { formatter, slotOf } from './baseline-time.ts';
import { type AdaptiveState, BODY_HISTORY } from './state.ts';

export interface RecentSample {
  at: number;
  value: number;
  zone: string;
}

export interface RecentDay {
  date: string;
  elapsed: number;
  samples: RecentSample[];
}

export interface Candidate {
  stream: string;
  metric: string;
  slot: number;
  days: RecentDay[];
  lastMono?: number;
  suggested?: boolean;
  latest?: RecentSample;
  evidenceElapsed?: number;
}

const DAY = 86_400_000;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export const keyOf = (stream: string, metric: string, slot: number): string => JSON.stringify([stream, metric, slot]);
export const paramOf = (stream: string, metric: string, slot: number): string =>
  `baseline:${Buffer.from(stream).toString('base64url')}:${Buffer.from(metric).toString('base64url')}:${slot}`;
export const encode = (bucket: Bucket): string => JSON.stringify({ ...bucket, dates: [...bucket.dates] });
export const candidateId = (c: Candidate): string => `${paramOf(c.stream, c.metric, c.slot)}:${c.days[0].elapsed}`;
export const sampleCount = (c: Candidate): number => c.days.reduce((sum, day) => sum + day.samples.length, 0);
export const ready = (c: Candidate): boolean => c.days.length >= 3 && sampleCount(c) >= 8;
export const expired = (c: Candidate, elapsed: number, wall: number): boolean =>
  elapsed - c.days[0].elapsed > 21 * DAY || wall - c.days[0].samples[0].at > 21 * DAY || wall < c.days[0].samples[0].at;
export const suggestionExpired = (c: Candidate, elapsed: number, wall: number): boolean => {
  const last = c.days[c.days.length - 1];
  const at = last.samples[last.samples.length - 1].at;
  return (
    !finite(wall) ||
    !finite(elapsed) ||
    wall < at ||
    wall - at >= 7 * DAY ||
    elapsed - (c.evidenceElapsed ?? last.elapsed) >= 7 * DAY
  );
};

export function pruneSuggestions(
  candidates: Map<string, Candidate>,
  state: AdaptiveState | undefined,
  mono: number,
  wall: number,
): void {
  for (const [key, candidate] of candidates) {
    if (!candidate.suggested) continue;
    const baseline = state?.[BODY_HISTORY]?.[candidate.stream]?.anomaly?.baseline?.clone();
    if (!baseline || !finite(mono)) {
      candidates.delete(key);
      continue;
    }
    baseline.advance(mono);
    if (suggestionExpired(candidate, baseline.elapsed, wall)) candidates.delete(key);
  }
}

export interface MetricState {
  latch: Record<string, 'normal' | 'warn'>;
  streaks: Record<string, number>;
}

export function metricState(state: AdaptiveState, stream: string, rules: readonly AnomalyRule[]): MetricState {
  const anomaly = state[BODY_HISTORY]?.[stream]?.anomaly;
  const latch: MetricState['latch'] = {};
  const streaks: MetricState['streaks'] = {};
  for (const rule of rules) {
    latch[`baseline:${rule.id}`] = anomaly?.latch[`baseline:${rule.id}`] ?? 'normal';
    streaks[rule.id] = anomaly?.streaks[rule.id] ?? 0;
  }
  return { latch, streaks };
}

export function withMetricState(state: AdaptiveState, stream: string, metric: MetricState): AdaptiveState {
  const history = state[BODY_HISTORY] ?? {};
  const entry = history[stream];
  if (!entry?.anomaly) throw new TypeError('rebaseline: missing history');
  return {
    ...state,
    ...metric.latch,
    [BODY_HISTORY]: {
      ...history,
      [stream]: {
        ...entry,
        anomaly: {
          ...entry.anomaly,
          latch: { ...entry.anomaly.latch, ...metric.latch },
          streaks: { ...entry.anomaly.streaks, ...metric.streaks },
        },
      },
    },
  };
}

export function withBaseline(state: AdaptiveState, stream: string, baseline: Baseline): AdaptiveState {
  const history = state[BODY_HISTORY] ?? {};
  const entry = history[stream];
  if (!entry?.anomaly) throw new TypeError('rebaseline: missing history');
  return {
    ...state,
    [BODY_HISTORY]: { ...history, [stream]: { ...entry, anomaly: { ...entry.anomaly, baseline } } },
  };
}

export function decode(backup: string, slot: number): Bucket {
  const raw = JSON.parse(backup) as { zone?: unknown };
  if (typeof raw?.zone !== 'string') throw new TypeError('rebaseline: missing zone');
  return parseBucket(raw, slot, formatter(raw.zone), raw.zone);
}

export function record(
  candidate: Candidate,
  date: string,
  elapsed: number,
  mono: number,
  sample: RecentSample,
): boolean {
  if (candidate.lastMono !== undefined && mono <= candidate.lastMono) return false;
  const latest = candidate.days.at(-1)?.samples.at(-1);
  if (latest && sample.at <= latest.at) return false;
  candidate.lastMono = mono;
  let day = candidate.days.at(-1);
  if (day?.date !== date) {
    if (candidate.days.some((entry) => entry.date === date) || (day && elapsed - day.elapsed < DAY)) return false;
    if (candidate.days.length === 3) candidate.days.shift();
    day = { date, elapsed, samples: [] };
    candidate.days.push(day);
  }
  day.samples.push(sample);
  if (day.samples.length > 16) day.samples.shift();
  candidate.evidenceElapsed = elapsed;
  return true;
}

export function build(candidate: Candidate, minScale: number): Bucket {
  let bucket: Bucket | undefined;
  for (const day of candidate.days) {
    for (const sample of day.samples) {
      bucket = bucket
        ? { ...advanceBucket(bucket, sample.value, sample.at, day.date, minScale), zone: sample.zone }
        : {
            mean: sample.value,
            median: sample.value,
            mad: 0,
            count: 1,
            lastAt: sample.at,
            zone: sample.zone,
            dates: new Set([day.date]),
            warmup: [sample.value],
          };
    }
  }
  if (!bucket) throw new TypeError('rebaseline: no samples');
  return bucket;
}

export function validate(raw: unknown): Candidate | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  if (
    typeof c.stream !== 'string' ||
    !c.stream ||
    typeof c.metric !== 'string' ||
    !c.metric ||
    !Number.isInteger(c.slot) ||
    (c.slot as number) < 0 ||
    (c.slot as number) >= 168 ||
    !Array.isArray(c.days) ||
    c.days.length < 1 ||
    c.days.length > 3 ||
    (c.suggested !== undefined && typeof c.suggested !== 'boolean') ||
    (c.evidenceElapsed !== undefined && (!finite(c.evidenceElapsed) || c.evidenceElapsed < 0))
  )
    return undefined;
  const days: RecentDay[] = [];
  try {
    for (const rawDay of c.days) {
      if (!rawDay || typeof rawDay !== 'object' || Array.isArray(rawDay)) return undefined;
      const d = rawDay as Record<string, unknown>;
      if (
        typeof d.date !== 'string' ||
        !d.date ||
        d.date.length > 40 ||
        !finite(d.elapsed) ||
        d.elapsed < 0 ||
        !Array.isArray(d.samples) ||
        d.samples.length < 1 ||
        d.samples.length > 16 ||
        days.some((old) => old.date === d.date) ||
        (days.length > 0 && d.elapsed - days[days.length - 1].elapsed < DAY)
      )
        return undefined;
      const samples: RecentSample[] = [];
      for (const rawSample of d.samples) {
        if (!rawSample || typeof rawSample !== 'object' || Array.isArray(rawSample)) return undefined;
        const s = rawSample as Record<string, unknown>;
        if (!finite(s.at) || Math.abs(s.at) > 8.64e15 || !finite(s.value) || typeof s.zone !== 'string')
          return undefined;
        const local = slotOf(formatter(s.zone), s.at);
        if (local.index !== c.slot || local.date !== d.date) return undefined;
        samples.push({ at: s.at, value: s.value, zone: s.zone });
      }
      days.push({ date: d.date, elapsed: d.elapsed, samples });
    }
  } catch {
    return undefined;
  }
  let latest: RecentSample | undefined;
  if (c.latest !== undefined) {
    const sample = c.latest as RecentSample;
    if (
      !sample ||
      !finite(sample.at) ||
      Math.abs(sample.at) > 8.64e15 ||
      !finite(sample.value) ||
      typeof sample.zone !== 'string'
    )
      return undefined;
    try {
      formatter(sample.zone);
    } catch {
      return undefined;
    }
    latest = { ...sample };
  }
  const candidate = {
    stream: c.stream,
    metric: c.metric,
    slot: c.slot as number,
    days,
    suggested: c.suggested as boolean | undefined,
    latest,
    evidenceElapsed: c.evidenceElapsed as number | undefined,
  };
  if (candidate.evidenceElapsed !== undefined && candidate.evidenceElapsed < days[days.length - 1].elapsed)
    return undefined;
  if (
    candidate.suggested &&
    (!ready(candidate) || expired(candidate, days.at(-1)?.elapsed ?? 0, days.at(-1)?.samples.at(-1)?.at ?? 0))
  )
    return undefined;
  return candidate;
}
