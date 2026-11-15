import type { BodyThresholdState } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { AnomalyEvaluator, type AnomalyRule } from '../../src/host/body/anomaly.ts';
import { Baseline } from '../../src/host/body/baseline.ts';
import { cpuBody, mkBody, sample } from './helpers.ts';

const HOUR = 3_600_000;
let now = 0;
const mkBaseline = () => new Baseline({ clock: () => now, installedAt: 0 });
const trained = (b: Baseline, n = 60, value = 0.2) => {
  for (let i = 0; i < n; i++) b.observe('cpu', value, i); // 0..59ms, all UTC hour-0 bucket
};
const rule = (over: Partial<AnomalyRule> = {}): AnomalyRule => ({ id: 'a', metric: 'cpu', ...over });
// Chronological samples: prev at at-100, next at at (all ≥500ms > last training obs)
const feed = (ev: AnomalyEvaluator, v: number, at: number, st: BodyThresholdState, pv = 0.2) =>
  ev.evaluate(sample(cpuBody(pv), at - 100), sample(cpuBody(v), at), st);
const trainedAt = (gateHours = 8) => {
  now = gateHours * HOUR;
  const b = mkBaseline();
  trained(b);
  return b;
};

describe('AnomalyEvaluator', () => {
  it('stays quiet below 30% learning progress but trains anyway', () => {
    const b = mkBaseline();
    trained(b);
    const ev = new AnomalyEvaluator(b, [rule({ consecutive: 1 })]);
    now = 5 * HOUR; // ~21%
    const r1 = feed(ev, 0.9, 500, {});
    expect(r1.signals).toEqual([]);
    now = 8 * HOUR; // ~33%, gate open
    const r2 = feed(ev, 0.9, 1000, r1.state, 0.9);
    expect(r2.signals[0]?.data.severity).toBe('warn');
    expect(r2.signals[0]?.data).toMatchObject({ layer: 'baseline', ruleId: 'a', metric: 'cpu' });
  });

  it('fires only after N consecutive breaches and recovers below .8k', () => {
    const b = trainedAt();
    const ev = new AnomalyEvaluator(b, [rule({ consecutive: 3 })]);
    let st: BodyThresholdState = {};
    for (let i = 1; i <= 2; i++) {
      const r = feed(ev, 0.9, i * 500, st, 0.9);
      st = r.state;
      expect(r.signals).toEqual([]);
    }
    const hit = feed(ev, 0.9, 1500, st, 0.9);
    expect(hit.signals).toHaveLength(1);
    expect(hit.signals[0]).toMatchObject({ kind: 'body.anomaly', subject: 'baseline:a', layer: 'baseline' });
    expect(hit.signals[0]?.data).toMatchObject({ severity: 'warn', k: 3 }); // conf=1 → 3*(2-1)
    expect(hit.signals[0]?.data.deviation).toBeGreaterThan(3);
    const calm = feed(ev, 0.2, 2000, hit.state, 0.9);
    expect(calm.signals[0]?.data.severity).toBe('normal');
    expect(calm.state['baseline:a']).toBe('normal');
  });

  it('resets pending streaks on calm/missing samples and retains the latch', () => {
    const b = trainedAt();
    const ev = new AnomalyEvaluator(b, [rule({ consecutive: 2 })]);
    let st = feed(ev, 0.9, 500, {}, 0.9).state;
    st = feed(ev, 0.2, 1000, st).state; // calm resets
    st = feed(ev, 0.9, 1500, st, 0.9).state;
    const hit = feed(ev, 0.9, 2000, st, 0.9);
    expect(hit.signals[0]?.data.severity).toBe('warn');
    const missing = ev.evaluate(sample(mkBody(), 2000), sample(mkBody(), 2500), hit.state);
    expect(missing.signals).toEqual([]); // streak cleared, latch kept — no fabricated recovery
    expect(missing.state['baseline:a']).toBe('warn');
    const evEmpty = new AnomalyEvaluator(mkBaseline(), [rule({ consecutive: 1 })]);
    expect(evEmpty.evaluate(sample(cpuBody(0.2), 500), sample(cpuBody(0.9), 600), {}).signals).toEqual([]);
  });

  it('ignores duplicate/backward timestamps without double-training', () => {
    const b = trainedAt();
    const ev = new AnomalyEvaluator(b, [rule()]);
    const r1 = feed(ev, 0.5, 500, {}, 0.5);
    const count = b.read('cpu', 500)?.count;
    const dup = ev.evaluate(sample(cpuBody(0.5), 500), sample(cpuBody(0.5), 500), r1.state);
    expect(dup.signals).toEqual([]);
    expect(dup.state).toEqual(r1.state);
    expect(dup.state).not.toBe(r1.state);
    expect(b.read('cpu', 500)?.count).toBe(count); // no double train
    const back = ev.evaluate(sample(cpuBody(0.5), 100), sample(cpuBody(0.5), 100), r1.state);
    expect(back.state).toEqual(r1.state);
  });

  it('widens k for low confidence and resolves sigma live', () => {
    const b = mkBaseline();
    trained(b, 30); // confidence .5 → k = 3*1.5 = 4.5
    now = 8 * HOUR;
    const ev = new AnomalyEvaluator(b, [rule({ consecutive: 1 })]);
    const r = feed(ev, 0.9, 500, {}, 0.9);
    expect(r.signals[0]?.data.k).toBeCloseTo(4.5, 6);
    expect(r.signals[0]?.data.confidence).toBe(0.5);
    // second sample trained the bucket (count 31): conf 31/60 → k = 50*(2-.5167)
    const evP = new AnomalyEvaluator(b, [rule({ id: 'p', consecutive: 1, param: 'cpu.sigma' })], () => 50);
    expect(feed(evP, 0.9, 1000, {}, 0.9).signals).toEqual([]);
    // third sample (count 32): conf 32/60 → k = 3*(2-.5333) ≈ 4.4
    const evBad = new AnomalyEvaluator(b, [rule({ id: 'q', consecutive: 1, param: 'cpu.sigma' })], () => Number.NaN);
    const rb = feed(evBad, 0.9, 1500, {}, 0.9);
    expect(rb.signals[0]?.data.k).toBeCloseTo(4.4, 5); // invalid lookup → configured 3
  });

  it('validates rules at construction', () => {
    const b = mkBaseline();
    const mkEv = (r: unknown) => () => new AnomalyEvaluator(b, [r as AnomalyRule]);
    for (const bad of [
      rule({ sigma: 0 }),
      rule({ sigma: Number.NaN }),
      rule({ consecutive: 0 }),
      rule({ consecutive: 1.5 }),
      rule({ metric: '' }),
    ]) {
      expect(mkEv(bad)).toThrow(TypeError);
    }
    expect(() => new AnomalyEvaluator(b, [rule(), rule()])).toThrow(TypeError); // dup id
  });
});
