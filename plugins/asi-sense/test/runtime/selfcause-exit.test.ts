import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSenseRuntime } from '../../src/host/runtime/index.ts';
import type {
  AgentEvent,
  DshPort,
  JobEvent,
  SenseOptions,
  SensePorts,
  ToolEvent,
} from '../../src/host/runtime/ports.ts';

afterEach(() => vi.useRealTimers());

function harness(options: SenseOptions = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  let mono = 0;
  let agent: (event: AgentEvent) => Promise<void> = async () => {};
  let tool: (event: ToolEvent) => Promise<void> = async () => {};
  let job: (event: JobEvent) => Promise<void> = async () => {};
  const delivered: Parameters<DshPort['deliver']>[1][] = [];
  const ports: SensePorts = {
    clock: { wall: () => Date.now(), mono: () => mono },
    dsh: {
      onAgentEvent: (cb) => {
        agent = cb;
        return () => {};
      },
      onTool: (cb) => {
        tool = cb;
        return () => {};
      },
      onJob: (cb) => {
        job = cb;
        return () => {};
      },
      deliver: async (_session, intent) => {
        delivered.push(intent);
      },
      tokenSnapshot: async () => undefined,
    },
    storage: { load: async () => undefined, save: async () => {} },
    helper: { spawn: () => undefined },
    probe: { create: () => ({ onSample: () => () => {}, start: () => {}, stop: async () => {} }) },
    files: { watch: () => ({ close: () => {} }) },
  };
  const runtime = createSenseRuntime(ports, { platform: 'linux', ...options });
  return {
    ports,
    runtime,
    delivered,
    agent: (event: AgentEvent) => agent(event),
    tool: (event: ToolEvent) => tool(event),
    job: (event: JobEvent) => job({ sessionId: 's', ...event }),
    elapseMono: (ms: number) => {
      mono += ms;
    },
    advance: async (ms: number) => {
      mono += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
}

describe('tool exit self-cause', () => {
  it.each([true, false])('suppresses a foreground false result with pid metadata=%s', async (withPid) => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's', userInitiated: true });
    await h.tool({
      type: 'pre-execute',
      sessionId: 's',
      toolCallId: 'false',
      ...(withPid ? { pid: 42, cwd: '/workspace/repo' } : {}),
    });
    const mono = h.ports.clock.mono;
    let reads = 0;
    h.ports.clock.mono = () => {
      const now = mono();
      if (reads++ === 0) h.elapseMono(0.01);
      return now;
    };
    await h.tool({
      type: 'post-execute',
      sessionId: 's',
      toolCallId: 'false',
      command: 'false',
      exitCode: 1,
      ...(withPid ? { pid: 42, cwd: '/workspace/repo' } : {}),
    });
    h.ports.clock.mono = mono;
    await h.advance(2_001);
    await h.agent({ type: 'pre-step', sessionId: 's', userInitiated: true });
    expect(h.delivered).toEqual([]);
    expect(h.runtime.events().filter((e) => e.subject === 'false')).toEqual([
      expect.objectContaining({ cause: 'agent', level: 'record', reason: 'self-caused' }),
    ]);
    await h.runtime.stop();
  });

  it('suppresses a failed tool result even if its pre-execute event was missed', async () => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's', userInitiated: true });
    await h.tool({ type: 'post-execute', sessionId: 's', toolCallId: 'false', command: 'false', exitCode: 1 });
    await h.advance(2_001);
    await h.agent({ type: 'pre-step', sessionId: 's', userInitiated: true });
    expect(h.delivered).toEqual([]);
    expect(h.runtime.events().find((e) => e.subject === 'false')).toMatchObject({
      cause: 'agent',
      level: 'record',
      reason: 'self-caused',
    });
    await h.runtime.stop();
  });

  it.each([0, 1])('wakes exactly once for a background child exit %i ms after its shell ends', async (delay) => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    await h.agent({ type: 'post-step', sessionId: 's' });
    await h.tool({ type: 'pre-execute', sessionId: 's', toolCallId: 'shell', pid: 42, cwd: '/workspace/repo' });
    await h.advance(100);
    await h.tool({ type: 'post-execute', sessionId: 's', toolCallId: 'shell', exitCode: 0 });
    await h.advance(delay);
    await h.job({
      type: 'exited',
      id: 'background',
      pid: 43,
      ppid: 42,
      ancestors: [42],
      cwd: '/workspace/repo',
      exitCode: 1,
    });
    expect(h.runtime.events().find((e) => e.subject === 'background')).toMatchObject({
      cause: 'unknown',
      level: 'wake',
    });
    await h.advance(2_001);
    expect(h.delivered.map((intent) => intent.kind)).toEqual(['followup']);
    await h.advance(4_000);
    expect(h.delivered.map((intent) => intent.kind)).toEqual(['followup']);
    await h.runtime.stop();
  });

  it.each([
    { delay: 1, cause: 'agent', level: 'record' },
    { delay: 1_999, cause: 'agent', level: 'record' },
    { delay: 2_000, cause: 'unknown', level: 'wake' },
    { delay: 2_001, cause: 'unknown', level: 'wake' },
  ])('classifies the same-pid job exit at $delay ms after the tool ends', async ({ delay, cause, level }) => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    await h.agent({ type: 'post-step', sessionId: 's' });
    await h.tool({ type: 'pre-execute', sessionId: 's', toolCallId: 'shell', pid: 42, cwd: '/workspace/repo' });
    await h.advance(100);
    await h.tool({ type: 'post-execute', sessionId: 's', toolCallId: 'shell' });
    await h.advance(delay);
    await h.job({ type: 'exited', id: 'same-pid', pid: 42, cwd: '/workspace/repo', exitCode: 1 });
    expect(h.runtime.events().find((e) => e.subject === 'same-pid')).toMatchObject({
      cause,
      level,
      ...(cause === 'agent' ? { reason: 'self-caused' } : {}),
    });
    await h.advance(2_001);
    await h.agent({ type: 'pre-step', sessionId: 's' });
    expect(h.delivered.map((intent) => intent.kind)).toEqual(cause === 'agent' ? [] : ['followup']);
    await h.runtime.stop();
  });

  it.each([
    { delay: 499, cause: 'agent', level: 'record' },
    { delay: 500, cause: 'unknown', level: 'wake' },
  ])('uses a post-execute pid and configured grace at $delay ms', async ({ delay, cause, level }) => {
    const h = harness({ selfCauseGraceMs: 500 });
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    await h.agent({ type: 'post-step', sessionId: 's' });
    await h.tool({ type: 'pre-execute', sessionId: 's', toolCallId: 'shell' });
    await h.tool({ type: 'post-execute', sessionId: 's', toolCallId: 'shell', pid: 42 });
    await h.advance(delay);
    await h.job({ type: 'exited', id: 'same-pid', pid: 42, exitCode: 1 });
    expect(h.runtime.events().find((e) => e.subject === 'same-pid')).toMatchObject({ cause, level });
    await h.runtime.stop();
  });
});
