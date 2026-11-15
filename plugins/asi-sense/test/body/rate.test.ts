import type { Signal } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { RateEvaluator, type RateRule } from '../../src/host/body/rate.ts';
import { blank, cpuBody, diskBody, f, mkBody, rssBody, sample } from './helpers.ts';

const rule = (over: Partial<RateRule> = {}): RateRule =>
  ({ id: 'r', metric: 'rss', windowMs: 10_000, direction: 'up', maxDelta: 10, ...over }) as RateRule;

describe('RateEvaluator construction', () => {
  it('rejects invalid rules and clones config defensively', () => {
    const base = rule();
    expect(() => new RateEvaluator([base, rule({ id: 'r' })])).toThrow(TypeError); // duplicate id
    expect(() => new RateEvaluator([rule({ metric: '' })])).toThrow(TypeError);
    expect(() => new RateEvaluator([rule({ windowMs: 0 })])).toThrow(TypeError);
    expect(() => new RateEvaluator([rule({ maxDelta: Number.NaN })])).toThrow(TypeError);
    expect(() => new RateEvaluator([rule({ maxDelta: -1 })])).toThrow(TypeError);
    expect(() => new RateEvaluator([{ ...base, maxSlope: 1 } as never])).toThrow(TypeError); // both limits
    expect(() => new RateEvaluator([{ id: 'x', metric: 'rss', windowMs: 1, direction: 'up' } as never])).toThrow(
      TypeError,
    ); // neither limit
    expect(() => new RateEvaluator([rule({ direction: 'sideways' as never })])).toThrow(TypeError);
    expect(() => new RateEvaluator([rule({ floor: Number.NaN })])).toThrow(TypeError);
    const rules = [rule({ maxDelta: 6 })];
    const ev = new RateEvaluator(rules);
    rules[0] = { ...rules[0], maxDelta: 0.001 } as RateRule;
    const r = ev.evaluate(sample(rssBody(0), 0), sample(rssBody(5), 1000), {});
    expect(r.signals).toHaveLength(0); // still uses the cloned limit 6
  });
});

