import assert from 'node:assert/strict';
import type { BodyThresholdState, Signal } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { BodyMonitor } from '../../src/host/body/monitor.ts';
import { captureRateTimes, RateEvaluator, type RateRule } from '../../src/host/body/rate.ts';
import { type AdaptiveState, BODY_HISTORY } from '../../src/host/body/state.ts';
import { SRC } from '../helpers.ts';
import {
  cpuBody,
  ctxBody,
  diskBody,
  diskFact,
  mkBody,
  rssBody,
  SRC2,
  freshSample as sample,
  sampleSrc,
} from './helpers.ts';

const deltaRule = (over: Partial<RateRule> = {}): RateRule =>
  ({
    id: 'r',
    metric: 'rss',
    windowMs: 10_000,
    direction: 'up',
    maxDelta: 10,
    ...over,
  }) as RateRule;
const ev = (rules: readonly RateRule[], thr?: (p: string, f: number) => number) => new RateEvaluator(rules, thr);
const GIB = 1024 ** 3;

it('stamps the first occurrence of each reading on the monotonic observation timeline', () => {
  const body = diskBody(500);
  body.disks.observedAt = 1_000;
  const first = captureRateTimes(body, 5_000, 1_000, {});
  expect(first['disk:/']).toEqual({ wall: 0, mono: 4_000 });
  const cached = captureRateTimes(body, 7_000, 3_000, first);
  expect(cached['disk:/']).toEqual(first['disk:/']);
  if (!body.disks.value) throw new Error('missing disk');
  body.disks.value[0].observedAt = 2_000;
  const next = captureRateTimes(body, 7_000, 3_000, cached);
  expect(next['disk:/']).toEqual({ wall: 2_000, mono: 6_000 });
});

const run = (e: RateEvaluator, frames: [number, number, number][] /* [at, mono, rss] */) => {
  let state: BodyThresholdState = {};
  const outs: Signal[][] = [];
  let prev = sample(rssBody(0), -1_000_000, undefined, -1_000_000);
  for (const [at, mono, rss] of frames) {
    const next = sample(rssBody(rss), at, undefined, mono);
    const r = e.evaluate(prev, next, state);
    state = r.state;
    outs.push(r.signals);
    prev = next;
  }
  return { outs, state };
};

describe('RateEvaluator maxDelta', () => {
  it('warns on a rising breach and recovers, latching per rule', () => {
    const { outs, state } = run(ev([deltaRule()]), [
      [0, 0, 0],
      [1, 1000, 20], // delta +20 > 10
      [2, 2000, 20], // window 0..2000 still +20 → latched, no re-emit
      [3, 2000, 10], // delta +10 → not > limit; hysteresis 8 → active? +10>=8 was warn → stays
      [4, 4000, 0], // first pt (0,0) pruned at 4000-10000? window 10s keeps all → first=0 last=0 delta 0 → normal
    ]);
    expect(outs[0]).toHaveLength(0);
    expect(outs[1]).toHaveLength(1);
    expect(outs[1]?.[0]).toMatchObject({
      kind: 'body.rate',
      subject: 'rate:r',
      data: { severity: 'warn', metric: 'rss' },
    });
    expect(outs[2]).toHaveLength(0);
    const normals = outs.flat().filter((s) => s.data.severity === 'normal');
    expect(normals).toHaveLength(1);
    expect(state['rate:r']).toBe('normal');
  });

  it('supports direction down for drops', () => {
    const e = ev([deltaRule({ id: 'd', metric: 'disk:/', direction: 'down', maxDelta: 100 })]);
    const p = sample(diskBody(500), 0, undefined, 0);
    const n = sample(diskBody(100), 1, undefined, 1000);
    const r = e.evaluate(p, n, {});
    expect(r.signals[0]).toMatchObject({ data: { severity: 'warn', delta: -400 } });
  });
});

