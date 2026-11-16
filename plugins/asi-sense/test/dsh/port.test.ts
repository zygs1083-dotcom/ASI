import { Context } from '@deepseek-ai/cordis';
import AgentRegistry, { type Agent, agentEvents } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDshPort } from '../../src/host/dsh/port.ts';
import { RuntimeAttention } from '../../src/host/runtime/attention.ts';
import { FactExpiry } from '../../src/host/runtime/expiry.ts';
import type { AgentEvent } from '../../src/host/runtime/ports.ts';

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
  async function routing() {
    const { ctx, agent: a, port } = await fixture();
    const bId = SessionId('synthetic-session-b');
    const b = { ...a, id: bId, session: Session.create(bId) };
    const clock = { wall: () => 1000, mono: () => 1000 };
    const attention = new RuntimeAttention(
      clock,
      port,
      () => [{ id: 'ctx', match: { kind: 'app.activated' }, level: 'context', createdBy: 'user', approved: true }],
      () => {},
      () => true,
      () => {},
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
    const unregisterA = await ctx.agents.register(a);
    const unregisterB = await ctx.agents.register(b);
    onTestFinished(async () => {
      off();
      await attention.stop();
      await unregisterA();
      await unregisterB();
    });
    const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'fixture' }] });
    const step = async (agent: Agent, controller = new AbortController()) => {
      const decision = await agentEvents(ctx, agent).waterfall(
        'agent/pre-step',
        {
          turn: 1,
          step: 1,
          messages: [user],
          signal: controller.signal,
          modelSelection: { provider: 'x', model: 'x' },
        },
        async () => ({ kind: 'enter' as const, messages: [user] }),
      );
      if (decision.kind !== 'enter') throw new Error('expected an entered step');
      return decision;
    };
    await step(a);
    await attention.accept(sample);
    return {
      ctx,
      a,
      b,
      attention,
      step,
      cancel: async () => {
        const controller = new AbortController();
        abort = controller;
        return step(a, controller);
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
    const event = h.a.session.append('user/message', message, { surfaceOp: 'append' });
    h.ctx.emit('session/event', h.a.session, event);
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
});
