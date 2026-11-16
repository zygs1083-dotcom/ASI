import { Context } from '@deepseek-ai/cordis';
import AgentRegistry, { type Agent, agentEvents } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDshPort } from '../../src/host/dsh/port.ts';
import { projectEvents } from '../../src/host/presenter/project.ts';
import { RuntimeAttention } from '../../src/host/runtime/attention.ts';
import { FactExpiry } from '../../src/host/runtime/expiry.ts';
import { PendingContext } from '../../src/host/runtime/pending-context.ts';
import type { AgentEvent } from '../../src/host/runtime/ports.ts';
import { createSessionTarget } from '../../src/host/runtime/session-target.ts';

const update = {
  since: 0,
  at: 0,
  changes: [
    {
      signal: {
        id: 'signal',
        kind: 'app.activated',
        at: 0,
        source: { id: 'fixture', api: 'fixture', host: 'local' },
        subject: 'fixture',
        data: { name: 'Fixture' },
      },
      count: 1,
      level: 'context' as const,
    },
  ],
  suppressed: 0,
};
const sample = update.changes[0]?.signal;
if (!sample) throw new Error('missing fixture signal');

async function fixture() {
  const ctx = new Context();
  onTestFinished(() => ctx.fiber.dispose());
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(AgentRegistry);
  const id = SessionId('synthetic-session');
  const agent: Agent = {
    id,
    ctx,
    session: Session.create(id),
    options: {},
    model: { current: () => undefined, select: () => {} },
    inbox: {
      nextTurn: [],
      nextStep: [],
      clear: () => {},
      append: () => {},
      prepend: () => {},
      replace: () => false,
      remove: () => false,
      splice: () => [],
    },
    status: 'idle',
    cancel: () => {},
    whenIdle: async () => {},
    runMaintenance: (task) => task(new AbortController().signal),
    send: vi.fn(),
    inject: vi.fn(),
    followup: vi.fn(),
    steer: vi.fn(),
  };
  return { ctx, agent, port: createDshPort(ctx, () => false) };
}

