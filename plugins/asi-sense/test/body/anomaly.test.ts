import assert from 'node:assert/strict';
import type { BodyThresholdState, Signal } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { AnomalyEvaluator, type AnomalyRule } from '../../src/host/body/anomaly.ts';
import { Baseline } from '../../src/host/body/baseline.ts';
import { type AdaptiveState, BODY_HISTORY } from '../../src/host/body/state.ts';
import { blank, cpuBody, mkBody, SRC2, freshSample as sample, sampleSrc } from './helpers.ts';

const TZ = 'UTC';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const WEEK = 7 * DAY;
const INSTALL = Date.UTC(2026, 0, 5); // Monday 2026-01-05 00:00 UTC
const SLOT10 = Date.UTC(2026, 0, 5, 10); // Monday 10:00 — week-1 slot
const EVAL = SLOT10 + 2 * WEEK; // week-3 Mon-10 slot; mature (installedAt +14d > 24h)

const rule = (over: Partial<AnomalyRule> = {}): AnomalyRule => ({ id: 'cpu', metric: 'cpu', ...over });

/**
 * Trains `cpu` to mean ~0.5 with `perDate` samples on TWO local dates per
 * requested hour slot (same weekday/hour in week 1 and week 2).
 */
function trained(hours: readonly number[], perDate = 8, value = 0.5, elapsedMs = 14 * DAY): Baseline {
  const b = new Baseline({ timeZone: TZ, installedAt: INSTALL, elapsedMs });
  for (const h of hours) {
    for (const wk of [0, WEEK]) {
      const t = SLOT10 + h * HOUR + wk;
      for (let i = 0; i < perDate; i++) b.observe('cpu', value, t + i);
    }
  }
  return b;
}

const mk = (b: Baseline, rules: AnomalyRule[] = [rule()]) => new AnomalyEvaluator(b, rules);

const feed = (e: AnomalyEvaluator, state: BodyThresholdState, frames: [number, number][]) => {
  const outs: Signal[][] = [];
  let st = state;
  let prev = sample(cpuBody(0.5), frames[0]?.[0] ?? EVAL - 1);
  for (const [at, cpu] of frames) {
    const next = sample(cpuBody(cpu), at);
    const r = e.evaluate(prev, next, st);
    st = r.state;
    outs.push(r.signals);
    prev = next;
  }
  return { outs, state: st };
};

describe('AnomalyEvaluator gating', () => {
  it('never fires at 8 hours even with an eligible bucket', () => {
    const b = trained([-2], 8, 0.5, 0);
    const e = mk(b);
    // The 08:00 bucket is eligible, but installation age is only eight hours.
    const { outs } = feed(e, {}, [
      [INSTALL + 8 * HOUR, 0.99],
      [INSTALL + 8 * HOUR + 60, 0.99],
      [INSTALL + 8 * HOUR + 120, 0.99],
    ]);
    expect(outs.flat()).toHaveLength(0);
  });

  it('never fires on a bucket with <8 samples', () => {
    const b = new Baseline({ timeZone: TZ, installedAt: INSTALL });
    for (const wk of [0, WEEK]) for (let i = 0; i < 3; i++) b.observe('cpu', 0.5, SLOT10 + wk + i); // 6 samples, 2 dates
    const e = mk(b);
    const { outs } = feed(e, {}, [
      [EVAL, 0.99],
      [EVAL + 60, 0.99],
      [EVAL + 120, 0.99],
    ]);
    expect(outs.flat()).toHaveLength(0);
  });

  it('never fires on a single-date bucket even with ≥8 samples', () => {
    const b = new Baseline({ timeZone: TZ, installedAt: INSTALL });
    for (let i = 0; i < 12; i++) b.observe('cpu', 0.5, SLOT10 + i); // 12 samples, 1 date
    const e = mk(b);
    const { outs } = feed(e, {}, [
      [EVAL, 0.99],
      [EVAL + 1, 0.99],
      [EVAL + 2, 0.99],
    ]);
    expect(outs.flat()).toHaveLength(0);
  });
});

