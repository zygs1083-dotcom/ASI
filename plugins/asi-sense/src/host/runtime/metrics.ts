import type { Body, Fact } from '@asi/sense-types';
import { effectiveDisks, factStatusAt } from '@asi/sense-types';
import { type DayBounds, LocalCalendar } from './history/time.ts';
import type { Clock } from './ports.ts';

/**
 * In-memory body-metric timeline (DESIGN change 3).
 *
 * Raw probe samples are folded into aligned 5-minute buckets holding each
 * metric's min/avg/max; only the most recent 24 hours are retained. Hourly
 * rollups are kept for 48 hours so the daily-summary writer can still emit a
 * complete day's 24 hourly buckets when it runs shortly after midnight. Both
 * structures are bounded and synchronous — recording never touches disk.
 */

export const METRIC_BUCKET_MS = 5 * 60_000;
export const METRIC_HOUR_MS = 60 * 60_000;
export const METRIC_RETENTION_MS = 24 * 60 * 60_000;
export const METRIC_HOUR_RETENTION_MS = 48 * 60 * 60_000;
export const MAX_METRIC_POINTS = 288;
export const MIN_METRIC_STEP_SECONDS = METRIC_BUCKET_MS / 1000;
export const MAX_METRIC_STEP_SECONDS = 86_400;

export const METRIC_KEYS = ['cpu', 'load1', 'load5', 'load15', 'memory', 'swap', 'disk', 'battery'] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];
export type MetricUnit = 'ratio' | 'load' | 'bytes' | 'percent';

export const METRIC_UNITS: Readonly<Record<MetricKey, MetricUnit>> = {
  cpu: 'ratio',
  load1: 'load',
  load5: 'load',
  load15: 'load',
  memory: 'bytes',
  swap: 'bytes',
  disk: 'bytes',
  battery: 'percent',
};

const METRIC_KEY_SET: ReadonlySet<string> = new Set(METRIC_KEYS);
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface MetricStats {
  min: number;
  avg: number;
  max: number;
  count: number;
}

interface MetricBucket {
  start: number;
  samples: number;
  metrics: Partial<Record<MetricKey, MetricStats>>;
  diskTotal?: number;
}

type HourBucket = MetricBucket;

export interface MetricSeriesPoint extends MetricStats {
  at: number;
}

export interface MetricQueryParams {
  metric?: unknown;
  from?: unknown;
  to?: unknown;
  /** Grouping step in seconds; defaults to the 5-minute bucket width. */
  step?: unknown;
}

export interface MetricQueryResult {
  available: boolean;
  metric: MetricKey;
  unit: MetricUnit;
  from: number;
  to: number;
  stepMs: number;
  availableFrom: number;
  availableTo: number;
  rangeClamped: boolean;
  truncated: boolean;
  points: MetricSeriesPoint[];
  reason?: string;
  note?: string;
}

export interface MetricTrend {
  metric: MetricKey;
  unit: MetricUnit;
  start: number;
  end: number;
  min: number;
  max: number;
  samples: number;
  ratioStart?: number;
  ratioMin?: number;
  ratioEnd?: number;
}

export interface MetricDayExtension {
  version: 1;
  bucketMs: number;
  hourMs: number;
  hours: Array<{
    start: number;
    samples: number;
    metrics: Record<string, MetricStats>;
    diskTotal?: number;
  }>;
}

export class MetricsArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricsArgsError';
  }
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function okFact<T>(fact: Fact<T>, at: number): T | undefined {
  return factStatusAt(fact as Fact<unknown> & { kind?: never }, at) === 'ok' && fact.value !== null
    ? fact.value
    : undefined;
}

function addValue(stats: MetricStats | undefined, value: number, count = 1): MetricStats {
  if (!stats) return { min: value, avg: value, max: value, count };
  const next = stats.count + count;
  return {
    min: Math.min(stats.min, value),
    max: Math.max(stats.max, value),
    avg: (stats.avg * stats.count + value * count) / next,
    count: next,
  };
}

function mergeStats(target: MetricStats | undefined, source: MetricStats): MetricStats {
  if (!target) return { ...source };
  const count = target.count + source.count;
  return {
    min: Math.min(target.min, source.min),
    max: Math.max(target.max, source.max),
    avg: (target.avg * target.count + source.avg * source.count) / count,
    count,
  };
}

