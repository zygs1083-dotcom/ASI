import type { Signal } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { FakeClock, jobExit, pipe, sess, sig } from './helpers.ts';

const file = (id: string, at: number, subject = '/w/a.ts', extra: Partial<Signal> = {}) =>
  sig({ id, kind: 'file.changed', at, subject, ...extra });

describe('AttentionPipeline merging', () => {
  it('reclaims disposed session state after ten minutes of monotonic time', () => {
    const c = new FakeClock();
    const { pipeline } = pipe(c);
    const sessions = (pipeline as unknown as { sessions: Map<string, unknown> }).sessions;
    for (let i = 0; i < 300; i++) {
      pipeline.setSession(sess({ id: `disposed-${i}` }));
      pipeline.disposeSession(`disposed-${i}`);
    }
    pipeline.setSession(sess({ id: 'live' }));
    c.advance(599_999);
    pipeline.pruneSessions();
    expect(sessions.size).toBe(301);
    c.advance(1);
    pipeline.pruneSessions();
    expect([...sessions.keys()]).toEqual(['live']);
  });
  it('merges repeated file saves (count=3) into an early pre-step inject', async () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    await pipeline.accept(file('a', 0), sess());
    c.advance(1000);
    await pipeline.accept(file('b', 1), sess());
    c.advance(1000);
    await pipeline.accept(file('x', 2), sess());
    await pipeline.preStep('s1'); // t=2000: context group closes early and injects
    expect(intents.length).toBe(1);
    const inj = intents[0];
    if (inj?.kind !== 'inject') throw new Error('expected inject');
    expect(inj.update.changes).toHaveLength(1);
    expect(inj.update.changes[0]).toMatchObject({
      count: 3,
      level: 'context',
      ruleId: 'watched-file',
    });
    expect(inj.update.changes[0]?.signal.id).toBe('x');
    expect(inj.update.since).toBe(0);
    c.advance(3001);
    await pipeline.preStep('s1'); // t=5001: nothing left to deliver
    expect(intents.length).toBe(1);
  });

  it('dedups exact signal.id; separate ids merge into a single wake', async () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    await pipeline.accept(jobExit('e1', 0, 1), sess());
    const dup = await pipeline.accept(jobExit('e1', 0, 1), sess()); // duplicate id
    expect(dup).toMatchObject({ level: 'record', reason: 'duplicate' });
    await pipeline.accept(jobExit('e2', 1, 1), sess()); // merged into same bucket
    c.advance(2001);
    await pipeline.flush();
    expect(intents).toHaveLength(1);
    const w = intents[0];
    if (w?.kind !== 'followup') throw new Error('expected followup');
    expect(w.update.changes).toHaveLength(1);
    expect(w.update.changes[0]).toMatchObject({
      count: 2,
      level: 'wake',
      ruleId: 'job-failed',
    });
  });

  it('batches ready context groups into one sorted inject at preStep', async () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    await pipeline.accept(file('b', 5, '/w/b.ts'), sess());
    await pipeline.accept(file('a', 1, '/w/a.ts'), sess());
    await pipeline.accept(jobExit('j', 3, 0), sess()); // exit 0 → context, 2s window
    c.advance(5001);
    await pipeline.preStep('s1');
    expect(intents).toHaveLength(1);
    const inj = intents[0];
    if (inj?.kind !== 'inject') throw new Error('expected inject');
    expect(inj.update.changes.map((ch) => ch.signal.id)).toEqual(['a', 'j', 'b']); // by at
    expect(inj.update.since).toBe(1);
  });

  it('record-level signals update state and never deliver', async () => {
    const c = new FakeClock();
    const { intents, pipeline, store } = pipe(c);
    await pipeline.accept(sig({ id: 'a', kind: 'app.activated', at: 0, data: { name: 'Safari' } }), sess());
    c.advance(10_000);
    await pipeline.flush();
    await pipeline.preStep('s1');
    expect(intents).toEqual([]);
    expect(store.snapshot().env.frontApp.value?.name).toBe('Safari');
  });

  it('self-caused signals record only, even on wake rules', async () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    const s = sess({ toolWindows: [{ startedAt: 0, pid: 42 }] });
    const ch = await pipeline.accept(jobExit('w', 0, 1, 'j1', { data: { exitCode: 1, pid: 42 } }), s);
    expect(ch).toMatchObject({
      level: 'record',
      reason: 'self-caused',
      signal: { cause: 'agent' },
    });
    c.advance(10_000);
    await pipeline.flush();
    await pipeline.preStep('s1');
    expect(intents).toEqual([]);
  });

  it('unapproved agent wake rules degrade to context with rule-pending-approval', async () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c, [
      {
        id: 'agent-wake',
        match: { kind: 'job.exited' },
        level: 'wake',
        createdBy: 'agent',
        approved: false,
      },
    ]);
    const ch = await pipeline.accept(jobExit('w', 0, 1), sess());
    expect(ch).toMatchObject({
      level: 'context',
      reason: 'rule-pending-approval',
      ruleId: 'agent-wake',
    });
    c.advance(2001);
    await pipeline.preStep('s1');
    expect(intents).toHaveLength(1);
    const inj = intents[0];
    if (inj?.kind !== 'inject') throw new Error('expected inject');
    expect(inj.update.changes[0]).toMatchObject({
      level: 'context',
      reason: 'rule-pending-approval',
    });
  });

  it('keeps the earliest event time as since on out-of-order merges', async () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    await pipeline.accept(file('b', 50), sess());
    await pipeline.accept(file('a', 10), sess()); // older event merges, since stays 10
    c.advance(5001);
    await pipeline.preStep('s1');
    const inj = intents[0];
    if (inj?.kind !== 'inject') throw new Error('expected inject');
    expect(inj.update.since).toBe(10);
    expect(inj.update.changes[0]?.count).toBe(2);
  });

  it('keeps same-kind different-level signals as separate details on merge', async () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    await pipeline.accept(jobExit('fail', 1, 1, 'j'), sess()); // wake
    await pipeline.accept(jobExit('ok', 5, 0, 'j'), sess()); // context, newer
    c.advance(2001);
    await pipeline.flush();
    const w = intents[0];
    if (w?.kind !== 'followup') throw new Error('expected followup');
    // (kind, level) details: the wake exit keeps its own representative and
    // count; the context exit is a separate change, never rank-merged
    expect(w.update.changes[0]).toMatchObject({
      count: 1,
      level: 'wake',
      ruleId: 'job-failed',
    });
    expect(w.update.changes[0]?.signal.id).toBe('fail');
    expect(w.update.changes[0]?.signal.data.exitCode).toBe(1);
    expect(w.update.changes[1]).toMatchObject({ count: 1, level: 'context' });
    expect(w.update.changes[1]?.signal.id).toBe('ok');
  });

  it('queued signals are immune to later caller mutation', async () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    const s = file('m', 0, '/w/m.ts');
    const result = await pipeline.accept(s, sess());
    s.subject = '/w/evil.ts';
    s.data.path = '/w/evil.ts';
    result.signal.subject = '/w/returned.ts';
    result.signal.data.path = '/w/returned.ts';
    c.advance(5001);
    await pipeline.preStep('s1');
    const inj = intents[0];
    if (inj?.kind !== 'inject') throw new Error('expected inject');
    expect(inj.update.changes[0]?.signal.subject).toBe('/w/m.ts');
  });
});

