import type { Signal, WatchRule } from '@asi/sense-types';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { RuntimeAttention } from '../../src/host/runtime/attention.ts';
import { FactExpiry } from '../../src/host/runtime/expiry.ts';
import type { PendingContext } from '../../src/host/runtime/pending-context.ts';
import type { DshPort } from '../../src/host/runtime/ports.ts';

const signal = (id: string, kind: string, subject = id): Signal => ({
  id,
  kind,
  subject,
  at: 0,
  source: { id: 'fixture', api: 'fixture', host: 'local' },
  data: { name: 'Fixture' },
});

function harness(kinds: string[]) {
  const clock = { wall: () => 0, mono: () => 0 };
  const rules: WatchRule[] = kinds.map((kind) => ({
    id: kind,
    match: { kind },
    level: 'context',
    createdBy: 'user',
    approved: true,
  }));
  const deliveries: Parameters<DshPort['deliver']>[1][] = [];
  let committed: (session: string, id: string) => void = () => {};
  const port = {
    onAgentEvent: () => () => {},
    onTool: () => () => {},
    onJob: () => () => {},
    tokenSnapshot: async () => undefined,
    deliver: async (_session, intent) => {
      deliveries.push(intent);
    },
    onDeliveryCommitted: (cb: typeof committed) => {
      committed = cb;
      return () => {};
    },
  } satisfies DshPort & { onDeliveryCommitted: (cb: typeof committed) => () => void };
  const changed = vi.fn();
  const attention = new RuntimeAttention(
    clock,
    port,
    () => rules,
    () => {},
    () => true,
    changed,
    new FactExpiry(clock),
  );
  onTestFinished(() => attention.stop());
  const pending = Reflect.get(attention, 'pending') as PendingContext;
  return {
    attention,
    deliveries,
    changed,
    pending,
    staged: Reflect.get(pending, 'staged') as Map<string, unknown>,
    merged: Reflect.get(pending, 'merged') as Map<string, string[]>,
    reported: Reflect.get(pending, 'reported') as Set<string>,
    commit: (index: number) => {
      const delivery = deliveries[index];
      if (!delivery?.deliveryId) throw new Error(`missing delivery ${index}`);
      committed(delivery.sessionId, `asi-sense:${delivery.deliveryId}`);
    },
  };
}

