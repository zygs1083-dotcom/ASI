export interface Bucket {
  mean: number;
  median: number;
  mad: number;
  count: number;
  lastAt: number;
  zone?: string;
  dates: Set<string>;
  warmup?: number[];
}

/** Half-life of the post-warmup EWMA/quantile estimator in real elapsed time. */
export const BASELINE_HALF_LIFE_MS = 30 * 60_000;
/** Cap per-step elapsed time so multi-day gaps between weekly visits cannot wipe history in one sample. */
export const BASELINE_MAX_STEP_MS = 5 * 60_000;
/** Retain only the most recent N distinct local dates per weekly-hour bucket. */
export const MAX_BUCKET_DATES = 8;

const dateKey = (value: string): number | undefined => {
  const m = /^(\d+)-(\d+)-(\d+)$/.exec(value);
  return m ? Number(m[1]) * 10_000 + Number(m[2]) * 100 + Number(m[3]) : undefined;
};

/** Keeps the most recent `limit` dates (chronologically by Y-M-D when formatted as local dates). */
export function pruneBucketDates(dates: Iterable<string>, limit: number = MAX_BUCKET_DATES): Set<string> {
  const list = [...new Set(dates)];
  if (list.length <= limit) return new Set(list);
  const keys = list.map(dateKey);
  if (keys.every((k): k is number => k !== undefined)) {
    const indexed = list.map((value, i) => ({ value, key: keys[i] as number, i }));
    indexed.sort((a, b) => a.key - b.key || a.i - b.i);
    return new Set(indexed.slice(-limit).map((item) => item.value));
  }
  return new Set(list.slice(-limit));
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Calibrate the stochastic estimator before its first eight-sample decision. */
export function advanceBucket(b: Bucket, value: number, at: number, date: string, minScale: number): Bucket {
  const dates = new Set(b.dates);
  dates.delete(date);
  dates.add(date);
  const n: Bucket = { ...b, dates: pruneBucketDates(dates), count: b.count + 1, lastAt: at };
  if (b.warmup && b.count < 8) {
    const values = [...b.warmup, value];
    n.mean = values.reduce((sum, x) => sum + x, 0) / values.length;
    n.median = median(values);
    n.mad = median(values.map((x) => Math.abs(x - n.median)));
    n.warmup = values.length < 8 ? values : undefined;
  } else {
    const dt = Math.min(Math.max(0, at - b.lastAt), BASELINE_MAX_STEP_MS);
    const alpha = 1 - Math.exp((-Math.LN2 * dt) / BASELINE_HALF_LIFE_MS);
    const scale = Math.max(minScale, 1.4826 * b.mad);
    n.median += alpha * scale * Math.sign(value - b.median);
    n.mad = Math.max(0, n.mad + alpha * scale * Math.sign(Math.abs(value - b.median) - b.mad));
    n.mean += alpha * Math.min(Math.max(value - b.mean, -3 * scale), 3 * scale);
  }
  return n;
}
