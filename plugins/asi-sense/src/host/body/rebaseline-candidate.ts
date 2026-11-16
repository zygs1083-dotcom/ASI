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
}

const DAY = 86_400_000;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export const keyOf = (stream: string, metric: string, slot: number): string => JSON.stringify([stream, metric, slot]);
export const paramOf = (stream: string, metric: string, slot: number): string =>
  `baseline:${Buffer.from(stream).toString('base64url')}:${Buffer.from(metric).toString('base64url')}:${slot}`;
export const encode = (bucket: Bucket): string => JSON.stringify({ ...bucket, dates: [...bucket.dates] });

export function withBaseline(state: AdaptiveState, stream: string, baseline: Baseline): AdaptiveState {
  const history = state[BODY_HISTORY] ?? {};
  const entry = history[stream];
  if (!entry?.anomaly) throw new TypeError('rebaseline: missing history');
  return {
    ...state,
    [BODY_HISTORY]: { ...history, [stream]: { ...entry, anomaly: { ...entry.anomaly, baseline } } },
  };
}

export function clearMetric(
  candidates: Map<string, Candidate>,
  retry: Map<string, number>,
  stream: string,
  metric: string,
): void {
  for (const [key, candidate] of candidates) {
    if (candidate.stream === stream && candidate.metric === metric) {
      candidates.delete(key);
      retry.delete(key);
    }
  }
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
    c.days.length > 3
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
  return { stream: c.stream, metric: c.metric, slot: c.slot as number, days };
}
