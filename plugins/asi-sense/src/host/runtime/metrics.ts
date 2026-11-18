import type { Body, Fact } from '@asi/sense-types';
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
const METRIC_INDEX: Readonly<Record<MetricKey, number>> = {
  cpu: 0,
  load1: 1,
  load5: 2,
  load15: 3,
  memory: 4,
  swap: 5,
  disk: 6,
  battery: 7,
};
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface MetricStats {
  min: number;
  avg: number;
  max: number;
  count: number;
}

interface InternalMetricStats {
  min: number;
  sum: number;
  max: number;
  count: number;
  /** First/last raw sample in this bucket, used for away trend edges. */
  first: number;
  last: number;
}

const SAMPLE_STRIDE = 2 + METRIC_KEYS.length;

interface MetricBucket {
  start: number;
  samples: number;
  slots: Array<InternalMetricStats | undefined>;
  diskTotal?: number;
  minMono: number;
  maxMono: number;
  inOrder: boolean;
  /** Flat [at, mono, v0..v7, ...] per sample to avoid per-metric array churn. */
  sampleData: number[];
  diskTotals?: number[];
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

export interface MetricTrendRange {
  from: number;
  to: number;
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
  return fact.status === 'ok' && fact.value !== null && !(at >= fact.observedAt + fact.ttlMs) ? fact.value : undefined;
}

function createBucket(start: number): MetricBucket {
  return {
    start,
    samples: 0,
    slots: [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined],
    minMono: Number.POSITIVE_INFINITY,
    maxMono: Number.NEGATIVE_INFINITY,
    inOrder: true,
    sampleData: [],
  };
}

function addSlotInPlace(slots: Array<InternalMetricStats | undefined>, idx: number, value: number): void {
  const stats = slots[idx];
  if (!stats) {
    slots[idx] = { min: value, sum: value, max: value, count: 1, first: value, last: value };
    return;
  }
  if (value < stats.min) stats.min = value;
  if (value > stats.max) stats.max = value;
  stats.sum += value;
  stats.count += 1;
  stats.last = value;
}

/** Trims binary floating-point noise so repeated averages stay exact decimals. */
function roundAvg(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

function isDiskVolumeOk(
  disks: Body['disks'],
  volume: NonNullable<Body['disks']['value']>[number],
  at: number,
): boolean {
  if (disks.unavailableMounts?.includes(volume.mount)) return false;
  const observedAt = volume.observedAt ?? disks.observedAt;
  const deadline = observedAt + (volume.ttlMs ?? disks.ttlMs);
  if (volume.status !== undefined) {
    return volume.status === 'ok' && !(at >= deadline);
  }
  const factDeadline = disks.observedAt + disks.ttlMs;
  return disks.status === 'ok' && !(at >= factDeadline) && !(at >= Math.min(deadline, factDeadline));
}

function readBodyInto(body: Body, at: number, out: Float64Array): number | undefined {
  out.fill(Number.NaN);
  const cpu = okFact(body.cpu, at);
  if (cpu) {
    if (finite(cpu.usage) && cpu.usage >= 0 && cpu.usage <= 1) out[0] = cpu.usage;
    if (finite(cpu.load1) && cpu.load1 >= 0) out[1] = cpu.load1;
    if (finite(cpu.load5) && cpu.load5 >= 0) out[2] = cpu.load5;
    if (finite(cpu.load15) && cpu.load15 >= 0) out[3] = cpu.load15;
  }
  const memory = okFact(body.memory, at);
  if (memory && finite(memory.total) && memory.total > 0 && finite(memory.used) && memory.used >= 0) {
    out[4] = memory.used;
    if (finite(memory.swapUsed) && memory.swapUsed >= 0) out[5] = memory.swapUsed;
  }
  let diskTotal: number | undefined;
  let diskFree: number | undefined;
  let diskRatio = Number.POSITIVE_INFINITY;
  const volumes = body.disks.value;
  if (volumes && volumes.length > 0) {
    for (const disk of volumes) {
      if (!isDiskVolumeOk(body.disks, disk, at)) continue;
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
    if (diskFree !== undefined) out[6] = diskFree;
  }
  const battery = okFact(body.battery, at);
  if (battery && finite(battery.percent) && battery.percent >= 0 && battery.percent <= 100) {
    out[7] = battery.percent;
  }
  return diskTotal;
}

const measureScratch = new Float64Array(METRIC_KEYS.length);

interface MeasuredValues {
  values: Partial<Record<MetricKey, number>>;
  diskTotal?: number;
}

/** Reads the change 3 metrics out of one body sample; missing/invalid facts are omitted. */
export function measureBody(body: Body, at: number): MeasuredValues {
  const diskTotal = readBodyInto(body, at, measureScratch);
  const values: Partial<Record<MetricKey, number>> = {};
  for (let i = 0; i < METRIC_KEYS.length; i++) {
    const value = measureScratch[i];
    if (!Number.isNaN(value)) values[METRIC_KEYS[i]] = value;
  }
  return diskTotal === undefined ? { values } : { values, diskTotal };
}

type LocalParts = ReturnType<LocalCalendar['parts']>;

function sameLocalHour(a: LocalParts, b: LocalParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour;
}

function localOffsetMs(p: LocalParts, secMs: number): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0) - secMs;
}

function visitMatchingSamples(
  bucket: MetricBucket,
  slotIdx: number,
  from: number,
  to: number,
  monoBounds: MetricTrendRange | undefined,
  onSample: (value: number, diskTotal: number | undefined, sampleAt: number, sampleMono: number, order: number) => void,
): void {
  const data = bucket.sampleData;
  for (let base = 0, order = 0; base < data.length; base += SAMPLE_STRIDE, order++) {
    const value = data[base + 2 + slotIdx];
    if (value === undefined || Number.isNaN(value)) continue;
    const sampleAt = data[base] as number;
    const sampleMono = data[base + 1] as number;
    const inWall = sampleAt >= from && sampleAt <= to && (!monoBounds || sampleMono <= monoBounds.to);
    const inMono = monoBounds !== undefined && sampleMono > monoBounds.from && sampleMono <= monoBounds.to;
    if (!inWall && !inMono) continue;
    const diskTotal = bucket.diskTotals ? (bucket.diskTotals[order] ?? bucket.diskTotal) : bucket.diskTotal;
    onSample(value, diskTotal, sampleAt, sampleMono, order);
  }
}

export class MetricTimeline {
  private readonly buckets = new Map<number, MetricBucket>();
  private readonly hours = new Map<number, HourBucket>();
  private readonly calendar: LocalCalendar;
  private readonly sampleScratch = new Float64Array(METRIC_KEYS.length);
  private lastBucket?: MetricBucket;
  private lastHour?: HourBucket;
  private lastHourEnd = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly clock: Clock,
    timeZone?: string,
  ) {
    this.calendar = new LocalCalendar(timeZone);
  }

