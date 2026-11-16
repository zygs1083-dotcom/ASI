import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../src/host/attention/rules.ts';
import { defaultBodyRules } from '../src/host/body/rules.ts';
import { FakeClock, jobExit, pipe, sess, sig } from './helpers.ts';

describe('runtime attention tuning', () => {
  it('shortens existing windows, never extends them, and delivers each generation once', async () => {
    const clock = new FakeClock();
    const { pipeline, intents } = pipe(clock);
    await pipeline.accept(jobExit('old', 0, 1), sess());
    await pipeline.accept(sig({ id: 'file', kind: 'file.changed', subject: '/f' }), sess());
    clock.advance(500);
    pipeline.setMergeWindows(1_000, 3_000);
    expect(pipeline.nextDeadline()).toBe(1_000);
    pipeline.setMergeWindows(4_000, 6_000);
    clock.advance(500);
    await pipeline.flush();
    expect(intents.flatMap((i) => i.update.changes.map((c) => c.signal.id))).toEqual(['old']);
    expect(pipeline.nextDeadline()).toBe(3_000);
    await pipeline.accept(jobExit('new', 1_000, 1, 'another'), sess());
    clock.advance(2_000);
    await pipeline.preStep('s1');
    expect(intents.flatMap((i) => i.update.changes.map((c) => c.signal.id)).sort()).toEqual(['file', 'old']);
    clock.advance(2_000);
    await pipeline.flush();
    await pipeline.preStep('s1');
    expect(intents.flatMap((i) => i.update.changes.map((c) => c.signal.id)).sort()).toEqual(['file', 'new', 'old']);
  });

  it('keeps retry deadlines and frozen payloads intact when windows change', async () => {
    const clock = new FakeClock();
    const { pipeline } = pipe(clock);
    const error = new Error('offline');
    let attempts = 0;
    const intents: unknown[] = [];
    const drain = (pipeline as unknown as { drain: { deliverer: { deliver: (intent: unknown) => Promise<void> } } })
      .drain;
    drain.deliverer.deliver = async (intent) => {
      intents.push(structuredClone(intent));
      if (++attempts === 1) throw error;
    };
    await pipeline.accept(jobExit('first', 0, 1), sess());
    clock.advance(2_000);
    await expect(pipeline.flush()).rejects.toBe(error);
    pipeline.setMergeWindows(1_000, 1_000);
    await pipeline.flush();
    expect(intents).toHaveLength(2);
    expect(intents[1]).toEqual(intents[0]);
  });

  it('changes only built-in alert levels without bypassing safety or approved rules', async () => {
    const clock = new FakeClock();
    const { pipeline } = pipe(clock, [
      ...DEFAULT_RULES,
      ...defaultBodyRules(),
      {
        id: 'custom',
        match: { kind: 'body.rate', where: { metric: 'rss' } },
        level: 'wake',
        approved: true,
        createdBy: 'user',
      },
    ]);
    pipeline.setDeliveryLevels({ 'body.rate': 'record', 'body.anomaly': 'record', 'file.burst': 'context' });
    const body = (id: string, data: Record<string, unknown>) =>
      sig({ id, kind: 'body.rate', subject: id, data: { severity: 'warn', ...data } });
    expect((await pipeline.accept(body('normal', { metric: 'disk' }), sess())).level).toBe('record');
    expect((await pipeline.accept(body('eta', { ruleId: 'context-eta', metric: 'context' }), sess())).level).toBe(
      'context',
    );
    expect((await pipeline.accept(body('soon', { metric: 'disk', timeToFloorMs: 30_000 }), sess())).level).toBe(
      'context',
    );
    expect((await pipeline.accept(body('custom', { metric: 'rss' }), sess())).level).toBe('wake');
    expect(
      (await pipeline.accept(sig({ id: 'critical', kind: 'body.threshold', data: { severity: 'critical' } }), sess()))
        .level,
    ).toBe('wake');
    expect(
      (
        await pipeline.accept(
          sig({ id: 'burst', kind: 'file.burst', data: { externalDeletionExceeded: true } }),
          sess(),
        )
      ).level,
    ).toBe('context');
  });
});
