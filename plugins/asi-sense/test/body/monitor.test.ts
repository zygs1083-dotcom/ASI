import { describe, expect, it } from 'vitest';
import { AnomalyEvaluator } from '../../src/host/body/anomaly.ts';
import { Baseline } from '../../src/host/body/baseline.ts';
import type { BodySignal } from '../../src/host/body/metrics.ts';
import { BodyMonitor } from '../../src/host/body/monitor.ts';
import { Tuner } from '../../src/host/body/tuner.ts';
import { cpuBody, diskBody, f, mkBody, rssBody, sample } from './helpers.ts';

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
    disks: f([{ mount: '/', total: 1000, free }]),
    harnessProcess: f({ rss, cpu: 0, uptimeSec: 0 }),
  });

describe('BodyMonitor', () => {
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

  it('applies tuner rate limits immediately', () => {
    const t = new Tuner({ 'rate.r.maxDelta': { value: 10, min: 1 } }, () => now);
    const m = new BodyMonitor({ rateRules: [rssRule], tuner: t });
    const r1 = m.evaluate(sample(rssBody(0), 0), sample(rssBody(5), 1000), {});
    expect(r1.signals).toEqual([]); // delta 5 ≤ tuned 10
    t.propose({ param: 'rate.r.maxDelta', to: 6, reason: 'step' }, 'user');
    t.propose({ param: 'rate.r.maxDelta', to: 4, reason: 'step' }, 'user');
    const r2 = m.evaluate(sample(rssBody(5), 1000), sample(rssBody(10), 2000), r1.state);
    expect(r2.signals[0]?.data.severity).toBe('warn'); // delta 5 > live limit 4
  });

  it('floors always evaluate and tuner can only tighten them', () => {
    const t = new Tuner(
      {
        'floor.disk.warn': { value: 0.5 }, // tightening: 50% free now warns
        'floor.disk.critical': { value: 0.001, min: 0 }, // loosening: stays 0.05
      },
      () => now,
    );
    const m = new BodyMonitor({ tuner: t });
    const r = m.evaluate(sample(diskBody(800, 1000), 0), sample(diskBody(300, 1000), 1000), {});
    const s = r.signals.find((x) => x.kind === 'body.threshold');
    expect(s?.data.severity).toBe('warn'); // 30% < tuned .5, not <.05 → warn
    const r2 = m.evaluate(sample(diskBody(300, 1000), 1000), sample(diskBody(40, 1000), 2000), r.state);
    expect(r2.signals[0]?.data.severity).toBe('critical'); // tuned loosening ignored
  });

  it('threads a supplied anomaly evaluator through with its baseline tag', () => {
    const b = new Baseline({ clock: () => 8 * 3_600_000, installedAt: 0 });
    for (let i = 0; i < 60; i++) b.observe('cpu', 0.2, i);
    const m = new BodyMonitor({
      anomaly: new AnomalyEvaluator(b, [{ id: 'a', metric: 'cpu', consecutive: 1 }]),
    });
    const r = m.evaluate(sample(cpuBody(0.2), 500), sample(cpuBody(0.9), 600), {});
    const s = r.signals.find((x) => x.kind === 'body.anomaly') as BodySignal | undefined;
    expect(s?.layer).toBe('baseline');
    expect(s?.data.severity).toBe('warn');
  });
});
