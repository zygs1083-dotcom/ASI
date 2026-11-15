import { describe, expect, it } from 'vitest';
import { AttentionPipeline, type DeliveryIntent } from '../src/host/attention/pipeline.ts';
import { StateStore } from '../src/host/state/store.ts';
import { FakeClock, jobExit, pipe, sess, sig, wake } from './helpers.ts';

const file = (id: string, at: number, subject = '/w/a.ts') => sig({ id, kind: 'file.changed', at, subject });
const keys = (intents: DeliveryIntent[]) => intents.map((i) => `${i.kind}:${i.sessionId}`);
const followups = (intents: DeliveryIntent[]) => intents.filter((i) => i.kind === 'followup');

function pipelineWith(clock: FakeClock, deliver: (intent: DeliveryIntent) => Promise<void>) {
  return new AttentionPipeline({
    store: new StateStore(clock.time),
    clock: clock.time,
    wallClock: clock.wallTime,
    deliverer: { deliver },
  });
}

describe('async intake and delivery', () => {
  it('accept queues new signals before cross-session delivery failures and recovers', async () => {
    const c = new FakeClock();
    const intents: DeliveryIntent[] = [];
    let fail = true;
    const pipeline = pipelineWith(c, async (i) => {
      if (fail && i.sessionId === 's2') throw new Error('s2-down');
      intents.push(i);
    });
    await pipeline.accept(jobExit('w2', 0, 1, 'w2'), sess({ id: 's2' }));
    await pipeline.accept(jobExit('w3', 0, 1, 'w3'), sess({ id: 's3' }));
    c.advance(2001); // both sessions' wake buckets are due
    // s1 intake is durable before rejection; s2's failure stops neither
    // s3's delivery nor the later preStep inject of the retained s1 batch
    await expect(pipeline.accept(file('f', 1), sess({ id: 's1' }))).rejects.toThrow('s2-down');
    expect(keys(intents)).toEqual(['followup:s3']);
    await expect(pipeline.preStep('s1')).rejects.toThrow('s2-down');
    expect(keys(intents)).toEqual(['followup:s3', 'inject:s1']);
    fail = false;
    await pipeline.flush(); // s2 retries once; nothing redelivered
    expect(keys(intents)).toEqual(['followup:s3', 'inject:s1', 'followup:s2']);
  });

  it('awaits rejected wake delivery without charging or losing the bucket', async () => {
    const c = new FakeClock();
    const intents: DeliveryIntent[] = [];
    let calls = 0;
    const pipeline = pipelineWith(c, async (i) => {
      calls++;
      if (calls === 1) throw new Error('nope');
      intents.push(i);
    });
    await pipeline.accept(jobExit('w1', 0, 1, 'w1'), sess());
    c.advance(2001);
    await expect(pipeline.flush()).rejects.toThrow('nope');
    c.advance(60_000);
    await pipeline.flush(); // retry delivers the retained bucket once
    expect(intents).toHaveLength(1);
    expect(intents[0]?.kind).toBe('followup');
    // the rejection never charged the budget: two more spaced wakes deliver
    c.advance(60_000);
    await wake(pipeline, c, 'w2');
    c.advance(60_000);
    await wake(pipeline, c, 'w3');
    expect(intents).toHaveLength(3);
    expect(pipeline.suppressed).toBe(0);
  });

  it('awaits rejected context delivery and retries only the retained batch', async () => {
    const c = new FakeClock();
    const intents: DeliveryIntent[] = [];
    let failNext = true;
    const pipeline = pipelineWith(c, async (i) => {
      if (failNext) {
        failNext = false;
        throw new Error('retry');
      }
      intents.push(i);
    });
    await pipeline.accept(jobExit('done', 0, 0), sess()); // context bucket
    c.advance(2001);
    await expect(pipeline.preStep('s1')).rejects.toThrow('retry');
    // a new context signal joins the retained batch for the next step
    await pipeline.accept(file('f', 2, '/w/b.ts'), sess());
    await pipeline.preStep('s1');
    await pipeline.preStep('s1');
    expect(intents).toHaveLength(1); // one inject, never redelivered
    const inj = intents[0];
    if (inj?.kind !== 'inject') throw new Error('expected inject');
    expect(inj.update.changes.map((ch) => ch.signal.id).sort()).toEqual(['done', 'f']);
  });

  it('serializes concurrent flush and preStep drains without duplicate or lost delivery', async () => {
    const c = new FakeClock();
    const intents: DeliveryIntent[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const pipeline = pipelineWith(c, async (i) => {
      await gate;
      intents.push(i);
    });
    await pipeline.accept(jobExit('w', 0, 1, 'w'), sess()); // wake bucket
    await pipeline.accept(file('f', 1), sess()); // context bucket
    c.advance(5001); // both due
    const p1 = pipeline.flush();
    const p2 = pipeline.preStep('s1');
    release();
    await Promise.all([p1, p2]);
    expect(intents.map((i) => i.kind).sort()).toEqual(['followup', 'inject']); // no duplicate, no loss
  });

  it('charges the wake budget at delivery completion, not drain start', async () => {
    const c = new FakeClock();
    const intents: DeliveryIntent[] = [];
    let deliverBegan!: () => void;
    const began = new Promise<void>((res) => {
      deliverBegan = res;
    });
    let release = (): void => {};
    let gate: Promise<void> | undefined = new Promise<void>((res) => {
      release = res;
    });
    const pipeline = pipelineWith(c, async (i) => {
      if (gate) {
        const g = gate;
        gate = undefined;
        deliverBegan();
        await g;
      }
      intents.push(i);
    });
    await pipeline.accept(jobExit('w1', 0, 1, 'w1'), sess());
    c.advance(2000); // t=2000: flush starts, adapter suspends on the gate
    const p = pipeline.flush();
    await began; // delivery is in flight
    c.advance(60_000); // t=62000: adapter finally resolves
    release();
    await p;
    expect(keys(intents)).toEqual(['followup:s1']);
    // w2 completes ~2s after w1 FINISHED, so the 60s min gap must downgrade
    // it — the gap cannot be measured from drain start
    await pipeline.accept(jobExit('w2', c.now, 1, 'w2'), sess());
    c.advance(2000);
    await pipeline.flush();
    expect(followups(intents)).toHaveLength(1);
    expect(pipeline.suppressed).toBe(1);
  });
});

describe('subject merge generations', () => {
  it('merges different kinds by subject without double charging', async () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    // first kind is context — the group window stays its 2s deadline
    await pipeline.accept(
      sig({ id: 'p', kind: 'process.exited', at: 0, subject: 'same', data: { exitCode: 0 } }),
      sess(),
    );
    await pipeline.accept(sig({ id: 'o', kind: 'job.exited', at: 1, subject: 'other', data: { exitCode: 1 } }), sess()); // interleaved: different subject stays a separate group
    await pipeline.accept(jobExit('j', 2, 1, 'same'), sess()); // wake detail upgrades the group
    await pipeline.accept(file('f', 3, 'same'), sess()); // lower later detail, no downgrade
    c.advance(2001);
    await pipeline.flush();
    expect(followups(intents)).toHaveLength(1); // 'same': one wake intent, three kinds, one charge
    expect(
      followups(intents)[0]
        ?.update.changes.map((ch) => ch.signal.kind)
        .sort(),
    ).toEqual(['file.changed', 'job.exited', 'process.exited']);
    // 'other' is a same-instant wake: the 60s min gap downgrades it to context
    expect(pipeline.suppressed).toBe(1);
    await pipeline.preStep('s1');
    const inj = intents.find((i) => i.kind === 'inject');
    expect(inj?.update.changes).toHaveLength(1);
    expect(inj?.update.changes[0]).toMatchObject({
      level: 'context',
      reason: 'wake-budget',
      signal: { id: 'o' },
    });
    // one charge for the merged group: two more spaced wakes still fit
    c.advance(60_000);
    await wake(pipeline, c, 'w2');
    c.advance(60_000);
    await wake(pipeline, c, 'w3');
    expect(followups(intents)).toHaveLength(3);
    expect(pipeline.suppressed).toBe(1);
  });

  it('counts suppressed groups, not wake-budget details, in update.suppressed', async () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    await wake(pipeline, c, 'w1'); // first wake charged
    // one subject, two wake-level kinds → a single suppressed group
    await pipeline.accept(jobExit('j', c.now, 1, 'same'), sess());
    await pipeline.accept(
      sig({ id: 'p', kind: 'process.exited', at: c.now, subject: 'same', data: { exitCode: 1 } }),
      sess(),
    );
    c.advance(2001); // due ~2s after the first wake: min-gap downgrade
    await pipeline.flush();
    expect(pipeline.suppressed).toBe(1);
    await pipeline.preStep('s1');
    const inj = intents.find((i) => i.kind === 'inject');
    expect(inj?.update.changes).toHaveLength(2); // both kind details retained
    expect(inj?.update.changes.every((ch) => ch.reason === 'wake-budget')).toBe(true);
    expect(inj?.update.suppressed).toBe(1); // one suppressed GROUP, not two details
  });

  it('preStep closes context early without injecting an open wake bucket', async () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    await pipeline.accept(jobExit('w', 0, 1, 'j1'), sess()); // wake group stays open
    await pipeline.accept(file('f', 1), sess()); // context group closes early
    await pipeline.preStep('s1');
    expect(intents).toHaveLength(1);
    const inj = intents[0];
    if (inj?.kind !== 'inject') throw new Error('expected inject');
    expect(inj.update.changes.map((ch) => ch.signal.kind)).toEqual(['file.changed']);
    c.advance(2001);
    await pipeline.flush(); // the wake group waits for its own deadline
    const w = intents[1];
    if (w?.kind !== 'followup') throw new Error('expected followup');
    expect(w.update.changes[0]?.signal.kind).toBe('job.exited');
  });

  it('starts a new half-open generation exactly at the deadline, retained failure included', async () => {
    const c = new FakeClock();
    const intents: DeliveryIntent[] = [];
    let fail = true;
    const pipeline = pipelineWith(c, async (i) => {
      if (fail) throw new Error('x');
      intents.push(i);
    });
    await pipeline.accept(file('a', 0), sess()); // gen1 [0, 5000)
    c.advance(5000);
    // received exactly at the deadline: joins gen2, NOT gen1 — durable intake
    // even though the first inject attempt then rejects and retains both
    await pipeline.accept(file('b', 1), sess());
    await expect(pipeline.preStep('s1')).rejects.toThrow('x');
    fail = false;
    await pipeline.preStep('s1');
    const inj = intents[0];
    if (inj?.kind !== 'inject') throw new Error('expected inject');
    // two separate generations deliver as two changes, never one count:2 merge
    expect(inj.update.changes).toHaveLength(2);
    expect(inj.update.changes.map((ch) => ch.signal.id).sort()).toEqual(['a', 'b']);
    expect(inj.update.changes.every((ch) => ch.count === 1)).toBe(true);
  });
});

