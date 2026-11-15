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
    st.apply(exited('A', 30));
    const prior = jobsFact(st);
    expect(prior.value).toEqual([]);
    st.apply(factUpdate('u40', 40, [], { status: 'unknown' }));
    const unknown = jobsFact(st);
    expect(unknown.status).toBe('unknown');
    // an unknown report changes ONLY the status: value, source, observedAt
    // and ttl are all preserved
    expect({ ...unknown, status: prior.status }).toEqual(prior);
    // an older running-A snapshot is rejected before any mutation: it must
    // not resurrect the tombstoned job nor regress the fact
    st.apply(factUpdate('old', 35, [{ id: 'A', startedAt: 1, status: 'running' }]));
    expect(jobsFact(st)).toEqual(unknown);
    st.apply(started('A', 25)); // the retained tombstone still wins over it
    st.apply(started('B', 45)); // an independent later job is accepted
    expect(jobIds(st)).toEqual(['B']);
  });

  it('keeps the newest watermark across three out-of-order snapshots', () => {
    const c = new FakeClock();
    const st = new StateStore(c.time, 1000, c.time);
    const seed = [{ id: 'S', startedAt: 29, status: 'running' }];
    st.apply(factUpdate('s30', 30, seed));
    st.apply(factUpdate('n20', 20, [{ id: 'T', startedAt: 19, status: 'running' }])); // stale: dropped
    st.apply(factUpdate('n25', 25, null)); // three out-of-order: the newest still wins
    st.apply(factUpdate('u40', 40, [], { status: 'unknown' })); // unknown moves the same watermark
    st.apply(factUpdate('n35', 35, [{ id: 'T', startedAt: 34, status: 'running' }])); // between the two: still rejected
    const fact = jobsFact(st);
    expect(fact.status).toBe('unknown'); // kept from the unknown report
    expect(fact.value).toEqual(seed); // without rolling the value back
    expect(fact.observedAt).toBe(30); // or regressing freshness
    st.apply(started('X', 25)); // below the newest non-unknown watermark: rejected
    st.apply(started('B', 35)); // above it: accepted alongside the seeded job
    expect(jobIds(st).sort()).toEqual(['B', 'S']);
  });

  it('accepts constructor-delayed snapshots but rejects reports older than explicit unknown', () => {
    const wall = new FakeClock();
    const mono = new FakeClock();
    wall.jumpWall(100); // constructed at wall=100
    expect(wall.wallTime()).toBe(100);
    const st = new StateStore(wall.wallTime, 1000, mono.time);
    // the constructor's 'unknown' is no report: the first real sample
    // predating the constructor clock is still accepted
    st.apply(factUpdate('s2', 2, [{ id: 'A', startedAt: 1, status: 'running' }]));
    expect(jobIds(st)).toEqual(['A']);
    expect(jobsFact(st).observedAt).toBe(2);
    // an explicit report moves the watermark whatever its status, so a
    // snapshot at 150 is rejected regardless of ITS status
    st.apply(factUpdate('u200', 200, [], { status: 'unknown' }));
    st.apply(factUpdate('s150', 150, [{ id: 'B', startedAt: 1, status: 'running' }], { status: 'ok' }));
    expect(jobsFact(st).status).toBe('unknown');
    expect(jobIds(st)).toEqual(['A']);
    // an older explicit unknown is rejected too — it cannot even set status
    st.apply(factUpdate('s300', 300, [{ id: 'C', startedAt: 1, status: 'running' }]));
    st.apply(factUpdate('u250', 250, [], { status: 'unknown' }));
    expect(jobsFact(st).status).toBe('ok');
    expect(jobIds(st)).toEqual(['C']);
  });

  it('merges a snapshot with newer per-job events instead of rejecting it wholesale', () => {
    const c = new FakeClock();
    const st = new StateStore(c.time, 1000, c.time);
    st.apply(exited('A', 50)); // tombstone at 50
    st.apply(started('B', 60));
    st.apply(started('D', 70));
    st.apply(
      factUpdate('s40', 40, [
        { id: 'A', startedAt: 1, status: 'running' }, // loses to A's newer tombstone
        { id: 'B', startedAt: 55, status: 'exited' }, // loses to B's newer start
        { id: 'C', startedAt: 39, status: 'running' }, // independent: seeded
      ]),
    );
    expect(jobIds(st).sort()).toEqual(['B', 'C', 'D']); // omitted D survives too
    // null at 45 clears only tracks at or below it: B and D survive
    st.apply(factUpdate('n45', 45, null));
    expect(jobIds(st).sort()).toEqual(['B', 'D']);
  });

  it.each(['unknown', 'denied', 'unavailable', 'stale', 'unsupported', 'ok'] as const)(
    'rejects an earlier snapshot after an accepted %s report',
    (status) => {
      const c = new FakeClock();
      const st = new StateStore(c.time, 1000, c.time);
      st.apply(factUpdate('first', 40, [{ id: 'F', startedAt: 39, status: 'running' }], { status }));
      const accepted = jobsFact(st);
      expect(accepted.status).toBe(status);
      st.apply(factUpdate('older', 35, [{ id: 'O', startedAt: 34, status: 'running' }]));
      expect(jobsFact(st)).toEqual(accepted);
      st.apply(started('O', 34));
      expect(jobIds(st)).toEqual(status === 'unknown' ? ['O'] : ['F']);
    },
  );
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
    let micro!: Promise<unknown>;
    const pipeline = new AttentionPipeline({
      store,
      clock: c.time,
      wallClock: c.wallTime,
      deliverer: {
        deliver: (intent) => {
          calls.push(intent);
          if (!scheduled) {
            scheduled = true;
            // a queueMicrotask still runs in the delivery context: intake only
            queueMicrotask(() => {
              micro = pipeline.accept(
                sig({ id: 'q', kind: 'window.focused', at: 1, data: { title: 'Queue' } }),
                sess({ id: 's2' }),
              );
            });
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
    await micro; // the microtask intake resolved inside the delivery context
    expect(store.snapshot().env.frontApp.value?.name).toBe('Later');
    expect(store.snapshot().env.focusedWindow.value?.title).toBe('Queue');
    if (outcome === 'rejected') {
      // the callback's own drain retried the retained delivery
      expect(calls.filter((i) => i.kind === 'followup')).toHaveLength(2);
    }
  });
});

describe('nextDeadline', () => {
  it('reports the earliest pending merge deadline for host timers', async () => {
    const c = new FakeClock();
    const { pipeline, intents } = pipe(c);
    const file = (id: string) => sig({ id, kind: 'file.changed', at: 1, subject: '/w/a.ts' }); // +5s window
    expect(pipeline.nextDeadline()).toBeUndefined(); // nothing pending
    await pipeline.accept(jobExit('w', 0, 1, 'w'), sess()); // wake merge: +2s
    await pipeline.accept(file('f'), sess()); // file merge: +5s — earliest stays
    expect(pipeline.nextDeadline()).toBe(2000);
    await pipeline.flush(); // before the deadline: nothing delivers
    expect(intents).toHaveLength(0);
    c.advance(2001); // past the wake deadline — nothing drains by itself
    await pipeline.accept(file('a'), sess()); // a due bucket never drains on accept
    expect(intents).toHaveLength(0);
    expect(pipeline.nextDeadline()).toBe(2000); // still pending on its deadline
    await pipeline.flush(); // the wake ships and the file merge remains
    expect(intents.map((i) => i.kind)).toEqual(['followup']);
    expect(pipeline.nextDeadline()).toBe(5000);
    c.advance(3000); // t=5001: the file bucket becomes ready context
    await pipeline.flush();
    expect(pipeline.nextDeadline()).toBeUndefined(); // ready context is not a merge deadline
    expect(intents).toHaveLength(1); // and flush never injects it
    await pipeline.preStep('s1'); // preStep does
    expect(intents.map((i) => i.kind)).toEqual(['followup', 'inject']);
    expect(pipeline.nextDeadline()).toBeUndefined();
  });
});