describe('DSH agent port', () => {
  it('uses the real agent registry and preserves turn attribution across pre-step calls', async () => {
    const { ctx, agent, port } = await fixture();
    const seen: AgentEvent[] = [];
    const off = port.onAgentEvent(async (event) => {
      seen.push(event);
    });
    const unregister = await ctx.agents.register(agent);
    onTestFinished(async () => {
      off();
      await unregister();
    });
    expect(seen).toEqual([{ type: 'created', sessionId: agent.id }]);
    const events = agentEvents(ctx, agent);
    const signal = new AbortController().signal;
    const modelSelection = { provider: 'fixture', model: 'fixture' };
    const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'fixture' }] });
    const step = async (turn: number, step: number, messages = [user]) =>
      events.waterfall('agent/pre-step', { turn, step, messages, signal, modelSelection }, async () => ({
        kind: 'enter' as const,
        messages,
      }));
    await step(1, 1);
    await step(1, 2, []);
    await step(2, 1, []);
    events.emit('agent/status', { status: 'idle' });
    expect(seen).toEqual([
      { type: 'created', sessionId: agent.id },
      { type: 'pre-step', sessionId: agent.id, userInitiated: true },
      { type: 'pre-step', sessionId: agent.id, userInitiated: true },
      { type: 'pre-step', sessionId: agent.id, userInitiated: false },
      { type: 'post-step', sessionId: agent.id },
    ]);
    off();
    await unregister();
    expect(seen).toHaveLength(5);
  });

  it('announces agents already registered before the subscription', async () => {
    const { ctx, agent, port } = await fixture();
    const unregister = await ctx.agents.register(agent);
    onTestFinished(unregister);
    const seen: AgentEvent[] = [];
    const off = port.onAgentEvent(async (event) => {
      seen.push(event);
    });
    onTestFinished(off);
    expect(seen).toEqual([{ type: 'created', sessionId: agent.id }]);
  });

  it('adds context to the claimed step and reconstructs it without another inbox entry', async () => {
    const { ctx, agent, port } = await fixture();
    const unregister = await ctx.agents.register(agent);
    onTestFinished(unregister);
    const off = port.onAgentEvent(async (event) => {
      if (event.type === 'pre-step') {
        await port.deliver(event.sessionId, { kind: 'inject', sessionId: event.sessionId, deliveryId: 'a', update });
      }
    });
    onTestFinished(off);
    const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'fixture' }] });
    const result = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      {
        turn: 1,
        step: 1,
        messages: [user],
        signal: new AbortController().signal,
        modelSelection: { provider: 'fixture', model: 'fixture' },
      },
      async () => ({ kind: 'enter' as const, messages: [user] }),
    );
    expect(result.kind).toBe('enter');
    if (result.kind !== 'enter') throw new Error('expected an entered step');
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toMatchObject({ source: { kind: 'environment' } });
    expect(agent.inject).not.toHaveBeenCalled();
    agent.session.append('turn/start', { turn: 1 });
    agent.session.append('step/start', { turn: 1, step: 1 });
    for (const message of result.messages) agent.session.append('user/message', message, { surfaceOp: 'append' });
    const events = agent.session.snapshotEvents();
    expect(events.filter((event) => event.type === 'step/start')).toHaveLength(1);
    expect(Session.create(agent.id, events, agent.session.header).deriveMessages()).toEqual(result.messages);
  });

  it('does not enqueue twice after a message is accepted, claimed and the call throws', async () => {
    const { ctx, agent, port } = await fixture();
    const unregister = await ctx.agents.register(agent);
    onTestFinished(unregister);
    const send = vi.mocked(agent.followup);
    send.mockImplementation((message) => {
      agent.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] });
      agent.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
      throw new Error('after acceptance');
    });
    const intent = { kind: 'followup' as const, sessionId: agent.id, deliveryId: 'wake-a', update };
    await port.deliver(agent.id, intent);
    await port.deliver(agent.id, intent);
    const reloaded = createDshPort(ctx, () => false);
    await reloaded.deliver(agent.id, intent);
    expect(send).toHaveBeenCalledTimes(1);
    const fresh = await fixture();
    const restored = {
      ...fresh.agent,
      session: Session.create(agent.id, agent.session.snapshotEvents(), agent.session.header),
    };
    const unregisterRestored = await fresh.ctx.agents.register(restored);
    onTestFinished(unregisterRestored);
    await fresh.port.deliver(restored.id, intent);
    expect(restored.followup).not.toHaveBeenCalled();
  });

  it('retains staged context if cancellation prevents admission, then admits it on the next step', async () => {
    const { ctx, agent, port } = await fixture();
    const unregister = await ctx.agents.register(agent);
    onTestFinished(unregister);
    const controller = new AbortController();
    let first = true;
    const off = port.onAgentEvent(async (event) => {
      if (event.type !== 'pre-step') return;
      await port.deliver(event.sessionId, { kind: 'inject', sessionId: event.sessionId, deliveryId: 'a', update });
      if (first) {
        first = false;
        controller.abort();
      }
    });
    onTestFinished(off);
    const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'fixture' }] });
    const run = (signal: AbortSignal) =>
      agentEvents(ctx, agent).waterfall(
        'agent/pre-step',
        { turn: 1, step: 1, messages: [user], signal, modelSelection: { provider: 'fixture', model: 'fixture' } },
        async () => ({ kind: 'enter' as const, messages: [user] }),
      );
    expect(await run(controller.signal)).toMatchObject({ messages: [user] });
    const next = await run(new AbortController().signal);
    expect(next.kind === 'enter' && next.messages).toHaveLength(2);
    expect(agent.inject).not.toHaveBeenCalled();
  });

  it('does not discard a newer pre-step staging for the same session', async () => {
    const { ctx, agent, port } = await fixture();
    const unregister = await ctx.agents.register(agent);
    onTestFinished(unregister);
    let releaseFirst = () => {};
    let releaseSecond = () => {};
    let enteredFirst = () => {};
    let enteredSecond = () => {};
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const secondEntered = new Promise<void>((resolve) => {
      enteredSecond = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    onTestFinished(() => {
      releaseFirst();
      releaseSecond();
    });
    let calls = 0;
    const off = port.onAgentEvent(async (event) => {
      if (event.type !== 'pre-step') return;
      await port.deliver(event.sessionId, { kind: 'inject', sessionId: event.sessionId, deliveryId: 'a', update });
      if (++calls === 1) {
        enteredFirst();
        await firstGate;
      } else {
        enteredSecond();
        await secondGate;
      }
    });
    onTestFinished(off);
    const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'fixture' }] });
    const step = () =>
      agentEvents(ctx, agent).waterfall(
        'agent/pre-step',
        {
          turn: 1,
          step: 1,
          messages: [user],
          signal: new AbortController().signal,
          modelSelection: { provider: 'x', model: 'x' },
        },
        async () => ({ kind: 'enter' as const, messages: [user] }),
      );
    const first = step();
    await firstEntered;
    const second = step();
    await secondEntered;
    releaseFirst();
    expect(await first).toMatchObject({ messages: [user] });
    releaseSecond();
    const result = await second;
    expect(result.kind === 'enter' && result.messages).toHaveLength(2);
  });
});