describe('RateEvaluator maxRatio + maxEtaMs', () => {
  it('keeps the monitor evidence slope unchanged on cached republication', () => {
    const monitor = new BodyMonitor({
      clock: () => 0,
      wallClock: () => 0,
      rateRules: [{ id: 'c', metric: 'context', windowMs: 20_000, direction: 'down', maxEtaMs: 5_000, floor: 0 }],
      anomalyRules: [],
    });
    const frame = (at: number, remaining: number) => ({
      ...sample(ctxBody(1000, 1000 - remaining), at, undefined, at),
      rateTimes: { context: { mono: at, wall: at } },
    });
    const first = frame(0, 1000);
    const second = frame(10_000, 200);
    const third = frame(20_000, 190);
    const initial = monitor.evaluate(first, second, {});
    const sampled = monitor.evaluate(second, third, initial.state);
    const before = monitor.rateEvidence('context');
    monitor.evaluate(third, { ...third, at: 21_000, monotonicAt: 21_000 }, sampled.state);
    const after = monitor.rateEvidence('context');
    expect(before.ratePerMinute).toBeCloseTo(-40.5 * 60);
    expect(after).toEqual(before);
  });

  it.each([
    { limit: 5_000, initiallyWarns: true },
    { limit: 4_000, initiallyWarns: false },
  ])('keeps the sampled slope while cached points age out (limit $limit)', ({ limit, initiallyWarns }) => {
    const e = ev([{ id: 'c', metric: 'context', windowMs: 20_000, direction: 'down', maxEtaMs: limit, floor: 0 }]);
    const frame = (at: number, remaining: number) => ({
      ...sample(ctxBody(1000, 1000 - remaining), at, undefined, at),
      rateTimes: { context: { mono: at, wall: at } },
    });
    const first = frame(0, 1000);
    const second = frame(10_000, initiallyWarns ? 200 : 700);
    const third = frame(20_000, 190);
    const initial = e.evaluate(first, second, {});
    const sampled = e.evaluate(second, third, initial.state);
    expect(sampled.state['rate:c']).toBe(initiallyWarns ? 'warn' : 'normal');
    const cached = { ...third, at: 21_000, monotonicAt: 21_000 };
    const republished = e.evaluate(third, cached, sampled.state);
    expect(republished.state['rate:c']).toBe('warn');
    if (initiallyWarns) expect(republished.signals).toHaveLength(0);
    else {
      expect(republished.signals[0]?.data.slope).toBeCloseTo(-40.5);
      expect(republished.signals[0]?.data.timeToFloorMs).toBeCloseTo(190_000 / 40.5 - 1000);
    }
    const later = { ...cached, at: 23_000, monotonicAt: 23_000 };
    const repeated = e.evaluate(cached, later, republished.state);
    expect(repeated.signals).toHaveLength(0);
    expect(repeated.state['rate:c']).toBe('warn');
    const recovered = e.evaluate(later, frame(30_000, 190), repeated.state);
    expect(recovered.signals[0]?.data.severity).toBe('normal');
  });

  it('keeps each rule window anchored to the delayed evaluation of its last new observation', () => {
    const e = ev([
      { id: 'short', metric: 'context', windowMs: 20_000, direction: 'down', maxEtaMs: 2_000, floor: 0 },
      { id: 'long', metric: 'context', windowMs: 30_000, direction: 'down', maxEtaMs: 3_000, floor: 0 },
    ]);
    const frame = (at: number, remaining: number) => ({
      ...sample(ctxBody(1000, 1000 - remaining), at, undefined, at),
      rateTimes: { context: { mono: at, wall: at } },
    });
    const first = frame(0, 1000);
    const second = frame(10_000, 700);
    const third = { ...frame(20_000, 190), evaluatedAt: { mono: 21_000, wall: 21_000 } };
    const initial = e.evaluate(first, second, {});
    const sampled = e.evaluate(second, third, initial.state);
    expect(sampled.signals).toHaveLength(0);
    const cached = { ...third, at: 22_000, monotonicAt: 22_000, evaluatedAt: { mono: 22_000, wall: 22_000 } };
    const result = e.evaluate(third, cached, sampled.state);
    expect(result.signals.map((signal) => [signal.data.ruleId, signal.data.slope])).toEqual([
      ['short', -51],
      ['long', -40.5],
    ]);
  });

  it('retains a warning on cached evidence even if the configured ETA threshold changes', () => {
    let limit = 5_000;
    const e = ev(
      [{ id: 'c', metric: 'context', windowMs: 20_000, direction: 'down', maxEtaMs: 5_000, floor: 0, param: 'eta' }],
      () => limit,
    );
    const first = { ...sample(ctxBody(1000, 0), 0, undefined, 0), rateTimes: { context: { mono: 0, wall: 0 } } };
    const second = {
      ...sample(ctxBody(1000, 800), 10_000, undefined, 10_000),
      rateTimes: { context: { mono: 10_000, wall: 10_000 } },
    };
    const sampled = e.evaluate(first, second, {});
    expect(sampled.state['rate:c']).toBe('warn');
    limit = 100;
    const cached = e.evaluate(second, { ...second, at: 11_000, monotonicAt: 11_000 }, sampled.state);
    expect(cached.state['rate:c']).toBe('warn');
    expect(cached.signals).toHaveLength(0);
  });

  it('reevaluates a cached ETA as time passes without adding evidence or emitting duplicates', () => {
    const e = ev([{ id: 'c', metric: 'context', windowMs: 300_000, direction: 'down', maxEtaMs: 5_000, floor: 0 }]);
    const first = { ...sample(ctxBody(1000, 980), 0, undefined, 0), rateTimes: { context: { mono: 0, wall: 0 } } };
    const second = {
      ...sample(ctxBody(1000, 990), 10_000, undefined, 10_000),
      rateTimes: { context: { mono: 10_000, wall: 10_000 } },
    };
    const initial = e.evaluate(first, second, {});
    expect(initial.signals).toHaveLength(0);
    const cached = { ...second, at: 15_000, monotonicAt: 15_000 };
    const warning = e.evaluate(second, cached, initial.state);
    expect(warning.signals[0]).toMatchObject({
      at: 15_000,
      data: { severity: 'warn', evidenceAt: 10_000, evidenceMono: 10_000, timeToFloorMs: 5_000 },
    });
    expect((warning.state as AdaptiveState)[BODY_HISTORY]?.fs?.rate?.windows.context.points).toHaveLength(2);
    expect(e.evaluate(cached, { ...cached, at: 16_000, monotonicAt: 16_000 }, warning.state).signals).toHaveLength(0);
  });

  it('advances cached ETA without reevaluating other rules', () => {
    const e = ev([
      { id: 'c', metric: 'context', windowMs: 20_000, direction: 'down', maxEtaMs: 5_000, floor: 0 },
      { id: 'd', metric: 'context', windowMs: 20_000, direction: 'down', maxDelta: 5 },
    ]);
    const first = { ...sample(ctxBody(1000, 980), 0, undefined, 0), rateTimes: { context: { mono: 0, wall: 0 } } };
    const second = {
      ...sample(ctxBody(1000, 990), 10_000, undefined, 10_000),
      rateTimes: { context: { mono: 10_000, wall: 10_000 } },
    };
    const initial = e.evaluate(first, second, {});
    expect(initial.signals.map((s) => s.data.ruleId)).toEqual(['d']);
    const expired = e.evaluate(second, { ...second, at: 25_000, monotonicAt: 25_000 }, initial.state);
    expect(expired.signals).toHaveLength(1);
    expect(expired.signals[0]).toMatchObject({ data: { ruleId: 'c', severity: 'warn', timeToFloorMs: 0 } });
    expect(expired.state['rate:d']).toBe('warn');
  });

  it('clamps an already elapsed observation ETA to zero at evaluation', () => {
    const e = ev([{ id: 'c', metric: 'context', windowMs: 300_000, direction: 'down', maxEtaMs: 5_000, floor: 0 }]);
    const prev = { ...sample(ctxBody(1000, 985), 0, undefined, 0), rateTimes: { context: { mono: 0, wall: 0 } } };
    const next = {
      ...sample(ctxBody(1000, 995), 20_000, undefined, 20_000),
      rateTimes: { context: { mono: 10_000, wall: 10_000 } },
    };
    expect(e.evaluate(prev, next, {}).signals[0]).toMatchObject({
      at: 20_000,
      data: { evidenceAt: 10_000, timeToFloorMs: 0, etaToFloorMs: 0, severity: 'warn' },
    });
  });

  it('includes the exact ten-minute context ETA boundary', () => {
    const e = ev([{ id: 'c', metric: 'context', windowMs: 300_000, direction: 'down', maxEtaMs: 600_000, floor: 0 }]);
    const p = sample(ctxBody(601_000, 0), 0, undefined, 0);
    const n = sample(ctxBody(601_000, 1000), 1000, undefined, 1000);
    expect(e.evaluate(p, n, {}).signals[0]?.data.etaToFloorMs).toBe(600_000);
  });

  it('breaches ratio on zero initial + positive change (RSS 0→1GiB in 1s)', () => {
    const e = ev([{ id: 'r', metric: 'rss', windowMs: 300_000, direction: 'up', maxRatio: 0.5 }]);
    const p = sample(rssBody(0), 0, undefined, 0);
    const n = sample(rssBody(GIB), 1, undefined, 1000);
    expect(e.evaluate(p, n, {}).signals[0]).toMatchObject({ kind: 'body.rate', data: { severity: 'warn' } });
  });

  it('breaches ETA when projected exhaustion drops below the limit', () => {
    const e = ev([{ id: 'c', metric: 'context', windowMs: 300_000, direction: 'down', maxEtaMs: 600_000, floor: 0 }]);
    // context falls 1000/s → eta ≈ 500s < 600s → breach
    const a = sample(ctxBody(1_000_000, 0), 0, undefined, 0);
    const b = sample(ctxBody(1_000_000, 500_000), 1, undefined, 1000);
    const r = e.evaluate(a, b, {});
    expect(r.signals[0]).toMatchObject({ data: { severity: 'warn' } });
    expect(r.signals[0]?.data.etaToFloorMs).toBeLessThan(600_000);
  });

  it('does not breach ETA while context grows', () => {
    const e = ev([{ id: 'c', metric: 'context', windowMs: 300_000, direction: 'down', maxEtaMs: 600_000, floor: 0 }]);
    const a = sample(ctxBody(1_000_000, 500_000), 0, undefined, 0);
    const b = sample(ctxBody(1_000_000, 100_000), 1, undefined, 1000);
    expect(e.evaluate(a, b, {}).signals).toHaveLength(0);
  });
});

