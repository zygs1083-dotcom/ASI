import { describe, expect, it } from 'vitest';
import { AttentionPipeline, type DeliveryIntent } from '../src/host/attention/pipeline.ts';
import { StateStore } from '../src/host/state/store.ts';
import { FakeClock, jobExit, pipe, sess, sig, wake } from './helpers.ts';

describe('wake budget', () => {
  it('suppresses a 4th wake within 600s; gap >=60s allowed; per-session isolated', () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    wake(pipeline, c, 'w1'); // t≈0
    c.advance(60_000);
    wake(pipeline, c, 'w2'); // gap exactly 60s → allowed
    c.advance(60_000);
    wake(pipeline, c, 'w3');
    expect(intents.map((i) => i.kind)).toEqual(['followup', 'followup', 'followup']);
    c.advance(60_000);
    wake(pipeline, c, 'w4'); // 4th in 600s window → suppressed
    expect(pipeline.suppressed).toBe(1);
    pipeline.preStep('s1');
    const inj = intents[3];
    if (inj?.kind !== 'inject') throw new Error('expected inject');
    expect(inj.sessionId).toBe('s1');
    expect(inj.update.changes[0]).toMatchObject({
      level: 'context',
      reason: 'wake-budget',
    });
    expect(inj.update.suppressed).toBe(1);
    // different session unaffected and routed to s2
    wake(pipeline, c, 'w5', sess({ id: 's2' }));
    const w5 = intents[4];
    if (w5?.kind !== 'followup') throw new Error('expected followup');
    expect(w5.sessionId).toBe('s2');
  });

  it('suppresses wakes closer than 60s even under the count limit', () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    wake(pipeline, c, 'w1');
    c.advance(30_000);
    wake(pipeline, c, 'w2');
    expect(intents).toHaveLength(1);
    expect(pipeline.suppressed).toBe(1);
    pipeline.preStep('s1');
    expect(intents[1]?.kind).toBe('inject');
  });

  it('allows wakes again after the 600s window rolls off', () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    wake(pipeline, c, 'w1');
    c.advance(60_000);
    wake(pipeline, c, 'w2');
    c.advance(60_000);
    wake(pipeline, c, 'w3');
    c.advance(600_001);
    wake(pipeline, c, 'w4');
    expect(intents.map((i) => i.kind)).toEqual(['followup', 'followup', 'followup', 'followup']);
    expect(pipeline.suppressed).toBe(0);
  });
});

