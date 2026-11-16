import assert from 'node:assert/strict';
import type { BodyThresholdState, Signal } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
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

it('stamps the first occurrence of each reading with its monotonic receipt time', () => {
  const body = diskBody(500);
  body.disks.observedAt = 1_000;
  const first = captureRateTimes(body, 5_000, {});
  expect(first['disk:/']).toEqual({ wall: 0, mono: 5_000 });
  const cached = captureRateTimes(body, 7_000, first);
  expect(cached['disk:/']).toEqual(first['disk:/']);
  if (!body.disks.value) throw new Error('missing disk');
  body.disks.value[0].observedAt = 2_000;
  const next = captureRateTimes(body, 7_000, cached);
  expect(next['disk:/']).toEqual({ wall: 2_000, mono: 7_000 });
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