interface MeasuredValues {
  values: Partial<Record<MetricKey, number>>;
  diskTotal?: number;
}

/** Reads the change 3 metrics out of one body sample; missing/invalid facts are omitted. */
export function measureBody(body: Body, at: number): MeasuredValues {
  const values: Partial<Record<MetricKey, number>> = {};
  const cpu = okFact(body.cpu, at);
  if (cpu && finite(cpu.usage) && cpu.usage >= 0 && cpu.usage <= 1) values.cpu = cpu.usage;
  if (cpu) {
    for (const key of ['load1', 'load5', 'load15'] as const) {
      const load = cpu[key];
      if (finite(load) && load >= 0) values[key] = load;
    }
  }
  const memory = okFact(body.memory, at);
  if (memory && finite(memory.total) && memory.total > 0 && finite(memory.used) && memory.used >= 0) {
    values.memory = memory.used;
    if (finite(memory.swapUsed) && memory.swapUsed >= 0) values.swap = memory.swapUsed;
  }
  let diskTotal: number | undefined;
  let diskFree: number | undefined;
  let diskRatio = Number.POSITIVE_INFINITY;
  for (const disk of effectiveDisks(body.disks, at).value ?? []) {
    if (disk.status !== 'ok') continue;
    if (!finite(disk.total) || disk.total <= 0 || !finite(disk.free) || disk.free < 0 || disk.free > disk.total)
      continue;
    const ratio = disk.free / disk.total;
    // Track the tightest volume; `disk` means "available disk headroom".
    if (ratio < diskRatio) {
      diskRatio = ratio;
      diskFree = disk.free;
      diskTotal = disk.total;
    }
  }
  if (diskFree !== undefined) values.disk = diskFree;
  const battery = okFact(body.battery, at);
  if (battery && finite(battery.percent) && battery.percent >= 0 && battery.percent <= 100) {
    values.battery = battery.percent;
  }
  return diskTotal === undefined ? { values } : { values, diskTotal };
}

export class MetricTimeline {
  private readonly buckets = new Map<number, MetricBucket>();
  private readonly hours = new Map<number, HourBucket>();
  private readonly calendar: LocalCalendar;

  constructor(
    private readonly clock: Clock,
    timeZone?: string,
  ) {
    this.calendar = new LocalCalendar(timeZone);
  }

  /** Folds one probe sample into the 5-minute and hourly buckets. Synchronous, no IO. */
  record(body: Body, at: number): void {
    if (!finite(at) || at < 0) return;
    const start = Math.floor(at / METRIC_BUCKET_MS) * METRIC_BUCKET_MS;
    const { values, diskTotal } = measureBody(body, at);
    const bucket = this.buckets.get(start) ?? { start, samples: 0, metrics: {} };
    bucket.samples += 1;
    for (const key of METRIC_KEYS) {
      const value = values[key];
      if (value !== undefined) bucket.metrics[key] = addValue(bucket.metrics[key], value);
    }
    if (diskTotal !== undefined) bucket.diskTotal = diskTotal;
    this.buckets.set(start, bucket);

    const hourStart = Math.floor(start / METRIC_HOUR_MS) * METRIC_HOUR_MS;
    const hour = this.hours.get(hourStart) ?? { start: hourStart, samples: 0, metrics: {} };
    hour.samples += 1;
    for (const key of METRIC_KEYS) {
      const value = values[key];
      if (value !== undefined) hour.metrics[key] = addValue(hour.metrics[key], value);
    }
    if (diskTotal !== undefined) hour.diskTotal = diskTotal;
    this.hours.set(hourStart, hour);

    this.prune(at);
  }