describe('pending context confirmation', () => {
  it('confirms visible merged events after more than 1024 offline groups', async () => {
    const kinds = [
      'app.activated',
      'app.launched',
      'app.terminated',
      'window.focused',
      'window.title-changed',
      'job.started',
    ];
    const h = harness(kinds);
    for (let subject = 0; subject < 200; subject++) {
      for (const kind of kinds) {
        await h.attention.accept(signal(`${subject}-${kind}`, kind, `subject-${subject}`));
      }
    }
    await h.attention.accept(signal('retained-1', kinds[0] as string, 'subject-0'));
    await h.attention.accept(signal('retained-2', kinds[0] as string, 'subject-0'));
    h.attention.create('a');
    await h.attention.preStep('a');
    expect(h.deliveries).toHaveLength(1);
    expect(h.deliveries[0]?.update.changes).toHaveLength(1200);
    expect(h.deliveries[0]?.update.changes.find((change) => change.signal.id === 'retained-2')?.count).toBe(3);
    const visible = new Set(h.attention.events().map((event) => event.id));
    expect(h.merged.size).toBeLessThanOrEqual(200);
    expect([...h.merged.values()].flat().every((id) => visible.has(id))).toBe(true);
    h.commit(0);
    for (const id of ['retained-1', 'retained-2']) {
      expect(h.attention.events().find((event) => event.id === id)?.level).toBe('context');
    }
  }, 20_000);

  it.each([0, 512, 1025])(
    'clears every alias after 1025 transfers when attempt %i confirms and ignores late confirmations',
    async (confirmed) => {
      const h = harness(['context']);
      h.attention.create('session-0');
      await h.attention.preStep('session-0');
      await h.attention.accept(signal('signal', 'context'));
      await h.attention.preStep('session-0');
      for (let i = 1; i <= 1025; i++) {
        h.attention.create(`session-${i}`);
        await h.attention.preStep(`session-${i}`);
      }
      expect(h.deliveries).toHaveLength(1026);
      expect(h.staged.size).toBe(1026);
      h.changed.mockClear();
      h.commit(confirmed);
      expect(h.attention.events().find((event) => event.id === 'signal')?.level).toBe('context');
      expect(h.changed).toHaveBeenCalledTimes(1);
      expect(h.staged.size).toBe(0);
      h.changed.mockClear();
      const delivery = h.deliveries[1025];
      if (!delivery) throw new Error('missing transferred delivery');
      h.pending.stage(delivery);
      expect(h.staged.size).toBe(0);
      for (const index of [0, 512, 1025]) h.commit(index);
      await h.attention.preStep('session-0');
      expect(h.changed).not.toHaveBeenCalled();
      expect(h.deliveries).toHaveLength(1026);
    },
  );

  it('preserves unconfirmed parts of a split batch when one transferred part commits', async () => {
    const h = harness(['context']);
    h.attention.create('a');
    await h.attention.preStep('a');
    await h.attention.accept(signal('one', 'context'));
    await h.attention.accept(signal('two', 'context'));
    await h.attention.preStep('a');
    h.attention.dispose('a');
    h.attention.create('b');
    await h.attention.preStep('b');
    expect(h.deliveries.map((delivery) => delivery.update.changes.length)).toEqual([2, 1, 1]);
    const first = h.deliveries[1]?.update.changes[0]?.signal.id;
    const second = h.deliveries[2]?.update.changes[0]?.signal.id;
    h.commit(1);
    expect(h.attention.events().find((event) => event.id === first)?.level).toBe('context');
    expect(h.attention.events().find((event) => event.id === second)?.level).toBe('record');
    h.changed.mockClear();
    h.commit(0);
    expect(h.attention.events().find((event) => event.id === second)?.level).toBe('context');
    expect(h.changed).toHaveBeenCalledTimes(1);
    expect(h.staged.size).toBe(0);
    h.changed.mockClear();
    h.commit(2);
    await h.attention.preStep('b');
    expect(h.changed).not.toHaveBeenCalled();
    expect(h.deliveries).toHaveLength(3);
  });

  it('keeps independent batches staged when another batch confirms', async () => {
    const h = harness(['context']);
    h.attention.create('a');
    await h.attention.preStep('a');
    await h.attention.accept(signal('one', 'context'));
    await h.attention.preStep('a');
    await h.attention.accept(signal('two', 'context'));
    await h.attention.preStep('a');
    h.attention.create('b');
    await h.attention.preStep('b');
    expect(h.deliveries.map((delivery) => delivery.update.changes[0]?.signal.id)).toEqual([
      'one',
      'one',
      'two',
      'one',
      'two',
    ]);
    h.commit(0);
    expect(h.attention.events().find((event) => event.id === 'one')?.level).toBe('context');
    expect(h.attention.events().find((event) => event.id === 'two')?.level).toBe('record');
    expect(h.staged.size).toBe(2);
    h.commit(4);
    expect(h.attention.events().find((event) => event.id === 'two')?.level).toBe('context');
    expect(h.staged.size).toBe(0);
  });

  it('releases merged mappings as events leave the visible log', async () => {
    const h = harness(['context']);
    await h.attention.accept(signal('context', 'context'));
    h.attention.create('a');
    await h.attention.preStep('a');
    expect(h.merged.size).toBe(1);
    for (let i = 0; i < 200; i++) await h.attention.accept(signal(`record-${i}`, 'record'));
    expect(h.merged.size).toBe(0);
  });

  it('releases confirmed event identities as events leave the visible log', async () => {
    const h = harness(['context']);
    h.attention.create('a');
    await h.attention.preStep('a');
    await h.attention.accept(signal('context', 'context'));
    await h.attention.preStep('a');
    h.commit(0);
    expect(h.reported.size).toBe(1);
    for (let i = 0; i < 200; i++) await h.attention.accept(signal(`record-${i}`, 'record'));
    expect(h.reported.size).toBe(0);
  });

  it('clears staged aliases and drain batches when a transferred window batch is skipped with titles disabled', async () => {
    let allowTitles = true;
    const clock = { wall: () => 0, mono: () => 0 };
    const rules: WatchRule[] = [
      { id: 'win', match: { kind: 'window.focused' }, level: 'context', createdBy: 'user', approved: true },
    ];
    const deliveries: Parameters<DshPort['deliver']>[1][] = [];
    const port = {
      onAgentEvent: () => () => {},
      onTool: () => () => {},
      onJob: () => () => {},
      tokenSnapshot: async () => undefined,
      deliver: async (_session, intent) => {
        deliveries.push(intent);
      },
      onDeliveryCommitted: () => () => {},
    } satisfies DshPort & { onDeliveryCommitted: () => () => void };
    const attention = new RuntimeAttention(
      clock,
      port,
      () => rules,
      () => {},
      () => allowTitles,
      () => {},
      new FactExpiry(clock),
    );
    onTestFinished(() => attention.stop());
    const pending = Reflect.get(attention, 'pending') as PendingContext;
    const staged = Reflect.get(pending, 'staged') as Map<string, unknown>;
    const batches = Reflect.get(Reflect.get(attention.pipeline, 'drain') as object, 'batches') as Map<
      string,
      unknown[]
    >;

    attention.create('a');
    await attention.preStep('a');
    await attention.accept({
      id: 'win-1',
      kind: 'window.focused',
      subject: 'fixture.app',
      at: 0,
      source: { id: 'fixture', api: 'fixture', host: 'local' },
      data: { title: 'Synthetic window' },
    });
    await attention.preStep('a');
    expect(deliveries).toHaveLength(1);
    expect(staged.size).toBe(1);
    expect(batches.size).toBe(1);

    allowTitles = false;
    attention.create('b');
    await attention.preStep('b');
    expect(deliveries).toHaveLength(1);
    expect(staged.size).toBe(0);
    expect(batches.size).toBe(0);

    allowTitles = true;
    await attention.preStep('b');
    expect(deliveries).toHaveLength(1);
  });
});
