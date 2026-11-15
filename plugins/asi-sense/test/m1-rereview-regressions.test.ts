import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AttentionPipeline, type DeliveryIntent, ReentrantDeliveryError } from '../src/host/attention/pipeline.ts';
import { formatEnvUpdate } from '../src/host/delivery/format.ts';
import { StateStore } from '../src/host/state/store.ts';
import { FakeClock, jobExit, pipe, sess, sig } from './helpers.ts';

const file = (id: string, at: number, subject = '/w/a.ts') => sig({ id, kind: 'file.changed', at, subject });
const changeIds = (i: DeliveryIntent | undefined) => i?.update.changes.map((ch) => ch.signal.id);

function pipelineWith(clock: FakeClock, deliver: (intent: DeliveryIntent) => Promise<void>) {
  return new AttentionPipeline({
    store: new StateStore(clock.time, 60_000, clock.time),
    clock: clock.time,
    wallClock: clock.wallTime,
    deliverer: { deliver },
  });
}

let jobSeq = 0;
const started = (job: string, at: number) =>
  sig({ id: `st-${job}-${at}-${jobSeq++}`, kind: 'job.started', at, subject: job, data: { command: job } });
const exited = (job: string, at: number) =>
  sig({ id: `ex-${job}-${at}-${jobSeq++}`, kind: 'job.exited', at, subject: job, data: { exitCode: 0 } });
const jobIds = (st: StateStore) => (st.snapshot().env.activeJobs.value ?? []).map((j) => j.id);

describe('delivery failures and stable identity', () => {
  it('rethrows an empty AggregateError by identity instead of swallowing it', async () => {
    const c = new FakeClock();
    const empty = new AggregateError([], 'offline');
    const calls: DeliveryIntent[] = [];
    let reject = true;
    const pipeline = pipelineWith(c, async (i) => {
      calls.push(i);
      if (reject) throw empty;
    });
    await pipeline.accept(jobExit('w', 0, 1, 'w'), sess());
    c.advance(2001);
    await expect(pipeline.flush()).rejects.toBe(empty);
    reject = false;
    await pipeline.flush(); // the retained wake bucket retries once, by identity
    expect(calls.map((i) => i.kind)).toEqual(['followup', 'followup']);
    // same identity propagation on the context inject path
    reject = true;
    await pipeline.accept(file('f', 0), sess());
    await expect(pipeline.preStep('s1')).rejects.toBe(empty);
    reject = false;
    await pipeline.preStep('s1');
  });
  it('combines independent raw failures without flattening adapter AggregateErrors', async () => {
    const c = new FakeClock();
    const agg = new AggregateError([new Error('inner')], 'adapter-agg');
    const plain = new Error('plain');
    const pipeline = pipelineWith(c, async (i) => {
      if (i.sessionId === 's1') throw agg;
      throw plain;
    });
    await pipeline.accept(jobExit('w1', 0, 1, 'w1'), sess());
    await pipeline.accept(jobExit('w2', 0, 1, 'w2'), sess({ id: 's2' }));
    c.advance(2001);
    const err = await pipeline.flush().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors).toEqual([agg, plain]);
  });
});

