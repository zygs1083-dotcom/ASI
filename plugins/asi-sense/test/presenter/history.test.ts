import { describe, expect, it } from 'vitest';
import { createHistory } from '../../src/host/presenter/history.ts';
import { diskFact, f, mkBody } from '../body/helpers.ts';

describe('presenter history', () => {
  it('bounds 10,000 high-frequency samples by interval and keeps the latest value per slot', () => {
    const history = createHistory({ cpu: 100 });
    const body = mkBody({ cpu: f({ usage: 0, perCore: [0], load1: 0, load5: 0, load15: 0 }) });
    for (let at = 0; at < 10_000; at++) {
      body.cpu.observedAt = at;
      if (body.cpu.value) body.cpu.value.usage = at / 10_000;
      history.record(body, at, at);
    }
    const first = history.snapshot(9_999);
    expect(first.cpu).toHaveLength(10);
    expect(first.cpu[0]).toEqual({ at: 999, value: 0.0999 });
    expect(first.cpu.at(-1)).toEqual({ at: 9_999, value: 0.9999 });
    expect(first.cpu.length).toBeLessThanOrEqual(300);
    expect(history.snapshot(9_999).cpu).toBe(first.cpu);
    for (let i = 0; i < 10_000; i++) {
      const at = 10_000 + i * 10;
      body.cpu.observedAt = at;
      if (body.cpu.value) body.cpu.value.usage = (i % 100) / 100;
      history.record(body, at, at);
    }
    const wrapped = history.snapshot(109_990);
    expect(wrapped.cpu).toHaveLength(110);
    expect(wrapped.cpu[0]?.at).toBe(999);
    expect(wrapped.cpu.at(-1)?.at).toBe(109_990);
    expect(first.cpu.at(-1)).toEqual({ at: 9_999, value: 0.9999 });
  });

  it('covers at least 295 seconds after five minutes of 100ms CPU samples', () => {
    const history = createHistory({ cpu: 100 });
    const body = mkBody({ cpu: f({ usage: 0.5, perCore: [0.5], load1: 0, load5: 0, load15: 0 }) });
    for (let at = 0; at <= 300_000; at += 100) {
      body.cpu.observedAt = at;
      history.record(body, at, at);
    }
    const points = history.snapshot(300_000).cpu;
    expect(points.length).toBeLessThanOrEqual(300);
    const last = points.at(-1);
    if (!last) throw new Error('missing history');
    expect(last.at - points[0].at).toBeGreaterThanOrEqual(295_000);
    expect(points.at(-1)?.at).toBe(300_000);
  });

  it('maps fresh facts to their documented units and keeps unchanged series by reference', () => {
    const history = createHistory({ cpu: 1_000 });
    const body = mkBody({
      cpu: f({ usage: 0.4, perCore: [0.4], load1: 1, load5: 2, load15: 3 }),
      memory: f({ total: 200, used: 50, pressure: 'normal', swapUsed: 0 }),
      disks: diskFact([{ mount: '/', total: 100, free: 30 }]),
      battery: f({ percent: 75, charging: false }),
      thermal: f('serious'),
      network: f({ online: true, rxBps: 40, txBps: 50 }),
      harnessProcess: f({ rss: 400, cpu: 0.2, uptimeSec: 7 }),
      tokens: f({
        contextWindow: 1000,
        contextUsed: 600,
        sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    });
    const first = history.update(body, 0);
    expect(first).toEqual({
      cpu: [{ at: 0, value: 0.4 }],
      memory: [{ at: 0, value: 0.25 }],
      disks: { '/': [{ at: 0, value: 0.7 }] },
      battery: [{ at: 0, value: 75 }],
      thermal: [{ at: 0, value: 2 }],
      networkRx: [{ at: 0, value: 40 }],
      networkTx: [{ at: 0, value: 50 }],
      processCpu: [{ at: 0, value: 0.2 }],
      processRss: [{ at: 0, value: 400 }],
      tokens: [{ at: 0, value: 600 }],
    });
    const next = structuredClone(body);
    next.cpu.observedAt = 1_000;
    if (next.cpu.value) next.cpu.value.usage = 0.5;
    const second = history.update(next, 1_000);
    expect(second.cpu).toHaveLength(2);
    expect(second.memory).toBe(first.memory);
    expect(second.disks).toBe(first.disks);
    expect(second.disks['/']).toBe(first.disks['/']);
    expect(history.update(next, 1_001)).toBe(second);
  });

  it('does not record stale, unreadable or invalid disks, and expires old points independently', () => {
    const history = createHistory();
    const first = mkBody({
      disks: diskFact([
        { mount: '/', total: 100, free: 20 },
        { mount: '/stale', total: 100, free: 30, status: 'stale' },
        { mount: '/missing', total: 100, free: 40 },
        { mount: '/invalid', total: 0, free: 0 },
      ]),
    });
    first.disks.unavailableMounts = ['/missing'];
    expect(history.update(first, 0).disks).toEqual({ '/': [{ at: 0, value: 0.8 }] });
    const later = mkBody({ disks: diskFact([{ mount: '/', total: 100, free: 50, observedAt: 300_001 }]) });
    later.disks.observedAt = 300_001;
    expect(history.update(later, 300_001).disks['/']).toEqual([{ at: 300_001, value: 0.5 }]);
    expect(history.update(mkBody(), 600_002).disks).toEqual({});
  });
});
