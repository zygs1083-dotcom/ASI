import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Body, Signal } from '@asi/sense-types';
import { afterEach, describe, expect, it } from 'vitest';
import { FileHistoryStoragePort } from '../../src/host/dsh/history-storage.ts';
import { AwayReporter } from '../../src/host/runtime/away.ts';
import { HistoryManager, LocalCalendar, parseDailySummary } from '../../src/host/runtime/history/index.ts';
import {
  MAX_METRIC_POINTS,
  METRIC_BUCKET_MS,
  METRIC_RETENTION_MS,
  MetricsArgsError,
  MetricTimeline,
} from '../../src/host/runtime/metrics.ts';
import { diskFact, f, freshSample, memBody, mkBody } from '../body/helpers.ts';
import { sig } from '../helpers.ts';

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
    const samples: Array<{ body: Body; at: number }> = [];
    for (let i = 0; i < 10_000; i++) {
      const at = base + i * step;
      samples.push({
        at,
        body: fresh(
          {
            cpu: cpuBody(0.1 + (i % 50) / 100, 1 + (i % 7)).cpu,
            memory: memBody(40 + (i % 20), 100).memory,
          },
          at,
        ),
      });
    }
    const warmup = new MetricTimeline(c, 'UTC');
    for (let i = 0; i < 2_000; i++) {
      const sample = samples[i];
      warmup.record(sample.body, sample.at);
    }
    const started = performance.now();
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      timeline.record(sample.body, sample.at);
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

  it('includes the containing bucket when query from falls mid-bucket', () => {
    const T = Date.UTC(2026, 10, 18, 10, 0, 0);
    const { clock: c } = clock(T + 600_000);
    const timeline = new MetricTimeline(c, 'UTC');
    timeline.record(fresh({ cpu: cpuBody(0.4).cpu }, T + 120_000), T + 120_000);
    timeline.record(fresh({ cpu: cpuBody(0.6).cpu }, T + 180_000), T + 180_000);

    const res = timeline.query({ metric: 'cpu', from: T + 60_000, to: T + 240_000 });
    expect(res.available).toBe(true);
    expect(res.points).toEqual([expect.objectContaining({ at: T, min: 0.4, avg: 0.5, max: 0.6, count: 2 })]);

    const beforeWindow = timeline.query({ metric: 'cpu', from: T - 600_000, to: T - 60_000 });
    expect(beforeWindow.available).toBe(false);
    expect(beforeWindow.points).toEqual([]);
  });

  it('starts trend from the bucket containing from across 5m boundary, mid-bucket, and bucket-end', () => {
    const T = Date.UTC(2026, 10, 18, 9, 0, 0);
    const { clock: c } = clock(T + 4_000_000);
    const timeline = new MetricTimeline(c, 'UTC');
    timeline.record(fresh({ cpu: cpuBody(0.1).cpu }, T - 120_000), T - 120_000);
    timeline.record(fresh({ cpu: cpuBody(0.5).cpu }, T + 60_000), T + 60_000);
    timeline.record(fresh({ cpu: cpuBody(0.5).cpu }, T + 3_900_000), T + 3_900_000);

    for (const from of [T, T + 150_000, T + METRIC_BUCKET_MS - 1]) {
      expect(timeline.trend('cpu', from, T + 4_000_000)).toMatchObject({
        start: 0.5,
        end: 0.5,
        min: 0.5,
        max: 0.5,
      });
    }
  });

  it('aligns hourly buckets and daily summaries to local hour/day boundaries in Asia/Kolkata (+05:30)', () => {
    const { clock: c } = clock(Date.UTC(2026, 10, 18, 12, 0, 0));
    const timeline = new MetricTimeline(c, 'Asia/Kolkata');
    const ist2345 = Date.UTC(2026, 10, 17, 18, 15, 0); // 2026-11-17 23:45 IST -> hour 17:30Z
    const ist0015 = Date.UTC(2026, 10, 17, 18, 45, 0); // 2026-11-18 00:15 IST -> hour 18:30Z
    const ist0045 = Date.UTC(2026, 10, 17, 19, 15, 0); // 2026-11-18 00:45 IST -> hour 18:30Z

    timeline.record(fresh({ cpu: cpuBody(0.2).cpu }, ist2345), ist2345);
    timeline.record(fresh({ cpu: cpuBody(0.4).cpu }, ist0015), ist0015);
    timeline.record(fresh({ cpu: cpuBody(0.6).cpu }, ist0045), ist0045);

    const nov17 = timeline.dailyExtension('2026-11-17');
    const nov18 = timeline.dailyExtension('2026-11-18');
    expect(nov17?.hours).toHaveLength(1);
    expect(nov17?.hours[0]).toMatchObject({
      start: Date.UTC(2026, 10, 17, 17, 30, 0),
      samples: 1,
      metrics: { cpu: { min: 0.2, max: 0.2, avg: 0.2, count: 1 } },
    });
    expect(nov18?.hours).toHaveLength(1);
    expect(nov18?.hours[0]).toMatchObject({
      start: Date.UTC(2026, 10, 17, 18, 30, 0),
      samples: 2,
      metrics: { cpu: { min: 0.4, max: 0.6, avg: 0.5, count: 2 } },
    });
  });

  it('aligns hourly buckets and daily summaries across midnight and DST in Australia/Adelaide', () => {
    const { clock: c } = clock(Date.UTC(2026, 10, 18, 12, 0, 0));
    const timeline = new MetricTimeline(c, 'Australia/Adelaide');
    // Nov 2026 Adelaide is UTC+10:30 (ACDT) -> midnight 2026-11-18 is 2026-11-17T13:30:00Z
    const acdt2345 = Date.UTC(2026, 10, 17, 13, 15, 0); // 2026-11-17 23:45 ACDT -> hour 12:30Z
    const acdt0015 = Date.UTC(2026, 10, 17, 13, 45, 0); // 2026-11-18 00:15 ACDT -> hour 13:30Z

    timeline.record(fresh({ cpu: cpuBody(0.25).cpu }, acdt2345), acdt2345);
    timeline.record(fresh({ cpu: cpuBody(0.75).cpu }, acdt0015), acdt0015);

    const nov17 = timeline.dailyExtension('2026-11-17');
    const nov18 = timeline.dailyExtension('2026-11-18');
    expect(nov17?.hours.map((h) => h.start)).toEqual([Date.UTC(2026, 10, 17, 12, 30, 0)]);
    expect(nov18?.hours.map((h) => h.start)).toEqual([Date.UTC(2026, 10, 17, 13, 30, 0)]);

    const cal = new LocalCalendar('Australia/Adelaide');
    const fall = cal.dayBounds('2026-04-05'); // 25h
    const spring = cal.dayBounds('2026-10-04'); // 23h
    expect(fall.durationMs).toBe(25 * 60 * 60_000);
    expect(spring.durationMs).toBe(23 * 60 * 60_000);
    for (const [date, bounds, expectedHours] of [
      ['2026-04-05', fall, 25],
      ['2026-10-04', spring, 23],
    ] as const) {
      const { clock: dc } = clock(bounds.endMs - 1);
      const dstTimeline = new MetricTimeline(dc, 'Australia/Adelaide');
      for (let at = bounds.startMs; at < bounds.endMs; at += 30 * 60_000) {
        dstTimeline.record(fresh({ cpu: cpuBody(0.5).cpu }, at), at);
      }
      expect(dstTimeline.dailyExtension(date)?.hours).toHaveLength(expectedHours);
    }
  });

  it('starts trend from the first sample at or after from within the bucket, falls through to the next bucket, and excludes samples after to', () => {
    const T = Date.UTC(2026, 10, 18, 9, 0, 0);
    const { clock: c } = clock(T + 5_000_000);
    const timeline = new MetricTimeline(c, 'UTC');
    timeline.record(fresh({ cpu: cpuBody(0.1).cpu }, T + 60_000), T + 60_000);
    timeline.record(fresh({ cpu: cpuBody(0.4).cpu }, T + 120_000), T + 120_000);
    timeline.record(fresh({ cpu: cpuBody(0.5).cpu }, T + 240_000), T + 240_000);
    timeline.record(fresh({ cpu: cpuBody(0.55).cpu }, T + 4_200_000), T + 4_200_000);
    timeline.record(fresh({ cpu: cpuBody(0.95).cpu }, T + 4_260_000), T + 4_260_000);

    // Within first bucket: start at 0.5 (T+240s), ignore 0.1/0.4 before T+180s, and ignore 0.95 after T+4200s.
    expect(timeline.trend('cpu', T + 180_000, T + 4_200_000)).toMatchObject({
      start: 0.5,
      end: 0.55,
      min: 0.5,
      max: 0.55,
      samples: 2,
    });

    // No sample >= T+250s in the first bucket -> falls through to the next bucket at T+4200s.
    expect(timeline.trend('cpu', T + 250_000, T + 4_200_000)).toMatchObject({
      start: 0.55,
      end: 0.55,
      min: 0.55,
      max: 0.55,
      samples: 1,
    });
  });

  it('preserves monotonic order and excludes pre-away samples in overlapped wall buckets during a 2h wall rollback', () => {
    const T = Date.UTC(2026, 10, 18, 12, 0, 0);
    let wall = T - 30 * 60_000;
    let mono = 1_000;
    const timeline = new MetricTimeline({ wall: () => wall, mono: () => mono }, 'UTC');
    // Pre-away reading in the 11:30 bucket before rollback.
    timeline.record(fresh({ cpu: cpuBody(0.05).cpu }, wall), wall);

    wall = T;
    mono = 10_000;
    timeline.record(fresh({ cpu: cpuBody(0.2).cpu }, wall), wall);

    // Wall jumps back 2h while mono advances 90m -> lands back in 11:30 bucket.
    wall = T - 2 * 3_600_000 + 90 * 60_000;
    mono += 90 * 60_000;
    timeline.record(fresh({ cpu: cpuBody(0.8).cpu }, wall), wall);

    const trend = timeline.trend('cpu', T, T + 90 * 60_000, { from: 10_000, to: mono });
    expect(trend).toMatchObject({
      start: 0.2,
      end: 0.8,
      min: 0.2,
      max: 0.8,
      samples: 2,
    });
  });

  it('excludes samples from before a wall-clock rollback so a flat away is not flagged as metric-growth', () => {
    const MINUTE = 60_000;
    const T = Date.UTC(2026, 10, 18, 9, 0, 0);
    let wall = T + 30 * MINUTE;
    let mono = 5_000;
    const clock = { wall: () => wall, mono: () => mono };
    const timeline = new MetricTimeline(clock, 'UTC');
    // Recorded while the wall clock ran 30m fast, before NTP rolled it back.
    timeline.record(fresh({ cpu: cpuBody(0.1).cpu }, wall), wall);
    wall = T;
    mono = 10_000;
    const emitted: Signal[] = [];
    const away = new AwayReporter(timeline, clock, (signal) => emitted.push(signal));
    away.observe(sig({ id: 'l1', kind: 'screen.locked', at: wall, subject: 'screen', data: { at: wall } }));
    for (const at of [T + 40 * MINUTE, T + 70 * MINUTE]) {
      wall = at;
      mono = 10_000 + (at - T);
      timeline.record(fresh({ cpu: cpuBody(0.5).cpu }, wall), wall);
    }
    away.observe(sig({ id: 'u1', kind: 'screen.unlocked', at: wall, subject: 'screen', data: { at: wall } }));

    const data = emitted[0]?.data as Record<string, unknown>;
    const cpu = (data.metrics as Array<Record<string, unknown>>).find((m) => m.metric === 'cpu');
    expect(data.anomalies).toEqual([]);
    expect(cpu).toMatchObject({ start: 0.5, end: 0.5, min: 0.5, max: 0.5 });
  });
});