describe('uncommitted context routing', () => {
  it.each(['owner', 'unowned-waiting', 'unowned-started', 'unowned-aborted'] as const)(
    'preserves the owner and routes %s correctly when a pinned target restores during injection',
    async (scenario) => {
      const { ctx, agent: a, port } = await fixture();
      const bId = SessionId('synthetic-session-b');
      const b = { ...a, id: bId, session: Session.create(bId), send: vi.fn(), followup: vi.fn() };
      let now = 0;
      let releaseInject = () => {};
      let injectEntered = () => {};
      let releaseRestore = () => {};
      const injecting = new Promise<void>((resolve) => {
        injectEntered = resolve;
      });
      const injectGate = new Promise<void>((resolve) => {
        releaseInject = resolve;
      });
      const restoreGate = new Promise<void>((resolve) => {
        releaseRestore = resolve;
      });
      let holdInject = false;
      let restoring = false;
      let steppedB = false;
      const wrapped = {
        ...port,
        deliver: async (...args: Parameters<typeof port.deliver>) => {
          await port.deliver(...args);
          const kind =
            scenario === 'unowned-started' || scenario === 'unowned-aborted' ? 'app.activated' : 'job.started';
          if (
            holdInject &&
            args[0] === a.id &&
            args[1].kind === 'inject' &&
            args[1].update.changes.some((change) => change.signal.kind === kind)
          ) {
            injectEntered();
            await injectGate;
          }
        },
      };
      const clock = { wall: () => now, mono: () => now };
      const attention = new RuntimeAttention(
        clock,
        wrapped,
        () => [
          { id: 'start', match: { kind: 'job.started' }, level: 'context', createdBy: 'user', approved: true },
          { id: 'exit', match: { kind: 'job.exited' }, level: 'wake', createdBy: 'user', approved: true },
          { id: 'app', match: { kind: 'app.activated' }, level: 'context', createdBy: 'user', approved: true },
        ],
        () => {},
        () => true,
        () => {},
        new FactExpiry(clock),
        () => target.ensure(),
        () => target.canEnsure(),
      );
      let unregisterB = await ctx.agents.register(b);
      const unregisterA = await ctx.agents.register(a);
      const target = createSessionTarget(
        {
          listSessions: async () => [a, b].map((agent) => ({ id: agent.id, title: '', updatedAt: 0, running: false })),
          ensureSession: async () => {
            if (!restoring) return;
            await restoreGate;
            unregisterB = await ctx.agents.register(b);
          },
        },
        { load: async () => undefined, save: async () => {} },
        'target-fixture',
        async (id) => {
          const transfer = attention.setTarget(id);
          port.selectDeliveryTarget?.(attention.current());
          await transfer;
        },
        () => {},
        () => {},
      );
      const off = port.onAgentEvent(async (event) => {
        if (event.type === 'created') attention.create(event.sessionId);
        if (event.type === 'disposed') {
          attention.dispose(event.sessionId);
          target.unload(event.sessionId);
        }
        if (event.type === 'pre-step') {
          if (event.sessionId === b.id) steppedB = true;
          await attention.preStep(event.sessionId, event.userInitiated);
        }
      });
      onTestFinished(async () => {
        releaseInject();
        releaseRestore();
        off();
        await target.stop();
        await attention.stop();
        await unregisterA();
        await unregisterB();
      });
      await target.start();
      await attention.preStep(a.id);
      attention.postStep(a.id);
      await target.select(b.id);
      restoring = true;
      await unregisterB();
      const owner = { sessionId: a.id, sessionToken: attention.sessionToken(a.id), id: 'fixture-job', exitCode: 1 };
      for (const kind of ['job.started', 'job.exited']) {
        await attention.accept({
          id: kind,
          kind,
          at: now,
          source: { id: 'dsh', api: 'events', host: 'local' },
          subject: 'fixture-job',
          data: owner,
        });
      }
      if (scenario !== 'owner') {
        await attention.accept({
          ...sample,
          id: 'unowned',
          data: { name: 'FixtureOrdinary' },
        });
      }
      now += 2_000;
      await attention.flush();
      expect(a.followup).toHaveBeenCalledTimes(1);
      const wake = vi.mocked(a.followup).mock.calls[0]?.[0];
      if (!wake) throw new Error('missing owner wake');
      holdInject = true;
      const step = (agent: Agent, messages: (typeof wake)[], controller = new AbortController()) =>
        agentEvents(ctx, agent).waterfall(
          'agent/pre-step',
          {
            turn: 1,
            step: 1,
            messages,
            signal: controller.signal,
            modelSelection: { provider: 'fixture', model: 'fixture' },
          },
          async () => ({ kind: 'enter' as const, messages }),
        );
      const controller = new AbortController();
      const pending = step(a, [wake], controller);
      await injecting;
      releaseRestore();
      await vi.waitFor(() => expect(attention.current()).toBe(b.id));
      const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'fixture' }] });
      const pendingB = step(b, [user]);
      await vi.waitFor(() => expect(steppedB).toBe(true));
      if (scenario === 'unowned-aborted') controller.abort();
      releaseInject();
      const result = await pending;
      expect(result.kind).toBe('enter');
      if (result.kind !== 'enter') throw new Error('expected an entered step');
      const text = JSON.stringify(result.messages);
      expect(text.match(/`fixture-job` started/g) ?? []).toHaveLength(scenario === 'unowned-aborted' ? 0 : 1);
      expect(JSON.stringify(result.messages).match(/`fixture-job` exited/g)).toHaveLength(1);
      expect(text.match(/FixtureOrdinary/g) ?? []).toHaveLength(scenario === 'unowned-started' ? 1 : 0);
      const next = await pendingB;
      expect(next.kind).toBe('enter');
      if (next.kind !== 'enter') throw new Error('expected an entered step');
      const bText = JSON.stringify(next.messages);
      expect(bText).not.toContain('fixture-job');
      expect(bText.match(/FixtureOrdinary/g) ?? []).toHaveLength(
        scenario === 'unowned-waiting' || scenario === 'unowned-aborted' ? 1 : 0,
      );
      if (scenario !== 'unowned-aborted') {
        holdInject = false;
        const beforeCommit = await step(a, [user]);
        expect(beforeCommit.kind).toBe('enter');
        if (beforeCommit.kind !== 'enter') throw new Error('expected an entered step');
        expect(JSON.stringify(beforeCommit.messages)).not.toContain('fixture-job');
        expect(JSON.stringify(beforeCommit.messages)).not.toContain('FixtureOrdinary');
      }
      for (const message of result.messages.slice(1)) {
        const event = a.session.append('user/message', message, { surfaceOp: 'append' });
        ctx.emit('session/event', a.session, event);
      }
      for (const message of next.messages.slice(1)) {
        const event = b.session.append('user/message', message, { surfaceOp: 'append' });
        ctx.emit('session/event', b.session, event);
      }
      holdInject = false;
      const later = await step(a, [user]);
      expect(later.kind).toBe('enter');
      if (later.kind !== 'enter') throw new Error('expected an entered step');
      const laterText = JSON.stringify(later.messages);
      expect(laterText.match(/`fixture-job` started/g) ?? []).toHaveLength(scenario === 'unowned-aborted' ? 1 : 0);
      expect(laterText).not.toContain('FixtureOrdinary');
      const finalB = await step(b, [user]);
      expect(finalB.kind).toBe('enter');
      if (finalB.kind !== 'enter') throw new Error('expected an entered step');
      expect(JSON.stringify(finalB.messages)).not.toContain('fixture-job');
      expect(JSON.stringify(finalB.messages)).not.toContain('FixtureOrdinary');
      expect(a.followup).toHaveBeenCalledTimes(1);
      expect(b.followup).not.toHaveBeenCalled();
      expect(b.send).not.toHaveBeenCalled();
    },
  );

  async function routing(wake = false, offline = 0, ownedContext = false) {
    const { ctx, agent: a, port } = await fixture();
    const bId = SessionId('synthetic-session-b');
    const b = { ...a, id: bId, session: Session.create(bId), send: vi.fn(), followup: vi.fn() };
    let now = 1000;
    const clock = { wall: () => now, mono: () => now };
    const changed = vi.fn();
    const attention = new RuntimeAttention(
      clock,
      port,
      () => [
        { id: 'ctx', match: { kind: 'app.activated' }, level: 'context', createdBy: 'user', approved: true },
        {
          id: 'wake',
          match: { kind: 'job.exited' },
          level: ownedContext ? 'context' : 'wake',
          createdBy: 'user',
          approved: true,
        },
        { id: 'wake2', match: { kind: 'job.failed' }, level: 'wake', createdBy: 'user', approved: true },
      ],
      () => {},
      () => true,
      changed,
      new FactExpiry(clock),
    );
    let abort: AbortController | undefined;
    const off = port.onAgentEvent(async (event) => {
      if (event.type === 'created') attention.create(event.sessionId);
      if (event.type === 'disposed') attention.dispose(event.sessionId);
      if (event.type === 'pre-step') {
        await attention.preStep(event.sessionId);
        abort?.abort();
        abort = undefined;
      }
    });
    for (let i = 1; i <= offline; i++) await attention.accept({ ...sample, id: `offline-${i}` });
    const unregisterA = await ctx.agents.register(a);
    const unregisterB = await ctx.agents.register(b);
    onTestFinished(async () => {
      off();
      await attention.stop();
      await unregisterA();
      await unregisterB();
    });
    const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'fixture' }] });
    const step = async (agent: Agent, controller = new AbortController(), userInitiated = true) => {
      const decision = await agentEvents(ctx, agent).waterfall(
        'agent/pre-step',
        {
          turn: 1,
          step: 1,
          messages: userInitiated ? [user] : [],
          signal: controller.signal,
          modelSelection: { provider: 'x', model: 'x' },
        },
        async () => ({ kind: 'enter' as const, messages: [user] }),
      );
      if (decision.kind !== 'enter') throw new Error('expected an entered step');
      return decision;
    };
    const initial = await step(a);
    if (!wake) await attention.accept(sample);
    return {
      ctx,
      a,
      b,
      attention,
      changed,
      step,
      initial,
      advance: (ms: number) => {
        now += ms;
      },
      cancel: async (agent: Agent = a) => {
        const controller = new AbortController();
        abort = controller;
        return step(agent, controller, false);
      },
      unregisterA,
    };
  }

  it('moves an aborted staged context to the next session without later duplication', async () => {
    const h = await routing();
    expect((await h.cancel()).messages).toHaveLength(1);
    const decision = await h.step(h.b);
    expect(decision.messages).toHaveLength(2);
    const message = decision.messages[1];
    if (!message) throw new Error('missing context message');
    const event = h.b.session.append('user/message', message, { surfaceOp: 'append' });
    h.ctx.emit('session/event', h.b.session, event);
    expect((await h.step(h.a)).messages).toHaveLength(1);
  });

  it.each([false, true])('keeps a cancelled owned job context private after owner disposal=%s', async (dispose) => {
    const h = await routing(true, 0, true);
    await h.attention.accept({
      ...sample,
      id: 'owned-job',
      kind: 'job.exited',
      subject: 'fixture-command',
      source: { id: 'dsh', api: 'events', host: 'local' },
      data: {
        id: 'owned-job',
        sessionId: h.a.id,
        sessionToken: h.attention.sessionToken(h.a.id),
        command: 'fixture-command',
        exitCode: 0,
      },
    });
    expect((await h.cancel()).messages).toHaveLength(1);
    if (dispose) await h.unregisterA();
    expect((await h.step(h.b)).messages).toHaveLength(1);
    if (!dispose) {
      const decision = await h.step(h.a);
      expect(decision.messages).toHaveLength(2);
      const message = decision.messages[1];
      if (!message) throw new Error('missing job context');
      expect(JSON.stringify(message)).toContain('owned-job');
      const event = h.a.session.append('user/message', message, { surfaceOp: 'append' });
      h.ctx.emit('session/event', h.a.session, event);
      expect((await h.step(h.a)).messages).toHaveLength(1);
    }
    expect(h.attention.events().some((item) => item.id === 'owned-job')).toBe(true);
  });

  it('retains an aborted staged context when its session is disposed', async () => {
    const h = await routing();
    expect((await h.cancel()).messages).toHaveLength(1);
    await h.unregisterA();
    expect((await h.step(h.b)).messages).toHaveLength(2);
  });

  it('removes a committed staged batch even when disposal races its confirmation', async () => {
    const h = await routing();
    const result = await h.step(h.a);
    expect(result.messages).toHaveLength(2);
    await h.unregisterA();
    const message = result.messages[1];
    if (!message) throw new Error('missing context message');
    expect(h.attention.events().find((item) => item.id === sample.id)?.level).toBe('record');
    const event = h.a.session.append('user/message', message, { surfaceOp: 'append' });
    h.ctx.emit('session/event', h.a.session, event);
    expect(h.attention.events().find((item) => item.id === sample.id)?.level).toBe('context');
    expect((await h.step(h.b)).messages).toHaveLength(1);
  });

  it('keeps multiple unconfirmed batches of the same subject after disposal', async () => {
    const h = await routing();
    await h.cancel();
    for (let i = 1; i < 19; i++) {
      await h.attention.accept({ ...sample, id: `signal-${i}`, at: i });
      await h.cancel();
    }
    await h.unregisterA();
    expect((await h.step(h.b)).messages).toHaveLength(20);
  });

  it('shares the 200-subject no-session limit with disposed staged batches', async () => {
    const h = await routing();
    for (let i = 0; i < 200; i++) {
      await h.attention.accept({ ...sample, id: `signal-${i}`, subject: `fixture-${i}` });
    }
    await h.cancel();
    await h.unregisterA();
    expect((await h.step(h.b)).messages).toHaveLength(201);
  });

  it.each([false, true])(
    'rechecks a cancelled budget downgrade for the target session after dispose=%s',
    async (dispose) => {
      const h = await routing(true);
      const wake = (id: string) => ({ ...sample, id, kind: 'job.exited', subject: id });
      h.attention.postStep(h.a.id);
      await h.attention.accept(wake('first'));
      h.advance(2000);
      await h.attention.flush();
      expect(h.a.followup).toHaveBeenCalledTimes(1);
      await h.attention.accept(wake('second'));
      h.advance(2000);
      await h.attention.flush();
      expect(h.attention.pipeline.suppressed).toBe(1);
      expect((await h.cancel()).messages).toHaveLength(1);
      if (dispose) await h.unregisterA();
      const next = await h.step(h.b, undefined, false);
      expect(next.messages).toHaveLength(1);
      expect(h.b.send).toHaveBeenCalledTimes(1);
      expect(h.attention.events().find((entry) => entry.id === 'second')).toMatchObject({ reason: 'agent-busy' });
      expect(h.attention.pipeline.suppressed).toBe(0);
      await h.attention.accept(wake('third'));
      h.advance(2000);
      await h.attention.flush();
      expect(h.attention.pipeline.suppressed).toBe(1);
      expect((await h.step(h.b, undefined, false)).messages).toHaveLength(2);
    },
  );

  it('records confirmed inject outcomes, not cancelled or transferred attempts', async () => {
    const h = await routing(true);
    const wake = (id: string) => ({ ...sample, id, kind: 'job.exited', subject: id });
    const projected = (id: string) =>
      projectEvents(
        h.attention.events(),
        true,
        (at) => at,
        (at) => at,
      ).find((event) => event.signal.id === id);
    const commit = (agent: Agent, message: Awaited<ReturnType<typeof h.step>>['messages'][number] | undefined) => {
      if (!message) throw new Error('missing staged message');
      const event = agent.session.append('user/message', message, { surfaceOp: 'append' });
      h.ctx.emit('session/event', agent.session, event);
    };
    h.attention.postStep(h.a.id);
    await h.attention.accept(wake('first'));
    h.advance(2000);
    await h.attention.flush();
    await h.attention.accept(wake('suppressed'));
    await h.attention.accept({ ...wake('suppressed-merged'), subject: 'suppressed' });
    h.advance(2000);
    await h.attention.flush();
    expect((await h.cancel()).messages).toHaveLength(1);
    expect(projected('suppressed')).toMatchObject({ level: 'record', reason: '' });
    const staged = await h.step(h.a, undefined, false);
    expect(projected('suppressed')).toMatchObject({ level: 'record', reason: '' });
    h.changed.mockClear();
    commit(h.a, staged.messages[1]);
    expect(projected('suppressed')).toMatchObject({ level: 'suppressed', reason: 'wake-budget' });
    expect(projected('suppressed-merged')).toMatchObject({ level: 'suppressed', reason: 'wake-budget' });
    expect(h.changed).toHaveBeenCalled();

    await h.attention.accept({ ...sample, id: 'context' });
    await h.attention.accept({ ...sample, id: 'context-merged' });
    expect(projected('context')?.level).not.toBe('context');
    expect(projected('context-merged')?.level).not.toBe('context');
    expect((await h.cancel()).messages).toHaveLength(1);
    expect(projected('context')?.level).not.toBe('context');
    const transferred = await h.step(h.b, undefined, false);
    expect(projected('context')?.level).not.toBe('context');
    h.changed.mockClear();
    commit(h.b, transferred.messages[1]);
    expect(projected('context')).toMatchObject({ level: 'context' });
    expect(projected('context-merged')).toMatchObject({ level: 'context' });
    expect(h.changed).toHaveBeenCalled();
  });

  it('confirms a transferred wake against an already-spent target budget', async () => {
    const h = await routing(true);
    const wake = (id: string) => ({ ...sample, id, kind: 'job.exited', subject: id });
    await h.step(h.b, undefined, false);
    h.attention.postStep(h.b.id);
    await h.attention.accept(wake('budget-b'));
    h.advance(2000);
    await h.attention.flush();
    await h.step(h.a, undefined, false);
    h.attention.postStep(h.a.id);
    await h.attention.accept(wake('budget-a'));
    h.advance(2000);
    await h.attention.flush();
    await h.attention.accept(wake('transferred'));
    h.advance(2000);
    await h.attention.flush();
    await h.cancel();
    await h.unregisterA();
    const staged = await h.step(h.b, undefined, false);
    expect(staged.messages).toHaveLength(2);
    expect(h.attention.pipeline.suppressed).toBe(1);
    expect(h.attention.events().find((entry) => entry.id === 'transferred')).toMatchObject({ level: 'record' });
    h.changed.mockClear();
    const message = staged.messages[1];
    if (!message) throw new Error('missing staged message');
    const event = h.b.session.append('user/message', message, { surfaceOp: 'append' });
    h.ctx.emit('session/event', h.b.session, event);
    const projected = projectEvents(
      h.attention.events(),
      true,
      (at) => at,
      (at) => at,
    );
    expect(projected.find((item) => item.signal.id === 'transferred')).toMatchObject({
      level: 'suppressed',
      reason: 'wake-budget',
    });
    expect(h.changed).toHaveBeenCalled();
  });

  it('restores all kinds of a budget-suppressed group as one target wake', async () => {
    const h = await routing(true);
    h.attention.postStep(h.a.id);
    await h.attention.accept({ ...sample, id: 'first', kind: 'job.exited' });
    h.advance(2000);
    await h.attention.flush();
    await h.attention.accept({ ...sample, id: 'second', kind: 'job.exited', subject: 'group' });
    await h.attention.accept({ ...sample, id: 'third', kind: 'job.failed', subject: 'group' });
    h.advance(2000);
    await h.attention.flush();
    expect(h.attention.pipeline.suppressed).toBe(1);
    await h.cancel();
    await h.unregisterA();
    await h.step(h.b, undefined, false);
    expect(h.b.send).toHaveBeenCalledTimes(1);
    const message = vi.mocked(h.b.send).mock.calls[0]?.[0];
    expect(JSON.stringify(message)).toContain('job: `job` exited');
    expect(JSON.stringify(message)).toContain('job.failed');
    expect(h.attention.pipeline.suppressed).toBe(0);
  });

  it('keeps the budget downgrade when a disposed session is restored under the same id', async () => {
    const h = await routing(true);
    h.attention.postStep(h.a.id);
    await h.attention.accept({ ...sample, id: 'first', kind: 'job.exited' });
    h.advance(2000);
    await h.attention.flush();
    await h.attention.accept({ ...sample, id: 'second', kind: 'job.exited' });
    h.advance(2000);
    await h.attention.flush();
    await h.cancel();
    await h.unregisterA();
    const unregister = await h.ctx.agents.register(h.a);
    onTestFinished(unregister);
    const result = await h.step(h.a, undefined, false);
    expect(result.messages).toHaveLength(2);
    expect(h.a.followup).toHaveBeenCalledTimes(1);
    expect(h.a.send).not.toHaveBeenCalled();
    expect(h.attention.pipeline.suppressed).toBe(1);
    const message = result.messages[1];
    if (!message) throw new Error('missing staged message');
    const event = h.a.session.append('user/message', message, { surfaceOp: 'append' });
    h.ctx.emit('session/event', h.a.session, event);
    expect(h.attention.events().find((item) => item.id === 'second')).toMatchObject({ reason: 'wake-budget' });
  });

  it('confirms every retained no-session context event in a merged inject', async () => {
    const h = await routing(true, 2);
    for (const id of ['offline-1', 'offline-2']) {
      expect(h.attention.events().find((item) => item.id === id)?.level).toBe('record');
    }
    const message = h.initial.messages[1];
    if (!message) throw new Error('missing staged message');
    const event = h.a.session.append('user/message', message, { surfaceOp: 'append' });
    h.ctx.emit('session/event', h.a.session, event);
    for (const id of ['offline-1', 'offline-2']) {
      expect(h.attention.events().find((item) => item.id === id)?.level).toBe('context');
    }
  });

  it('bounds retained merged identities to the 200 visible events', async () => {
    const h = await routing(true, 205);
    expect(h.attention.events()).toHaveLength(200);
    const message = h.initial.messages[1];
    if (!message) throw new Error('missing staged message');
    const event = h.a.session.append('user/message', message, { surfaceOp: 'append' });
    h.ctx.emit('session/event', h.a.session, event);
    expect(h.attention.events().every((item) => item.level === 'context')).toBe(true);
  });

  it('retains an outstanding outcome across more than 1024 unconfirmed transfers', async () => {
    const h = await routing(true);
    const mark = vi.fn();
    const pending = new PendingContext(mark);
    for (let i = 0; i < 1025; i++) {
      pending.stage({ kind: 'inject', sessionId: `session-${i}`, deliveryId: `delivery-${i}`, update });
    }
    pending.committed('session-0', 'asi-sense:delivery-0', h.attention.pipeline);
    expect(mark).toHaveBeenCalledWith('signal', undefined, 'context');
    mark.mockClear();
    pending.forget('signal');
    pending.committed('session-1', 'asi-sense:delivery-1', h.attention.pipeline);
    expect(mark).not.toHaveBeenCalled();
  });
});
