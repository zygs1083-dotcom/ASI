import type { Signal } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { FakeClock, jobExit, pipe, sess, sig } from './helpers.ts';

const file = (id: string, at: number, subject = '/w/a.ts', extra: Partial<Signal> = {}) =>
  sig({ id, kind: 'file.changed', at, subject, ...extra });

describe('AttentionPipeline merging', () => {
  it('merges repeated file saves (count=3), no inject before 5s deadline', () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    pipeline.accept(file('a', 0), sess());
    c.advance(1000);
    pipeline.accept(file('b', 1), sess());
    c.advance(1000);
    pipeline.accept(file('x', 2), sess());
    pipeline.preStep('s1'); // t=2000, deadline=5000
    expect(intents).toEqual([]);
    c.advance(3001);
    pipeline.preStep('s1'); // t=5001
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
  });

  it('dedups exact signal.id; separate ids merge into a single wake', () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    pipeline.accept(jobExit('e1', 0, 1), sess());
    const dup = pipeline.accept(jobExit('e1', 0, 1), sess()); // duplicate id
    expect(dup).toMatchObject({ level: 'record', reason: 'duplicate' });
    pipeline.accept(jobExit('e2', 1, 1), sess()); // merged into same bucket
    c.advance(2001);
    pipeline.flush();
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

  it('batches ready context groups into one sorted inject at preStep', () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    pipeline.accept(file('b', 5, '/w/b.ts'), sess());
    pipeline.accept(file('a', 1, '/w/a.ts'), sess());
    pipeline.accept(jobExit('j', 3, 0), sess()); // exit 0 → context, 2s window
    c.advance(5001);
    pipeline.preStep('s1');
    expect(intents).toHaveLength(1);
    const inj = intents[0];
    if (inj?.kind !== 'inject') throw new Error('expected inject');
    expect(inj.update.changes.map((ch) => ch.signal.id)).toEqual(['a', 'j', 'b']); // by at
    expect(inj.update.since).toBe(1);
  });

  it('record-level signals update state and never deliver', () => {
    const c = new FakeClock();
    const { intents, pipeline, store } = pipe(c);
    pipeline.accept(sig({ id: 'a', kind: 'app.activated', at: 0, data: { name: 'Safari' } }), sess());
    c.advance(10_000);
    pipeline.flush();
    pipeline.preStep('s1');
    expect(intents).toEqual([]);
    expect(store.snapshot().env.frontApp.value?.name).toBe('Safari');
  });

  it('self-caused signals record only, even on wake rules', () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    const s = sess({ toolWindows: [{ startedAt: 0, pid: 42 }] });
    const ch = pipeline.accept(jobExit('w', 0, 1, 'j1', { data: { exitCode: 1, pid: 42 } }), s);
    expect(ch).toMatchObject({
      level: 'record',
      reason: 'self-caused',
      signal: { cause: 'agent' },
    });
    c.advance(10_000);
    pipeline.flush();
    pipeline.preStep('s1');
    expect(intents).toEqual([]);
  });

  it('unapproved agent wake rules degrade to context with rule-pending-approval', () => {
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
    const ch = pipeline.accept(jobExit('w', 0, 1), sess());
    expect(ch).toMatchObject({
      level: 'context',
      reason: 'rule-pending-approval',
      ruleId: 'agent-wake',
    });
    c.advance(2001);
    pipeline.preStep('s1');
    expect(intents).toHaveLength(1);
    const inj = intents[0];
    if (inj?.kind !== 'inject') throw new Error('expected inject');
    expect(inj.update.changes[0]).toMatchObject({
      level: 'context',
      reason: 'rule-pending-approval',
    });
  });

  it('keeps the earliest event time as since on out-of-order merges', () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    pipeline.accept(file('b', 50), sess());
    pipeline.accept(file('a', 10), sess()); // older event merges, since stays 10
    c.advance(5001);
    pipeline.preStep('s1');
    const inj = intents[0];
    if (inj?.kind !== 'inject') throw new Error('expected inject');
    expect(inj.update.since).toBe(10);
    expect(inj.update.changes[0]?.count).toBe(2);
  });

  it('keeps the highest-level signal as representative on merge', () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    pipeline.accept(jobExit('fail', 1, 1, 'j'), sess()); // wake
    pipeline.accept(jobExit('ok', 5, 0, 'j'), sess()); // context, newer
    c.advance(2001);
    pipeline.flush();
    const w = intents[0];
    if (w?.kind !== 'followup') throw new Error('expected followup');
    expect(w.update.changes[0]).toMatchObject({
      count: 2,
      level: 'wake',
      ruleId: 'job-failed',
    });
    expect(w.update.changes[0]?.signal.id).toBe('fail');
    expect(w.update.changes[0]?.signal.data.exitCode).toBe(1);
  });

  it('queued signals are immune to later caller mutation', () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    const s = file('m', 0, '/w/m.ts');
    const result = pipeline.accept(s, sess());
    s.subject = '/w/evil.ts';
    s.data.path = '/w/evil.ts';
    result.signal.subject = '/w/returned.ts';
    result.signal.data.path = '/w/returned.ts';
    c.advance(5001);
    pipeline.preStep('s1');
    const inj = intents[0];
    if (inj?.kind !== 'inject') throw new Error('expected inject');
    expect(inj.update.changes[0]?.signal.subject).toBe('/w/m.ts');
  });
});

describe('source status transitions', () => {
  it('notifies denied/error once per transition, resets on recovery', () => {
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
    const done = () => {
      c.advance(2001);
      pipeline.preStep('s1');
    };
    denied('d1');
    denied('d2'); // same status → suppressed
    done();
    expect(intents).toHaveLength(1);
    expect(intents[0]?.kind).toBe('inject');
    pipeline.accept(
      sig({
        id: 'ok',
        kind: 'source.status',
        at: c.now,
        data: { status: 'ok' },
      }),
      sess(),
    );
    denied('d3'); // recovery happened → notify again
    done();
    expect(intents).toHaveLength(2);
    pipeline.accept(sig({ id: 'e1', kind: 'source.error', at: c.now }), sess());
    pipeline.accept(sig({ id: 'e2', kind: 'source.error', at: c.now }), sess());
    done();
    expect(intents).toHaveLength(3);
    // state still updates even when notification is deduped
    expect(store.snapshot().observation.sources.fs?.status).toBe('unavailable');
  });

  it('transitions are per-session and out-of-order notifications cannot retrigger', () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    const st = (id: string, at: number, status: string, sid = 's1') =>
      pipeline.accept(sig({ id, kind: 'source.status', at, data: { status } }), sess({ id: sid }));
    st('a', 10, 'denied');
    st('b', 10, 'denied', 's2'); // separate session is notified too
    st('ok', 20, 'ok');
    st('stale', 5, 'denied'); // older than denied@10 → cannot retrigger
    c.advance(2001);
    pipeline.preStep('s1');
    pipeline.preStep('s2');
    const deniedBySession = intents
      .filter((i) => i.kind === 'inject')
      .flatMap((i) =>
        i.update.changes
          .filter((ch) => ch.signal.data.status === 'denied')
          .map((ch) => `${i.sessionId}:${ch.signal.id}`),
      );
    expect(deniedBySession.sort()).toEqual(['s1:a', 's2:b']);
  });
});
