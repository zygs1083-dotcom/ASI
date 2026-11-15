import { describe, expect, it } from 'vitest';
import { readMetrics } from '../../src/host/body/metrics.ts';
import { battBody, blank, ctxBody, diskBody, f, mkBody, rssBody, sample } from './helpers.ts';

const at = 1000;

describe('readMetrics', () => {
  it('reads every fresh metric with its range-checked value and natural floor', () => {
    const m = readMetrics(
      sample(
        mkBody({
          cpu: f({ usage: 0.5, perCore: [0.5], load1: 0, load5: 0, load15: 0 }),
          memory: f({ total: 200, used: 50, pressure: 'normal', swapUsed: 0 }),
          disks: f([{ mount: '/', total: 1000, free: 300 }]),
          battery: f({ percent: 40, charging: false }),
          network: f({ online: true, rxBps: 10, txBps: 20 }),
          harnessProcess: f({ rss: 1024, cpu: 0, uptimeSec: 5 }),
          tokens: f({
            contextWindow: 1000,
            contextUsed: 700,
            contextProjected: 999_999,
            sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }),
        }),
        at,
      ),
    );
    expect(m.get('cpu')).toEqual({ value: 0.5 });
    expect(m.get('rss')).toEqual({ value: 1024 });
    expect(m.get('memory')).toEqual({ value: 0.25 });
    expect(m.get('disk:/')).toEqual({ value: 300, floor: 50 }); // floor = 5% total
    expect(m.get('context')).toEqual({ value: 300, floor: 50 }); // window - used
    expect(m.get('battery')).toEqual({ value: 40, floor: 5 });
    expect(m.get('network.rx')).toEqual({ value: 10 });
    expect(m.get('network.tx')).toEqual({ value: 20 });
  });

  it('omits out-of-range, non-finite, stale and unavailable facts', () => {
    const cases: [key: string, body: ReturnType<typeof mkBody>][] = [
      ['cpu', mkBody({ cpu: f({ usage: 1.5, perCore: [], load1: 0, load5: 0, load15: 0 }) })],
      ['cpu', mkBody({ cpu: f({ usage: Number.NaN, perCore: [], load1: 0, load5: 0, load15: 0 }) })],
      ['rss', rssBody(-1)],
      ['memory', mkBody({ memory: f({ total: 100, used: 150, pressure: 'normal', swapUsed: 0 }) })],
      ['disk:/', diskBody(1500, 1000)],
      ['disk:/', diskBody(10, 0)],
      ['battery', battBody(120)],
      ['battery', battBody(50, true)], // charging: omitted entirely
      ['network.rx', mkBody({ network: f({ online: true, rxBps: -1, txBps: 5 }) })],
    ];
    for (const [key, body] of cases) {
      expect(readMetrics(sample(body, at)).has(key), key).toBe(false);
    }
    const stale = readMetrics(sample(diskBody(100), 70_000));
    expect(stale.has('disk:/')).toBe(false); // observedAt 0 + ttl 60s < 70s
    const denied = readMetrics(sample(mkBody({ cpu: blank('denied') }), at));
    expect(denied.has('cpu')).toBe(false);
    const nan = readMetrics(sample(diskBody(Number.NaN), at));
    expect(nan.has('disk:/')).toBe(false);
    // Infinity totals yield no fake ratio or floor
    const inf = readMetrics(
      sample(
        mkBody({
          memory: f({ total: Number.POSITIVE_INFINITY, used: 1, pressure: 'normal', swapUsed: 0 }),
          disks: f([{ mount: '/', total: Number.POSITIVE_INFINITY, free: 10 }]),
        }),
        at,
      ),
    );
    expect(inf.has('memory')).toBe(false);
    expect(inf.has('disk:/')).toBe(false);
  });

  it('uses actual context usage only; negative remaining is a valid reading', () => {
    const over = readMetrics(sample(ctxBody(100, 120), at));
    expect(over.get('context')).toEqual({ value: -20, floor: 5 });
    const noUsed = readMetrics(sample(ctxBody(100), at)); // projected only
    expect(noUsed.has('context')).toBe(false);
    const negUsed = readMetrics(sample(ctxBody(100, -1), at));
    expect(negUsed.has('context')).toBe(false);
    const noWindow = readMetrics(sample(ctxBody(0, 10), at));
    expect(noWindow.has('context')).toBe(false);
  });
});
