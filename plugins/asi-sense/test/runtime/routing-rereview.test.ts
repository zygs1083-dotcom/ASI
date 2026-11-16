import type { Signal, WatchRule } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { RuntimeAttention } from '../../src/host/runtime/attention.ts';
import { FactExpiry } from '../../src/host/runtime/expiry.ts';
import type { Clock, DshPort } from '../../src/host/runtime/ports.ts';

const rules: WatchRule[] = [
  { id: 'ctx', match: { kind: 'context' }, level: 'context', createdBy: 'user', approved: true },
  { id: 'wake', match: { kind: 'wake' }, level: 'wake', createdBy: 'user', approved: true },
];
const signal = (id: string, kind: string): Signal => ({
  id,
  kind,
  at: 0,
  subject: id,
  source: { id: 'fixture', api: 'test', host: 'local' },
  data: {},
});

function harness(failFirst: boolean, configuredRules = rules, blockFirst = true) {
  let now = 0;
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delivered: Parameters<DshPort['deliver']>[1][] = [];
  const clock: Clock = { wall: () => now, mono: () => now };
  const dsh = {
    deliver: async (_id, intent) => {
      delivered.push(intent);
      if (blockFirst && delivered.length === 1) {
        entered();
        await gate;
        if (failFirst) throw new Error('unconfirmed');
      }
    },
  } satisfies Pick<DshPort, 'deliver'>;
  const attention = new RuntimeAttention(
    clock,
    dsh as DshPort,
    () => configuredRules,
    () => {},
    () => true,
    () => {},
    new FactExpiry(clock),
  );
  return {
    attention,
    delivered,
    waiting,
    release,
    advance: () => {
      now = 2_000;
    },
  };
}

describe('in-flight session ownership', () => {
  it('moves the due wake after an in-flight context delivery changes session', async () => {
    const h = harness(false);
    h.attention.create('a');
    h.attention.create('b');
    await h.attention.preStep('a');
    await h.attention.accept(signal('ctx', 'context'));
    await h.attention.accept(signal('wake', 'wake'));
    h.advance();
    const old = h.attention.preStep('a');
    await h.waiting;
    h.attention.dispose('a');
    const next = h.attention.preStep('b');
    h.release();
    await Promise.all([old, next]);
    expect(h.delivered.map((item) => [item.sessionId, item.kind])).toEqual([
      ['a', 'inject'],
      ['b', 'send'],
    ]);
  });

  it('retains a failed wake and moves all later buckets before another delivery', async () => {
    const h = harness(true);
    h.attention.create('a');
    h.attention.create('b');
    await h.attention.preStep('a');
    await h.attention.accept(signal('wake-1', 'wake'));
    await h.attention.accept(signal('wake-2', 'wake'));
    h.advance();
    const old = h.attention.flush().catch(() => {});
    await h.waiting;
    h.attention.dispose('a');
    const next = h.attention.preStep('b');
    h.release();
    await Promise.all([old, next]);
    expect(h.delivered[0]).toMatchObject({ sessionId: 'a' });
    expect(h.delivered.slice(1).every((item) => item.sessionId === 'b')).toBe(true);
    await h.attention.preStep('b');
    expect(
      h.delivered.flatMap((item) => item.update.changes).filter((item) => item.signal.id === 'wake-2'),
    ).toHaveLength(1);
    expect(h.delivered.filter((item) => item.sessionId === 'b')).toHaveLength(2);
    const retried = h.delivered.find(
      (item) => item.sessionId === 'b' && item.update.changes.some((change) => change.signal.id === 'wake-1'),
    );
    expect(retried).toMatchObject({ kind: 'inject', deliveryId: expect.any(String) });
    expect(retried?.deliveryId).not.toBe(h.delivered[0]?.deliveryId);
  });

  it('invalidates an in-flight drain even if a disposed session id is reused', async () => {
    const h = harness(false);
    h.attention.create('a');
    await h.attention.preStep('a');
    await h.attention.accept(signal('ctx', 'context'));
    await h.attention.accept(signal('wake', 'wake'));
    h.advance();
    const old = h.attention.preStep('a');
    await h.waiting;
    h.attention.dispose('a');
    h.attention.create('a');
    await h.attention.preStep('a', false, false);
    h.release();
    await old;
    expect(h.delivered).toHaveLength(1);
    await h.attention.preStep('a');
    expect(h.delivered.map((item) => item.kind)).toEqual(['inject', 'send']);
  });
});

describe('bounded context without a session', () => {
  it('counts subjects rather than kinds when retaining 200 subjects', async () => {
    const configured = ['one', 'two'].map((kind) => ({
      id: kind,
      match: { kind },
      level: 'context' as const,
      createdBy: 'user' as const,
      approved: true,
    }));
    const h = harness(false, configured, false);
    for (let i = 0; i < 200; i++) await h.attention.accept({ ...signal(`s-${i}`, 'one'), subject: `s-${i}` });
    await h.attention.accept({ ...signal('extra', 'two'), subject: 's-199' });
    h.attention.create('a');
    await h.attention.preStep('a');
    const changes = h.delivered.flatMap((item) => item.update.changes);
    expect(changes).toHaveLength(201);
    expect(changes.some((item) => item.signal.subject === 's-0')).toBe(true);
    expect(h.attention.events().some((item) => item.reason?.startsWith('pending-evicted'))).toBe(false);
  });

  it('bounds per-subject kinds and merges excess into other', async () => {
    const configured = Array.from({ length: 20 }, (_, index) => ({
      id: `kind-${index}`,
      match: { kind: `kind-${index}` },
      level: 'context' as const,
      createdBy: 'user' as const,
      approved: true,
    }));
    const h = harness(false, configured, false);
    for (let i = 0; i < 20; i++) await h.attention.accept({ ...signal(`id-${i}`, `kind-${i}`), subject: 'same' });
    h.attention.create('a');
    await h.attention.preStep('a');
    const changes = h.delivered.flatMap((item) => item.update.changes);
    expect(changes).toHaveLength(16);
    expect(changes.find((item) => item.signal.kind === 'other')?.count).toBe(5);
  });

  it('does not buffer an explicitly older context while no session is selected', async () => {
    const h = harness(false, rules, false);
    await h.attention.accept({ ...signal('new', 'context'), subject: 'same', data: { sequence: 10 } });
    await h.attention.accept({ ...signal('old', 'context'), subject: 'same', data: { sequence: 5 } });
    h.attention.create('a');
    await h.attention.preStep('a');
    const changes = h.delivered.flatMap((item) => item.update.changes);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ count: 1, signal: { id: 'new' } });
  });

  it('does not compare independent subjects using their per-event sequences', async () => {
    const h = harness(false, rules, false);
    await h.attention.accept({ ...signal('one', 'context'), subject: 'first', data: { sequence: 10 } });
    await h.attention.accept({ ...signal('two', 'context'), subject: 'second', data: { sequence: 5 } });
    h.attention.create('a');
    await h.attention.preStep('a');
    expect(h.delivered.flatMap((item) => item.update.changes)).toHaveLength(2);
  });
});