describe('busy sessions', () => {
  it('wakes become next-step sends; user-active for user turns, agent-busy otherwise', () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    pipeline.accept(jobExit('w1', 0, 1), sess({ busy: true, userInitiated: true }));
    c.advance(2001);
    pipeline.flush();
    const s1 = intents[0];
    if (s1?.kind !== 'send') throw new Error('expected send');
    expect(s1.sessionId).toBe('s1');
    expect(s1.target).toBe('next-step');
    expect(s1.wakeup).toBe(true);
    expect(s1.update.changes[0]?.reason).toBe('user-active');
    expect(s1.update.changes[0]?.note).toBeUndefined();
    c.advance(60_001);
    pipeline.accept(jobExit('w2', c.now, 1, 'j2'), sess({ busy: true, userInitiated: false }));
    c.advance(2001);
    pipeline.flush();
    const s2 = intents[1];
    if (s2?.kind !== 'send') throw new Error('expected send');
    expect(s2.update.changes[0]?.reason).toBe('agent-busy');
  });

  it('setSession updates busy without a new signal; sends count toward budget', () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    const busyWake = (id: string) => {
      pipeline.accept(jobExit(id, c.now, 1, id), sess({ busy: true }));
      c.advance(2001);
      pipeline.flush();
    };
    // session goes busy between accept and flush → send, not followup
    pipeline.accept(jobExit('w1', c.now, 1, 'w1'), sess());
    pipeline.setSession(sess({ busy: true }));
    c.advance(2001);
    pipeline.flush();
    expect(intents[0]?.kind).toBe('send');
    c.advance(60_000);
    busyWake('w2');
    c.advance(60_000);
    busyWake('w3');
    expect(intents.map((i) => i.kind)).toEqual(['send', 'send', 'send']);
    c.advance(60_000);
    busyWake('w4');
    expect(pipeline.suppressed).toBe(1); // 4th send wake suppressed like followups
    pipeline.preStep('s1');
    expect(intents[3]?.kind).toBe('inject');
  });

  it('refreshes busy from a new accept before flushing expired buckets', () => {
    const c = new FakeClock();
    const { intents, pipeline } = pipe(c);
    pipeline.accept(jobExit('w', 0, 1, 'w'), sess());
    c.advance(2001); // bucket expired but not yet flushed
    // this accept refreshes the session to busy BEFORE flushing the bucket
    pipeline.accept(sig({ id: 'r', kind: 'app.activated', at: c.now }), sess({ busy: true, userInitiated: false }));
    const send = intents[0];
    if (send?.kind !== 'send') throw new Error('expected send');
    expect(send.update.changes[0]?.reason).toBe('agent-busy');
  });

  it('propagates deliverer errors synchronously', () => {
    const c = new FakeClock();
    const store = new StateStore(c.time);
    const pipeline = new AttentionPipeline({
      store,
      deliverer: {
        deliver: () => {
          throw new Error('nope');
        },
      },
      clock: c.time,
    });
    pipeline.accept(jobExit('w', 0, 1), sess());
    c.advance(2001);
    expect(() => pipeline.flush()).toThrow('nope');
  });

  it('keeps the pending event and unspent budget when deliver throws', () => {
    const c = new FakeClock();
    const store = new StateStore(c.time);
    const intents: DeliveryIntent[] = [];
    let calls = 0;
    const pipeline = new AttentionPipeline({
      store,
      deliverer: {
        deliver: (i) => {
          calls++;
          if (calls === 1) throw new Error('nope');
          intents.push(i);
        },
      },
      clock: c.time,
    });
    pipeline.accept(jobExit('w1', 0, 1, 'w1'), sess());
    c.advance(2001);
    expect(() => pipeline.flush()).toThrow('nope');
    c.advance(60_000);
    pipeline.flush(); // retry delivers the retained event
    expect(intents).toHaveLength(1);
    // budget was not spent by the throw: two more spaced wakes still deliver
    c.advance(60_000);
    wake(pipeline, c, 'w2');
    c.advance(60_000);
    wake(pipeline, c, 'w3');
    expect(intents).toHaveLength(3);
    expect(pipeline.suppressed).toBe(0);
  });

  it('applies new input to the store before a throwing flush can abort', () => {
    const c = new FakeClock();
    const store = new StateStore(c.time);
    const pipeline = new AttentionPipeline({
      store,
      deliverer: {
        deliver: () => {
          throw new Error('nope');
        },
      },
      clock: c.time,
    });
    pipeline.accept(jobExit('w', 0, 1), sess());
    c.advance(2001);
    // next accept: store.apply runs before the flush that throws
    expect(() =>
      pipeline.accept(sig({ id: 'a', kind: 'app.activated', at: 1, data: { name: 'Safari' } }), sess()),
    ).toThrow('nope');
    expect(store.snapshot().env.frontApp.value?.name).toBe('Safari');
  });

  it('retains a context batch when inject fails and delivers it only once on retry', () => {
    const c = new FakeClock();
    const intents: DeliveryIntent[] = [];
    let failed = false;
    const pipeline = new AttentionPipeline({
      store: new StateStore(c.time),
      clock: c.time,
      deliverer: {
        deliver(intent) {
          if (!failed) {
            failed = true;
            throw new Error('retry');
          }
          intents.push(intent);
        },
      },
    });
    pipeline.accept(jobExit('done', 0, 0), sess());
    c.advance(2000);
    expect(() => pipeline.preStep('s1')).toThrow('retry');
    pipeline.preStep('s1');
    pipeline.preStep('s1');
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ kind: 'inject', sessionId: 's1' });
  });
});
