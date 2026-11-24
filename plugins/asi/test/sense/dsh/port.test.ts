import { Context } from '@deepseek-ai/cordis';
import AgentRegistry, { type Agent, agentEvents } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDshPort } from '../../../src/sense/host/dsh/port.ts';
import type { AgentEvent, JobEvent, ToolEvent } from '../../../src/sense/host/runtime/ports.ts';

async function fixture() {
  const ctx = new Context();
  onTestFinished(() => ctx.fiber.dispose());
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(AgentRegistry);
  const jobListeners = new Set<(event: unknown) => void>();
  ctx.provide('jobs', {
    list: () => [],
    events: {
      subscribe: (_filter: unknown, listener: (event: unknown) => void) => {
        jobListeners.add(listener);
        return () => jobListeners.delete(listener);
      },
    },
  });
  ctx.provide('sessions', { list: () => [] });
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
  return { ctx, agent, jobListeners, port: createDshPort(ctx) };
}

describe('DSH pure sensory port', () => {
  it('uses the real agent registry, preserves turn attribution across pre-step calls, and NEVER injects messages', async () => {
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
    const step = async (turn: number, stepNum: number, messages = [user]) =>
      events.waterfall('agent/pre-step', { turn, step: stepNum, messages, signal, modelSelection }, async () => ({
        kind: 'enter' as const,
        messages,
      }));
    const d1 = await step(1, 1);
    const d2 = await step(1, 2, []);
    const d3 = await step(2, 1, []);
    expect(d1).toEqual({ kind: 'enter', messages: [user] });
    expect(d2).toEqual({ kind: 'enter', messages: [] });
    expect(d3).toEqual({ kind: 'enter', messages: [] });
    expect(agent.send).not.toHaveBeenCalled();
    expect(agent.inject).not.toHaveBeenCalled();
    expect(agent.followup).not.toHaveBeenCalled();

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

  it('announces agents already registered before the subscription and cleans up on disposal', async () => {
    const { ctx, agent, port } = await fixture();
    const unregister = await ctx.agents.register(agent);
    const seen: AgentEvent[] = [];
    const off = port.onAgentEvent(async (event) => {
      seen.push(event);
    });
    onTestFinished(off);
    expect(seen).toEqual([{ type: 'created', sessionId: agent.id }]);
    await unregister();
    expect(seen).toEqual([
      { type: 'created', sessionId: agent.id },
      { type: 'disposed', sessionId: agent.id },
    ]);
  });

  it('maps tool pre-execute/result and correlates background job events', async () => {
    const { ctx, agent, jobListeners, port } = await fixture();
    const unregister = await ctx.agents.register(agent);
    onTestFinished(unregister);
    const tools: ToolEvent[] = [];
    const jobs: JobEvent[] = [];
    const offTool = port.onTool(async (e) => {
      tools.push(e);
    });
    const offJob = port.onJob(async (e) => {
      jobs.push(e);
    });
    onTestFinished(() => {
      offTool();
      offJob();
    });

    const exec = {
      agent,
      callId: 'tc-1',
      name: 'bash',
      arguments: { command: 'pnpm test', workdir: '/tmp/work' },
    };
    await (
      ctx as unknown as { waterfall(n: string, e: unknown, next: () => Promise<unknown>): Promise<unknown> }
    ).waterfall('tools/pre-execute', exec, async () => undefined);
    for (const listener of jobListeners) {
      listener({
        type: 'registered',
        job: {
          id: 'job-1',
          kind: 'bash',
          label: 'pnpm test',
          owner: agent.id,
          status: 'running',
          startedAt: 100,
        },
      });
      listener({
        type: 'settled',
        awaited: true,
        job: {
          id: 'job-1',
          kind: 'bash',
          label: 'pnpm test',
          owner: agent.id,
          status: 'completed',
          detail: 'exit code: 0',
          startedAt: 100,
          finishedAt: 200,
        },
      });
    }
    (ctx as unknown as { emit(n: string, ...args: unknown[]): void }).emit('tools/result', exec, {
      value: { kind: 'foreground', exitCode: 1, cwd: '/tmp/work' },
    });
    expect(tools).toEqual([
      { type: 'pre-execute', sessionId: agent.id, toolCallId: 'tc-1', command: 'pnpm test', cwd: '/tmp/work' },
      {
        type: 'post-execute',
        sessionId: agent.id,
        toolCallId: 'tc-1',
        command: 'pnpm test',
        cwd: '/tmp/work',
        exitCode: 1,
      },
    ]);
    expect(jobs).toEqual([
      { type: 'started', id: 'job-1', command: 'pnpm test', at: 100, sessionId: agent.id },
      { type: 'exited', id: 'job-1', command: 'pnpm test', at: 200, sessionId: agent.id, cwd: '/tmp/work' },
    ]);
  });
});
