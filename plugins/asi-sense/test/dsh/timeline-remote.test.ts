import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { Body } from '@asi/sense-types';
import { Context } from '@deepseek-ai/cordis';
import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { panelModel } from '../../src/client/panel-model.ts';
import { FileHistoryStoragePort } from '../../src/host/dsh/history-storage.ts';
import { presenterFrames } from '../../src/host/dsh/presenter-frames.ts';
import { AsiSenseRemote } from '../../src/host/dsh/remote.ts';
import { createPresenter } from '../../src/host/presenter/index.ts';
import { summarizeDay } from '../../src/host/runtime/history/summarize.ts';
import { LocalCalendar } from '../../src/host/runtime/history/time.ts';
import { createSenseRuntime } from '../../src/host/runtime/index.ts';
import type { SensePorts } from '../../src/host/runtime/ports.ts';
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

function makeBody(at: number): Body {
  return {
    ...mkBody(),
    cpu: { ...f({ usage: 0.35, perCore: [0.35], load1: 1, load5: 1, load15: 1 }), observedAt: at },
    memory: { ...f({ total: 10_000, used: 6_000, pressure: 'normal', swapUsed: 0 }), observedAt: at },
    disks: { ...diskFact([{ mount: '/', total: 100_000, free: 45_000 }]), observedAt: at },
    battery: { ...f({ percent: 85, charging: false }), observedAt: at },
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

describe('DSH timeline & history actions integration', () => {
  it('routes listMonths, loadMonthly, and clearHistory through remote to runtime and empties timeline after clear', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'asi-dsh-timeline-'));
    cleanupDirs.push(dir);
    const historyPort = new FileHistoryStoragePort(dir);
    const cal = new LocalCalendar('UTC');
    const prevDate = '2026-10-15';
    const prevBounds = cal.dayBounds(prevDate);
    await historyPort.writeDaily(
      prevDate,
      JSON.stringify(
        summarizeDay(
          prevDate,
          {
            events: [
              {
                id: 'ev-oct',
                kind: 'app.activated',
                subject: 'CodeForge',
                level: 'wake',
                at: prevBounds.startMs + 60_000,
                source: { id: 'helper', api: 'ax', host: 'local' },
              },
            ],
            lifecycle: [
              { record: 'lifecycle', state: 'active', at: prevBounds.startMs },
              { record: 'lifecycle', state: 'stopped', at: prevBounds.startMs + 600_000 },
            ],
          },
          prevBounds,
        ),
      ),
    );

    let wall = Date.UTC(2026, 10, 18, 9, 0, 0);
    let mono = 1_000;
    const clock = { wall: () => wall, mono: () => mono };
    let helperChild: FakeHelper | undefined;
    let emitSample: ((body: Body) => void) | undefined;
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
              pid: 10,
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
            emitSample = cb;
            return () => {};
          },
          start: () => {},
          stop: async () => {},
        }),
      },
      dsh: {
        onAgentEvent: () => () => {},
        onTool: () => () => {},
        onJob: () => () => {},
        deliver: async () => {},
        tokenSnapshot: async () => undefined,
      },
    };

    const ctx = new Context();
    const runtime = createSenseRuntime(ports, {
      platform: 'darwin',
      timeZone: 'UTC',
      helperPath: '/fixture/helper',
      rules: [],
    });
    await runtime.start();
    const presenter = createPresenter(runtime, { clock });
    const remote = new AsiSenseRemote(ctx, runtime.actions, presenterFrames(presenter));
    const ac = new AbortController();

    try {
      await new Promise((resolve) => setTimeout(resolve, 15));
      helperChild?.send({ type: 'app.activated', at: wall, name: 'CodeForge', bundleId: 'CodeForge', pid: 10 });
      wall += 5 * 60_000;
      mono += 5 * 60_000;
      emitSample?.(makeBody(wall));
      await new Promise((resolve) => setTimeout(resolve, 15));
      helperChild?.send({ type: 'screen.locked', at: wall });
      wall += 70 * 60_000;
      mono += 70 * 60_000;
      helperChild?.send({ type: 'screen.unlocked', at: wall });
      await new Promise((resolve) => setTimeout(resolve, 25));

      const months = await remote.listMonths();
      expect(months).toEqual(['2026-10']);

      const monthly = await remote.loadMonthly('2026-10');
      expect(monthly.available).toBe(true);
      if (monthly.available) {
        expect(monthly.summary.month).toBe('2026-10');
        expect(monthly.summary.topApps[0]?.app).toBe('CodeForge');
        expect(monthly.summary.wakeCount).toBe(1);
      }

      const iter = remote.frames(ac.signal)[Symbol.asyncIterator]();
      const firstWire = await iter.next();
      expect(firstWire.done).toBe(false);
      expect(isRemoteJsonValue(firstWire.value)).toBe(true);
      const firstClient = panelModel(firstWire.value);
      expect(firstClient.timeline?.today).toBeDefined();
      expect(firstClient.timeline?.metrics?.cpu?.points.length).toBeGreaterThanOrEqual(1);
      expect(firstClient.timeline?.lastAway).toBeDefined();

      // Clear history through Remote -> actions -> runtime
      await remote.clearHistory();

      // Advance past presenter's 500ms frame throttle so next emitted frame arrives promptly
      wall += 600;
      mono += 600;
      const clearedWire = await iter.next();
      expect(clearedWire.done).toBe(false);
      expect(panelModel(clearedWire.value).timeline).toBeUndefined();
      expect(runtime.events()).toEqual([]);
      expect(await remote.listMonths()).toEqual([]);
      const missingMonthly = await remote.loadMonthly('2026-10');
      expect(missingMonthly.available).toBe(false);
    } finally {
      ac.abort();
      presenter.close();
      await runtime.stop();
      await ctx.fiber.dispose();
    }
  });
});
