import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Body } from '@asi/sense-types';
import { afterEach, describe, expect, it } from 'vitest';
import { FileHistoryStoragePort } from '../../src/host/dsh/history-storage.ts';
import { HistoryManager, LocalCalendar, parseDailySummary } from '../../src/host/runtime/history/index.ts';
import {
  MAX_METRIC_POINTS,
  METRIC_BUCKET_MS,
  METRIC_RETENTION_MS,
  MetricsArgsError,
  MetricTimeline,
} from '../../src/host/runtime/metrics.ts';
import { diskFact, f, freshSample, memBody, mkBody } from '../body/helpers.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function clock(start: number) {
  let wall = start;
  return {
    clock: { wall: () => wall, mono: () => wall },
    at: () => wall,
    set: (value: number) => {
      wall = value;
    },
  };
}

function cpuBody(usage: number, load1 = 1): Body {
  return mkBody({
    cpu: f({ usage, perCore: [usage], load1, load5: load1, load15: load1 }),
  });
}

function fresh(over: Partial<Body>, at: number): Body {
  return freshSample(mkBody(over), at).body;
}

describe('metric timeline bucket aggregation', () => {
  it('folds samples into aligned 5-minute buckets with min/avg/max and omits missing metrics', () => {
    const base = Date.UTC(2026, 10, 18, 10, 0, 0);
    const { clock: c } = clock(base + 4 * 60_000);
    const timeline = new MetricTimeline(c, 'UTC');
    timeline.record(fresh({ cpu: cpuBody(0.2).cpu }, base), base);
    timeline.record(fresh({ cpu: cpuBody(0.4).cpu }, base + 120_000), base + 120_000);
    timeline.record(
      fresh({ cpu: cpuBody(0.6, 3).cpu, memory: memBody(30, 100).memory }, base + 240_000),
      base + 240_000,
    );

    const result = timeline.query({ metric: 'cpu', from: base, to: base + METRIC_BUCKET_MS - 1 });
    expect(result.available).toBe(true);
    expect(result.unit).toBe('ratio');
    expect(result.stepMs).toBe(METRIC_BUCKET_MS);
    expect(result.points).toEqual([expect.objectContaining({ at: base, min: 0.2, avg: 0.4, max: 0.6, count: 3 })]);
    // Every sample carries load1=1 in the helper; the third sample raises the peak.
    expect(timeline.query({ metric: 'load1', from: base }).points[0]).toMatchObject({ min: 1, max: 3, count: 3 });
    // Memory was absent from the first two samples and is simply missing, never zero-filled.
    expect(timeline.query({ metric: 'memory', from: base }).points[0]).toMatchObject({
      min: 30,
      max: 30,
      avg: 30,
      count: 1,
    });
    expect(timeline.query({ metric: 'battery', from: base })).toMatchObject({
      available: false,
      points: [],
      reason: 'no samples in range',
    });
  });

  it('keeps peaks and troughs when several samples share a bucket', () => {
    const base = Date.UTC(2026, 10, 18, 12, 0, 0);
    const { clock: c } = clock(base + 240_000);
    const timeline = new MetricTimeline(c, 'UTC');
    for (const [i, free] of [500, 100, 900].entries()) {
      const at = base + i * 60_000;
      timeline.record(fresh({ disks: diskFact([{ mount: '/', total: 1000, free }]) }, at), at);
    }
    const point = timeline.query({ metric: 'disk', from: base }).points[0];
    expect(point).toMatchObject({ min: 100, max: 900, avg: 500, count: 3 });
    expect(timeline.trend('disk', base, base + 240_000)).toMatchObject({ start: 500, end: 900, min: 100, max: 900 });
  });

  it('rolls 5-minute buckets up into hourly buckets per local day and separates midnight', () => {
    const day1 = Date.UTC(2026, 10, 18, 23, 50, 0);
    const day2 = Date.UTC(2026, 10, 19, 0, 10, 0);
    const { clock: c } = clock(day2);
    const timeline = new MetricTimeline(c, 'UTC');
    timeline.record(fresh({ cpu: cpuBody(0.2).cpu }, day1), day1);
    timeline.record(fresh({ cpu: cpuBody(0.4).cpu }, day1 + 5 * 60_000), day1 + 5 * 60_000);
    timeline.record(fresh({ cpu: cpuBody(0.6).cpu }, day2), day2);

    const first = timeline.dailyExtension('2026-11-18');
    expect(first?.hours).toHaveLength(1);
    expect(first?.hours[0]).toMatchObject({
      start: Date.UTC(2026, 10, 18, 23, 0, 0),
      samples: 2,
      metrics: { cpu: { min: 0.2, max: 0.4, avg: 0.3, count: 2 } },
    });
    const second = timeline.dailyExtension('2026-11-19');
    expect(second?.hours).toHaveLength(1);
    expect(second?.hours[0]).toMatchObject({
      start: Date.UTC(2026, 10, 19, 0, 0, 0),
      samples: 1,
      metrics: { cpu: { min: 0.6, max: 0.6, avg: 0.6, count: 1 } },
    });
    // Cross-day query returns both buckets in ascending order.
    const series = timeline.query({ metric: 'cpu', from: day1, to: day2 });
    expect(series.points.map((point) => point.at)).toEqual([
      Date.UTC(2026, 10, 18, 23, 50, 0),
      Date.UTC(2026, 10, 18, 23, 55, 0),
      Date.UTC(2026, 10, 19, 0, 10, 0),
    ]);
  });

  it('tolerates clock rollback: merges into the matching bucket and keeps output ordered', () => {
    const t = Date.UTC(2026, 10, 18, 10, 0, 0);
    const { clock: c, set } = clock(t + 20 * 60_000);
    const timeline = new MetricTimeline(c, 'UTC');
    const record = (at: number, usage: number) => timeline.record(fresh({ cpu: cpuBody(usage).cpu }, at), at);
    record(t + 20 * 60_000, 0.9); // bucket 10:20
    record(t + 4 * 60_000, 0.1); // earlier bucket 10:00
    record(t - 60_000, 0.2); // earlier still, 09:55
    record(t + 3 * 60_000, 0.3); // back into 10:00
    set(t + 30 * 60_000);

    const series = timeline.query({ metric: 'cpu', from: t - 10 * 60_000, to: t + 30 * 60_000 });
    expect(series.points.map((point) => point.at)).toEqual([t - 5 * 60_000, t, t + 20 * 60_000]);
    expect(series.points[1]).toMatchObject({ min: 0.1, max: 0.3, avg: 0.2, count: 2 });
  });

  it('produces 23/25 hourly buckets on DST transition days', () => {
    const calendar = new LocalCalendar('America/New_York');
    const spring = calendar.dayBounds('2026-03-08');
    const fall = calendar.dayBounds('2026-11-01');
    expect(spring.durationMs).toBe(23 * 60 * 60_000);
    expect(fall.durationMs).toBe(25 * 60 * 60_000);

    for (const [date, bounds, hours] of [
      ['2026-03-08', spring, 23],
      ['2026-11-01', fall, 25],
    ] as const) {
      const { clock: c } = clock(bounds.endMs - 1);
      const timeline = new MetricTimeline(c, 'America/New_York');
      for (let at = bounds.startMs; at < bounds.endMs; at += 30 * 60_000) {
        timeline.record(fresh({ cpu: cpuBody(0.5).cpu }, at), at);
      }
      expect(timeline.dailyExtension(date)?.hours).toHaveLength(hours);
    }
  });

  it('rejects unknown metrics, inverted ranges and invalid steps, and truncates to 288 points', () => {
    const base = Date.UTC(2026, 10, 18, 0, 0, 0);
    const { clock: c } = clock(base + 24 * 60 * 60_000);
    const timeline = new MetricTimeline(c, 'UTC');
    for (let i = 0; i <= 288; i++) {
      const at = base + i * METRIC_BUCKET_MS;
      timeline.record(fresh({ cpu: cpuBody(0.1 + (i % 10) / 100).cpu }, at), at);
    }
    expect(() => timeline.query({ metric: 'gpu' })).toThrow(MetricsArgsError);
    expect(() => timeline.query({ metric: 'cpu', from: base + 10, to: base })).toThrow(MetricsArgsError);
    expect(() => timeline.query({ metric: 'cpu', step: 299 })).toThrow(MetricsArgsError);
    expect(() => timeline.query({ metric: 'cpu', step: 2.5 })).toThrow(MetricsArgsError);

    const full = timeline.query({ metric: 'cpu', from: base, to: base + 24 * 60 * 60_000 });
    expect(full.points.length).toBe(MAX_METRIC_POINTS);
    expect(full.truncated).toBe(true);
    expect(full.note).toContain('288');
    expect(full.points.at(-1)?.at).toBe(base + 288 * METRIC_BUCKET_MS);

    const clamped = timeline.query({ metric: 'cpu', from: base - 48 * 60 * 60_000, to: base + 24 * 60 * 60_000 });
    expect(clamped.rangeClamped).toBe(true);
    expect(clamped.from).toBe(base);
    expect(clamped.note).toContain('range clamped');
  });

  it('aggregates 10k samples under 200ms and stays under the 10MB structure budget', () => {
    const base = Date.UTC(2026, 10, 18, 0, 0, 0);
    const { clock: c } = clock(base + METRIC_RETENTION_MS);
    const timeline = new MetricTimeline(c, 'UTC');
    const step = Math.floor(METRIC_RETENTION_MS / 10_000);
    const started = performance.now();
    for (let i = 0; i < 10_000; i++) {
      const at = base + i * step;
      timeline.record(
        fresh(
          {
            cpu: cpuBody(0.1 + (i % 50) / 100, 1 + (i % 7)).cpu,
            memory: memBody(40 + (i % 20), 100).memory,
          },
          at,
        ),
        at,
      );
    }
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(200);
    const retained = timeline.retained();
    expect(retained.buckets).toBeLessThanOrEqual(MAX_METRIC_POINTS + 1);
    expect(retained.hours).toBeLessThanOrEqual(25);
    expect(retained.bytes).toBeLessThan(10 * 1024 * 1024);
  });
});

