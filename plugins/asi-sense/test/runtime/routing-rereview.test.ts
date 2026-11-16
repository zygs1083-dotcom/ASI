import type { Signal, WatchRule } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { createDelivery } from '../../src/host/dsh/deliver.ts';
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

function harness(failFirst: boolean, configuredRules = rules, blockFirst = true, staged = false) {
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
    ...(staged ? { onDeliveryCommitted: () => () => {} } : {}),
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
    advance: (ms = 2_000) => {
      now += ms;
    },
  };
}

describe('in-flight session ownership', () => {
  it('does not apply a queued job after its owner is disposed and recreated reentrantly', async () => {
    const h = harness(
      false,
      [{ id: 'starts', match: { kind: 'job.started' }, level: 'context', createdBy: 'user', approved: true }],
      false,
    );
    h.attention.create('a');
    await h.attention.preStep('a');
    let queued: Promise<void> | undefined;
    const off = h.attention.store.subscribe(() => {
      off();
      queued = h.attention.accept({
        id: 'old-event',
        kind: 'job.started',
        at: 0,
        subject: 'synthetic-old-job',
        source: { id: 'dsh', api: 'events', host: 'local' },
        data: { id: 'synthetic-old-job', sessionId: 'a', sessionToken: h.attention.sessionToken('a') },
      });
      h.attention.dispose('a');
      h.attention.create('a');
    });
    await h.attention.accept(signal('outer', 'context'));
    await queued;
    expect(h.attention.state().env.activeJobs.value ?? []).not.toContainEqual(
      expect.objectContaining({ id: 'synthetic-old-job' }),
    );
    expect(h.attention.state().observation.sources.dsh).toBeUndefined();
    expect(h.attention.events()).toContainEqual(
      expect.objectContaining({ id: 'old-event', reason: 'session-private' }),
    );
    expect(h.attention.pipeline.nextDeadline()).toBeUndefined();
    await h.attention.preStep('a');
    await h.attention.accept({
      id: 'old-event',
      kind: 'job.started',
      at: 0,
      subject: 'synthetic-new-job',
      source: { id: 'dsh', api: 'events', host: 'local' },
      data: { id: 'synthetic-new-job', sessionId: 'a', sessionToken: h.attention.sessionToken('a') },
    });
    expect(h.attention.state().env.activeJobs.value).toContainEqual(
      expect.objectContaining({ id: 'synthetic-new-job' }),
    );
    await h.attention.stop();
  });

  it('does not enqueue a job if the owner generation changes during store notification', async () => {
    const configured: WatchRule[] = [
      { id: 'jobs', match: { kind: 'job.exited' }, level: 'wake', createdBy: 'user', approved: true },
    ];
    const h = harness(false, configured, false);
    h.attention.create('a');
    await h.attention.preStep('a');
    const token = h.attention.sessionToken('a');
    const off = h.attention.store.subscribe(() => {
      off();
      h.attention.dispose('a');
      h.attention.create('a');
    });
    await h.attention.accept({
      id: 'old-event',
      kind: 'job.exited',
      at: 0,
      subject: 'old-job',
      source: { id: 'dsh', api: 'events', host: 'local' },
      data: { id: 'old-job', sessionId: 'a', sessionToken: token, exitCode: 1 },
    });
    const drain = (h.attention.pipeline as unknown as { drain: { pending: Map<number, unknown> } }).drain;
    expect(drain.pending.size).toBe(0);
    expect(h.attention.events()).toContainEqual(
      expect.objectContaining({ id: 'old-event', reason: 'session-private' }),
    );
    await h.attention.stop();
  });

  it('bounds 350 waiting owned jobs and delivers one counted summary to their owner', async () => {
    const configured: WatchRule[] = [
      { id: 'jobs', match: { kind: 'job.exited' }, level: 'wake', createdBy: 'user', approved: true },
    ];
    const h = harness(false, configured, false);
    h.attention.create('a');
    h.attention.create('b');
    await h.attention.preStep('b');
    const token = h.attention.sessionToken('a');
    for (let i = 0; i < 350; i++) {
      await h.attention.accept({
        id: `event-${i}`,
        kind: 'job.exited',
        at: i,
        subject: `job-${i}`,
        source: { id: 'dsh', api: 'events', host: 'local' },
        data: { id: `job-${i}`, sessionId: 'a', sessionToken: token, exitCode: i % 2 },
      });
    }
    const drain = (
      h.attention.pipeline as unknown as {
        drain: {
          pending: Map<number, { details: Map<string, { ids: string[] }>; jobs: { recent: Map<string, unknown> } }>;
        };
      }
    ).drain;
    expect(drain.pending.size).toBe(1);
    const bucket = [...drain.pending.values()][0];
    if (!bucket) throw new Error('job bucket missing');
    expect(bucket?.jobs.recent.size).toBe(20);
    expect([...bucket.details.values()].flatMap((detail) => detail.ids)).toHaveLength(200);
    expect(h.delivered).toHaveLength(0);
    h.advance();
    await h.attention.preStep('a');
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]).toMatchObject({
      sessionId: 'a',
      update: { changes: [expect.objectContaining({ count: 350 })] },
    });
    const messages: unknown[] = [];
    const agent = { inject: () => {}, send: (message: unknown) => messages.push(message), followup: () => {} };
    const deliver = createDelivery(
      () => agent as never,
      () => true,
      async () => false,
    );
    await deliver('a', h.delivered[0] as Parameters<typeof deliver>[1]);
    const text = JSON.stringify(messages);
    expect(text).toContain('jobs: 350 events');
    expect(text).toContain('另有 330 个未列出');
    expect(text.match(/job: `job-/g)).toHaveLength(20);
    expect(text).toContain('job-330');
    expect(text).toContain('job-349');
    expect(text).not.toContain('job-329');
    await h.attention.stop();
  });

  it('keeps repeated job events and mixed levels in one bounded summary across merge windows', async () => {
    const configured: WatchRule[] = [
      { id: 'starts', match: { kind: 'job.started' }, level: 'context', createdBy: 'user', approved: true },
      { id: 'exits', match: { kind: 'job.exited' }, level: 'wake', createdBy: 'user', approved: true },
    ];
    const h = harness(false, configured, false);
    h.attention.create('a');
    h.attention.create('b');
    await h.attention.preStep('b');
    for (let i = 0; i < 30; i++) {
      for (const kind of ['job.started', 'job.exited'] as const) {
        await h.attention.accept({
          id: `event-${i}-${kind}`,
          kind,
          at: i,
          subject: `job-${i}`,
          source: { id: 'dsh', api: 'events', host: 'local' },
          data: { id: `job-${i}`, sessionId: 'a', sessionToken: h.attention.sessionToken('a'), exitCode: 1 },
        });
      }
      h.advance(3_000);
    }
    await h.attention.preStep('a');
    const changes = h.delivered.flatMap((intent) => intent.update.changes);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      count: 60,
      level: 'wake',
      signal: {
        data: {
          jobSummary: {
            total: 60,
            omitted: 40,
            recent: expect.arrayContaining([
              expect.objectContaining({ id: 'job-29', count: 1, kind: 'job.started' }),
              expect.objectContaining({ id: 'job-29', count: 1, kind: 'job.exited' }),
            ]),
          },
        },
      },
    });
    await h.attention.stop();
  });

  it('reports each job kind and count accurately in the model delivery', async () => {
    const configured: WatchRule[] = [
      { id: 'starts', match: { kind: 'job.started' }, level: 'context', createdBy: 'user', approved: true },
      { id: 'exits', match: { kind: 'job.exited' }, level: 'wake', createdBy: 'user', approved: true },
    ];
    const h = harness(false, configured, false);
    h.attention.create('a');
    h.attention.create('b');
    await h.attention.preStep('b');
    for (const [index, kind] of ['job.started', 'job.exited', 'job.started', 'job.exited', 'job.exited'].entries()) {
      await h.attention.accept({
        id: `event-${index}`,
        kind,
        at: index,
        subject: 'id1',
        source: { id: 'dsh', api: 'events', host: 'local' },
        data: { id: 'id1', sessionId: 'a', sessionToken: h.attention.sessionToken('a'), exitCode: 1 },
      });
    }
    h.advance();
    await h.attention.preStep('a');
    const messages: unknown[] = [];
    const agent = { inject: () => {}, send: (message: unknown) => messages.push(message), followup: () => {} };
    const deliver = createDelivery(
      () => agent as never,
      () => true,
      async () => false,
    );
    await deliver('a', h.delivered[0] as Parameters<typeof deliver>[1]);
    const text = JSON.stringify(messages);
    expect(text).toContain('jobs: 5 events');
    expect(text).toContain('job: `id1` started ×2');
    expect(text).toContain('job: `id1` exited 1 ×3');
    expect(text).not.toContain('job: `id1` exited 1 ×5');
    await h.attention.stop();
  });

  it('wakes for a failed job while an earlier successful job awaits injection', async () => {
    const configured: WatchRule[] = [
      {
        id: 'failed',
        match: { kind: 'job.exited', where: { exitCode: { '!=': 0 } } },
        level: 'wake',
        createdBy: 'user',
        approved: true,
      },
      { id: 'done', match: { kind: 'job.exited' }, level: 'context', createdBy: 'user', approved: true },
    ];
    const h = harness(false, configured, false);
    h.attention.create('a');
    await h.attention.preStep('a');
    h.attention.postStep('a');
    const add = (id: string, exitCode: number) =>
      h.attention.accept({
        id,
        kind: 'job.exited',
        at: 0,
        subject: id,
        source: { id: 'dsh', api: 'events', host: 'local' },
        data: { id, sessionId: 'a', sessionToken: h.attention.sessionToken('a'), exitCode },
      });
    await add('success', 0);
    h.advance();
    await h.attention.flush();
    await add('failure', 1);
    expect(h.attention.pipeline.nextDeadline()).toBe(4_000);
    h.advance();
    await h.attention.flush();
    expect(h.delivered.filter((intent) => intent.kind === 'followup')).toHaveLength(1);
    expect(h.delivered[0]?.update.changes[0]?.signal.data.id).toBe('failure');
    for (let i = 0; i < 50; i++) {
      await add(`failure-${i}`, 1);
      h.advance(500);
      await h.attention.flush();
    }
    const drain = h.attention.pipeline as unknown as {
      drain: { pending: Map<number, unknown>; ready: Map<string, unknown[]>; batches: Map<string, unknown[]> };
    };
    expect(
      drain.drain.pending.size +
        (drain.drain.ready.get('a')?.length ?? 0) +
        (drain.drain.batches.get('a')?.length ?? 0),
    ).toBeLessThanOrEqual(3);
    expect(h.delivered.filter((intent) => intent.kind === 'followup')).toHaveLength(1);
    expect(h.attention.pipeline.suppressed).toBe(1);
    h.advance(1_000);
    await h.attention.flush();
    expect(h.attention.pipeline.nextDeadline()).toBeUndefined();
    h.advance(39_000);
    await add('failure-after-budget', 1);
    expect(h.attention.pipeline.nextDeadline()).toBe(71_000);
    h.advance();
    await h.attention.flush();
    expect(h.delivered.filter((intent) => intent.kind === 'followup')).toHaveLength(2);
    await h.attention.preStep('a');
    expect(h.delivered.flatMap((intent) => intent.update.changes).reduce((sum, change) => sum + change.count, 0)).toBe(
      53,
    );
    await h.attention.stop();
  });

  it('starts a new merge window when a parked budget-downgraded job becomes a wake', async () => {
    const configured: WatchRule[] = [
      {
        id: 'failed',
        match: { kind: 'job.exited', where: { exitCode: { '!=': 0 } } },
        level: 'wake',
        createdBy: 'user',
        approved: true,
      },
      { id: 'done', match: { kind: 'job.exited' }, level: 'context', createdBy: 'user', approved: true },
    ];
    const h = harness(false, configured, false);
    h.attention.create('a');
    await h.attention.preStep('a');
    h.attention.postStep('a');
    const add = (id: string, exitCode: number) =>
      h.attention.accept({
        id,
        kind: 'job.exited',
        at: 0,
        subject: id,
        source: { id: 'dsh', api: 'events', host: 'local' },
        data: { id, sessionId: 'a', sessionToken: h.attention.sessionToken('a'), exitCode },
      });
    await add('success', 0);
    h.advance();
    await h.attention.flush();
    await add('first-wake', 1);
    h.advance();
    await h.attention.flush();
    await add('downgraded', 1);
    h.advance();
    await h.attention.flush();
    h.advance(58_000);
    await add('new-wake', 1);
    expect(h.attention.pipeline.nextDeadline()).toBe(66_000);
    await h.attention.flush();
    expect(h.delivered).toHaveLength(1);
    h.advance(1_000);
    await add('merged-wake', 1);
    expect(h.attention.pipeline.nextDeadline()).toBe(66_000);
    h.attention.pipeline.setMergeWindows(1_500, 5_000);
    expect(h.attention.pipeline.nextDeadline()).toBe(65_500);
    h.advance(500);
    await h.attention.flush();
    expect(h.delivered).toHaveLength(2);
    expect(h.delivered[1]?.update.changes[0]).toMatchObject({
      count: 3,
      level: 'wake',
      signal: { data: { jobSummary: { total: 3 } } },
    });
    expect(h.attention.pipeline.suppressed).toBe(1);
    await h.attention.stop();
  });

  it('lets a wake pass a frozen context batch without changing that batch', async () => {
    const configured: WatchRule[] = [
      {
        id: 'failed',
        match: { kind: 'job.exited', where: { exitCode: { '!=': 0 } } },
        level: 'wake',
        createdBy: 'user',
        approved: true,
      },
      { id: 'done', match: { kind: 'job.exited' }, level: 'context', createdBy: 'user', approved: true },
    ];
    const h = harness(false, configured, false, true);
    h.attention.create('a');
    await h.attention.preStep('a');
    const add = (id: string, exitCode: number) =>
      h.attention.accept({
        id,
        kind: 'job.exited',
        at: 0,
        subject: id,
        source: { id: 'dsh', api: 'events', host: 'local' },
        data: { id, sessionId: 'a', sessionToken: h.attention.sessionToken('a'), exitCode },
      });
    await add('success', 0);
    await h.attention.preStep('a');
    const first = structuredClone(h.delivered[0]);
    h.attention.postStep('a');
    await add('failure', 1);
    h.advance();
    expect(h.attention.pipeline.nextDeadline()).toBe(2_000);
    await h.attention.flush();
    expect(h.delivered.map((intent) => intent.kind)).toEqual(['inject', 'followup']);
    expect(h.delivered[0]).toEqual(first);
    expect(h.delivered[1]?.update.changes[0]?.signal.data.id).toBe('failure');
    await h.attention.stop();
  });

  it('keeps the budget downgrade when a normal job joins a parked summary', async () => {
    const configured: WatchRule[] = [
      {
        id: 'failed',
        match: { kind: 'job.exited', where: { exitCode: { '!=': 0 } } },
        level: 'wake',
        createdBy: 'user',
        approved: true,
      },
      { id: 'done', match: { kind: 'job.exited' }, level: 'context', createdBy: 'user', approved: true },
    ];
    const h = harness(false, configured, false);
    h.attention.create('a');
    await h.attention.preStep('a');
    h.attention.postStep('a');
    const add = (id: string, exitCode: number) =>
      h.attention.accept({
        id,
        kind: 'job.exited',
        at: 0,
        subject: id,
        source: { id: 'dsh', api: 'events', host: 'local' },
        data: { id, sessionId: 'a', sessionToken: h.attention.sessionToken('a'), exitCode },
      });
    await add('success', 0);
    h.advance();
    await h.attention.flush();
    await add('wake', 1);
    h.advance();
    await h.attention.flush();
    await add('suppressed', 1);
    h.advance();
    await h.attention.flush();
    await add('success-later', 0);
    await h.attention.preStep('a');
    const suppressed = h.delivered.find((intent) => intent.update.suppressed === 1);
    expect(suppressed?.update.changes[0]).toMatchObject({ count: 2, level: 'context', reason: 'wake-budget' });
    expect(h.attention.pipeline.suppressed).toBe(1);
    await h.attention.stop();
  });

  it('bounds new job summaries behind a failed immutable job delivery', async () => {
    let now = 0;
    let failing = true;
    const delivered: Parameters<DshPort['deliver']>[1][] = [];
    const clock: Clock = { wall: () => now, mono: () => now };
    const attention = new RuntimeAttention(
      clock,
      {
        deliver: async (_session: string, intent: Parameters<DshPort['deliver']>[1]) => {
          if (failing) throw new Error('fixture failure');
          delivered.push(intent);
        },
      } as DshPort,
      () => [{ id: 'jobs', match: { kind: 'job.exited' }, level: 'wake', createdBy: 'user', approved: true }],
      () => {},
      () => true,
      () => {},
      new FactExpiry(clock),
    );
    attention.create('a');
    attention.create('b');
    await attention.preStep('a');
    const add = (i: number) =>
      attention.accept({
        id: `event-${i}`,
        kind: 'job.exited',
        at: now,
        subject: `job-${i}`,
        source: { id: 'dsh', api: 'events', host: 'local' },
        data: { id: `job-${i}`, sessionId: 'a', sessionToken: attention.sessionToken('a'), exitCode: 1 },
      });
    await add(0);
    now += 2_000;
    await attention.flush().catch(() => {});
    for (let cycle = 0; cycle < 6; cycle++) {
      await attention.preStep('b');
      for (let i = 1; i <= 30; i++) await add(cycle * 30 + i);
      now += 3_000;
      await attention.preStep('a').catch(() => {});
    }
    const drain = (
      attention.pipeline as unknown as { drain: { pending: Map<number, { details: Map<string, { count: number }> }> } }
    ).drain;
    expect(drain.pending.size).toBeLessThanOrEqual(2);
    expect(
      [...drain.pending.values()].flatMap((bucket) => [...bucket.details.values()]).reduce((n, d) => n + d.count, 0),
    ).toBe(181);
    failing = false;
    await attention.preStep('a');
    await attention.flush();
    await attention.preStep('a');
    expect(delivered.flatMap((intent) => intent.update.changes).reduce((n, change) => n + change.count, 0)).toBe(181);
    await attention.stop();
  });

  it('bounds job context waiting for the next pre-step without scheduling a busy loop', async () => {
    const configured: WatchRule[] = [
      { id: 'jobs', match: { kind: 'job.exited' }, level: 'context', createdBy: 'user', approved: true },
    ];
    const h = harness(false, configured, false);
    h.attention.create('a');
    await h.attention.preStep('a');
    for (let i = 0; i < 50; i++) {
      await h.attention.accept({
        id: `event-${i}`,
        kind: 'job.exited',
        at: i,
        subject: `job-${i}`,
        source: { id: 'dsh', api: 'events', host: 'local' },
        data: { id: `job-${i}`, sessionId: 'a', sessionToken: h.attention.sessionToken('a'), exitCode: 0 },
      });
      h.advance();
      await h.attention.flush();
    }
    const drain = (
      h.attention.pipeline as unknown as { drain: { pending: Map<number, unknown>; ready: Map<string, unknown[]> } }
    ).drain;
    expect(drain.pending.size).toBe(1);
    expect(drain.ready.get('a')).toHaveLength(1);
    expect(h.attention.pipeline.nextDeadline()).toBeUndefined();
    await h.attention.preStep('a');
    expect(h.delivered.flatMap((intent) => intent.update.changes).reduce((n, change) => n + change.count, 0)).toBe(50);
    await h.attention.stop();
  });

  it('reschedules a blocked job summary after a staged job batch is committed', async () => {
    let now = 0;
    let scheduled = 0;
    let commit: (session: string, id: string) => void = () => {};
    const delivered: Parameters<DshPort['deliver']>[1][] = [];
    const clock: Clock = { wall: () => now, mono: () => now };
    const dsh = {
      onAgentEvent: () => () => {},
      onTool: () => () => {},
      onJob: () => () => {},
      tokenSnapshot: async () => undefined,
      deliver: async (_session: string, intent: Parameters<DshPort['deliver']>[1]) => {
        delivered.push(intent);
      },
      onDeliveryCommitted: (cb: (session: string, id: string) => void) => {
        commit = cb;
        return () => {};
      },
    };
    const attention = new RuntimeAttention(
      clock,
      dsh,
      () => [{ id: 'jobs', match: { kind: 'job.exited' }, level: 'context', createdBy: 'user', approved: true }],
      () => {
        scheduled++;
      },
      () => true,
      () => {},
      new FactExpiry(clock),
    );
    attention.create('a');
    await attention.preStep('a');
    const add = (id: string) =>
      attention.accept({
        id,
        kind: 'job.exited',
        at: now,
        subject: id,
        source: { id: 'dsh', api: 'events', host: 'local' },
        data: { id, sessionId: 'a', sessionToken: attention.sessionToken('a'), exitCode: 0 },
      });
    await add('first');
    await attention.preStep('a');
    await add('second');
    now += 2_000;
    expect(attention.pipeline.nextDeadline()).toBeUndefined();
    const before = scheduled;
    const id = delivered[0]?.deliveryId;
    if (!id) throw new Error('staged delivery missing');
    commit('a', `asi-sense:${id}`);
    await attention.pipeline.retarget('a');
    await Promise.resolve();
    expect(scheduled).toBeGreaterThan(before);
    expect(attention.pipeline.nextDeadline()).toBe(2_000);
    await attention.preStep('a');
    expect(delivered).toHaveLength(2);
    expect(delivered[1]?.update.changes[0]?.signal.subject).toBe('second');
    await attention.stop();
  });

  it('keeps staged private token buckets separate when ordinary context transfers', async () => {
    const configured = [
      ...rules,
      {
        id: 'body-warn',
        match: { kind: 'body.threshold' },
        level: 'context' as const,
        createdBy: 'user' as const,
        approved: true,
      },
    ];
    const h = harness(false, configured, false, true);
    h.attention.create('a');
    h.attention.create('b');
    await h.attention.preStep('a');
    await h.attention.accept({
      ...signal('private', 'body.threshold'),
      subject: 'context',
      data: { sessionId: 'a', sessionToken: h.attention.sessionToken('a'), severity: 'warn', value: 0.1 },
    });
    await h.attention.accept({ ...signal('ordinary', 'context'), subject: 'context' });
    await h.attention.preStep('a');
    await h.attention.preStep('b');
    const b = h.delivered.filter((item) => item.sessionId === 'b').flatMap((item) => item.update.changes);
    expect(b.map((change) => change.signal.id)).toEqual(['ordinary']);
    h.attention.dispose('a');
    h.attention.create('a');
    await h.attention.preStep('a');
    expect(
      h.delivered
        .filter((item) => item.sessionId === 'a')
        .flatMap((item) => item.update.changes)
        .filter((change) => change.signal.id === 'private'),
    ).toHaveLength(1);
    await h.attention.stop();
  });

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
