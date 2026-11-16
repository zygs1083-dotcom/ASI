import type { Body, Fact, FactStatus } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import {
  BODY_THRESHOLDS,
  type BodyThresholdSample,
  bodyThresholdSignals,
  FloorEvaluator,
} from '../src/host/attention/thresholds.ts';
import { SRC } from './helpers.ts';

function f<T>(value: T | null, status: FactStatus = 'ok'): Fact<T> {
  return { value, status, source: SRC, observedAt: 0, ttlMs: 60_000 };
}

const blank = (status: FactStatus = 'unknown'): Fact<never> => f<never>(null, status);

function mkBody(over: Partial<Body> = {}): Body {
  return {
    cpu: blank(),
    memory: blank(),
    disks: { ...blank(), kind: 'disks' },
    battery: blank(),
    thermal: blank(),
    network: blank(),
    harnessProcess: blank(),
    tokens: blank(),
    ...over,
  };
}

function sample(body: Body, at: number, state?: BodyThresholdSample['state']): BodyThresholdSample {
  return { body, at, source: SRC, ...(state ? { state } : {}) };
}

const disks = (free: number, total = 100) => mkBody({ disks: { ...f([{ mount: '/', total, free }]), kind: 'disks' } });
const tokens = (window: number, used?: number, projected?: number) =>
  mkBody({
    tokens: f({
      contextWindow: window,
      ...(used !== undefined ? { contextUsed: used } : {}),
      ...(projected !== undefined ? { contextProjected: projected } : {}),
      sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  });
const battery = (percent: number | null, charging = false) =>
  mkBody({ battery: f(percent === null ? null : { percent, charging }) });
const memory = (pressure: string) =>
  mkBody({
    memory: f({
      total: 1,
      used: 1,
      pressure: pressure as 'normal' | 'warn' | 'critical',
      swapUsed: 0,
    }),
  });
const thermal = (v: string) => mkBody({ thermal: f(v as 'nominal' | 'fair' | 'serious' | 'critical') });

describe('bodyThresholdSignals', () => {
  it('exports the approved defaults', () => {
    expect(BODY_THRESHOLDS).toEqual({
      disk: { warn: 0.1, critical: 0.05 },
      context: { warn: 0.15, critical: 0.05 },
      battery: { warn: 0.15, critical: 0.05 },
      hysteresis: 0.05,
    });
  });

  it('warns once on disk entry, suppresses jitter inside hysteresis band', () => {
    const p0 = sample(disks(20), 0);
    const r1 = bodyThresholdSignals(p0, sample(disks(8), 10));
    expect(r1.signals).toHaveLength(1);
    expect(r1.signals[0]).toMatchObject({
      kind: 'body.threshold',
      subject: 'disk:/',
      at: 10,
      data: { severity: 'warn' },
    });
    expect(r1.signals[0]?.id).toBe('fs:disk:/:10:warn');
    const r2 = bodyThresholdSignals(sample(disks(8), 10, r1.state), sample(disks(12), 20));
    expect(r2.signals).toHaveLength(0); // 12% < 15% warn+hyst
    const r3 = bodyThresholdSignals(sample(disks(12), 20, r2.state), sample(disks(16), 30));
    expect(r3.signals).toHaveLength(1);
    expect(r3.signals[0]?.data.severity).toBe('normal'); // recovery is record-level
    expect(r3.state['disk:/']).toBe('normal');
  });

  it('latches critical through hysteresis and de-escalates to warn', () => {
    const p0 = sample(disks(20), 0);
    const r1 = bodyThresholdSignals(p0, sample(disks(4), 10));
    expect(r1.signals[0]?.data.severity).toBe('critical');
    const r2 = bodyThresholdSignals(sample(disks(4), 10, r1.state), sample(disks(7), 20));
    expect(r2.signals).toHaveLength(0); // 7% < 10% critical+hyst
    const r3 = bodyThresholdSignals(sample(disks(7), 20, r2.state), sample(disks(12), 30));
    expect(r3.signals[0]?.data.severity).toBe('warn'); // critical→warn is context
    expect(r3.state['disk:/']).toBe('warn');
  });

  it('infers prior state from a valid prev sample instead of re-alerting', () => {
    const r = bodyThresholdSignals(sample(disks(8), 0), sample(disks(7), 10));
    expect(r.signals).toHaveLength(0); // already low before monitoring
    expect(r.state['disk:/']).toBe('warn');
  });

  it('ignores invalid/stale facts and retains latch without fabricated recovery', () => {
    const prevState = { 'disk:/': 'warn' as const };
    const bad = sample(mkBody({ disks: { ...blank('stale'), kind: 'disks' } }), 10);
    const r = bodyThresholdSignals(sample(disks(8), 0, prevState), bad);
    expect(r.signals).toHaveLength(0);
    expect(r.state['disk:/']).toBe('warn');
    const nan = bodyThresholdSignals(sample(disks(8), 0, prevState), sample(disks(Number.NaN), 20));
    expect(nan.signals).toHaveLength(0);
    expect(nan.state['disk:/']).toBe('warn');
    const missing = bodyThresholdSignals(
      sample(disks(8), 0, prevState),
      sample(mkBody({ disks: { ...f([]), kind: 'disks' } }), 30),
    );
    expect(missing.state['disk:/']).toBe('warn'); // absent mounts retain latch
  });

  it('evaluates each disk independently and retains stale or unreadable latches', () => {
    const partial = mkBody({
      disks: {
        kind: 'disks',
        ...f([
          { mount: '/', total: 100, free: 2, status: 'stale' as const, observedAt: 0, ttlMs: 6000 },
          { mount: '/data', total: 100, free: 90, status: 'ok' as const, observedAt: 2000, ttlMs: 30000 },
        ]),
        unavailableMounts: ['/missing'],
      },
    });
    const prev = sample(mkBody(), 0);
    const next = sample(partial, 6500);
    expect(bodyThresholdSignals(prev, next).signals).toEqual([]);
    const held = bodyThresholdSignals({ ...prev, state: { 'disk:/': 'critical' } }, next);
    expect(held.signals).toEqual([]);
    expect(held.state['disk:/']).toBe('critical');
    const unreadable = { ...partial, disks: { ...partial.disks, unavailableMounts: ['/data'] } };
    const heldData = bodyThresholdSignals({ ...prev, state: { 'disk:/data': 'critical' } }, sample(unreadable, 6500));
    expect(heldData.state['disk:/data']).toBe('critical');
    const restored = {
      ...partial,
      disks: {
        ...partial.disks,
        value: [{ mount: '/', total: 100, free: 90, status: 'ok' as const, observedAt: 6500, ttlMs: 6000 }],
      },
    };
    expect(bodyThresholdSignals({ ...prev, state: held.state }, sample(restored, 6501)).signals).toMatchObject([
      { subject: 'disk:/', data: { severity: 'normal' } },
    ]);
  });

  it('uses actual context usage and ignores projected usage for thresholds', () => {
    // projected 97% never drives the metric: actual 50% used → 50% free
    const r = bodyThresholdSignals(sample(tokens(100, 50), 0), sample(tokens(100, 50, 97), 10));
    expect(r.signals).toHaveLength(0);
    const warn = bodyThresholdSignals(sample(tokens(100, 50), 0), sample(tokens(100, 90), 10));
    expect(warn.signals[0]?.data.severity).toBe('warn');
    const crit = bodyThresholdSignals(sample(tokens(100, 50), 0), sample(tokens(100, 97), 10));
    expect(crit.signals[0]).toMatchObject({
      subject: 'context',
      data: { severity: 'critical' },
    });
    // no actual usage → no context signal even when a projection exists
    const projectedOnly = bodyThresholdSignals(sample(tokens(100, 50), 0), sample(tokens(100, undefined, 97), 10));
    expect(projectedOnly.signals).toHaveLength(0);
    const invalid = bodyThresholdSignals(sample(tokens(100, 50), 0), sample(tokens(0), 10));
    expect(invalid.signals).toHaveLength(0);
  });

  it('evaluates battery only when discharging; charging recovers to normal', () => {
    const r1 = bodyThresholdSignals(sample(battery(50), 0), sample(battery(10), 10));
    expect(r1.signals[0]).toMatchObject({
      subject: 'battery',
      data: { severity: 'warn' },
    });
    const charging = bodyThresholdSignals(sample(battery(10), 10, r1.state), sample(battery(10, true), 20));
    expect(charging.signals[0]?.data.severity).toBe('normal');
    const sameWhileCharging = bodyThresholdSignals(
      sample(battery(10, true), 20, charging.state),
      sample(battery(10, true), 30),
    );
    expect(sameWhileCharging.signals).toHaveLength(0);
    const outOfRange = bodyThresholdSignals(sample(battery(50), 0), sample(battery(120), 10));
    expect(outOfRange.signals).toHaveLength(0);
    const noBattery = bodyThresholdSignals(sample(battery(null), 0), sample(battery(null), 10));
    expect(noBattery.signals).toHaveLength(0);
  });

  it('maps memory pressure and thermal categories', () => {
    const mem = bodyThresholdSignals(sample(memory('normal'), 0), sample(memory('warn'), 10));
    expect(mem.signals[0]).toMatchObject({
      subject: 'memory',
      data: { severity: 'warn' },
    });
    const th = bodyThresholdSignals(sample(thermal('nominal'), 0), sample(thermal('serious'), 10));
    expect(th.signals[0]).toMatchObject({
      subject: 'thermal',
      data: { severity: 'warn' },
    });
    const thCrit = bodyThresholdSignals(sample(thermal('serious'), 10, th.state), sample(thermal('critical'), 20));
    expect(thCrit.signals[0]?.data.severity).toBe('critical');
    const bogus = bodyThresholdSignals(sample(memory('normal'), 0), sample(memory('bogus'), 10));
    expect(bogus.signals).toHaveLength(0);
  });

  it('rejects negative context usage and treats overflow as critical', () => {
    const bad = bodyThresholdSignals(sample(tokens(100, 50), 0, { context: 'warn' }), sample(tokens(100, -5), 10));
    // used < 0 is corrupt: no signal, prior latch retained
    expect(bad.signals).toHaveLength(0);
    expect(bad.state.context).toBe('warn');
    // used > window is a real overflow (negative ratio) → critical
    const over = bodyThresholdSignals(sample(tokens(100, 50), 0), sample(tokens(100, 120), 10));
    expect(over.signals[0]).toMatchObject({
      subject: 'context',
      data: { severity: 'critical' },
    });
    expect(over.state.context).toBe('critical');
  });

  it('honours a custom threshold table', () => {
    const tight = {
      ...BODY_THRESHOLDS,
      disk: { warn: 0.5, critical: 0.2 },
    };
    const res = bodyThresholdSignals(sample(disks(80), 0), sample(disks(40), 10), tight);
    // 40% free < 50% warn → warns under custom table (default would not)
    expect(res.signals[0]?.data.severity).toBe('warn');
    const resDefault = bodyThresholdSignals(sample(disks(80), 0), sample(disks(40), 10));
    expect(resDefault.signals).toHaveLength(0);
  });
});

describe('FloorEvaluator', () => {
  it('honours an explicit latch and mutates neither inputs nor config', () => {
    const ev = new FloorEvaluator();
    const prev = sample(disks(20), 0);
    const next = sample(disks(15), 10);
    const latch = { 'disk:/': 'warn' as const };
    const out = ev.evaluate(prev, next, latch);
    // warn latch + 15% free ≥ 5%: stays warn until ≥15% → normal
    expect(out.signals[0]?.data.severity).toBe('normal');
    expect(out.state['disk:/']).toBe('normal');
    expect(latch).toEqual({ 'disk:/': 'warn' });
    expect(prev.state).toBeUndefined();
    expect(BODY_THRESHOLDS).toEqual({
      disk: { warn: 0.1, critical: 0.05 },
      context: { warn: 0.15, critical: 0.05 },
      battery: { warn: 0.15, critical: 0.05 },
      hysteresis: 0.05,
    });
  });

  it('uses its own threshold table from the constructor', () => {
    const ev = new FloorEvaluator({
      ...BODY_THRESHOLDS,
      battery: { warn: 0.9, critical: 0.8 },
    });
    const out = ev.evaluate(sample(battery(100), 0), sample(battery(85), 10), {});
    expect(out.signals[0]?.data.severity).toBe('warn');
  });
});
