import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../../src/host/attention/rules.ts';
import { BodyMonitor, defaultBodyRules, defaultRateRules } from '../../src/host/body/index.ts';
import { FakeClock, pipe, sess, sig } from '../helpers.ts';
import { ctxBody, diskBody, fileChanged, rssBody, freshSample as sample } from './helpers.ts';

describe('BodyMonitor built-ins', () => {
  it('cold-start defaults detect RSS 0 to 1GiB in one second', () => {
    const monitor = new BodyMonitor({ clock: () => 1000 });
    expect(monitor.evaluate(sample(rssBody(0), 0, undefined, 0), sample(rssBody(1024 ** 3), 1000), {}).signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'body.rate', data: expect.objectContaining({ metric: 'rss' }) }),
      ]),
    );
  });

  it('defaults detect disk loss, context ETA and external deletion without rule injection', () => {
    const monitor = new BodyMonitor({ clock: () => 1000 });
    const disk = monitor.evaluate(
      sample(diskBody(60 * 1024 ** 3, 100 * 1024 ** 3), 0, undefined, 0),
      sample(diskBody(56 * 1024 ** 3, 100 * 1024 ** 3), 1000),
      {},
    );
    expect(disk.signals.some((s) => s.kind === 'body.rate' && s.data.metric === 'disk:/')).toBe(true);
    const context = monitor.evaluate(
      sample(ctxBody(100_000, 0), 0, undefined, 0),
      sample(ctxBody(100_000, 10_000), 1000),
      {},
    );
    expect(context.signals.some((s) => s.kind === 'body.rate' && s.data.metric === 'context')).toBe(true);
    const bursts = Array.from({ length: 51 }, (_, i) =>
      monitor.accept(fileChanged(`d${i}`, i, `/fixture/a${i}`, 'delete'), i),
    ).flat();
    expect(bursts[0]?.data.externalDeletionExceeded).toBe(true);
  });

  it('explicit empty arrays override adaptive layers without disabling floors', () => {
    const monitor = new BodyMonitor({ rateRules: [], anomalyRules: [] });
    expect(monitor.evaluate(sample(rssBody(0), 0), sample(rssBody(1024 ** 3), 1000), {}).signals).toHaveLength(0);
    expect(defaultRateRules()).toHaveLength(3);
    const rules = defaultBodyRules();
    assert(rules[0]);
    rules[0].id = 'mutated';
    expect(defaultBodyRules()[0]?.id).not.toBe('mutated');
  });
});

describe('defaultBodyRules through unchanged M1 pipeline', () => {
  it('delivers deletion escalation after an add burst with the same wall timestamp', async () => {
    const clock = new FakeClock();
    const { pipeline, intents } = pipe(clock, defaultBodyRules());
    const monitor = new BodyMonitor();
    const bursts = [];
    for (let i = 0; i < 101; i++) {
      bursts.push(...monitor.accept(fileChanged(`add${i}`, 1000, `/w/a${i}`, 'add'), i));
    }
    for (let i = 0; i < 51; i++) {
      bursts.push(...monitor.accept(fileChanged(`delete${i}`, 1000, `/w/d${i}`, 'delete'), 101 + i));
    }
    expect(bursts).toHaveLength(2);
    assert(bursts[0] && bursts[1]);
    expect((await pipeline.accept(bursts[0], sess())).level).toBe('record');
    expect((await pipeline.accept(bursts[1], sess())).level).toBe('wake');
    clock.advance(2001);
    await pipeline.flush();
    expect(intents[0]?.kind).toBe('followup');
  });

  it('accept only intakes rate/anomaly warnings; preStep injects context', async () => {
    const clock = new FakeClock();
    const { pipeline, intents } = pipe(clock, [...DEFAULT_RULES, ...defaultBodyRules()]);
    for (const kind of ['body.rate', 'body.anomaly']) {
      const change = await pipeline.accept(sig({ id: kind, kind, subject: kind, data: { severity: 'warn' } }), sess());
      expect(change.level).toBe('context');
      expect(intents).toHaveLength(0);
    }
    await pipeline.preStep('s1');
    expect(intents).toHaveLength(1);
    expect(intents[0]?.kind).toBe('inject');
    expect(intents[0]?.update.changes.map((c) => c.level)).toEqual(['context', 'context']);
  });

  it('external deletion becomes approved wake only after flush', async () => {
    const clock = new FakeClock();
    const { pipeline, intents } = pipe(clock, defaultBodyRules());
    const monitor = new BodyMonitor({ fileBurst: { maxDeleted: 2 } });
    const events = Array.from({ length: 3 }, (_, i) => fileChanged(`ext${i}`, i, `/w/${i}`, 'delete'));
    const burst = events.flatMap((event, i) => monitor.accept(event, i))[0];
    assert(burst);
    const change = await pipeline.accept(burst, sess());
    expect(change.level).toBe('wake');
    expect(intents).toHaveLength(0);
    await pipeline.preStep('s1');
    expect(intents).toHaveLength(0);
    clock.advance(2001);
    await pipeline.flush();
    expect(intents[0]?.kind).toBe('followup');
  });

  it.each(['add', 'modify', 'delete'])(
    'three self-caused %s events remain record even with an approved wake rule',
    async (kind) => {
      const clock = new FakeClock();
      const { pipeline, intents } = pipe(clock, [
        ...defaultBodyRules(),
        { id: 'all-bursts', match: { kind: 'file.burst' }, level: 'wake', approved: true, createdBy: 'user' },
      ]);
      const monitor = new BodyMonitor({ fileBurst: { maxChanges: 2, maxDeleted: 2 } });
      const bursts = Array.from({ length: 3 }, (_, i) =>
        monitor.accept(fileChanged(`self${i}`, i, `/w/${i}`, kind, 'agent'), i),
      ).flat();
      expect(bursts).toHaveLength(1);
      expect(bursts[0]?.cause).toBe('agent');
      assert(bursts[0]);
      expect((await pipeline.accept(bursts[0], sess())).level).toBe('record');
      clock.advance(2001);
      await pipeline.flush();
      await pipeline.preStep('s1');
      expect(intents).toHaveLength(0);
    },
  );
});
