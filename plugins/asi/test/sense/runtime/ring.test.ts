import { describe, expect, it } from 'vitest';
import { createRingHistory } from '../../../src/sense/host/runtime/ring.ts';
import { diskFact, f, mkBody } from '../helpers.ts';

describe('5-minute short-term vitals trend ring', () => {
  it('records cpu, memory, battery, thermal, network, process, tokens, disks ratio and diskFree bytes', () => {
    const ring = createRingHistory({ cpu: 2_000, thermal: 30_000 });
    const body = mkBody(
      {
        cpu: f({ usage: 0.45, perCore: [0.45], load1: 1.5, load5: 1.2, load15: 1.0 }, 'ok', 10_000),
        memory: f({ total: 16_000, used: 12_000, pressure: 'warn', swapUsed: 500 }, 'ok', 10_000),
        battery: f({ percent: 35, charging: false }, 'ok', 10_000),
        thermal: f('serious', 'ok', 10_000),
        network: f({ online: true, rxBps: 1_024, txBps: 512 }, 'ok', 10_000),
        harnessProcess: f({ rss: 200 * 1024 ** 2, cpu: 0.05, uptimeSec: 120 }, 'ok', 10_000),
        tokens: f(
          {
            contextWindow: 100_000,
            contextUsed: 25_000,
            sessionUsage: { input: 25_000, output: 1_000, cacheRead: 0, cacheWrite: 0 },
          },
          'ok',
          10_000,
        ),
        disks: diskFact(
          [
            { mount: '/', total: 100_000, free: 20_000, observedAt: 10_000 },
            { mount: '__proto__', total: 50_000, free: 10_000, observedAt: 10_000 },
          ],
          'ok',
          10_000,
        ),
      },
      10_000,
    );

    ring.record(body, 10_000, 10_000);
    const snap = ring.snapshot(10_000);
    expect(snap.cpu).toEqual([{ at: 10_000, value: 0.45 }]);
    expect(snap.memory).toEqual([{ at: 10_000, value: 0.75 }]);
    expect(snap.battery).toEqual([{ at: 10_000, value: 35 }]);
    expect(snap.thermal).toEqual([{ at: 10_000, value: 2 }]);
    expect(snap.networkRx).toEqual([{ at: 10_000, value: 1_024 }]);
    expect(snap.networkTx).toEqual([{ at: 10_000, value: 512 }]);
    expect(snap.processCpu).toEqual([{ at: 10_000, value: 0.05 }]);
    expect(snap.processRss).toEqual([{ at: 10_000, value: 200 * 1024 ** 2 }]);
    expect(snap.tokens).toEqual([{ at: 10_000, value: 25_000 }]);
    expect(snap.disks['/']).toEqual([{ at: 10_000, value: 0.8 }]);
    expect(snap.diskFree?.['/']).toEqual([{ at: 10_000, value: 20_000 }]);
    expect(Object.getOwnPropertyDescriptor(snap.disks, '__proto__')?.value).toEqual([{ at: 10_000, value: 0.8 }]);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('evicts samples older than 5 minutes (300_000ms) on monotonic time and ignores non-ok/unavailable volumes', () => {
    const ring = createRingHistory({ cpu: 2_000 });
    ring.record(
      mkBody({ cpu: f({ usage: 0.1, perCore: [0.1], load1: 1, load5: 1, load15: 1 }, 'ok', 1_000) }),
      1_000,
      1_000,
    );
    ring.record(
      mkBody({
        cpu: f({ usage: 0.6, perCore: [0.6], load1: 2, load5: 2, load15: 2 }, 'ok', 200_000),
        disks: diskFact(
          [
            { mount: '/', total: 100, free: 40, observedAt: 200_000, status: 'ok' },
            { mount: '/Volumes/Stale', total: 100, free: 5, observedAt: 200_000, status: 'stale' },
            { mount: '/Volumes/Unavail', total: 100, free: 5, observedAt: 200_000, status: 'ok' },
          ],
          'ok',
          200_000,
          30_000,
          ['/Volumes/Unavail'],
        ),
      }),
      200_000,
      200_000,
    );

    const at302k = ring.snapshot(302_000);
    expect(at302k.cpu).toEqual([{ at: 200_000, value: 0.6 }]);
    expect(at302k.disks['/']).toEqual([{ at: 200_000, value: 0.6 }]);
    expect(at302k.disks['/Volumes/Stale']).toBeUndefined();
    expect(at302k.disks['/Volumes/Unavail']).toBeUndefined();

    const at600k = ring.snapshot(600_000);
    expect(at600k.cpu).toEqual([]);
    expect(at600k.disks['/']).toBeUndefined();
    expect(at600k.diskFree?.['/']).toBeUndefined();
  });
});