describe('daily summary metric extension', () => {
  it('writes hourly metric buckets into the closing day summary under extensions.metrics', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-metrics-'));
    tempDirs.push(dir);
    const port = new FileHistoryStoragePort(dir);
    const day = Date.UTC(2026, 10, 18, 23, 50, 0);
    const nextDay = Date.UTC(2026, 10, 19, 0, 5, 0);
    const { clock: c, set } = clock(day);
    const metrics = new MetricTimeline(c, 'UTC');
    const manager = new HistoryManager({
      port,
      clock: c,
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: () => {},
      emitSourceOk: () => {},
      timeZone: 'UTC',
      dayExtensions: (date) => {
        const extension = metrics.dailyExtension(date);
        return extension ? { metrics: extension } : undefined;
      },
    });

    metrics.record(fresh({ cpu: cpuBody(0.2).cpu }, day), day);
    metrics.record(fresh({ cpu: cpuBody(0.4).cpu }, day + 5 * 60_000), day + 5 * 60_000);
    await manager.start(false);
    manager.recordEvent({
      id: 'evt-1',
      kind: 'app.activated',
      subject: 'SyntheticApp',
      level: 'record',
      at: day,
      source: { id: 'helper', api: 'nsworkspace', host: 'local' },
    });
    set(nextDay);
    // Advance the manager past midnight before recording, matching the runtime
    // heartbeat path that writes the closing day summary.
    await manager.tick();
    manager.recordEvent({
      id: 'evt-2',
      kind: 'app.activated',
      subject: 'SyntheticApp',
      level: 'record',
      at: nextDay,
      source: { id: 'helper', api: 'nsworkspace', host: 'local' },
    });
    await manager.stop();

    const raw = await port.readDaily('2026-11-18');
    expect(raw).toBeDefined();
    const daily = parseDailySummary(raw as string);
    expect(daily).toBeDefined();
    const extensions = daily?.extensions as { metrics?: Record<string, unknown> } | undefined;
    expect(extensions?.metrics).toMatchObject({ version: 1, bucketMs: METRIC_BUCKET_MS });
    if (!extensions?.metrics) throw new Error('missing extensions.metrics');
    const hours = (extensions.metrics as { hours: Array<Record<string, unknown>> }).hours;
    expect(hours).toHaveLength(1);
    expect(hours[0]).toMatchObject({
      start: Date.UTC(2026, 10, 18, 23, 0, 0),
      samples: 2,
      metrics: { cpu: { min: 0.2, max: 0.4, avg: 0.3, count: 2 } },
    });
  });
});