describe('source status transitions', () => {
  it('notifies denied/error once per transition, resets on recovery', async () => {
    const c = new FakeClock();
    const { intents, pipeline, store } = pipe(c);
    const denied = (id: string) =>
      pipeline.accept(
        sig({
          id,
          kind: 'source.status',
          at: c.now,
          data: { status: 'denied' },
        }),
        sess(),
      );
    const done = async () => {
      c.advance(2001);
      await pipeline.preStep('s1');
    };
    await denied('d1');
    await denied('d2'); // same status → suppressed
    await done();
    expect(intents).toHaveLength(1);
    expect(intents[0]?.kind).toBe('inject');
    await pipeline.accept(
      sig({
        id: 'ok',
        kind: 'source.status',
        at: c.now,
        data: { status: 'ok' },
      }),
      sess(),
    );
    await denied('d3'); // recovery happened → notify again
    await done();
    expect(intents).toHaveLength(2);
    await pipeline.accept(sig({ id: 'e1', kind: 'source.error', at: c.now }), sess());
    await pipeline.accept(sig({ id: 'e2', kind: 'source.error', at: c.now }), sess());
    await done();
    expect(intents).toHaveLength(3);
    // state still updates even when notification is deduped
    expect(store.snapshot().observation.sources.fs?.status).toBe('unavailable');
  });

  it('transitions are per-session and out-of-order notifications cannot retrigger', async () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    const st = (id: string, at: number, status: string, sid = 's1') =>
      pipeline.accept(sig({ id, kind: 'source.status', at, data: { status, sequence: at } }), sess({ id: sid }));
    await st('a', 10, 'denied');
    await st('b', 10, 'denied', 's2'); // separate session is notified too
    await st('ok', 20, 'ok');
    await st('stale', 5, 'denied'); // older than denied@10 → cannot retrigger
    c.advance(2001);
    await pipeline.preStep('s1');
    await pipeline.preStep('s2');
    const deniedBySession = intents
      .filter((i) => i.kind === 'inject')
      .flatMap((i) =>
        i.update.changes
          .filter((ch) => ch.signal.data.status === 'denied')
          .map((ch) => `${i.sessionId}:${ch.signal.id}`),
      );
    expect(deniedBySession.sort()).toEqual(['s1:a', 's2:b']);
  });

  it('recognizes source-health transitions in receipt order after a wall-clock rollback', async () => {
    const c = new FakeClock();
    const { pipeline, intents, store } = pipe(c);
    await pipeline.accept(sig({ id: 'ok', kind: 'source.status', at: 100_000, data: { status: 'ok' } }), sess());
    await pipeline.accept(sig({ id: 'denied', kind: 'source.status', at: 90_000, data: { status: 'denied' } }), sess());
    expect(store.snapshot().observation.sources.fs?.status).toBe('denied');
    await pipeline.preStep('s1');
    expect(intents.flatMap((item) => item.update.changes).map((item) => item.signal.id)).toContain('denied');
  });

  it('does not enqueue a wake for an explicitly older job event', async () => {
    const c = new FakeClock();
    const { pipeline, intents } = pipe(c);
    await pipeline.accept(
      sig({
        id: 'new',
        kind: 'job.exited',
        subject: 'job',
        at: 10,
        data: { exitCode: 1, sequence: 10 },
      }),
      sess(),
    );
    const stale = await pipeline.accept(
      sig({
        id: 'old',
        kind: 'job.exited',
        subject: 'job',
        at: 20,
        data: { exitCode: 1, sequence: 5 },
      }),
      sess(),
    );
    expect(stale).toMatchObject({ level: 'record', reason: 'older-sequence' });
    c.advance(2001);
    await pipeline.flush();
    expect(intents.flatMap((item) => item.update.changes)).toMatchObject([{ signal: { id: 'new' }, count: 1 }]);
  });
});
