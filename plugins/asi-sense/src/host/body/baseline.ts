import { advanceBucket, type Bucket } from './baseline-stat.ts';

/**
 * Per-metric weekly baseline (DESIGN §2.2c): 168 LOCAL hour-of-week
 * buckets holding an EWMA mean plus a constant-step stochastic median/MAD
 * approximation. Honest limits: this is NOT an exact rolling MAD —
 * quantile oscillation is of order alpha*scale, the 1.4826 sigma
 * calibration only holds for Gaussian tails.
 *
 * Bucketing uses `Intl.DateTimeFormat` in the configured `timeZone` —
 * DST-repeated local hours land in the same bucket and skipped hours never
 * fabricate a phantom one. Buckets are copy-on-write so a {@link clone}
 * can share untouched state safely (the anomaly evaluator forks baselines
 * into caller-owned state). Snapshots are version 2; any malformed input
 * rebuilds EMPTY with `restoreFailed` set — callers must treat that as a
 * restore failure, never as a first install.
 */

export interface BaselineOptions {
  /** Wall clock for {@link learningProgress} display; default Date.now. */
  clock?: () => number;
  installedAt?: number;
  /** IANA zone; default the runtime's resolved local zone. */
  timeZone?: string;
  /** Minimum scales: exact metric, `disk:*`, `network.*` or `other`. */
  minScale?: Record<string, number>;
}

export interface BaselineStat {
  mean: number;
  scale: number;
  count: number;
  /** Distinct local dates this bucket has sampled. */
  dates: number;
  /** min(1, count/60). */
  confidence: number;
}

export const BASELINE_SLOTS = 168;
export const BASELINE_MIN_COUNT = 8;
export const BASELINE_MIN_DATES = 2;
const DAY_MS = 86_400_000;
const SIGMA = 1.4826;
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

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const validAt = (at: unknown): at is number => finite(at) && Math.abs(at) <= MAX_AT;

const formatter = (timeZone: string | undefined): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat('en-US-u-nu-latn', {
    ...(timeZone ? { timeZone } : {}),
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });

/** Local weekday*24+hour slot and local calendar date for `at` in `fmt`'s zone. */
const slotOf = (fmt: Intl.DateTimeFormat, at: number): { index: number; date: string } => {
  let wd = -1;
  let hour = -1;
  let y = '';
  let m = '';
  let d = '';
  for (const p of fmt.formatToParts(at)) {
    if (p.type === 'weekday') wd = WEEKDAY[p.value] ?? -1;
    else if (p.type === 'hour') hour = Number(p.value);
    else if (p.type === 'year') y = p.value;
    else if (p.type === 'month') m = p.value;
    else if (p.type === 'day') d = p.value;
  }
  return { index: wd * 24 + hour, date: `${y}-${m}-${d}` };
};

export class Baseline {
  /** True when the last {@link deserialize} input was malformed — fail closed. */
  readonly restoreFailed: boolean;
  private readonly clock: () => number;
  private readonly fmt: Intl.DateTimeFormat;
  private readonly zone: string;
  private installed: number;
  private readonly minScale: Map<string, number>;
  private buckets = new Map<string, (Bucket | null)[]>();

  constructor(options: BaselineOptions = {}, failed = false) {
    if (options.clock !== undefined && typeof options.clock !== 'function') {
      throw new TypeError('baseline: clock must be a function');
    }
    this.clock = options.clock ?? Date.now;
    const installedAt = options.installedAt ?? this.clock();
    if (!finite(installedAt)) throw new TypeError('baseline: installedAt must be finite');
    let fmt: Intl.DateTimeFormat;
    try {
      fmt = formatter(options.timeZone);
    } catch {
      throw new TypeError(`baseline: invalid timeZone ${JSON.stringify(options.timeZone)}`);
    }
    this.fmt = fmt;
    this.zone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.minScale = new Map(Object.entries(DEFAULT_MIN));
    for (const [k, v] of Object.entries(options.minScale ?? {})) {
      if (!finite(v) || v <= 0) {
        throw new TypeError(`baseline: minScale ${JSON.stringify(k)} must be positive and finite`);
      }
      this.minScale.set(k, v);
    }
    this.installed = installedAt;
    this.restoreFailed = failed;
  }

  /** Install stamp for the 24h learning gate. */
  get installedAt(): number {
    return this.installed;
  }

  get timeZone(): string {
    return this.zone;
  }

  /** A COW-safe fork: shares bucket objects; observe() clones before writing. */
  clone(): Baseline {
    const c = new Baseline(
      {
        clock: this.clock,
        installedAt: this.installed,
        timeZone: this.zone,
        minScale: Object.fromEntries(this.minScale),
      },
      this.restoreFailed,
    );
    c.buckets = new Map([...this.buckets].map(([k, arr]) => [k, arr.slice()]));
    return c;
  }

