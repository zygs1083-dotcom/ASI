import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import { nowReadings } from '../../src/host/dsh/now-facts.ts';
import { createDshPort } from '../../src/host/dsh/port.ts';

function fixture() {
  const agent = {
    id: 'fixture-session',
    status: 'idle',
    model: {
      current: (): { provider: string; model: string } | undefined => ({
        provider: 'fixture-provider',
        model: 'fixture-model',
      }),
    },
    inbox: { nextTurn: [{}], nextStep: [{}, {}] },
  };
  const jobs = [
    { id: 'job-1', owner: agent.id, status: 'running', startedAt: 10, label: 'fixture-job' },
    { id: 'job-2', status: 'completed', startedAt: 20, label: 'finished' },
  ];
  const providers = [
    { provider: 'fixture-provider', settingsNs: 'fixture-settings', settingsPath: ['providers', 'fixture-provider'] },
  ];
  let settings: unknown = {
    providers: { 'fixture-provider': { baseURL: 'http://user:password@127.0.0.1:9876/v1?key=secret' } },
  };
  let pendingEvents: { event: string; agentId: string }[] = [];
  let failJobs = false;
  let failTools = false;
  let agents = [agent];
  let sessions = [{ id: agent.id }];
  const ctx = {
    agents: { list: () => agents, get: (id: string) => agents.find((item) => item.id === id) },
    sessions: { list: () => sessions },
    jobs: {
      list: (id?: string) => {
        if (failJobs) throw new Error('private fixture details');
        return jobs.filter((job) => job.owner === undefined || job.owner === id);
      },
    },
    tools: {
      definitions: () => {
        if (failTools) throw new Error('private fixture details');
        return [{ name: 'allowed' }, { name: 'conditional' }];
      },
      executable: (name: string) => name === 'allowed',
    },
    llm: { listConfigurableProviders: () => providers },
    get: (name: string) =>
      name === 'settings'
        ? {
            describe: (options: unknown) => {
              expect(options).toEqual({ redactSecrets: true });
              return [{ ns: 'fixture-settings', value: settings }];
            },
          }
        : name === 'typertGateway'
          ? { getPendingRemoteEvents: () => pendingEvents }
          : undefined,
  } as unknown as Context;
  return {
    ctx,
    agent,
    jobs,
    setAgents: (value: typeof agents) => {
      agents = value;
      sessions = value.map(({ id }) => ({ id }));
    },
    setSessions: (ids: string[]) => {
      sessions = ids.map((id) => ({ id }));
    },
    setSettings: (value: unknown) => {
      settings = value;
    },
    setPendingEvents: (value: typeof pendingEvents) => {
      pendingEvents = value;
    },
    failSources: () => {
      failJobs = true;
      failTools = true;
    },
  };
}