  query(params: MetricQueryParams = {}): MetricQueryResult {
    const metric = params.metric;
    if (typeof metric !== 'string' || !METRIC_KEY_SET.has(metric)) {
      throw new MetricsArgsError(`unknown metric: ${typeof metric === 'string' ? metric : String(metric)}`);
    }
    const key = metric as MetricKey;
    const now = this.clock.wall();
    const fromRaw = this.parseBound(params.from, 'start');
    const toRaw = this.parseBound(params.to, 'end');
    const from = fromRaw ?? now - METRIC_RETENTION_MS;
    const to = toRaw ?? now;
    if (from > to) throw new MetricsArgsError('from must be earlier than or equal to to');
    const stepMs = this.parseStep(params.step);
    const availableFrom = this.earliestBucketStart() ?? now;
    const availableTo = now;
    let rangeClamped = false;
    let clampedFrom = Math.max(from, now - METRIC_RETENTION_MS, availableFrom);
    const clampedTo = Math.min(to, availableTo);
    if ((fromRaw !== undefined && clampedFrom !== from) || (toRaw !== undefined && clampedTo !== to)) {
      rangeClamped = true;
    }
    if (clampedFrom > clampedTo) clampedFrom = clampedTo;

    const groups = new Map<number, { min: number; max: number; sum: number; count: number; samples: number }>();
    const starts = [...this.buckets.keys()].sort((a, b) => a - b);
    for (const start of starts) {
      if (start < clampedFrom || start > clampedTo) continue;
      const bucket = this.buckets.get(start);
      const stats = bucket?.metrics[key];
      if (!bucket || !stats) continue;
      const at = Math.floor(start / stepMs) * stepMs;
      const group = groups.get(at) ?? { min: stats.min, max: stats.max, sum: 0, count: 0, samples: 0 };
      group.min = Math.min(group.min, stats.min);
      group.max = Math.max(group.max, stats.max);
      group.sum += stats.avg * stats.count;
      group.count += stats.count;
      group.samples += bucket.samples;
      groups.set(at, group);
    }
    let points: MetricSeriesPoint[] = [...groups.entries()]
      .sort(([a], [b]) => a - b)
      .map(([at, group]) => ({
        at,
        min: group.min,
        max: group.max,
        avg: group.count > 0 ? group.sum / group.count : group.min,
        count: group.count,
      }));
    const truncated = points.length > MAX_METRIC_POINTS;
    if (truncated) points = points.slice(-MAX_METRIC_POINTS);
    const notes: string[] = [];
    if (rangeClamped) notes.push('range clamped to the retained last 24 hours and the current time');
    if (truncated) notes.push('series truncated to the most recent 288 points; narrow the range or increase step');
    const result: MetricQueryResult = {
      available: points.length > 0,
      metric: key,
      unit: METRIC_UNITS[key],
      from: clampedFrom,
      to: clampedTo,
      stepMs,
      availableFrom,
      availableTo,
      rangeClamped,
      truncated,
      points,
    };
    if (points.length === 0) result.reason = 'no samples in range';
    if (notes.length > 0) result.note = notes.join('; ');
    return result;
  }

  /** First/last aggregated values and extremes for an away episode. */
  trend(metric: MetricKey, from: number, to: number): MetricTrend | undefined {
    if (!finite(from) || !finite(to) || to < from) return undefined;
    const starts = [...this.buckets.keys()].sort((a, b) => a - b);
    let first: { bucket: MetricBucket; stats: MetricStats } | undefined;
    let last: { bucket: MetricBucket; stats: MetricStats } | undefined;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let samples = 0;
    let ratioMin = Number.POSITIVE_INFINITY;
    for (const start of starts) {
      if (start < from - METRIC_BUCKET_MS) continue;
      if (start > to) break;
      const bucket = this.buckets.get(start);
      const stats = bucket?.metrics[metric];
      if (!bucket || !stats) continue;
      if (!first) first = { bucket, stats };
      last = { bucket, stats };
      min = Math.min(min, stats.min);
      max = Math.max(max, stats.max);
      samples += stats.count;
      if (metric === 'disk' && bucket.diskTotal !== undefined && bucket.diskTotal > 0) {
        ratioMin = Math.min(ratioMin, stats.min / bucket.diskTotal);
      } else if (metric === 'battery') {
        ratioMin = Math.min(ratioMin, stats.min / 100);
      }
    }
    if (!first || !last) return undefined;
    const result: MetricTrend = {
      metric,
      unit: METRIC_UNITS[metric],
      start: first.stats.avg,
      end: last.stats.avg,
      min,
      max,
      samples,
    };
    if (metric === 'disk') {
      if (first.bucket.diskTotal !== undefined && first.bucket.diskTotal > 0) {
        result.ratioStart = first.stats.avg / first.bucket.diskTotal;
      }
      if (last.bucket.diskTotal !== undefined && last.bucket.diskTotal > 0) {
        result.ratioEnd = last.stats.avg / last.bucket.diskTotal;
      }
      if (ratioMin !== Number.POSITIVE_INFINITY) result.ratioMin = ratioMin;
    } else if (metric === 'battery') {
      result.ratioStart = first.stats.avg / 100;
      result.ratioEnd = last.stats.avg / 100;
      if (ratioMin !== Number.POSITIVE_INFINITY) result.ratioMin = ratioMin;
    }
    return result;
  }