  /** Gate: 24 FULL hours elapsed since install, measured on the explicit sample time. */
  mature(at: number): boolean {
    return validAt(at) && at - this.installed >= DAY_MS;
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
      arr = new Array<Bucket | null>(BASELINE_SLOTS).fill(null);
      this.buckets.set(metric, arr);
    }
    const { index, date } = slotOf(this.fmt, at);
    const b = arr[index];
    if (!b) {
      arr[index] = {
        mean: value,
        median: value,
        mad: 0,
        count: 1,
        lastAt: at,
        dates: new Set([date]),
        warmup: [value],
      };
      return;
    }
    if (at <= b.lastAt) return; // same or older observation: ignored
    arr[index] = advanceBucket(b, value, at, date, this.minFor(metric));
  }

  read(metric: string, at: number): BaselineStat | undefined {
    if (!validAt(at)) return undefined;
    const b = this.buckets.get(metric)?.[slotOf(this.fmt, at).index];
    if (!b) return undefined;
    return {
      mean: b.mean,
      scale: Math.max(this.minFor(metric), SIGMA * b.mad),
      count: b.count,
      dates: b.dates.size,
      confidence: Math.min(1, b.count / 60),
    };
  }

  /** Wall-clock display progress: 0..100, pinned at 100 after 24 full hours. */
  get learningProgress(): number {
    const now = this.clock();
    if (!validAt(now)) throw new TypeError('baseline: clock must be finite and date-valid');
    return Math.min(100, Math.max(0, ((now - this.installed) / DAY_MS) * 100));
  }

  serialize(): string {
    const metrics: Record<string, unknown> = {};
    for (const [name, arr] of this.buckets) {
      metrics[name] = arr.map((b) => (b ? { ...b, dates: [...b.dates] } : null));
    }
    return JSON.stringify({ version: 2, installedAt: this.installed, timeZone: this.zone, metrics });
  }

  /**
   * Restores a v2 snapshot; ANY malformed piece — version, timezone, slot
   * shape, non-finite stat, timestamp outside its own slot (checked in the
   * persisted zone), bad date list — rebuilds EMPTY with `restoreFailed`.
   * Host timezone overrides index under the current zone with no migration.
   */
  static deserialize(json: string, options: BaselineOptions = {}): Baseline {
    const failed = () => new Baseline(options, true);
    try {
      const d = JSON.parse(json) as { version?: unknown; installedAt?: unknown; timeZone?: unknown; metrics?: unknown };
      const m = d?.metrics;
      if (
        d?.version !== 2 ||
        !validAt(d.installedAt) ||
        typeof d.timeZone !== 'string' ||
        m === null ||
        typeof m !== 'object' ||
        Array.isArray(m)
      ) {
        return failed();
      }
      let savedFmt: Intl.DateTimeFormat;
      try {
        savedFmt = formatter(d.timeZone);
      } catch {
        return failed();
      }
      const parsed = new Map<string, (Bucket | null)[]>();
      for (const [name, arr] of Object.entries(m as Record<string, unknown>)) {
        if (!Array.isArray(arr) || arr.length !== BASELINE_SLOTS) return failed();
        const slots: (Bucket | null)[] = new Array(BASELINE_SLOTS).fill(null);
        for (const [i, raw] of arr.entries()) {
          if (raw === null) continue;
          const s = raw as Record<string, unknown>;
          if (
            !finite(s.mean) ||
            !finite(s.median) ||
            !finite(s.mad) ||
            s.mad < 0 ||
            !Number.isSafeInteger(s.count) ||
            (s.count as number) <= 0 ||
            !validAt(s.lastAt) ||
            slotOf(savedFmt, s.lastAt).index !== i ||
            !Array.isArray(s.dates) ||
            s.dates.length === 0 ||
            s.dates.length > 400 ||
            !s.dates.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 40) ||
            (s.warmup !== undefined &&
              (!Array.isArray(s.warmup) ||
                s.warmup.length !== s.count ||
                (s.count as number) >= 8 ||
                !s.warmup.every(finite)))
          ) {
            return failed();
          }
          slots[i] = {
            mean: s.mean,
            median: s.median,
            mad: s.mad,
            count: s.count as number,
            lastAt: s.lastAt,
            dates: new Set(s.dates),
            warmup: s.warmup as number[] | undefined,
          };
        }
        parsed.set(name, slots);
      }
      // Host override keeps hour semantics under its own zone; absent an
      // override the persisted zone is adopted — never migrated.
      const b = new Baseline({
        ...options,
        installedAt: d.installedAt as number,
        timeZone: options.timeZone ?? d.timeZone,
      });
      b.buckets = parsed;
      return b;
    } catch {
      return failed();
    }
  }
}
