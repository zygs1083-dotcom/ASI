import type { Signal } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { AttentionPipeline, type DeliveryIntent } from '../src/host/attention/pipeline.ts';
import { StateStore } from '../src/host/state/store.ts';
import { FakeClock, jobExit, pipe, sess, sig } from './helpers.ts';

let seq = 0;
const started = (job: string, at: number) =>
  sig({ id: `st-${job}-${at}-${seq++}`, kind: 'job.started', at, subject: job, data: { command: job } });
const exited = (job: string, at: number) =>
  sig({ id: `ex-${job}-${at}-${seq++}`, kind: 'job.exited', at, subject: job, data: { exitCode: 0 } });
const factUpdate = (id: string, at: number, value: unknown, extra: Partial<Signal['data']> = {}) =>
  sig({ id, kind: 'fact.updated', at, data: { path: 'env.activeJobs', value, ...extra } });
const jobIds = (st: StateStore) => (st.snapshot().env.activeJobs.value ?? []).map((j) => j.id);
const jobsFact = (st: StateStore) => st.snapshot().env.activeJobs;

describe('env.activeJobs snapshot watermarks', () => {
  it('keeps job tombstones when unknown is followed by an older snapshot', () => {
    const c = new FakeClock();
    const st = new StateStore(c.time, 1000, c.time);
    st.apply(started('A', 1));
    st.apply(exited('A', 5));
    const prior = jobsFact(st);
    expect(prior.value).toEqual([]);
    st.apply(factUpdate('u10', 10, [], { status: 'unknown' }));
    const unknown = jobsFact(st);
    expect(unknown.status).toBe('unknown');
    // an unknown report changes ONLY the status: value, source, observedAt
    // and ttl are all preserved
    expect({ ...unknown, status: prior.status }).toEqual(prior);
    // an older running-A snapshot is rejected before any mutation: it must
    // not resurrect the tombstoned job nor regress the fact
    st.apply(factUpdate('old', 2, [{ id: 'A', startedAt: 1, status: 'running' }]));
    expect(jobsFact(st)).toEqual(unknown);
    st.apply(started('A', 3)); // the retained tombstone still wins over it
    st.apply(started('B', 6)); // an independent later job is accepted
    expect(jobIds(st)).toEqual(['B']);
  });

  it('keeps the newest watermark across three out-of-order snapshots', () => {
    const c = new FakeClock();
    const st = new StateStore(c.time, 1000, c.time);
    const seed = [{ id: 'S', startedAt: 29, status: 'running' }];
    st.apply(factUpdate('s30', 30, seed));
    st.apply(factUpdate('u40', 40, [], { status: 'unknown' }));
    st.apply(factUpdate('n20', 20, null)); // older than BOTH watermarks: dropped
    const fact = jobsFact(st);
    expect(fact.status).toBe('unknown'); // kept from the unknown report
    expect(fact.value).toEqual(seed); // without rolling the value back
    expect(fact.observedAt).toBe(30); // or regressing freshness
    st.apply(started('X', 25)); // below the newest watermark: rejected
    st.apply(started('B', 35)); // above it: accepted alongside the seeded job
    expect(jobIds(st).sort()).toEqual(['B', 'S']);
  });

  it('accepts a first real job snapshot before constructor and unknown timestamps', () => {
    const wall = new FakeClock();
    const mono = new FakeClock();
    wall.jumpWall(100); // constructed at wall=100
    expect(wall.wallTime()).toBe(100);
    const st = new StateStore(wall.wallTime, 1000, mono.time);
    st.apply(factUpdate('u200', 200, [], { status: 'unknown' }));
    // the first real sample predates both the constructor clock and the
    // unknown report - the -Infinity observation baselines still accept it
    st.apply(factUpdate('s2', 2, [{ id: 'A', startedAt: 1, status: 'running' }]));
    expect(jobIds(st)).toEqual(['A']);
    expect(jobsFact(st).observedAt).toBe(2);
    // a stale unknown below both watermarks is dropped unchanged
    const accepted = jobsFact(st);
    st.apply(factUpdate('u1', 1, [], { status: 'unknown' }));
    expect(jobsFact(st)).toEqual(accepted);
    st.apply(started('X', 1)); // pre-snapshot start: blocked by the watermark
    expect(jobIds(st)).toEqual(['A']);
  });
});