describe('RateEvaluator.evaluate', () => {
  it('derives slope in units/second (OLS) and a signed delta, emitting on transitions only', () => {
    const ev = new RateEvaluator([rule({ id: 's', maxDelta: undefined, maxSlope: 1 })]);
    const r1 = ev.evaluate(sample(rssBody(10), 0), sample(rssBody(16), 3000), {});
    expect(r1.signals).toHaveLength(1);
    expect(r1.signals[0]).toMatchObject({
      kind: 'body.rate',
      subject: 'rate:s',
      layer: 'rate',
      at: 3000,
    });
    expect(r1.signals[0]?.data).toMatchObject({
      layer: 'rate',
      severity: 'warn',
      ruleId: 's',
      metric: 'rss',
      windowMs: 10_000,
      delta: 6, // signed raw last-first
      slope: 2, // (16-10)/3s on the y=2t+10 line
      direction: 'up',
    });
    expect(r1.state['rate:s']).toBe('warn');
    const r2 = ev.evaluate(sample(rssBody(16), 3000), sample(rssBody(24), 7000), r1.state);
    expect(r2.signals).toHaveLength(0); // still latched, no re-emit
    expect(r2.state['rate:s']).toBe('warn');
  });

  it('supports direction down with maxDelta (signed magnitude check)', () => {
    const ev = new RateEvaluator([rule({ id: 'd', direction: 'down', maxDelta: 5 })]);
    const r = ev.evaluate(sample(rssBody(30), 0), sample(rssBody(24), 3000), {});
    expect(r.signals[0]?.data).toMatchObject({ severity: 'warn', delta: -6, slope: -2, direction: 'down' });
  });

  it('evaluates only points inside now-windowMs (exact time expiry)', () => {
    const ev = new RateEvaluator([rule({ id: 'e', windowMs: 5000, maxDelta: 7 })]);
    const r1 = ev.evaluate(sample(rssBody(10), 0), sample(rssBody(16), 3000), {});
    expect(r1.signals).toHaveLength(0); // delta 6 <= 7
    const r2 = ev.evaluate(sample(rssBody(16), 3000), sample(rssBody(24), 7000), r1.state);
    // cutoff 2000: only (3000,16) and (7000,24) remain — delta 8, not 14
    expect(r2.signals[0]?.data).toMatchObject({ severity: 'warn', delta: 8, slope: 2 });
  });

  it('holds the latch at exactly 80% of the limit and rearms below it', () => {
    const ev = new RateEvaluator([rule({ id: 'h', maxDelta: 10 })]);
    const r1 = ev.evaluate(sample(rssBody(0), 0), sample(rssBody(12), 1000), {});
    expect(r1.signals[0]?.data.severity).toBe('warn');
    const r2 = ev.evaluate(sample(rssBody(12), 1000), sample(rssBody(8), 2000), r1.state);
    expect(r2.signals).toHaveLength(0); // magnitude 8 == 0.8*10: still latched
    expect(r2.state['rate:h']).toBe('warn');
    const r3 = ev.evaluate(sample(rssBody(8), 2000), sample(rssBody(7), 3000), r2.state);
    expect(r3.signals[0]?.data).toMatchObject({ severity: 'normal', delta: 7 });
    expect(r3.state['rate:h']).toBe('normal');
    const r4 = ev.evaluate(sample(rssBody(7), 3000), sample(rssBody(20), 4000), r3.state);
    expect(r4.signals[0]?.data.severity).toBe('warn'); // rearmed and re-triggered
  });

  it('computes etaToFloorMs for falling floor-bearing metrics and omits it otherwise', () => {
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const body = (free: number, used: number, pct: number) =>
      mkBody({
        disks: f([{ mount: '/', total: 1000, free }]),
        tokens: f({ contextWindow: 1000, contextUsed: used, sessionUsage: usage }),
        battery: f({ percent: pct, charging: false }),
      });
    const ev = new RateEvaluator([
      rule({ id: 'dk', metric: 'disk:/', windowMs: 20_000, direction: 'down', maxDelta: undefined, maxSlope: 10 }),
      rule({ id: 'cx', metric: 'context', windowMs: 20_000, direction: 'down', maxDelta: undefined, maxSlope: 10 }),
      rule({ id: 'bt', metric: 'battery', windowMs: 20_000, direction: 'down', maxDelta: undefined, maxSlope: 10 }),
    ]);
    const r = ev.evaluate(sample(body(500, 300, 50), 0), sample(body(400, 600, 30), 1000), {});
    const byRule = new Map<string, Signal>(r.signals.map((s) => [String(s.data.ruleId), s]));
    expect(r.signals).toHaveLength(3);
    // disk floor 50, slope -100/s → (400-50)/100*1000 = 3500
    expect(byRule.get('dk')?.data).toMatchObject({ delta: -100, etaToFloorMs: 3500, timeToFloorMs: 3500 });
    // context floor 50, remaining 400, slope -300/s → 1166.67
    expect(byRule.get('cx')?.data.etaToFloorMs).toBeCloseTo(1166.67, 2);
    expect(byRule.get('cx')?.data.timeToFloorMs).toBeCloseTo(1166.67, 2);
    // battery floor 5, slope -20/s → (30-5)/20*1000 = 1250
    expect(byRule.get('bt')?.data).toMatchObject({ etaToFloorMs: 1250, timeToFloorMs: 1250 });

    const floorless = new RateEvaluator([
      rule({ id: 'c', metric: 'cpu', direction: 'down', maxDelta: undefined, maxSlope: 0.5 }),
    ]);
    const fc = floorless.evaluate(sample(cpuBody(0.9), 0), sample(cpuBody(0.1), 1000), {});
    expect(fc.signals[0]?.data).not.toHaveProperty('etaToFloorMs');
    expect(fc.signals[0]?.data).not.toHaveProperty('timeToFloorMs');

    const rising = new RateEvaluator([rule({ id: 'u', metric: 'disk:/', maxDelta: 10 })]);
    const ru = rising.evaluate(sample(diskBody(100), 0), sample(diskBody(300), 1000), {});
    expect(ru.signals[0]?.data).not.toHaveProperty('etaToFloorMs'); // rising: no ETA

    const override = new RateEvaluator([
      rule({ id: 'o', metric: 'disk:/', direction: 'down', maxDelta: undefined, maxSlope: 10, floor: 100 }),
    ]);
    const ro = override.evaluate(sample(diskBody(500), 0), sample(diskBody(400), 1000), {});
    expect(ro.signals[0]?.data.etaToFloorMs).toBe(3000); // rule.floor wins over 5% default
  });

  it('retains the latch and breaks history on missing/stale/NaN metrics', () => {
    const ev = new RateEvaluator([
      rule({ id: 'm', metric: 'disk:/', direction: 'down', maxDelta: undefined, maxSlope: 10 }),
    ]);
    const r1 = ev.evaluate(sample(diskBody(500), 0), sample(diskBody(400), 1000), {});
    expect(r1.state['rate:m']).toBe('warn');
    const stale = mkBody({ disks: blank('stale') });
    const r2 = ev.evaluate(sample(diskBody(400), 1000), sample(stale, 2000), r1.state);
    expect(r2.signals).toHaveLength(0);
    expect(r2.state['rate:m']).toBe('warn'); // retained, no fabricated recovery
    const r3 = ev.evaluate(sample(stale, 2000), sample(diskBody(400), 3000), r2.state);
    expect(r3.signals).toHaveLength(0); // history broken: only 1 fresh point
    const r4 = ev.evaluate(sample(diskBody(400), 3000), sample(diskBody(400), 4000), r3.state);
    expect(r4.signals[0]?.data.severity).toBe('normal'); // two fresh points → recovery
    const nan = ev.evaluate(sample(diskBody(400), 4000), sample(diskBody(Number.NaN), 5000), r4.state);
    expect(nan.signals).toHaveLength(0);
    expect(nan.state['rate:m']).toBe('normal');
  });

  it('ignores equal or backward sample timestamps wholesale', () => {
    const ev = new RateEvaluator([rule({ id: 't' })]);
    const r1 = ev.evaluate(sample(rssBody(0), 0), sample(rssBody(5), 1000), {});
    const equal = ev.evaluate(sample(rssBody(5), 1000), sample(rssBody(50), 1000), r1.state);
    expect(equal.signals).toHaveLength(0);
    expect(equal.state).toEqual(r1.state);
    expect(equal.state).not.toBe(r1.state); // unchanged but cloned
    const back = ev.evaluate(sample(rssBody(50), 1000), sample(rssBody(90), 500), r1.state);
    expect(back.signals).toHaveLength(0);
    expect(back.state).toEqual(r1.state);
    const fwd = ev.evaluate(sample(rssBody(50), 1000), sample(rssBody(90), 2000), r1.state);
    expect(fwd.signals[0]?.data.severity).toBe('warn'); // history resumed: delta 90-0
    expect(fwd.signals[0]?.data.delta).toBe(90);
  });

  it('resolves the live limit through rule.param', () => {
    const calls: [string, number][] = [];
    const ev = new RateEvaluator([rule({ id: 'p', maxDelta: 10, param: 'rate.rss.maxDelta' })], (param, fallback) => {
      calls.push([param, fallback]);
      return 2;
    });
    const r = ev.evaluate(sample(rssBody(0), 0), sample(rssBody(5), 1000), {});
    expect(r.signals[0]?.data.severity).toBe('warn'); // resolved 2, not fallback 10
    expect(calls).toEqual([['rate.rss.maxDelta', 10]]);
    const bad = new RateEvaluator([rule({ id: 'q', maxDelta: 10, param: 'x' })], () => Number.NaN);
    const rb = bad.evaluate(sample(rssBody(0), 0), sample(rssBody(5), 1000), {});
    expect(rb.signals).toHaveLength(0); // invalid lookup → configured 10
  });
});