describe('reentrant pipeline intake ordering', () => {
  it('delivers the first denied before a nested accept marks recovery', async () => {
    const c = new FakeClock();
    const { store, pipeline, intents } = pipe(c);
    const nested: Promise<unknown>[] = [];
    let once = true;
    store.subscribe((snap) => {
      if (once && snap.observation.sources.fs?.status === 'denied') {
        once = false;
        nested.push(pipeline.accept(sig({ id: 'app', kind: 'app.activated', at: 2, data: { name: 'B' } }), sess()));
      }
    });
    await pipeline.accept(sig({ id: 'd1', kind: 'source.status', at: 1, data: { status: 'denied' } }), sess());
    await Promise.all(nested);
    c.advance(2001);
    await pipeline.preStep('s1');
    const inj = intents.find((i) => i.kind === 'inject');
    expect(changeIds(inj)).toEqual(['d1']); // not judged stale by the nested mark
    expect(store.snapshot().observation.sources.fs?.status).toBe('ok'); // nested signal still recovered it
  });
  it('merges a nested same-subject signal into the outer bucket window', async () => {
    const c = new FakeClock();
    const { store, pipeline, intents } = pipe(c);
    const nested: Promise<unknown>[] = [];
    let once = true;
    store.subscribe(() => {
      if (once) {
        once = false;
        nested.push(pipeline.accept(file('f', 1, 'same'), sess()));
      }
    });
    await pipeline.accept(jobExit('w', 0, 1, 'same'), sess()); // wake bucket: 2s window
    await Promise.all(nested);
    c.advance(2001);
    await pipeline.flush();
    const w = intents.find((i) => i.kind === 'followup');
    expect(w?.update.changes.map((ch) => ch.signal.kind).sort()).toEqual(['file.changed', 'job.exited']);
  });
  it('queues a pipeline accept triggered from a store.apply subscriber', async () => {
    const c = new FakeClock();
    const { store, pipeline, intents } = pipe(c);
    const nested: Promise<unknown>[] = [];
    let once = true;
    store.subscribe(() => {
      if (once) {
        once = false;
        nested.push(pipeline.accept(file('n', 2, '/w/n.ts'), sess()));
      }
    });
    store.apply(sig({ id: 'outer', kind: 'app.activated', at: 1, data: { name: 'A' } })); // direct apply, no callback
    await Promise.all(nested);
    c.advance(5001);
    await pipeline.preStep('s1');
    const inj = intents.find((i) => i.kind === 'inject');
    expect(changeIds(inj)).toEqual(['n']);
  });
});

describe('job tracking', () => {
  const factUpdate = (id: string, at: number, value: unknown) =>
    sig({ id, kind: 'fact.updated', at, data: { path: 'env.activeJobs', value } });
  it('blocks pre-snapshot starts for replaced and unknown ids but accepts independent late jobs', () => {
    const c = new FakeClock();
    const st = new StateStore(c.time, 1000, c.time);
    st.apply(started('A', 1));
    st.apply(exited('A', 5));
    st.apply(factUpdate('snap', 10, []));
    st.apply(started('A', 2)); // pre-snapshot, retained tombstone also blocks
    st.apply(started('X', 9)); // pre-snapshot start for an unknown id: watermark blocks
    st.apply(started('B', 20)); // post-snapshot: independent job accepted
    st.apply(started('C', 12)); // late but still after the snapshot: accepted
    expect(jobIds(st)).toEqual(['B', 'C']);
    st.apply(factUpdate('clr', 30, null)); // a null replacement also watermarks
    st.apply(started('Y', 25)); // pre-watermark: ignored
    st.apply(started('Z', 40));
    expect(jobIds(st)).toEqual(['Z']);
  });
});

describe('mixed bucket context split', () => {
  it('injects split context at preStep while the wake keeps its deadline and count', async () => {
    const c = new FakeClock();
    const { pipeline, intents } = pipe(c);
    await pipeline.accept(file('f', 0, 'same'), sess()); // context, opens the 5s window
    await pipeline.accept(jobExit('j', 0, 1, 'same'), sess()); // wake detail joins the mixed bucket
    c.advance(1000);
    await pipeline.preStep('s1'); // context detail splits out and injects now
    expect(intents).toHaveLength(1);
    const inj = intents[0];
    if (inj?.kind !== 'inject') throw new Error('expected inject');
    expect(changeIds(inj)).toEqual(['f']);
    await pipeline.accept(file('f2', 1, 'same'), sess());
    c.advance(500);
    await pipeline.preStep('s1');
    expect(intents).toHaveLength(2);
    expect(changeIds(intents[1])).toEqual(['f2']);
    c.advance(4000); // t=5500 > the 5s deadline
    await pipeline.flush();
    const w = intents.find((i) => i.kind === 'followup');
    expect(changeIds(w)).toEqual(['j']); // context never repeated in the wake
    expect(w?.update.alreadyInjected).toBe(2);
    expect(formatEnvUpdate(w?.update ?? { since: 0, at: 0, changes: [], suppressed: 0 })).toContain(
      '另有 2 条已在上一步注入',
    );
    await pipeline.preStep('s1'); // nothing repeats on a later step
    expect(intents).toHaveLength(3);
  });
  it('ignores wall-clock jumps and prunes exit tombstones at exactly 600s monotonic', () => {
    const wall = new FakeClock();
    const mono = new FakeClock();
    const st = new StateStore(wall.time, 1000, mono.time);
    st.apply(started('A', 1));
    st.apply(exited('A', 5));
    wall.advance(600_000); // a forward wall jump cannot release the tombstone
    st.apply(started('A', 2));
    expect(jobIds(st)).toEqual([]);
    wall.advance(-1_200_000); // nor a backward one
    st.apply(started('A', 3));
    expect(jobIds(st)).toEqual([]);
    mono.advance(599_999); // half-open [receivedAt, receivedAt+600s): still held
    st.apply(started('A', 4));
    expect(jobIds(st)).toEqual([]);
    mono.advance(1); // exactly 600_000 → pruned on the next job event
    // an OLD start (at=2, blocked above while the tombstone held) is now an
    // ordinary new event — proving pruning, not newer-start acceptance
    st.apply(started('A', 2));
    expect(jobIds(st)).toEqual(['A']);
  });
});

