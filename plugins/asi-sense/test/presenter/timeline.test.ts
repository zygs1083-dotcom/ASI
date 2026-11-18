import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { Body } from '@asi/sense-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileHistoryStoragePort } from '../../src/host/dsh/history-storage.ts';
import { createPresenter } from '../../src/host/presenter/index.ts';
import { summarizeDay } from '../../src/host/runtime/history/summarize.ts';
import { LocalCalendar } from '../../src/host/runtime/history/time.ts';
import { createSenseRuntime } from '../../src/host/runtime/index.ts';
import type { DshPort, SensePorts } from '../../src/host/runtime/ports.ts';
import { diskFact, f, mkBody } from '../body/helpers.ts';

class FakeHelper extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  closed = false;
  gen = 0;
  constructor(private readonly getWall: () => number) {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        const msg = JSON.parse(line) as { cmd: string; id: string; enabled?: boolean };
        if (msg.cmd === 'titles') {
          this.send({
            type: 'titles.ack',
            id: msg.id,
            session: 'fixture-session',
            enabled: msg.enabled ?? true,
            gen: ++this.gen,
          });
        } else if (msg.cmd === 'snapshot') {
          this.send({ type: 'snapshot', thermal: 'nominal' });
        }
      }
    });
  }
  send(event: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ v: 1, at: this.getWall(), ...event })}\n`);
  }
  kill = vi.fn(() => {
    if (!this.closed) {
      this.closed = true;
      this.stdout.end();
      queueMicrotask(() => this.emit('close', 0, 'SIGTERM'));
    }
    return true;
  });
}

function makeProbeSample(
  at: number,
  opts: { cpu: number; memUsed: number; memTotal: number; diskFree: number; battery: number | null },
): Body {
  return {
    ...mkBody(),
    cpu: {
      ...f({ usage: opts.cpu, perCore: [opts.cpu], load1: 1.1, load5: 1.0, load15: 0.9 }),
      observedAt: at,
    },
    memory: {
      ...f({ total: opts.memTotal, used: opts.memUsed, pressure: 'normal', swapUsed: 0 }),
      observedAt: at,
    },
    disks: {
      ...diskFact([{ mount: '/', total: 100 * 1024 ** 3, free: opts.diskFree, observedAt: at }]),
      observedAt: at,
    },
    battery:
      opts.battery === null
        ? { ...f(null, 'ok'), observedAt: at }
        : { ...f({ percent: opts.battery, charging: false }), observedAt: at },
    thermal: { ...f('nominal' as const), observedAt: at },
    network: { ...f({ online: true, rxBps: 0, txBps: 0 }), observedAt: at },
    harnessProcess: { ...f({ rss: 100, cpu: 0.01, uptimeSec: 10 }), observedAt: at },
    tokens: { ...f({ sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }), observedAt: at },
  };
}

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

async function createTimelineHarness(
  startWall: number,
  seedHistory?: (port: FileHistoryStoragePort) => Promise<void>,
  useDefaultRules = false,
) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'asi-presenter-timeline-'));
  cleanupDirs.push(dir);
  const historyPort = new FileHistoryStoragePort(dir);
  if (seedHistory) await seedHistory(historyPort);

  let wall = startWall;
  let mono = 1_000;
  const clock = { wall: () => wall, mono: () => mono };
  let helperChild: FakeHelper | undefined;
  let emitProbeSample: ((body: Body) => void) | undefined;
  const delivered: Parameters<DshPort['deliver']>[1][] = [];
  let agentCb:
    | ((
        ev:
          | { type: 'created'; sessionId: string }
          | { type: 'pre-step'; sessionId: string; userInitiated?: boolean }
          | { type: 'post-step'; sessionId: string },
      ) => Promise<void> | void)
    | undefined;

  const ports: SensePorts = {
    clock,
    storage: { load: async () => undefined, save: async () => {} },
    history: historyPort,
    files: { watch: () => ({ close: () => {} }) },
    helper: {
      spawn: () => {
        helperChild = new FakeHelper(() => wall);
        queueMicrotask(() =>
          helperChild?.send({
            type: 'hello',
            at: wall,
            version: '0.1.0',
            pid: 100,
            session: 'fixture-session',
            permissions: { accessibility: 'granted' },
          }),
        );
        return helperChild as never;
      },
    },
    probe: {
      create: () => ({
        onSample: (cb) => {
          emitProbeSample = cb;
          return () => {};
        },
        start: () => {},
        stop: async () => {},
      }),
    },
    dsh: {
      onAgentEvent: (cb) => {
        agentCb = cb as typeof agentCb;
        return () => {};
      },
      onTool: () => () => {},
      onJob: () => () => {},
      deliver: async (_sessionId, intent) => {
        delivered.push(intent);
      },
      tokenSnapshot: async () => undefined,
    },
  };

  const runtime = createSenseRuntime(ports, {
    platform: 'darwin',
    timeZone: 'UTC',
    helperPath: '/fixture/helper',
    ...(useDefaultRules ? {} : { rules: [] }),
  });
  await runtime.start();
  await agentCb?.({ type: 'created', sessionId: 'sess-1' });
  await agentCb?.({ type: 'pre-step', sessionId: 'sess-1', userInitiated: true });
  await agentCb?.({ type: 'post-step', sessionId: 'sess-1' });
  const presenter = createPresenter(runtime, { clock });

  return {
    runtime,
    presenter,
    delivered,
    setWall: (nextWall: number) => {
      mono += Math.max(0, nextWall - wall);
      wall = nextWall;
    },
    advance: (ms: number) => {
      wall += ms;
      mono += ms;
    },
    emitHelper: async (event: Record<string, unknown>) => {
      helperChild?.send({ at: wall, ...event });
      await new Promise((resolve) => setTimeout(resolve, 15));
    },
    emitBody: async (opts: {
      cpu: number;
      memUsed: number;
      memTotal: number;
      diskFree: number;
      battery: number | null;
    }) => {
      emitProbeSample?.(makeProbeSample(wall, opts));
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
}

describe('presenter timeline projection & caching', () => {
  it('projects today top-5 apps, counters, yesterday summary, 24h metric buckets with units, and away summaries', async () => {
    const start = Date.UTC(2026, 10, 18, 9, 0, 0);
    const yesterday = '2026-11-17';
    const cal = new LocalCalendar('UTC');
    const h = await createTimelineHarness(start, async (port) => {
      const yBounds = cal.dayBounds(yesterday);
      const ySummary = summarizeDay(
        yesterday,
        {
          events: [
            {
              id: 'y-1',
              kind: 'app.activated',
              subject: 'YesterdayApp',
              level: 'record',
              at: yBounds.startMs + 60_000,
              source: { id: 'helper', api: 'ax', host: 'local' },
            },
          ],
          lifecycle: [
            { record: 'lifecycle', state: 'active', at: yBounds.startMs },
            { record: 'lifecycle', state: 'stopped', at: yBounds.startMs + 600_000 },
          ],
        },
        yBounds,
      );
      await port.writeDaily(yesterday, JSON.stringify(ySummary));
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 15));

      await h.emitHelper({ type: 'power.sleep' });
      h.advance(10 * 60_000);
      await h.emitHelper({ type: 'power.wake' });

      await h.emitHelper({ type: 'screen.locked' });
      h.advance(70 * 60_000);
      await h.emitHelper({ type: 'screen.unlocked' });

      // Body samples across two 5-min buckets (memTotal = 10GB, used = 5GB/7GB -> 0.5..0.7 ratio)
      await h.emitBody({ cpu: 0.2, memUsed: 5_000, memTotal: 10_000, diskFree: 40_000, battery: 80 });
      h.advance(10_000);
      await h.emitBody({ cpu: 0.6, memUsed: 7_000, memTotal: 10_000, diskFree: 39_000, battery: 78 });
      h.advance(5 * 60_000);
      await h.emitBody({ cpu: 0.4, memUsed: 6_000, memTotal: 10_000, diskFree: 38_000, battery: 76 });

      const appSpecs = [
        ['AppOne', 10_000],
        ['AppTwo', 20_000],
        ['AppThree', 30_000],
        ['AppFour', 40_000],
        ['AppFive', 50_000],
        ['AppSix', 60_000],
      ] as const;
      for (const [name, dur] of appSpecs) {
        await h.emitHelper({ type: 'app.activated', name, bundleId: name, pid: 1 });
        h.advance(dur);
      }
      await h.emitHelper({ type: 'app.activated', name: 'AppEnd', bundleId: 'AppEnd', pid: 1 });
      await new Promise((resolve) => setTimeout(resolve, 25));

      const frame = h.presenter.snapshot();
      const timeline = frame.timeline;
      expect(timeline).toBeDefined();
      const today = timeline?.today;
      expect(today).toBeDefined();
      if (!today || !timeline) throw new Error('Expected today timeline to be defined');

      expect(today.date).toBe('2026-11-18');
      expect(today.topApps).toHaveLength(5);
      expect(today.topApps.map((a) => a.app)).toEqual(['AppSix', 'AppFive', 'AppFour', 'AppThree', 'AppTwo']);
      expect(today.sleepCount).toBe(1);
      expect(today.sleepDurationMs).toBe(10 * 60_000);
      expect(today.lockDurationMs).toBe(70 * 60_000);
      expect(today.observedMs).toBeGreaterThan(0);

      expect(timeline.yesterday).toMatchObject({
        date: '2026-11-17',
        observedMs: 600_000,
        topApps: [{ app: 'YesterdayApp', foregroundMs: 540_000, switches: 1 }],
      });

      const metrics = timeline.metrics;
      expect(metrics).toBeDefined();
      expect(metrics?.cpu).toEqual({
        unit: 'ratio',
        points: [
          expect.objectContaining({ min: 0.2, avg: 0.4, max: 0.6 }),
          expect.objectContaining({ min: 0.4, avg: 0.4, max: 0.4 }),
        ],
      });
      expect(metrics?.memory).toEqual({
        unit: 'ratio',
        points: [
          expect.objectContaining({ min: 0.5, avg: 0.6, max: 0.7 }),
          expect.objectContaining({ min: 0.6, avg: 0.6, max: 0.6 }),
        ],
      });
      expect(metrics?.disk?.unit).toBe('bytes');
      expect(metrics?.disk?.points[0]).toMatchObject({ min: 39_000, avg: 39_500, max: 40_000 });
      expect(metrics?.battery?.unit).toBe('percent');
      expect(metrics?.battery?.points[0]).toMatchObject({ min: 78, avg: 79, max: 80 });

      expect(timeline.lastAway).toMatchObject({
        durationMs: 70 * 60_000,
        hasAnomaly: false,
        anomalies: [],
        pushed: false,
      });
    } finally {
      h.presenter.close();
      await h.runtime.stop();
    }
  });

  it('keeps identical timeline object reference across 10 consecutive frames within the same 5-minute bucket', async () => {
    const start = Date.UTC(2026, 10, 18, 10, 0, 0);
    const fiftyGiB = 50 * 1024 ** 3;
    const h = await createTimelineHarness(start);
    try {
      await h.emitBody({ cpu: 0.25, memUsed: 4_000, memTotal: 10_000, diskFree: fiftyGiB, battery: 90 });
      const baseline = h.presenter.snapshot();
      expect(baseline.timeline).toBeDefined();

      // Advance 10 frames (every 500ms-20s) inside the SAME 5-minute bucket [10:00, 10:05)
      for (let i = 1; i <= 10; i++) {
        h.advance(10_000);
        await h.emitBody({
          cpu: 0.25 + (i % 3) * 0.01,
          memUsed: 4_000 + i * 10,
          memTotal: 10_000,
          diskFree: fiftyGiB - i * 1024,
          battery: 90 - (i % 2),
        });
        const nextFrame = h.presenter.snapshot();
        expect(nextFrame.timeline).toBe(baseline.timeline);
      }

      // Cross into the next 5-minute bucket [10:05, 10:10): timeline must rebuild
      h.advance(210_000);
      await h.emitBody({ cpu: 0.5, memUsed: 5_000, memTotal: 10_000, diskFree: fiftyGiB - 20_000, battery: 88 });
      const afterBoundary = h.presenter.snapshot();
      expect(afterBoundary.timeline).not.toBe(baseline.timeline);
      expect(afterBoundary.timeline?.metrics?.cpu?.points).toHaveLength(2);
    } finally {
      h.presenter.close();
      await h.runtime.stop();
    }
  });

  it('falls back memory unit to bytes when total is unavailable', async () => {
    const start = Date.UTC(2026, 10, 18, 11, 0, 0);
    const h = await createTimelineHarness(start);
    try {
      // Simulate a custom runtime/metrics case where memory points lack memoryTotal
      vi.spyOn(h.runtime, 'metricsVersion').mockReturnValue(1);
      vi.spyOn(h.runtime, 'metrics24h').mockReturnValue({
        version: 1,
        cpu: [],
        memory: [{ at: start, min: 4_000_000, avg: 4_500_000, max: 5_000_000 }],
        disk: [],
        battery: [],
      });
      const frame = h.presenter.snapshot();
      expect(frame.timeline?.metrics?.memory).toEqual({
        unit: 'bytes',
        points: [{ at: start, min: 4_000_000, avg: 4_500_000, max: 5_000_000 }],
      });
    } finally {
      h.presenter.close();
      await h.runtime.stop();
    }
  });

  it('projects anomalous and pushed away summaries when an anomaly happens while locked', async () => {
    const start = Date.UTC(2026, 10, 18, 12, 0, 0);
    const h = await createTimelineHarness(start, undefined, true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 15));
      await h.emitHelper({ type: 'screen.locked' });
      await h.emitBody({ cpu: 0.1, memUsed: 4_000, memTotal: 10_000, diskFree: 50_000, battery: 90 });
      h.advance(70 * 60_000);
      await h.emitBody({ cpu: 0.55, memUsed: 4_000, memTotal: 10_000, diskFree: 50_000, battery: 85 });
      await h.emitHelper({ type: 'screen.unlocked' });
      await new Promise((resolve) => setTimeout(resolve, 25));

      const frame = h.presenter.snapshot();
      expect(frame.timeline?.lastAway).toBeDefined();
      expect(frame.timeline?.lastAway).toMatchObject({
        durationMs: 70 * 60_000,
        hasAnomaly: true,
        pushed: true,
      });
      expect(frame.timeline?.lastAway?.anomalies.length).toBeGreaterThan(0);
    } finally {
      h.presenter.close();
      await h.runtime.stop();
    }
  });
});
