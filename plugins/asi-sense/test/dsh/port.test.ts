import { Context } from '@deepseek-ai/cordis';
import AgentRegistry, { type Agent, agentEvents } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDshPort } from '../../src/host/dsh/port.ts';
import type { AgentEvent } from '../../src/host/runtime/ports.ts';

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
});
