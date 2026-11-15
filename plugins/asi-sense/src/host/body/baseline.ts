/**
 * Per-metric weekly baseline (DESIGN §2.2c): 168 UTC hour-of-week buckets
 * holding an EWMA mean plus a constant-step *stochastic* median/MAD
 * approximation. Honest limits: this is NOT an exact rolling MAD — quantile
 * oscillation is of order alpha*scale with no distribution-free error
 * guarantee, the 1.4826 sigma calibration only holds for Gaussian tails,
 * and the clipped mean resists spikes but eventually adapts to sustained
 * shifts. No filesystem persistence.
 */

export interface BaselineOptions {
  /** Wall clock in ms (required). */
  clock: () => number;
  installedAt?: number;
  /** Minimum scales: exact metric, `disk:*`, `network.*` or `other`. */
  minScale?: Record<string, number>;
}

export interface BaselineStat {
  mean: number;
  scale: number;
  count: number;
  /** min(1, count/60). */
  confidence: number;
}

interface Bucket {
  mean: number;
  median: number;
  mad: number;
  count: number;
  lastAt: number;
}

const SLOTS = 168;
const DAY_MS = 86_400_000;
const SIGMA = 1.4826;
const ALPHA = 0.05;
const MAX_AT = 8.64e15; // beyond this `new Date(at)` is invalid

const DEFAULT_MIN: Record<string, number> = {
  cpu: 0.03,
  memory: 0.03,
  rss: 32 * 1024 ** 2,
  'disk:*': 128 * 1024 ** 2,
  context: 1000,
  battery: 2,
  'network.*': 1024,
  other: 1,
};

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const validAt = (at: number): boolean => finite(at) && Math.abs(at) <= MAX_AT;
const bucketIndex = (at: number): number => {
  const d = new Date(at);
  return d.getUTCDay() * 24 + d.getUTCHours();
};

export class Baseline {
  private readonly clock: () => number;
  private installedAt: number;
  private readonly minScale: Map<string, number>;
  private buckets = new Map<string, (Bucket | null)[]>();

  constructor(options: BaselineOptions) {
    if (typeof options.clock !== 'function') throw new TypeError('baseline: clock function required');
    const installedAt = options.installedAt ?? options.clock();
    if (!finite(installedAt)) throw new TypeError('baseline: installedAt must be finite');
    this.minScale = new Map(Object.entries(DEFAULT_MIN));
    for (const [k, v] of Object.entries(options.minScale ?? {})) {
      if (!finite(v) || v <= 0) {
        throw new TypeError(`baseline: minScale ${JSON.stringify(k)} must be positive and finite`);
      }
      this.minScale.set(k, v);
    }
    this.clock = options.clock;
    this.installedAt = installedAt;
  }

  private minFor(metric: string): number {
    const own = this.minScale.get(metric);
    if (own !== undefined) return own;
    if (metric.startsWith('disk:')) return this.minScale.get('disk:*') as number;
    if (metric.startsWith('network.')) return this.minScale.get('network.*') as number;
    return this.minScale.get('other') as number;
  }

  observe(metric: string, value: number, at: number): void {
    if (!finite(value) || !validAt(at)) return;
    let arr = this.buckets.get(metric);
    if (!arr) {
      arr = new Array<Bucket | null>(SLOTS).fill(null);
      this.buckets.set(metric, arr);
    }
    const i = bucketIndex(at);
    const b = arr[i];
    if (!b) {
      arr[i] = { mean: value, median: value, mad: 0, count: 1, lastAt: at };
      return;
    }
    if (at <= b.lastAt) return; // same or older observation: ignored
    const scale = Math.max(this.minFor(metric), SIGMA * b.mad);
    const median = b.median;
    b.median += ALPHA * scale * Math.sign(value - median);
    b.mad = Math.max(0, b.mad + ALPHA * scale * Math.sign(Math.abs(value - median) - b.mad));
    b.mean += ALPHA * Math.min(Math.max(value - b.mean, -3 * scale), 3 * scale);
    b.count++;
    b.lastAt = at;
  }

  read(metric: string, at: number): BaselineStat | undefined {
    if (!validAt(at)) return undefined;
    const b = this.buckets.get(metric)?.[bucketIndex(at)];
    if (!b) return undefined;
    return {
      mean: b.mean,
      scale: Math.max(this.minFor(metric), SIGMA * b.mad),
      count: b.count,
      confidence: Math.min(1, b.count / 60),
    };
  }

  get learningProgress(): number {
    return Math.min(100, Math.max(0, ((this.clock() - this.installedAt) / DAY_MS) * 100));
  }

  serialize(): string {
    return JSON.stringify({ version: 1, installedAt: this.installedAt, metrics: Object.fromEntries(this.buckets) });
  }

  /** Malformed input — version, shape, stat or slot mismatch — rebuilds empty. */
  static deserialize(json: string, options: BaselineOptions): Baseline {
    const fresh = new Baseline(options);
    try {
      const d = JSON.parse(json) as { version?: unknown; installedAt?: unknown; metrics?: unknown };
      const m = d?.metrics;
      if (d?.version !== 1 || !finite(d.installedAt) || m === null || typeof m !== 'object' || Array.isArray(m)) {
        return fresh;
      }
      // Validate EVERY entry into a local map first — install is atomic.
      const parsed = new Map<string, (Bucket | null)[]>();
      for (const [name, arr] of Object.entries(m as Record<string, unknown>)) {
        if (!Array.isArray(arr) || arr.length !== SLOTS) return fresh;
        const slots = arr.slice() as (Bucket | null)[];
        if (!slots.every((b, i) => validBucket(b, i))) return fresh;
        parsed.set(name, slots);
      }
      fresh.buckets = parsed;
      fresh.installedAt = d.installedAt;
      return fresh;
    } catch {
      return fresh;
    }
  }
}

const validBucket = (b: unknown, i: number): boolean => {
  if (b === null) return true;
  const s = b as Bucket;
  return (
    s !== null &&
    typeof s === 'object' &&
    finite(s.mean) &&
    finite(s.median) &&
    finite(s.mad) &&
    s.mad >= 0 &&
    Number.isSafeInteger(s.count) &&
    s.count > 0 &&
    validAt(s.lastAt) &&
    bucketIndex(s.lastAt) === i // a bucket's own timestamp must live in its slot
  );
};