describe('DSH now facts', () => {
  it('reports the no-session reason and an actual empty job list', () => {
    const f = fixture();
    f.setAgents([]);
    const facts = nowReadings(f.ctx, undefined, new Map(), new Set());
    for (const key of ['env.where.model', 'env.where.toolExec', 'self.activity', 'self.pending', 'self.tools']) {
      expect(facts[key]).toMatchObject({ status: 'unknown', reason: '没有活动会话' });
    }
    expect(facts['env.activeJobs']).toEqual({ value: [] });
  });

  it('uses the selected session, redacted configuration, inbox, jobs, and executable tools', () => {
    const f = fixture();
    const facts = nowReadings(f.ctx, f.agent.id, new Map(), new Set());
    expect(facts['env.where.model']).toEqual({
      value: { provider: 'fixture-provider', endpoint: 'http://127.0.0.1:9876', local: true },
    });
    expect(facts['env.where.toolExec']).toMatchObject({ status: 'unknown', reason: 'DSH 未提供工具执行宿主' });
    expect(facts['self.activity']).toEqual({ value: 'idle' });
    expect(facts['self.pending']).toEqual({ value: { inbox: 3, jobs: 1 } });
    expect(facts['self.tools']).toEqual({ value: ['allowed'] });
    expect(facts['env.activeJobs']).toEqual({
      value: [{ id: 'job-1', owner: f.agent.id, command: 'fixture-job', startedAt: 10, status: 'running' }],
    });
  });

  it('does not invent an endpoint, activity, or selected session', () => {
    const f = fixture();
    f.setSettings({ providers: { 'fixture-provider': {} } });
    f.agent.status = 'running';
    let facts = nowReadings(f.ctx, f.agent.id, new Map(), new Set());
    expect(facts['env.where.model']).toMatchObject({ status: 'unknown', reason: expect.stringContaining('endpoint') });
    expect(facts['self.activity']).toMatchObject({ status: 'unknown', reason: expect.stringContaining('等待用户') });
    facts = nowReadings(f.ctx, f.agent.id, new Map(), new Set([f.agent.id]));
    expect(facts['self.activity']).toEqual({ value: 'thinking' });
    facts = nowReadings(f.ctx, f.agent.id, new Map([['call', f.agent.id]]), new Set());
    expect(facts['self.activity']).toEqual({ value: 'tool' });
    f.setPendingEvents([{ event: 'user-questions/request', agentId: f.agent.id }]);
    facts = nowReadings(f.ctx, f.agent.id, new Map([['call', f.agent.id]]), new Set());
    expect(facts['self.activity']).toEqual({ value: 'waiting-user' });
    f.setPendingEvents([{ event: 'approval/request', agentId: 'other-session' }]);
    facts = nowReadings(f.ctx, f.agent.id, new Map([['call', f.agent.id]]), new Set());
    expect(facts['self.activity']).toEqual({ value: 'tool' });
    f.setAgents([f.agent, { ...f.agent, id: 'other-session' }]);
    facts = nowReadings(f.ctx, undefined, new Map(), new Set());
    expect(facts['self.pending']).toMatchObject({ status: 'unknown', reason: '没有活动会话' });
  });

  it('classifies a configured remote endpoint without leaking its path or query', () => {
    const f = fixture();
    f.setSettings({ providers: { 'fixture-provider': { baseURL: 'https://example.invalid/private?token=secret' } } });
    expect(nowReadings(f.ctx, f.agent.id, new Map(), new Set())['env.where.model']).toEqual({
      value: { provider: 'fixture-provider', endpoint: 'https://example.invalid', local: false },
    });
  });

  it('explains missing model and unavailable registry sources without leaking errors', () => {
    const f = fixture();
    f.agent.model.current = () => undefined;
    f.failSources();
    const facts = nowReadings(f.ctx, f.agent.id, new Map(), new Set());
    expect(facts['env.where.model']).toMatchObject({ status: 'unknown', reason: '会话尚未选择模型' });
    expect(facts['env.activeJobs']).toMatchObject({ status: 'unavailable', reason: 'DSH 任务列表不可用' });
    expect(facts['self.pending']).toMatchObject({ status: 'unavailable', reason: 'DSH 任务列表不可用' });
    expect(facts['self.tools']).toMatchObject({ status: 'unavailable', reason: 'DSH 工具列表不可用' });
    expect(JSON.stringify(facts)).not.toContain('private fixture details');
  });

  it('lists all active jobs in the sidebar but counts only the selected session', () => {
    const f = fixture();
    f.jobs.push({
      id: 'unowned',
      owner: undefined as never,
      status: 'running',
      startedAt: 30,
      label: 'orphan-command',
    });
    const facts = nowReadings(f.ctx, f.agent.id, new Map(), new Set());
    expect(facts['self.pending']).toEqual({ value: { inbox: 3, jobs: 1 } });
    expect(facts['env.activeJobs'].value).toEqual([
      expect.objectContaining({ id: 'unowned', owner: undefined }),
      expect.objectContaining({ id: 'job-1', owner: f.agent.id }),
    ]);
    expect(nowReadings(f.ctx, undefined, new Map(), new Set())['env.activeJobs'].value).toHaveLength(2);
  });

  it('includes jobs belonging to live sessions without an active agent', () => {
    const f = fixture();
    f.setSessions([f.agent.id, 'session-without-agent']);
    f.jobs.push({
      id: 'detached-job',
      owner: 'session-without-agent',
      status: 'running',
      startedAt: 40,
      label: 'fixture-detached-job',
    });
    const facts = nowReadings(f.ctx, f.agent.id, new Map(), new Set());
    expect(facts['env.activeJobs'].value).toContainEqual(
      expect.objectContaining({ id: 'detached-job', owner: 'session-without-agent' }),
    );
    expect(facts['self.pending']).toEqual({ value: { inbox: 3, jobs: 1 } });
  });

  it('reads only owned job summaries for each model session', () => {
    const f = fixture();
    const other = { ...f.agent, id: 'other-session' };
    f.setAgents([f.agent, other]);
    f.jobs.push(
      { id: 'other-job', owner: other.id, status: 'running', startedAt: 30, label: 'private-other-command' },
      { id: 'orphan', owner: undefined as never, status: 'running', startedAt: 40, label: 'private-orphan-command' },
    );
    const ctx = f.ctx as unknown as Record<string, unknown>;
    ctx.sessionProjections = { register: async () => ({}) };
    const port = createDshPort(f.ctx);
    expect(port.modelJobs?.(f.agent.id)).toEqual([{ id: 'job-1', startedAt: 10, status: 'running' }]);
    expect(port.modelJobs?.(other.id)).toEqual([{ id: 'other-job', startedAt: 30, status: 'running' }]);
    expect(port.modelJobs?.('missing')).toEqual([]);
  });

  it('tracks dispatched tools until they settle without notifying after disposal', async () => {
    const f = fixture();
    f.agent.status = 'running';
    const ctx = f.ctx as unknown as Record<string, unknown>;
    const listeners = new Map<string, unknown>();
    ctx.on = (event: string, callback: unknown) => {
      listeners.set(event, callback);
      return () => listeners.delete(event);
    };
    ctx.jobs = { ...(ctx.jobs as object), events: { subscribe: () => () => {} } };
    ctx.sessionProjections = { register: async () => ({}) };
    const port = createDshPort(f.ctx);
    let notifications = 0;
    const off = port.onNowChanged(() => notifications++);
    const execute = listeners.get('tools/execute') as (
      exec: { agent: { id: string }; callId: string },
      next: () => Promise<string>,
    ) => Promise<string>;
    let release!: (value: string) => void;
    const result = execute(
      { agent: f.agent, callId: 'fixture-call' },
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    expect(port.nowReadings(f.agent.id)['self.activity']).toEqual({ value: 'tool' });
    expect(notifications).toBe(1);
    off();
    release('fixture-result');
    await expect(result).resolves.toBe('fixture-result');
    expect(notifications).toBe(1);
    expect(port.nowReadings(f.agent.id)['self.activity']).toMatchObject({ status: 'unknown' });
    expect(listeners.size).toBe(0);
  });

  it('expires lost streams, ignores late end frames and does not reuse old lifecycle state', () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.agent.status = 'running';
      const ctx = f.ctx as unknown as Record<string, unknown>;
      const listeners = new Map<string, (...args: never[]) => void>();
      ctx.on = (event: string, callback: (...args: never[]) => void) => {
        listeners.set(event, callback);
        return () => listeners.delete(event);
      };
      ctx.jobs = { ...(ctx.jobs as object), events: { subscribe: () => () => {} } };
      ctx.sessionProjections = { register: async () => ({}) };
      let mono = 0;
      const port = createDshPort(f.ctx, () => mono);
      const off = port.onNowChanged(() => {});
      const stream = listeners.get('agent/assistant-stream') as unknown as (event: unknown) => void;
      const status = listeners.get('agent/status') as unknown as (event: unknown) => void;
      stream({ agent: f.agent, frame: { type: 'start', attemptId: 'first', revision: 1 } });
      expect(port.nowReadings(f.agent.id)['self.activity']).toEqual({ value: 'thinking' });
      mono += 31_000;
      expect(port.nowReadings(f.agent.id)['self.activity']).toMatchObject({ status: 'unknown' });
      stream({ agent: f.agent, frame: { type: 'chunk', attemptId: 'first', revision: 1 } });
      expect(port.nowReadings(f.agent.id)['self.activity']).toMatchObject({ status: 'unknown' });
      stream({ agent: f.agent, frame: { type: 'start', attemptId: 'second', revision: 2 } });
      stream({ agent: f.agent, frame: { type: 'end', attemptId: 'first', revision: 1 } });
      expect(port.nowReadings(f.agent.id)['self.activity']).toEqual({ value: 'thinking' });
      status({ agent: f.agent, status: 'idle' });
      stream({ agent: f.agent, frame: { type: 'start', attemptId: 'first', revision: 1 } });
      expect(port.nowReadings(f.agent.id)['self.activity']).toMatchObject({ status: 'unknown' });
      const replacement = { ...f.agent };
      f.setAgents([replacement]);
      expect(port.nowReadings(replacement.id)['self.activity']).toMatchObject({ status: 'unknown' });
      off();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['approval/request', 'user-questions/request'])(
    'tracks local %s until its answerer settles',
    async (name) => {
      const f = fixture();
      f.agent.status = 'running';
      const ctx = f.ctx as unknown as Record<string, unknown>;
      const listeners = new Map<string, unknown>();
      ctx.on = (event: string, callback: unknown) => {
        listeners.set(event, callback);
        return () => listeners.delete(event);
      };
      ctx.jobs = { ...(ctx.jobs as object), events: { subscribe: () => () => {} } };
      ctx.sessionProjections = { register: async () => ({}) };
      const port = createDshPort(f.ctx);
      const off = port.onNowChanged(() => {});
      const execute = listeners.get('tools/execute') as (
        event: unknown,
        next: () => Promise<unknown>,
      ) => Promise<unknown>;
      const request = listeners.get(name) as (event: unknown, next: () => Promise<unknown>) => Promise<unknown>;
      let releaseTool!: () => void;
      const tool = execute(
        { agent: f.agent, callId: 'tool' },
        () =>
          new Promise<void>((resolve) => {
            releaseTool = resolve;
          }),
      );
      let answer!: () => void;
      const waiting = request(
        { agent: f.agent },
        () =>
          new Promise<void>((resolve) => {
            answer = resolve;
          }),
      );
      expect(port.nowReadings(f.agent.id)['self.activity']).toEqual({ value: 'waiting-user' });
      answer();
      await waiting;
      expect(port.nowReadings(f.agent.id)['self.activity']).toEqual({ value: 'tool' });
      releaseTool();
      await tool;
      off();
    },
  );

  it('observes an already-registered local answerer that does not delegate', async () => {
    const f = fixture();
    f.agent.status = 'running';
    const bus = new Context();
    const events = bus as unknown as {
      on(name: string, listener: (...args: never[]) => unknown): () => void;
      waterfall(name: string, request: unknown, next: () => Promise<unknown>): Promise<unknown>;
    };
    let answer!: () => void;
    const offAnswerer = events.on(
      'approval/request',
      () =>
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
    );
    const ctx = f.ctx as unknown as Record<string, unknown>;
    ctx.on = bus.on.bind(bus);
    ctx.jobs = { ...(ctx.jobs as object), events: { subscribe: () => () => {} } };
    ctx.sessionProjections = { register: async () => ({}) };
    const port = createDshPort(f.ctx);
    const off = port.onNowChanged(() => {});
    try {
      const request = events.waterfall('approval/request', { agent: f.agent }, async () => undefined);
      expect(port.nowReadings(f.agent.id)['self.activity']).toEqual({ value: 'waiting-user' });
      answer();
      await request;
      expect(port.nowReadings(f.agent.id)['self.activity']).toMatchObject({ status: 'unknown' });
    } finally {
      off();
      offAnswerer();
      await bus.fiber.dispose();
    }
  });

  it('passes unscoped user questions through the real waterfall', async () => {
    const f = fixture();
    const bus = new Context();
    const events = bus as unknown as {
      on(name: string, listener: (...args: never[]) => unknown): () => void;
      waterfall(name: string, request: unknown, next: () => Promise<unknown>): Promise<unknown>;
    };
    const offAnswerer = events.on('user-questions/request', () => 'answered');
    const ctx = f.ctx as unknown as Record<string, unknown>;
    ctx.on = bus.on.bind(bus);
    ctx.jobs = { ...(ctx.jobs as object), events: { subscribe: () => () => {} } };
    ctx.sessionProjections = { register: async () => ({}) };
    const off = createDshPort(f.ctx).onNowChanged(() => {});
    try {
      await expect(events.waterfall('user-questions/request', { questions: [] }, async () => 'fallback')).resolves.toBe(
        'answered',
      );
    } finally {
      off();
      offAnswerer();
      await bus.fiber.dispose();
    }
  });
});