describe('AnomalyEvaluator streak + latch', () => {
  it('uses distinct signal IDs for repeated warnings after wall-clock rollback', () => {
    const e = mk(trained([0]));
    let state: BodyThresholdState = {};
    let prev = sample(cpuBody(0.5), EVAL, undefined, 0);
    const warnings = [];
    for (const [wall, mono, value] of [
      [EVAL + 1, 1, 0.99],
      [EVAL + 2, 2, 0.99],
      [EVAL + 3, 3, 0.99],
      [EVAL + 4, 4, 0.5],
      [EVAL + 1, 5, 0.99],
      [EVAL + 2, 6, 0.99],
      [EVAL + 3, 7, 0.99],
    ]) {
      const next = sample(cpuBody(value), wall, undefined, mono);
      const result = e.evaluate(prev, next, state);
      warnings.push(...result.signals.filter((signal) => signal.data.severity === 'warn'));
      state = result.state;
      prev = next;
    }
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.id).not.toBe(warnings[1]?.id);
  });

  it('detects real anomalies during wall-clock forward and rollback when receipt time increases', () => {
    const e = mk(trained([0]));
    let state: BodyThresholdState = {};
    let prev = sample(cpuBody(0.5), EVAL, undefined, 0);
    for (const [wall, mono, value] of [
      [EVAL, 1, 0.5],
      [EVAL + 3 * HOUR, 2, 0.5],
      [EVAL + 1, 3, 0.99],
      [EVAL + 2, 4, 0.99],
      [EVAL + 3, 5, 0.99],
    ]) {
      const next = sample(cpuBody(value), wall, undefined, mono);
      const result = e.evaluate(prev, next, state);
      state = result.state;
      prev = next;
      if (mono === 5) expect(result.signals[0]?.data.severity).toBe('warn');
    }
  });

  it('warns on the 3rd consecutive breach and recovers once', () => {
    const e = mk(trained([0]));
    const { outs, state } = feed(e, {}, [
      [EVAL, 0.99],
      [EVAL + 60, 0.99],
      [EVAL + 120, 0.99],
      [EVAL + 180, 0.5],
      [EVAL + 240, 0.5],
    ]);
    expect(outs[0]).toHaveLength(0);
    expect(outs[1]).toHaveLength(0);
    expect(outs[2]?.[0]).toMatchObject({ kind: 'body.anomaly', subject: 'baseline:cpu', data: { severity: 'warn' } });
    const normals = outs.flat().filter((s) => s.data.severity === 'normal');
    expect(normals).toHaveLength(1);
    expect(state['baseline:cpu']).toBe('normal');
  });

  it('keeps the latch but clears the streak when the metric goes missing', () => {
    const e = mk(trained([0]));
    const r1 = feed(e, {}, [
      [EVAL, 0.99],
      [EVAL + 60, 0.99],
      [EVAL + 120, 0.99],
    ]);
    expect(r1.outs[2]?.[0]?.data.severity).toBe('warn');
    const hist = (r1.state as AdaptiveState)[BODY_HISTORY]?.fs?.anomaly;
    assert(hist);
    expect(hist.streaks.cpu).toBe(3);
    // Sample with no cpu metric: streak resets, latch retained, no recovery emitted.
    const r2 = e.evaluate(sample(cpuBody(0.99), EVAL + 180), sample(mkBody({ cpu: blank() }), EVAL + 240), r1.state);
    expect(r2.signals).toHaveLength(0);
    const hist2 = (r2.state as AdaptiveState)[BODY_HISTORY]?.fs?.anomaly;
    assert(hist2);
    expect(hist2.streaks.cpu).toBe(0);
    expect(hist2.latch['baseline:cpu']).toBe('warn');
  });

  it('uses the live sigma from the tuner', () => {
    let sigma = 3;
    const e = new AnomalyEvaluator(trained([0]), [rule({ param: 'anomaly.cpu.sigma' })], () => sigma);
    const { outs } = feed(e, {}, [
      [EVAL, 0.99],
      [EVAL + 60, 0.99],
      [EVAL + 120, 0.99],
    ]);
    expect(outs[2]).toHaveLength(1);
    sigma = 100; // widened → breach no longer qualifies
    const e2 = new AnomalyEvaluator(trained([0]), [rule({ param: 'anomaly.cpu.sigma' })], () => sigma);
    const { outs: o2 } = feed(e2, {}, [
      [EVAL, 0.99],
      [EVAL + 60, 0.99],
      [EVAL + 120, 0.99],
    ]);
    expect(o2.flat()).toHaveLength(0);
  });
});