describe('RateEvaluator wildcard metrics', () => {
  it('latches each concrete disk metric separately', () => {
    const e = ev([{ id: 'd', metric: 'disk:*', windowMs: 60_000, direction: 'down', maxDelta: 100 }]);
    const both = (a: number, b: number) =>
      mkBody({
        disks: diskFact([
          { mount: '/', total: 1000, free: a },
          { mount: '/v', total: 1000, free: b },
        ]),
      });
    const p = sample(both(500, 500), 0, undefined, 0);
    const n = sample(both(100, 490), 1, undefined, 1000);
    const r = e.evaluate(p, n, {});
    expect(r.signals).toHaveLength(1);
    expect(r.signals[0]).toMatchObject({ subject: 'rate:d:disk:/', data: { metric: 'disk:/' } });
    expect(r.state['rate:d:disk:/']).toBe('warn');
    expect(r.state['rate:d:disk:/v']).toBe('normal');
  });
});

describe('RateEvaluator monotonic ordering + purity', () => {
  it('uses distinct signal IDs for repeated warnings after wall-clock rollback', () => {
    const { outs } = run(ev([deltaRule()]), [
      [1000, 0, 0],
      [1001, 100, 20],
      [1002, 200, 0],
      [1001, 300, 20],
    ]);
    const warnings = outs.flat().filter((signal) => signal.data.severity === 'warn');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.id).not.toBe(warnings[1]?.id);
  });

  it('measures windows on monotonic stamps, not chaotic wall times', () => {
    // RSS wall: 0, 1000, 3601000, 2000 — mono: 0,1000,2000,3000.
    const e = ev([deltaRule()]);
    let state: BodyThresholdState = {};
    const seq: [number, number, number][] = [
      [0, 0, 0],
      [1000, 1000, 5],
      [3_601_000, 2000, 30], // +25 in 2s of mono > 10 → warn
      [2000, 3000, 40],
    ];
    const sigs: Signal[][] = [];
    let prev = sample(rssBody(0), -1, undefined, -1);
    for (const [at, mono, rss] of seq) {
      const next = sample(rssBody(rss), at, undefined, mono);
      const r = e.evaluate(prev, next, state);
      state = r.state;
      sigs.push(r.signals);
      prev = next;
    }
    expect(sigs.flat().filter((s) => s.data.severity === 'warn')).toHaveLength(1);
  });

  it('rejects nonfinite/backward monotonic stamps and is replay-safe', () => {
    const e = ev([deltaRule()]);
    let state: BodyThresholdState = {};
    const p0 = sample(rssBody(0), 0, undefined, 0);
    const n1 = sample(rssBody(20), 1, undefined, 1000);
    const r1 = e.evaluate(p0, n1, state);
    state = r1.state;
    expect(r1.signals).toHaveLength(1);
    // Retry of the SAME sample with the SAME state → ignored (ordering gate).
    const retry = e.evaluate(p0, n1, r1.state);
    expect(retry.signals).toHaveLength(0);
    // Backward + nonfinite stamps are ignored too.
    expect(e.evaluate(n1, sample(rssBody(50), 2, undefined, 500), state).signals).toHaveLength(0);
    expect(() => e.evaluate(n1, sample(rssBody(50), 3, undefined, Number.NaN), state)).toThrow(TypeError);
  });

  it('produces identical output for identical inputs (no hidden mutation)', () => {
    const e = ev([deltaRule()]);
    const runOnce = () => {
      let st: BodyThresholdState = {};
      const seq: Signal[][] = [];
      let prev = sample(rssBody(0), 0, undefined, 0);
      for (const [at, mono, rss] of [
        [1, 1000, 5],
        [2, 2000, 30],
      ] as const) {
        const next = sample(rssBody(rss), at, undefined, mono);
        const r = e.evaluate(prev, next, st);
        st = r.state;
        seq.push(r.signals);
        prev = next;
      }
      return { seq, st };
    };
    const a = runOnce();
    const b = runOnce();
    expect(a.seq).toEqual(b.seq);
    expect(a.st).toEqual(b.st);
  });

  it('isolates interleaved streams sharing one caller state', () => {
    const e = ev([deltaRule()]);
    let state: BodyThresholdState = {};
    const a0 = sampleSrc(SRC, rssBody(0), 0, 0);
    const a1 = sampleSrc(SRC, rssBody(30), 1, 1000);
    const r1 = e.evaluate(a0, a1, state); // stream A breaches → warn
    expect(r1.signals[0]?.data.severity).toBe('warn');
    state = r1.state;
    const b0 = sampleSrc(SRC2, rssBody(0), 0, 0);
    const b1 = sampleSrc(SRC2, rssBody(1), 1, 500);
    const r2 = e.evaluate(b0, b1, state); // stream B normal — must NOT inherit A's warn
    expect(r2.signals).toHaveLength(0);
    const hB = (r2.state as AdaptiveState)[BODY_HISTORY]?.ax?.rate;
    assert(hB);
    expect(hB.latch['rate:r']).toBe('normal');
    // B then breaches — its own streak, not suppressed by A's latch.
    const b2 = sampleSrc(SRC2, rssBody(50), 2, 1500);
    const r3 = e.evaluate(b1, b2, r2.state);
    expect(r3.signals[0]?.data.severity).toBe('warn');
    // And A's latch is still authoritative in A's metadata.
    const hA = (r3.state as AdaptiveState)[BODY_HISTORY]?.fs?.rate;
    assert(hA);
    expect(hA.latch['rate:r']).toBe('warn');
  });

  it('drops a missing metric window but retains the latch', () => {
    const e = ev([deltaRule()]);
    let state: BodyThresholdState = {};
    let prev = sample(rssBody(0), 0, undefined, 0);
    const n1 = sample(rssBody(30), 1, undefined, 1000);
    const r1 = e.evaluate(prev, n1, state);
    state = r1.state;
    prev = n1;
    // rss missing entirely → window dropped, no fabricated recovery signal.
    const r2 = e.evaluate(prev, sample(cpuBody(0.5), 2, undefined, 2000), state);
    expect(r2.signals).toHaveLength(0);
    const hist = (r2.state as AdaptiveState)[BODY_HISTORY]?.fs?.rate;
    assert(hist);
    expect(hist.windows.rss).toBeUndefined();
    expect(hist.latch['rate:r']).toBe('warn'); // latch retained
  });

  it('consults the live tuner limit per evaluation', () => {
    let limit = 10;
    const e = ev([deltaRule({ param: 'rate.x' })], () => limit);
    const state: BodyThresholdState = {};
    const p = sample(rssBody(0), 0, undefined, 0);
    const n = sample(rssBody(15), 1, undefined, 1000);
    const r1 = e.evaluate(p, n, state);
    expect(r1.signals).toHaveLength(1); // 15 > 10
    limit = 100;
    const n2 = sample(rssBody(30), 2, undefined, 2000);
    const r2 = e.evaluate(n, n2, r1.state);
    // widened to 100 → +30 < 100 → recovers
    expect(r2.signals[0]?.data.severity).toBe('normal');
  });
});