  /** Folds one probe sample into the 5-minute and hourly buckets. Synchronous, no IO. */
  record(body: Body, at: number): void {
    if (!finite(at) || at < 0) return;

    let bucket = this.lastBucket;
    if (!bucket || at < bucket.start || at >= bucket.start + METRIC_BUCKET_MS) {
      const start = Math.floor(at / METRIC_BUCKET_MS) * METRIC_BUCKET_MS;
      bucket = this.buckets.get(start);
      if (!bucket) {
        bucket = createBucket(start);
        this.buckets.set(start, bucket);
      }
      this.lastBucket = bucket;
      this.pruneBuckets(at);
    }

    let hour = this.lastHour;
    if (!hour || at < hour.start || at >= this.lastHourEnd) {
      const bounds = this.localHourBounds(at);
      hour = this.hours.get(bounds.start);
      if (!hour) {
        hour = createBucket(bounds.start);
        this.hours.set(bounds.start, hour);
      }
      this.lastHour = hour;
      this.lastHourEnd = bounds.end;
      this.pruneHours(at);
    }

    bucket.samples += 1;
    hour.samples += 1;

    const rawMono = this.clock.mono();
    const mono = finite(rawMono) ? rawMono : 0;
    const data = bucket.sampleData;
    const dataLen = data.length;
    if (bucket.inOrder && dataLen > 0) {
      const prevAt = data[dataLen - SAMPLE_STRIDE] as number;
      const prevMono = data[dataLen - SAMPLE_STRIDE + 1] as number;
      if (at < prevAt || mono < prevMono) bucket.inOrder = false;
    }
    if (mono < bucket.minMono) bucket.minMono = mono;
    if (mono > bucket.maxMono) bucket.maxMono = mono;

    const scratch = this.sampleScratch;
    const diskTotal = readBodyInto(body, at, scratch);
    for (let i = 0; i < METRIC_KEYS.length; i++) {
      const value = scratch[i] as number;
      if (!Number.isNaN(value)) {
        addSlotInPlace(bucket.slots, i, value);
        addSlotInPlace(hour.slots, i, value);
      }
    }
    data.push(
      at,
      mono,
      scratch[0] as number,
      scratch[1] as number,
      scratch[2] as number,
      scratch[3] as number,
      scratch[4] as number,
      scratch[5] as number,
      scratch[6] as number,
      scratch[7] as number,
    );
    if (diskTotal !== undefined) {
      const sampleIdx = dataLen / SAMPLE_STRIDE;
      if (bucket.diskTotal !== undefined && diskTotal !== bucket.diskTotal && !bucket.diskTotals) {
        bucket.diskTotals = new Array<number>(sampleIdx).fill(bucket.diskTotal);
      }
      if (bucket.diskTotals) {
        while (bucket.diskTotals.length < sampleIdx) bucket.diskTotals.push(bucket.diskTotal ?? diskTotal);
        bucket.diskTotals.push(diskTotal);
      }
      bucket.diskTotal = diskTotal;
      hour.diskTotal = diskTotal;
    }
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
    const emptyRange = clampedFrom > clampedTo;
    if (emptyRange) clampedFrom = clampedTo;