  /** Hourly rollup for one local calendar day, shaped for `DailySummary.extensions.metrics`. */
  dailyExtension(date: string): MetricDayExtension | undefined {
    const bounds: DayBounds = this.calendar.dayBounds(date);
    const hours: MetricDayExtension['hours'] = [];
    for (const [start, hour] of [...this.hours.entries()].sort(([a], [b]) => a - b)) {
      if (start < bounds.startMs || start >= bounds.endMs) continue;
      const metrics: Record<string, MetricStats> = {};
      for (const key of METRIC_KEYS) {
        const stats = hour.metrics[key];
        if (stats) metrics[key] = { ...stats };
      }
      hours.push({
        start,
        samples: hour.samples,
        metrics,
        ...(hour.diskTotal !== undefined ? { diskTotal: hour.diskTotal } : {}),
      });
    }
    if (hours.length === 0) return undefined;
    return { version: 1, bucketMs: METRIC_BUCKET_MS, hourMs: METRIC_HOUR_MS, hours };
  }

  /** Diagnostic bounds used by tests and capacity assertions. */
  retained(): { buckets: number; hours: number; bytes: number } {
    const dump = {
      buckets: [...this.buckets.values()],
      hours: [...this.hours.values()],
    };
    return {
      buckets: this.buckets.size,
      hours: this.hours.size,
      bytes: Buffer.byteLength(JSON.stringify(dump), 'utf8'),
    };
  }

  private prune(at: number): void {
    const bucketCutoff = Math.floor((at - METRIC_RETENTION_MS) / METRIC_BUCKET_MS) * METRIC_BUCKET_MS;
    for (const start of this.buckets.keys()) {
      if (start < bucketCutoff) this.buckets.delete(start);
    }
    const hourCutoff = Math.floor((at - METRIC_HOUR_RETENTION_MS) / METRIC_HOUR_MS) * METRIC_HOUR_MS;
    for (const start of this.hours.keys()) {
      if (start < hourCutoff) this.hours.delete(start);
    }
  }

  private earliestBucketStart(): number | undefined {
    let earliest: number | undefined;
    for (const start of this.buckets.keys()) {
      if (earliest === undefined || start < earliest) earliest = start;
    }
    return earliest;
  }

  private parseStep(value: unknown): number {
    if (value === undefined) return METRIC_BUCKET_MS;
    if (
      !finite(value) ||
      !Number.isInteger(value) ||
      value < MIN_METRIC_STEP_SECONDS ||
      value > MAX_METRIC_STEP_SECONDS
    ) {
      throw new MetricsArgsError(
        `step must be an integer number of seconds between ${MIN_METRIC_STEP_SECONDS} and ${MAX_METRIC_STEP_SECONDS}`,
      );
    }
    return value * 1000;
  }

  private parseBound(value: unknown, edge: 'start' | 'end'): number | undefined {
    if (value === undefined) return undefined;
    if (finite(value)) {
      if (value < 0) throw new MetricsArgsError('from/to epoch timestamp must be a non-negative finite number');
      return value;
    }
    if (typeof value !== 'string' || !value.trim()) {
      throw new MetricsArgsError('from/to must be an epoch timestamp, ISO string or YYYY-MM-DD date');
    }
    const trimmed = value.trim();
    if (DATE_ONLY_RE.test(trimmed)) {
      let bounds: DayBounds;
      try {
        bounds = this.calendar.dayBounds(trimmed);
      } catch {
        throw new MetricsArgsError(`invalid calendar date: ${value}`);
      }
      return edge === 'start' ? bounds.startMs : Math.max(bounds.startMs, bounds.endMs - 1);
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isFinite(parsed)) throw new MetricsArgsError(`invalid ISO date/time string: ${value}`);
    return parsed;
  }
}
