import type { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';
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
  const ctx = {
    agents: { list: () => agents },
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
      value: [{ id: 'job-1', command: 'fixture-job', startedAt: 10, status: 'running' }],
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
    expect(facts['self.pending']).toMatchObject({ status: 'unknown', reason: '没有明确的当前会话' });
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
    const port = createDshPort(f.ctx, () => false);
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
    expect(port.nowReadings()['self.activity']).toEqual({ value: 'tool' });
    expect(notifications).toBe(1);
    off();
    release('fixture-result');
    await expect(result).resolves.toBe('fixture-result');
    expect(notifications).toBe(1);
    expect(port.nowReadings()['self.activity']).toMatchObject({ status: 'unknown' });
    expect(listeners.size).toBe(0);
  });
});