describe('(kind, level) bucket details', () => {
  it.each(['success', 'failure'])('injects same-kind context before the wake deadline (%s first)', async (first) => {
    const c = new FakeClock();
    const { pipeline, intents } = pipe(c);
    const okSig = jobExit('ok', 0, 0, 'j1'); // context level
    const badSig = jobExit('bad', 1, 1, 'j1'); // wake level
    await pipeline.accept(first === 'success' ? okSig : badSig, sess());
    await pipeline.accept(first === 'success' ? badSig : okSig, sess());
    c.advance(1000); // t=1000, inside the 2s merge window
    await pipeline.preStep('s1');
    expect(intents).toHaveLength(1);
    const inj = intents[0];
    if (inj?.kind !== 'inject') throw new Error('expected inject');
    expect(inj.update.changes).toHaveLength(1);
    expect(inj.update.changes[0]).toMatchObject({ count: 1, level: 'context' });
    expect(inj.update.changes[0]?.signal.id).toBe('ok');
    c.advance(999); // t=1999: still before the deadline
    await pipeline.flush();
    expect(intents).toHaveLength(1);
    c.advance(1); // t=2000: the wake detail's deadline
    await pipeline.flush();
    const wake = intents[1];
    if (wake?.kind !== 'followup') throw new Error('expected followup');
    expect(wake.update.changes).toHaveLength(1);
    expect(wake.update.changes[0]).toMatchObject({ count: 1, level: 'wake' });
    expect(wake.update.changes[0]?.signal.id).toBe('bad');
    expect(wake.update.alreadyInjected).toBe(1);
    await pipeline.preStep('s1'); // already injected once: never repeats
    expect(intents).toHaveLength(2);
  });

  it('keeps same-kind outcome counts separate without a preStep split', async () => {
    const c = new FakeClock();
    const { pipeline, intents } = pipe(c);
    await pipeline.accept(jobExit('ok1', 0, 0, 'j1'), sess());
    await pipeline.accept(jobExit('ok2', 1, 0, 'j1'), sess());
    await pipeline.accept(jobExit('bad1', 2, 1, 'j1'), sess());
    await pipeline.accept(jobExit('bad2', 3, 1, 'j1'), sess());
    await pipeline.accept(jobExit('bad3', 4, 1, 'j1'), sess());
    c.advance(2001);
    await pipeline.flush(); // one expired bucket, no preStep split involved
    const wake = intents.find((i) => i.kind === 'followup');
    expect(wake?.update.changes.map((ch) => ch.count).sort()).toEqual([2, 3]); // never a merged 5
    expect(wake?.update.changes.find((ch) => ch.level === 'context')?.count).toBe(2);
    expect(wake?.update.changes.find((ch) => ch.level === 'wake')?.count).toBe(3);
  });
});

describe('delivery context', () => {
  it.each(['resolved', 'rejected'])('allows inherited setImmediate intake after delivery %s', async (outcome) => {
    const c = new FakeClock();
    const store = new StateStore(c.time, 60_000, c.time);
    const calls: DeliveryIntent[] = [];
    let failOnce = outcome === 'rejected';
    let scheduled = false;
    let settled!: Promise<void>;
    const pipeline = new AttentionPipeline({
      store,
      clock: c.time,
      wallClock: c.wallTime,
      deliverer: {
        deliver: (intent) => {
          calls.push(intent);
          if (!scheduled) {
            scheduled = true;
            // inherits the delivery's async context: legal once it settles -
            // errors reject `settled` instead of crashing unhandled
            settled = new Promise<void>((resolve, reject) => {
              setImmediate(() => {
                void (async () => {
                  await pipeline.accept(
                    sig({ id: 'app', kind: 'app.activated', at: 1, data: { name: 'Later' } }),
                    sess({ id: 's2' }),
                  );
                  await pipeline.flush();
                  await pipeline.preStep('s2');
                })().then(resolve, reject);
              });
            });
          }
          if (failOnce) {
            failOnce = false;
            return Promise.reject(new Error('down'));
          }
          return Promise.resolve();
        },
      },
    });
    await pipeline.accept(jobExit('w', 0, 1, 'w'), sess());
    c.advance(2001);
    if (outcome === 'rejected') await expect(pipeline.flush()).rejects.toThrow('down');
    else await pipeline.flush();
    await settled; // a ReentrantDeliveryError here fails the test
    expect(store.snapshot().env.frontApp.value?.name).toBe('Later');
    if (outcome === 'rejected') {
      // the callback's own drain retried the retained delivery
      expect(calls.filter((i) => i.kind === 'followup')).toHaveLength(2);
    }
  });
});