describe('monotonic vs wall clock', () => {
  it('wall-clock jumps do not change monotonic merge deadlines or wake budget', async () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    await wake(pipeline, c, 'w1');
    c.advance(60_000);
    await wake(pipeline, c, 'w2');
    c.advance(60_000);
    await wake(pipeline, c, 'w3');
    expect(followups(intents)).toHaveLength(3);
    // forward wall jump must NOT roll the 600s budget window off
    c.jumpWall(600_000);
    c.advance(60_000);
    await wake(pipeline, c, 'w4');
    expect(pipeline.suppressed).toBe(1);
    expect(followups(intents)).toHaveLength(3);
    // backward wall jump must NOT tighten the min gap either
    c.jumpWall(-600_000);
    c.advance(540_001); // monotonic 600s window now truly elapsed
    await wake(pipeline, c, 'w5');
    expect(followups(intents)).toHaveLength(4);
    // merge deadlines are monotonic: a wall jump cannot complete a bucket early
    await pipeline.accept(jobExit('w6', c.now, 1, 'w6'), sess());
    c.jumpWall(10_000);
    await pipeline.flush();
    expect(followups(intents)).toHaveLength(4);
    c.advance(60_001); // real monotonic deadline (and wake min-gap) reached
    await pipeline.flush();
    expect(followups(intents)).toHaveLength(5);
  });

  it('wall clock behind monotonic still uses real time for budgets and deadlines', async () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    await wake(pipeline, c, 'w1'); // charged at monotonic 2001
    c.jumpWall(-120_000); // wall now far BEHIND monotonic
    c.advance(63_000);
    await wake(pipeline, c, 'w2'); // gap measured on monotonic → allowed
    expect(followups(intents)).toHaveLength(2);
    expect(pipeline.suppressed).toBe(0);
    // a pending merge still closes at its real monotonic deadline
    await pipeline.accept(file('f', c.wall, '/w/z.ts'), sess());
    c.advance(5001);
    await pipeline.preStep('s1');
    const inj = intents.find((i) => i.kind === 'inject');
    expect(inj?.update.changes[0]?.signal.id).toBe('f');
    // the update's display timestamp comes from the wall clock
    expect(inj?.update.at).toBe(c.wall);
  });
});
