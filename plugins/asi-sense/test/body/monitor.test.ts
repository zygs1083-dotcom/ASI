import type { BodyThresholdSample } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { Baseline } from '../../src/host/body/baseline.ts';
import type { BodySignal } from '../../src/host/body/metrics.ts';
import { BodyMonitor } from '../../src/host/body/monitor.ts';
import { Tuner } from '../../src/host/body/tuner.ts';
import { cpuBody, diskBody, diskFact, f, freshSample, mkBody, rssBody, sample } from './helpers.ts';

const now = 0;
const rssRule = {
  id: 'r',
  metric: 'rss',
  windowMs: 10_000,
  direction: 'up',
  maxDelta: 10,
  param: 'rate.r.maxDelta',
} as const;
const both = (free: number, rss: number) =>
  mkBody({
    disks: diskFact([{ mount: '/', total: 1000, free }]),
    harnessProcess: f({ rss, cpu: 0, uptimeSec: 0 }),
  });

describe('BodyMonitor', () => {
  it('does not finish learning after a one-week wall jump in ten monotonic seconds', () => {
    const week = 7 * 86_400_000;
    const wall = Date.UTC(2026, 0, 5, 10);
    const m = new BodyMonitor({ clock: () => 0, wallClock: () => wall, timeZone: 'UTC' });
    let state = {};
    let prev = freshSample(cpuBody(0.5), wall, undefined, 0);
    const signals = [];
    for (let i = 0; i < 11; i++) {
      const at = wall + (i >= 4 ? week : 0) + i * 1000;
      const next = freshSample(cpuBody(i < 8 ? 0.5 : 0.99), at, undefined, i * 1000);
      const result = m.evaluate(prev, next, state);
      signals.push(...result.signals);
      state = result.state;
      prev = next;
    }
    expect(signals.some((signal) => signal.kind === 'body.anomaly')).toBe(false);
    expect(m.baseline.learningProgress).toBeLessThan(1);
  });

  it('rejects missing monotonic timestamps instead of reading a clock during evaluate', () => {
    const m = new BodyMonitor({ clock: () => 1000 });
    const { monotonicAt: _missing, ...withoutStamp } = sample(rssBody(100), 1);
    expect(() => m.evaluate(sample(rssBody(0), 0), withoutStamp as BodyThresholdSample, {})).toThrow();
  });

  it('composes floor+rate with layer tags and a shared latch state', () => {
    const m = new BodyMonitor({ rateRules: [rssRule] });
    const out = m.evaluate(sample(both(500, 0), 0), sample(both(30, 20), 1000), {});
    const sigs = out.signals as BodySignal[];
    const floor = sigs.find((s) => s.kind === 'body.threshold');
    expect(floor).toMatchObject({ layer: 'floor', subject: 'disk:/' });
    expect(floor?.data.layer).toBe('floor');
    expect(floor?.data.severity).toBe('critical'); // 3% free < 5%
    const rate = sigs.find((s) => s.kind === 'body.rate');
    expect(rate?.layer).toBe('rate');
    expect(rate?.data.severity).toBe('warn'); // rss 0→20 > 10
  });

  it('excludes stale and unreadable volumes from learning and rate windows', () => {
    const m = new BodyMonitor({
      clock: () => 0,
      wallClock: () => 0,
      timeZone: 'UTC',
      rateRules: [{ id: 'disk', metric: 'disk:*', windowMs: 60_000, direction: 'down', maxDelta: 100 }],
    });
    const first = sample(
      mkBody({
        disks: diskFact([
          { mount: '/fresh', total: 1000, free: 800 },
          { mount: '/stale', total: 1000, free: 800 },
        ]),
      }),
      0,
      undefined,
      0,
    );
    const seeded = m.evaluate(first, first, {});
    expect(m.baseline.read('disk:/stale', 0)?.count).toBe(1);
    const disks = diskFact([
      { mount: '/fresh', total: 1000, free: 600, status: 'ok' },
      { mount: '/stale', total: 1000, free: 100, status: 'stale' },
      { mount: '/expired', total: 1000, free: 100, status: 'ok', observedAt: 0, ttlMs: 1000 },
      { mount: '/unreadable', total: 1000, free: 100, status: 'ok' },
    ]);
    disks.unavailableMounts = ['/unreadable'];
    const mixed = sample(mkBody({ disks }), 1000, undefined, 1000);
    const result = m.evaluate(first, mixed, seeded.state);
    expect(result.signals.filter((signal) => signal.kind === 'body.rate').map((signal) => signal.data.metric)).toEqual([
      'disk:/fresh',
    ]);
    expect(m.baseline.read('disk:/fresh', 1000)?.count).toBe(2);
    expect(m.baseline.read('disk:/stale', 1000)?.count).toBe(1);
    expect(m.baseline.read('disk:/expired', 1000)).toBeUndefined();
    expect(m.baseline.read('disk:/unreadable', 1000)).toBeUndefined();

    const recovered = sample(
      mkBody({
        disks: diskFact([
          { mount: '/fresh', total: 1000, free: 600 },
          { mount: '/stale', total: 1000, free: 100 },
        ]),
      }),
      2000,
      undefined,
      2000,
    );
    const after = m.evaluate(mixed, recovered, result.state);
    expect(
      after.signals.filter((signal) => signal.kind === 'body.rate' && signal.data.metric === 'disk:/stale'),
    ).toEqual([]);
    expect(m.baseline.read('disk:/stale', 2000)?.count).toBe(2);
  });

  it('applies tuner rate limits immediately', async () => {
    const t = new Tuner(
      { 'rate.r.maxDelta': { value: 10, min: 1 } },
      {
        clock: () => now,
        actor: () => 'user',
        persistence: { load: async () => undefined, save: async () => {} },
      },
    );
    await t.restore();
    const m = new BodyMonitor({ rateRules: [rssRule], tuner: t });
    const r1 = m.evaluate(sample(rssBody(0), 0), sample(rssBody(5), 1000), {});
    expect(r1.signals).toEqual([]); // delta 5 ≤ tuned 10
    await t.propose({ param: 'rate.r.maxDelta', to: 6, reason: 'step' });
    await t.propose({ param: 'rate.r.maxDelta', to: 4, reason: 'step' });
    const r2 = m.evaluate(sample(rssBody(5), 1000), sample(rssBody(10), 2000), r1.state);
    expect(r2.signals[0]?.data.severity).toBe('warn'); // delta 5 > live limit 4
  });

  it('uses effective floors without clamping a trusted user loosening to defaults', () => {
    const t = new Tuner(
      {
        'floor.disk.warn': { value: 0.5, tighten: 'up' },
        'floor.disk.critical': { value: 0, min: 0, tighten: 'up' },
      },
      { clock: () => now },
    );
    const m = new BodyMonitor({ tuner: t });
    const r = m.evaluate(sample(diskBody(800, 1000), 0), sample(diskBody(300, 1000), 1000), {});
    const s = r.signals.find((x) => x.kind === 'body.threshold');
    expect(s?.data.severity).toBe('warn'); // 30% < tuned .5, not <.05 → warn
    const r2 = m.evaluate(sample(diskBody(300, 1000), 1000), sample(diskBody(40, 1000), 2000), r.state);
    expect(r2.signals.filter((x) => x.kind === 'body.threshold')).toHaveLength(0);
  });

  it('threads a supplied mature baseline through with its baseline tag', () => {
    const week = 7 * 86_400_000;
    const b = new Baseline({ clock: () => 2 * week, installedAt: -week, timeZone: 'UTC', elapsedMs: 2 * week });
    for (const start of [-week, 0]) for (let i = 0; i < 8; i++) b.observe('cpu', 0.2, start + i);
    const m = new BodyMonitor({
      baseline: b,
      anomalyRules: [{ id: 'a', metric: 'cpu', consecutive: 1 }],
    });
    const r = m.evaluate(sample(cpuBody(0.2), 500), sample(cpuBody(0.9), 600), {});
    const s = r.signals.find((x) => x.kind === 'body.anomaly') as BodySignal | undefined;
    expect(s?.layer).toBe('baseline');
    expect(s?.data.severity).toBe('warn');
  });
});