    const slotIdx = METRIC_INDEX[key];
    const groups = new Map<number, { min: number; max: number; sum: number; count: number; samples: number }>();
    if (!emptyRange) {
      const starts = [...this.buckets.keys()].sort((a, b) => a - b);
      for (const start of starts) {
        if (start + METRIC_BUCKET_MS <= clampedFrom || start > clampedTo) continue;
        const bucket = this.buckets.get(start);
        const stats = bucket?.slots[slotIdx];
        if (!bucket || !stats) continue;
        const at = Math.floor(start / stepMs) * stepMs;
        const group = groups.get(at) ?? { min: stats.min, max: stats.max, sum: 0, count: 0, samples: 0 };
        group.min = Math.min(group.min, stats.min);
        group.max = Math.max(group.max, stats.max);
        group.sum += stats.sum;
        group.count += stats.count;
        group.samples += bucket.samples;
        groups.set(at, group);
      }
    }
    let points: MetricSeriesPoint[] = [...groups.entries()]
      .sort(([a], [b]) => a - b)
      .map(([at, group]) => ({
        at,
        min: group.min,
        max: group.max,
        avg: group.count > 0 ? roundAvg(group.sum / group.count) : group.min,
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
  trend(metric: MetricKey, from: number, to: number, monoRange?: MetricTrendRange): MetricTrend | undefined {
    if (!finite(from) || !finite(to) || to < from) return undefined;
    const slotIdx = METRIC_INDEX[metric];
    const monoBounds = monoRange && finite(monoRange.from) && finite(monoRange.to) ? monoRange : undefined;
    const matchedBuckets: MetricBucket[] = [];
    for (const bucket of this.buckets.values()) {
      if (!bucket.slots[slotIdx]) continue;
      const wallOverlap = bucket.start + METRIC_BUCKET_MS > from && bucket.start <= to;
      const monoOverlap =
        monoBounds !== undefined && bucket.maxMono > monoBounds.from && bucket.minMono <= monoBounds.to;
      if (wallOverlap || monoOverlap) matchedBuckets.push(bucket);
    }
    if (matchedBuckets.length === 0) return undefined;
    matchedBuckets.sort((a, b) => a.start - b.start);

    let canUseFastPath = true;
    let prevMaxMono = Number.NEGATIVE_INFINITY;
    for (const bucket of matchedBuckets) {
      if (
        !bucket.inOrder ||
        bucket.minMono < prevMaxMono ||
        (monoBounds !== undefined && bucket.start + METRIC_BUCKET_MS <= from)
      ) {
        canUseFastPath = false;
        break;
      }
      prevMaxMono = bucket.maxMono;
    }

    let firstValue: number | undefined;
    let firstDiskTotal: number | undefined;
    let lastValue: number | undefined;
    let lastDiskTotal: number | undefined;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let samples = 0;
    let ratioMin = Number.POSITIVE_INFINITY;

    const acceptSample = (value: number, diskTotal: number | undefined) => {
      if (firstValue === undefined) {
        firstValue = value;
        firstDiskTotal = diskTotal;
      }
      lastValue = value;
      lastDiskTotal = diskTotal;
      if (value < min) min = value;
      if (value > max) max = value;
      samples += 1;
      if (metric === 'disk' && diskTotal !== undefined && diskTotal > 0) {
        ratioMin = Math.min(ratioMin, value / diskTotal);
      } else if (metric === 'battery') {
        ratioMin = Math.min(ratioMin, value / 100);
      }
    };

    if (canUseFastPath) {
      for (const bucket of matchedBuckets) {
        const stats = bucket.slots[slotIdx];
        if (!stats) continue;
        const wallFullyInside = bucket.start >= from && bucket.start + METRIC_BUCKET_MS - 1 <= to;
        const monoOk = monoBounds === undefined || bucket.maxMono <= monoBounds.to;
        if (wallFullyInside && monoOk && !bucket.diskTotals) {
          if (firstValue === undefined) {
            firstValue = stats.first;
            firstDiskTotal = bucket.diskTotal;
          }
          lastValue = stats.last;
          lastDiskTotal = bucket.diskTotal;
          if (stats.min < min) min = stats.min;
          if (stats.max > max) max = stats.max;
          samples += stats.count;
          if (metric === 'disk' && bucket.diskTotal !== undefined && bucket.diskTotal > 0) {
            ratioMin = Math.min(ratioMin, stats.min / bucket.diskTotal);
          } else if (metric === 'battery') {
            ratioMin = Math.min(ratioMin, stats.min / 100);
          }
          continue;
        }
        visitMatchingSamples(bucket, slotIdx, from, to, monoBounds, (value, diskTotal) => {
          acceptSample(value, diskTotal);
        });
      }
    } else {
      const collected: Array<{
        mono: number;
        at: number;
        order: number;
        value: number;
        diskTotal: number | undefined;
      }> = [];
      for (const bucket of matchedBuckets) {
        visitMatchingSamples(bucket, slotIdx, from, to, monoBounds, (value, diskTotal, sampleAt, sampleMono, order) => {
          collected.push({ mono: sampleMono, at: sampleAt, order, value, diskTotal });
        });
      }
      collected.sort((a, b) => (a.mono !== b.mono ? a.mono - b.mono : a.at !== b.at ? a.at - b.at : a.order - b.order));
      for (const item of collected) acceptSample(item.value, item.diskTotal);
    }

    if (firstValue === undefined || lastValue === undefined) return undefined;
    const result: MetricTrend = {
      metric,
      unit: METRIC_UNITS[metric],
      start: firstValue,
      end: lastValue,
      min,
      max,
      samples,
    };
    if (metric === 'disk') {
      if (firstDiskTotal !== undefined && firstDiskTotal > 0) {
        result.ratioStart = firstValue / firstDiskTotal;
      }
      if (lastDiskTotal !== undefined && lastDiskTotal > 0) {
        result.ratioEnd = lastValue / lastDiskTotal;
      }
      if (ratioMin !== Number.POSITIVE_INFINITY) result.ratioMin = ratioMin;
    } else if (metric === 'battery') {
      result.ratioStart = firstValue / 100;
      result.ratioEnd = lastValue / 100;
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
      for (let i = 0; i < METRIC_KEYS.length; i++) {
        const stats = hour.slots[i];
        if (stats) {
          metrics[METRIC_KEYS[i]] = {
            min: stats.min,
            avg: roundAvg(stats.sum / stats.count),
            max: stats.max,
            count: stats.count,
          };
        }
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

  private localHourBounds(at: number): { start: number; end: number } {
    const secMs = Math.floor(at / 1000) * 1000;
    const p = this.calendar.parts(secMs);
    const guess = secMs - (p.minute * 60_000 + p.second * 1000);
    let start: number;
    let sp: LocalParts;
    if (guess >= 0) {
      const gp = this.calendar.parts(guess);
      if (sameLocalHour(gp, p) && gp.minute === 0 && gp.second === 0) {
        start = guess;
        sp = gp;
      } else {
        start = this.findLocalHourStart(secMs, p);
        sp = this.calendar.parts(start);
      }
    } else {
      start = this.findLocalHourStart(secMs, p);
      sp = this.calendar.parts(start);
    }
    const nextProbe = start + METRIC_HOUR_MS;
    const ep = this.calendar.parts(nextProbe);
    const startOffset = localOffsetMs(sp, Math.floor(start / 1000) * 1000);
    const end =
      ep.minute === 0 && ep.second === 0 && (!sameLocalHour(ep, sp) || localOffsetMs(ep, nextProbe) !== startOffset)
        ? nextProbe
        : this.findLocalHourEnd(start, sp, startOffset);
    return { start, end };
  }

  private findLocalHourStart(secMs: number, p: LocalParts): number {
    const targetOffset = localOffsetMs(p, secMs);
    let lo = Math.max(0, secMs - METRIC_HOUR_MS);
    let hi = secMs;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const mp = this.calendar.parts(mid);
      if (sameLocalHour(mp, p) && localOffsetMs(mp, Math.floor(mid / 1000) * 1000) === targetOffset) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    return lo;
  }

  private findLocalHourEnd(start: number, sp: LocalParts, startOffset: number): number {
    let lo = start + 1;
    let hi = start + METRIC_HOUR_MS;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const mp = this.calendar.parts(mid);
      if (sameLocalHour(mp, sp) && localOffsetMs(mp, Math.floor(mid / 1000) * 1000) === startOffset) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  private pruneBuckets(at: number): void {
    const bucketCutoff = Math.floor((at - METRIC_RETENTION_MS) / METRIC_BUCKET_MS) * METRIC_BUCKET_MS;
    for (const start of this.buckets.keys()) {
      if (start < bucketCutoff) this.buckets.delete(start);
    }
  }

  private pruneHours(at: number): void {
    const cutoffPoint = at - METRIC_HOUR_RETENTION_MS;
    if (cutoffPoint <= 0) return;
    const hourCutoff = this.localHourBounds(cutoffPoint).start;
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