describe('delivery isolation and reentrancy', () => {
  it('clamps future cutoffs, rejects non-finite ones and keeps same-subject arrivals in a fresh bucket', async () => {
    const c = new FakeClock();
    const calls: DeliveryIntent[] = [];
    let began = false;
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const pipeline = pipelineWith(c, async (i) => {
      calls.push(i);
      began = true;
      await gate; // the adapter suspends mid-delivery
    });
    await pipeline.accept(jobExit('a', 0, 1, 'same'), sess());
    await pipeline.flush(1_000_000);
    expect(calls).toHaveLength(0);
    expect(() => pipeline.flush(Number.NaN)).toThrow(TypeError);
    expect(() => pipeline.preStep('s1', Number.POSITIVE_INFINITY)).toThrow(TypeError);
    c.advance(2001); // A's wake bucket now due; delivery suspends on the gate
    const f1 = pipeline.flush();
    await vi.waitFor(() => {
      expect(began).toBe(true);
    });
    const pB = pipeline.accept(jobExit('b', 1, 1, 'same'), sess());
    const pF = pipeline.flush();
    const pS = pipeline.preStep('s1');
    release();
    await Promise.all([f1, pB, pF, pS]);
    expect(changeIds(calls[0])).toEqual(['a']); // A delivered alone
    c.advance(2001); // B's own deadline
    await pipeline.flush(); // B hits A's recent wake charge → context downgrade
    await pipeline.preStep('s1');
    const follows = calls
      .filter((i) => i.kind === 'followup')
      .flatMap((i) => i.update.changes.map((ch) => ch.signal.id));
    expect(follows).toEqual(['a']);
    const inj = calls.find((i) => i.kind === 'inject');
    expect(changeIds(inj)).toEqual(['b']); // B delivered separately, never dropped
  });
  it('rejects pipeline APIs awaited inside adapter.deliver without deadlock', async () => {
    const c = new FakeClock();
    const reentryErrors: string[] = [];
    const pipeline = pipelineWith(c, async () => {
      await Promise.resolve(); // still inside the delivery context after an await
      for (const call of [
        () => pipeline.flush(),
        () => pipeline.preStep('s1'),
        () => pipeline.accept(sig({ id: 're', kind: 'app.activated', at: 0, data: { name: 'X' } }), sess()),
      ]) {
        try {
          await call();
          reentryErrors.push('resolved');
        } catch (e) {
          reentryErrors.push((e as Error).name);
        }
      }
    });
    await pipeline.accept(jobExit('w', 0, 1, 'w'), sess());
    c.advance(2001);
    await pipeline.flush(); // must not deadlock on the adapter's own drain
    expect(reentryErrors).toEqual([
      ReentrantDeliveryError.name,
      ReentrantDeliveryError.name,
      ReentrantDeliveryError.name,
    ]);
  });
  it('retries a failed wake with the same deliveryId and frozen display time', async () => {
    const c = new FakeClock();
    const calls: DeliveryIntent[] = [];
    let fail = true;
    const pipeline = pipelineWith(c, async (i) => {
      calls.push(structuredClone(i));
      if (fail) {
        fail = false;
        throw new Error('down');
      }
    });
    await pipeline.accept(jobExit('z9', 0, 1, 'w'), sess());
    await pipeline.accept(jobExit('a1', 1, 1, 'w'), sess());
    c.advance(2001);
    await expect(pipeline.flush()).rejects.toThrow('down');
    c.jumpWall(100_000); // wall moves — the retry keeps the frozen display time
    await pipeline.flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.deliveryId).toBe(calls[0]?.deliveryId);
    expect(calls[1]?.update.at).toBe(calls[0]?.update.at);
    const expected = createHash('sha256')
      .update(JSON.stringify(['s1', ['a1', 'z9']]))
      .digest('hex');
    expect(calls[0]?.deliveryId).toBe(expected);
  });
  it('downgrades a failed wake retry to a separate frozen inject once the budget moved', async () => {
    const c = new FakeClock();
    const calls: DeliveryIntent[] = [];
    let failOnce = true;
    const pipeline = pipelineWith(c, async (i) => {
      calls.push(structuredClone(i));
      if (failOnce && i.update.changes.some((ch) => ch.signal.id === 'old')) {
        failOnce = false;
        throw new Error('old-down');
      }
    });
    await pipeline.accept(jobExit('old', 0, 1, 'old'), sess());
    await pipeline.accept(jobExit('new', 0, 1, 'new'), sess());
    c.advance(2001); // both due: old rejected, new still delivered independently
    await expect(pipeline.flush()).rejects.toThrow('old-down');
    expect(calls.map((i) => `${i.kind}:${i.update.changes[0]?.signal.id}`)).toEqual(['followup:old', 'followup:new']);
    c.advance(2000); // retrying old now collides with new's fresh charge
    await pipeline.flush(); // → budget downgrade to context, nothing delivered yet
    expect(calls).toHaveLength(2);
    c.jumpWall(50_000);
    await pipeline.preStep('s1'); // followup(new) then inject(old), per the review
    const inj = calls[2];
    expect(inj?.kind).toBe('inject');
    expect(changeIds(inj)).toEqual(['old']); // never merged into another context batch
    expect(inj?.update.at).toBe(calls[0]?.update.at); // frozen display time retained
    expect(inj?.deliveryId).toBe(calls[0]?.deliveryId); // same underlying signal ids
  });
  it('isolates adapter mutations of a delivered intent from the retained retry', async () => {
    const c = new FakeClock();
    const pristine: DeliveryIntent[] = [];
    let fail = true;
    const pipeline = pipelineWith(c, async (i) => {
      pristine.push(structuredClone(i)); // adapter records first, then corrupts
      i.update.at = -1;
      i.update.changes = [];
      if (fail) {
        fail = false;
        throw new Error('x');
      }
    });
    await pipeline.accept(jobExit('done', 0, 0), sess());
    c.advance(2001);
    await expect(pipeline.preStep('s1')).rejects.toThrow('x');
    c.jumpWall(9999);
    await pipeline.preStep('s1');
    expect(pristine).toHaveLength(2);
    expect(changeIds(pristine[1])).toEqual(['done']); // mutation never reached the batch
    expect(pristine[1]?.update.at).toBe(pristine[0]?.update.at);
    expect(pristine[1]?.deliveryId).toBe(pristine[0]?.deliveryId);
  });
  it('injects a same-step budget downgrade once and propagates inject failure', async () => {
    const c = new FakeClock();
    const calls: DeliveryIntent[] = [];
    const pipeline = pipelineWith(c, async (i) => {
      calls.push(i);
    });
    await pipeline.accept(jobExit('w1', 0, 1, 'w1'), sess());
    c.advance(2001);
    await pipeline.flush(); // w1's followup charges the 60s min-gap budget
    await pipeline.accept(jobExit('w2', 2, 1, 'w2'), sess());
    c.advance(2001); // w2 due, still inside the gap → downgraded to context
    await pipeline.preStep('s1'); // must inject it in THIS step, not the next
    expect(calls.map((i) => i.kind)).toEqual(['followup', 'inject']);
    expect(changeIds(calls[1])).toEqual(['w2']);
    // a rejected downgrade batch is attempted once per step, retained frozen
    const c2 = new FakeClock();
    const calls2: DeliveryIntent[] = [];
    let fail2 = true;
    const p2 = pipelineWith(c2, async (i) => {
      calls2.push(i);
      if (fail2 && i.kind === 'inject') throw new Error('inject-down');
    });
    await p2.accept(jobExit('w1', 0, 1, 'w1'), sess());
    c2.advance(2001);
    await p2.flush();
    await p2.accept(jobExit('w2', 2, 1, 'w2'), sess());
    c2.advance(2001);
    await expect(p2.preStep('s1')).rejects.toThrow('inject-down');
    expect(calls2.filter((i) => i.kind === 'inject')).toHaveLength(1); // not retried in-step
    fail2 = false;
    await p2.preStep('s1'); // the frozen batch retries next step
    expect(calls2.filter((i) => i.kind === 'inject')).toHaveLength(2);
  });
});
