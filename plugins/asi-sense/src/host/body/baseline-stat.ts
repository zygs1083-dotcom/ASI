export interface Bucket {
  mean: number;
  median: number;
  mad: number;
  count: number;
  lastAt: number;
  dates: Set<string>;
  warmup?: number[];
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Calibrate the stochastic estimator before its first eight-sample decision. */
export function advanceBucket(b: Bucket, value: number, at: number, date: string, minScale: number): Bucket {
  const n: Bucket = { ...b, dates: new Set(b.dates), count: b.count + 1, lastAt: at };
  n.dates.add(date);
  if (b.warmup && b.count < 8) {
    const values = [...b.warmup, value];
    n.mean = values.reduce((sum, x) => sum + x, 0) / values.length;
    n.median = median(values);
    n.mad = median(values.map((x) => Math.abs(x - n.median)));
    n.warmup = values.length < 8 ? values : undefined;
  } else {
    const scale = Math.max(minScale, 1.4826 * b.mad);
    n.median += 0.05 * scale * Math.sign(value - b.median);
    n.mad = Math.max(0, n.mad + 0.05 * scale * Math.sign(Math.abs(value - b.median) - b.mad));
    n.mean += 0.05 * Math.min(Math.max(value - b.mean, -3 * scale), 3 * scale);
  }
  return n;
}