describe('AnomalyEvaluator contamination + purity', () => {
  it.each([2, 3])('does not train an empty next hour during %i pending/warn samples', (count) => {
    const e = mk(trained([0]));
    const start = EVAL + 57 * 60_000;
    const frames: [number, number][] = Array.from({ length: count }, (_, i) => [start + i * 60_000, 0.99]);
    frames.push([EVAL + HOUR, 0.99]);
    const { state } = feed(e, {}, frames);
    const baseline = (state as AdaptiveState)[BODY_HISTORY]?.fs?.anomaly?.baseline;
    expect(baseline?.read('cpu', EVAL + HOUR)).toBeUndefined();
    const recovered = feed(e, state, [[EVAL + WEEK, 0.5]]);
    const after = (recovered.state as AdaptiveState)[BODY_HISTORY]?.fs?.anomaly?.baseline;
    expect(after?.read('cpu', EVAL + WEEK)?.count).toBe(17);
  });

  it('detects a sustained .99 CPU anomaly on the 3rd frame (eval regression)', () => {
    // Fixture matching the eval finding: count 79, 2 dates, mean ~.51, scale ~.135.
    const b = new Baseline({ timeZone: TZ, installedAt: INSTALL, elapsedMs: 14 * DAY, minScale: { cpu: 0.135 } });
    for (const wk of [0, WEEK]) for (let i = 0; i < 40; i++) b.observe('cpu', 0.51, SLOT10 + wk + i);
    const stat = b.read('cpu', EVAL);
    expect(stat?.count).toBe(80);
    expect(stat?.dates).toBe(2);
    expect(stat?.scale).toBe(0.135);
    const e = mk(b);
    const { outs } = feed(e, {}, [
      [EVAL, 0.99],
      [EVAL + 60_000, 0.99],
      [EVAL + 120_000, 0.99],
    ]);
    expect(outs[0]).toHaveLength(0);
    expect(outs[1]).toHaveLength(0);
    expect(outs[2]?.[0]).toMatchObject({ data: { severity: 'warn' } });
  });

  it('never lets breach candidates train the baseline — pending OR warned', () => {
    const b = trained([0, 1, 2], 8, 0.5); // slots Mon-10/11/12 mature
    const e = mk(b);
    const before = [b.read('cpu', EVAL)?.mean, b.read('cpu', EVAL + HOUR)?.mean, b.read('cpu', EVAL + 2 * HOUR)?.mean];
    // 2h of .99 CPU crossing two hour boundaries: every slot is an eligible
    // above-k candidate → excluded from training → baseline must not drift.
    const frames: [number, number][] = [];
    for (let i = 0; i <= 12; i++) frames.push([EVAL + i * 600_000, 0.99]); // every 10min for 2h
    const { outs, state } = feed(e, {}, frames);
    const warned = outs.flat().filter((s) => s.data.severity === 'warn');
    expect(warned).toHaveLength(1); // one warn transition, sustained
    const trainedB = (state as AdaptiveState)[BODY_HISTORY]?.fs?.anomaly?.baseline;
    assert(trainedB);
    expect(trainedB.read('cpu', EVAL)?.mean).toBe(before[0]);
    expect(trainedB.read('cpu', EVAL + HOUR)?.mean).toBe(before[1]);
    expect(trainedB.read('cpu', EVAL + 2 * HOUR)?.mean).toBe(before[2]);
    // …while NORMAL samples still train (a fresh slot-13 bucket here; the
    // seed baseline itself stays untouched).
    const r = feed(e, state, [[EVAL + WEEK, 0.5]]);
    const afterNormal = (r.state as AdaptiveState)[BODY_HISTORY]?.fs?.anomaly?.baseline;
    assert(afterNormal);
    expect(afterNormal.read('cpu', EVAL)?.count).toBe(17);
    expect(b.read('cpu', EVAL)?.count).toBe(16); // seed immutable
  });

  it('is pure: identical inputs → identical outputs, streams isolated', () => {
    const b = trained([0]);
    const e = mk(b);
    const once = () =>
      feed(e, {}, [
        [EVAL, 0.99],
        [EVAL + 60, 0.99],
        [EVAL + 120, 0.99],
      ]);
    const a = once();
    const c = once();
    expect(a.outs).toEqual(c.outs);
    // Interleaved stream B shares caller state but gets its own history.
    const ra = feed(e, {}, [
      [EVAL, 0.99],
      [EVAL + 60, 0.99],
    ]);
    let st = ra.state;
    const b0 = sampleSrc(SRC2, cpuBody(0.5), EVAL);
    const b1 = sampleSrc(SRC2, cpuBody(0.99), EVAL + 30);
    const r1 = e.evaluate(b0, b1, st);
    st = r1.state;
    expect(r1.signals).toHaveLength(0); // B streak 1 — not A's streak 2
    // A's third breach still fires on its own streak.
    const a2 = e.evaluate(sample(cpuBody(0.99), EVAL + 60), sample(cpuBody(0.99), EVAL + 120), st);
    expect(a2.signals[0]?.data.severity).toBe('warn');
    // Outliers can share the immutable seed; their latches/streaks cannot.
    const hB = (a2.state as AdaptiveState)[BODY_HISTORY]?.ax?.anomaly;
    const hA = (a2.state as AdaptiveState)[BODY_HISTORY]?.fs?.anomaly;
    assert(hB && hA);
    expect(hB.baseline?.read('cpu', EVAL)?.mean).toBe(hA.baseline?.read('cpu', EVAL)?.mean);
    expect(hB.latch['baseline:cpu']).toBe('normal');
  });
});
