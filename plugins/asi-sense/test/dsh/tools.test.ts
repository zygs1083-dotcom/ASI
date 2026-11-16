import type { SenseState } from '@asi/sense-types';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native';
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit';
import ToolsService from '@deepseek-ai/dsh-tools';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { FileBurstDetector } from '../../src/host/body/burst.ts';
import { formatEnvUpdate } from '../../src/host/delivery/format.ts';
import { registerSenseTools } from '../../src/host/dsh/tools.ts';
import { createSenseRuntime } from '../../src/host/runtime/index.ts';
import type { AgentEvent, JobEvent, SensePorts, ToolEvent } from '../../src/host/runtime/ports.ts';
import { StateStore } from '../../src/host/state/store.ts';

async function fixture(liveState = false, isolated = false) {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolsService);
  ctx.tools.setExecutor(new NativeToolExecutor(ctx));
  let agentEvent: (event: AgentEvent) => Promise<void> = async () => {};
  let toolEvent: (event: ToolEvent) => Promise<void> = async () => {};
  let jobEvent: (event: JobEvent) => Promise<void> = async () => {};
  const ports: SensePorts = {
    clock: { wall: () => 1_000, mono: () => 1_000 },
    dsh: {
      onAgentEvent: (callback) => {
        agentEvent = callback;
        return () => {};
      },
      onTool: (callback) => {
        toolEvent = callback;
        return () => {};
      },
      onJob: (callback) => {
        jobEvent = callback;
        return () => {};
      },
      deliver: async () => {},
      tokenSnapshot: async (session) =>
        isolated
          ? {
              contextUsed: session === 'session-a' ? 11 : 22,
              sessionUsage: { input: session === 'session-a' ? 11 : 22, output: 0, cacheRead: 0, cacheWrite: 0 },
            }
          : undefined,
    },
    storage: { load: async () => undefined, save: async () => {} },
    helper: { spawn: () => undefined },
    probe: { create: () => ({ onSample: () => () => {}, start: () => {}, stop: async () => {} }) },
    files: { watch: () => ({ close: () => {} }) },
  };
  const jobs = [
    { id: 'a-job', owner: 'session-a', command: 'private-a-command', status: 'running' as const, startedAt: 1 },
    { id: 'b-job', owner: 'session-b', command: 'private-b-command', status: 'running' as const, startedAt: 2 },
    { id: 'orphan', owner: undefined, command: 'private-orphan-command', status: 'running' as const, startedAt: 3 },
  ];
  Object.assign(ports.dsh, {
    nowReadings: (session?: string) =>
      isolated
        ? {
            'env.activeJobs': { value: jobs },
            'self.activity': { value: session === 'session-a' ? 'tool' : 'thinking' },
            'self.pending': { value: { inbox: session === 'session-a' ? 1 : 2, jobs: 1 } },
            'self.tools': { value: [session === 'session-a' ? 'a-tool' : 'b-tool'] },
            'env.where.model': {
              value: { provider: session === 'session-a' ? 'provider-a' : 'provider-b', endpoint: '', local: true },
            },
          }
        : { 'env.activeJobs': { value: jobs } },
    modelJobs: (session: string) =>
      jobs.filter((job) => job.owner === session).map(({ id, status, startedAt }) => ({ id, status, startedAt })),
  });
  const live = createSenseRuntime(ports, { platform: 'linux' });
  await live.start();
  const state = new StateStore(() => 990).snapshot();
  state.env.frontApp.value = { name: 'Fixture App', bundleId: 'org.fixture.app' };
  state.env.frontApp.status = 'ok';
  state.env.focusedWindow.value = { title: 'Synthetic title' };
  state.env.focusedWindow.status = 'ok';
  state.observation.sources.helper = { status: 'ok', lastSignalAt: 990 };
  let titles = true;
  const runtime = {
    ...live,
    tools: {
      ...live.tools,
      envState: (section?: 'self' | 'env' | 'observation') => {
        const copy = structuredClone(state);
        if (!titles) copy.env.focusedWindow.value = null;
        return section ? copy[section] : copy;
      },
    },
    events: () => [
      {
        id: 'event',
        kind: 'window.focused',
        subject: titles ? 'org.fixture.app' : '',
        level: 'record' as const,
        at: 990,
        source: { id: 'helper', api: 'test', host: 'local' },
      },
    ],
  };
  const off = registerSenseTools(ctx, liveState ? live : runtime, ports.clock.wall);
  const id = SessionId('synthetic-tool-test');
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
  onTestFinished(async () => {
    off();
    await live.stop();
    await ctx.fiber.dispose();
  });
  const call = (
    name: string,
    args: object,
    options: { agent?: boolean; signal?: AbortSignal; session?: string } = {},
  ) =>
    executeToolFixture(ctx, {
      callId: ToolCallId(`call-${name}`),
      name,
      arguments: args,
      signal: options.signal ?? new AbortController().signal,
      ...(options.agent === false
        ? {}
        : { agent: options.session ? { ...agent, id: SessionId(options.session) } : agent }),
    });
  return {
    ctx,
    live,
    state,
    call,
    off,
    agentEvent: (event: AgentEvent) => agentEvent(event),
    toolEvent: (event: ToolEvent) => toolEvent(event),
    jobEvent: (event: JobEvent) => jobEvent(event),
    setTitles: (value: boolean) => (titles = value),
  };
}

describe('model-facing tools', () => {
  it('returns fact age and redacts titles when disabled; rejects calls without an agent', async () => {
    const h = await fixture();
    expect(await h.call('env_state', {}, { agent: false })).toMatchObject({
      isError: true,
      error: { info: { code: 'TOOL_CONTEXT_UNAVAILABLE' } },
    });
    const first = await h.call('env_state', { section: 'env' });
    expect(first).toMatchObject({
      isError: false,
      value: { frontApp: { ageMs: 10 }, focusedWindow: { value: { title: 'Synthetic title' } } },
    });
    h.setTitles(false);
    const redacted = await h.call('env_state', { section: 'env' });
    expect(redacted).toMatchObject({ isError: false, value: { focusedWindow: { value: null } } });
    expect(JSON.stringify(redacted)).not.toContain('Synthetic title');
  });

  it('returns only local foreground facts, recent events and the fixed computer-use guidance', async () => {
    const h = await fixture();
    const result = await h.call('env_detail', { app: 'org.fixture.app', window: 'Synthetic title' });
    expect(result).toMatchObject({
      isError: false,
      value: {
        current: true,
        app: { value: { name: 'Fixture App' } },
        window: { value: { title: 'Synthetic title' } },
        pid: { value: null, status: 'unknown' },
        windowCount: { value: null, status: 'unknown' },
        recentEvents: [{ kind: 'window.focused' }],
        sources: { helper: { status: 'ok' } },
        guidance: '如需查看窗口内容，请使用当前会话可用的 computer-use 工具（需经其授权流程）',
      },
    });
    expect(await h.call('env_detail', { app: 'not-current' })).toMatchObject({
      isError: false,
      value: { match: 'not-current', app: null, window: null, recentEvents: [] },
    });
    h.setTitles(false);
    const hidden = await h.call('env_detail', { window: 'Synthetic title' });
    expect(hidden).toMatchObject({ isError: false, value: { match: 'unknown', window: { value: null } } });
    expect(JSON.stringify(hidden.value)).not.toContain('Synthetic title');
  });

  it('minimizes machine, endpoint, paths, and foreign job commands in model output', async () => {
    const h = await fixture();
    h.state.env.where.harness.value = { host: 'fixture-host.invalid', os: 'FixtureOS', pid: 123 };
    h.state.env.where.observed.value = { host: 'fixture-host.invalid', userSession: 'fixture' };
    h.state.env.where.toolExec.value = { host: 'fixture-host.invalid', cwd: '/private/fixture/work' };
    h.state.env.where.model.value = {
      provider: 'fixture-provider',
      endpoint: 'https://fixture-host.invalid:443',
      local: false,
    };
    h.state.self.activity.source.host = 'fixture-host.invalid';
    h.state.env.frontApp.source.host = 'fixture-host.invalid';
    h.state.env.watchedPaths.value = { '/private/fixture/project': { changes: 0, lastChange: 0 } };
    h.state.env.activeJobs.value = [{ id: 'foreign', startedAt: 1, status: 'running', command: 'foreign-command' }];
    const result = await h.call('env_state', {});
    const text = JSON.stringify(result.value);
    expect(text).not.toContain('fixture-host.invalid');
    expect(text).not.toContain('/private/fixture');
    expect(text).not.toContain('foreign-command');
    expect(result.value).toMatchObject({
      env: {
        where: {
          harness: { value: { os: 'FixtureOS' } },
          model: { value: { provider: 'fixture-provider', local: false } },
        },
      },
    });
    expect(JSON.stringify((await h.call('env_detail', {})).value)).not.toContain('fixture-host.invalid');
  });

  it('projects consented titles and excludes arbitrary notes and colliding private paths', async () => {
    const h = await fixture();
    const title = 'open </private/fixture/report> backup.example.invalid';
    const projected = 'open <report> <host>';
    h.state.env.focusedWindow.value = { title };
    if (!h.state.env.frontApp.value) throw new Error('fixture missing');
    h.state.env.frontApp.value.bundleId = 'backup.example.invalid';
    h.state.env.watchedPaths.value = {
      '/private/a/project': { changes: 1, lastChange: 1 },
      '/private/b/project': { changes: 2, lastChange: 2 },
      '/': { changes: 3, lastChange: 3 },
      '/private/a/__proto__': { changes: 4, lastChange: 4 },
    };
    const state = await h.call('env_state', { section: 'env' });
    expect(state.value).toMatchObject({
      focusedWindow: { value: { title: projected } },
      watchedPaths: { value: { project: { changes: 1 }, 'project (2)': { changes: 2 }, '[path]': { changes: 3 } } },
    });
    expect(Object.hasOwn((state.value as unknown as SenseState['env']).watchedPaths.value ?? {}, '__proto__')).toBe(
      true,
    );
    expect(JSON.stringify((state.value as unknown as SenseState['env']).frontApp)).not.toContain(
      'backup.example.invalid',
    );
    expect((await h.call('env_detail', {})).value).toMatchObject({ window: { value: { title: projected } } });
    const result = await h.call('env_watch', {
      action: 'add',
      rule: {
        id: 'fixture-rule',
        match: { kind: 'app.activated' },
        level: 'record',
        note: 'open </private/fixture/report> backup.example.invalid',
      },
    });
    expect(JSON.stringify(result.value)).not.toContain('/private/fixture');
    expect(JSON.stringify(result.value)).not.toContain('backup.example.invalid');
    h.setTitles(false);
    expect(JSON.stringify((await h.call('env_state', {})).value)).not.toContain(title);
  });

  it('isolates actual model state by caller and selects the local panel session', async () => {
    const h = await fixture(true);
    await h.agentEvent({ type: 'created', sessionId: 'session-a' });
    await h.agentEvent({ type: 'created', sessionId: 'session-b' });
    await h.agentEvent({ type: 'pre-step', sessionId: 'session-b' });
    expect(JSON.stringify(h.live.state().env.activeJobs)).toContain('private-b-command');
    expect(JSON.stringify(h.live.state().env.activeJobs)).toContain('private-orphan-command');
    expect(JSON.stringify(h.live.state().env.activeJobs)).toContain('private-a-command');
    for (const [session, own, foreign] of [
      ['session-a', 'a-job', 'b-job'],
      ['session-b', 'b-job', 'a-job'],
    ]) {
      const result = await h.call('env_state', { section: 'env' }, { session });
      expect(result).toMatchObject({ isError: false, value: { activeJobs: { value: [{ id: own }] } } });
      const text = JSON.stringify(result.value);
      expect(text).not.toContain(foreign);
      expect(text).not.toContain('orphan');
      expect(text).not.toContain('private-');
      expect(JSON.stringify((await h.call('env_detail', {}, { session })).value)).not.toContain('private-');
    }
  });

  it('isolates interleaved session activity, pending, tools, jobs and tokens through the DSH tool boundary', async () => {
    const h = await fixture(true, true);
    const seen: { session?: string; used?: number; jobs: string[] }[] = [];
    const off = h.live.subscribe((state) => {
      seen.push({
        session: h.live.currentSessionId(),
        used: state.self.body.tokens.value?.contextUsed,
        jobs: state.env.activeJobs.value?.map((job) => job.id) ?? [],
      });
    });
    for (const sessionId of ['session-a', 'session-b']) {
      await h.agentEvent({ type: 'created', sessionId });
      await h.agentEvent({ type: 'pre-step', sessionId });
      await h.toolEvent({ type: 'pre-execute', sessionId, toolCallId: `${sessionId}-call` });
      await h.jobEvent({ type: 'started', id: `${sessionId}-job`, sessionId, command: `${sessionId}-private-command` });
    }
    await h.agentEvent({ type: 'pre-step', sessionId: 'session-a' });
    await h.agentEvent({ type: 'post-step', sessionId: 'session-b' });
    await h.jobEvent({ type: 'exited', id: 'orphan', command: 'orphan-private-command', exitCode: 1 });
    expect(h.live.state().self.body.tokens.value?.contextUsed).toBe(11);
    expect(h.live.state().env.activeJobs.value?.map((job) => job.id)).toEqual(['a-job', 'b-job', 'orphan']);
    for (const item of seen) {
      if (!item.session) continue;
      const own = item.session === 'session-a' ? 'a' : 'b';
      expect(item.used === undefined || item.used === (own === 'a' ? 11 : 22)).toBe(true);
      expect(item.jobs.every((job) => ['a-job', 'b-job', 'orphan'].includes(job))).toBe(true);
    }
    off();
    for (const [session, own, other, used, activity] of [
      ['session-a', 'a', 'b', 11, 'tool'],
      ['session-b', 'b', 'a', 22, 'thinking'],
    ] as const) {
      const result = await h.call('env_state', {}, { session });
      expect(result).toMatchObject({
        isError: false,
        value: {
          self: {
            activity: { value: activity },
            pending: { value: { inbox: own === 'a' ? 1 : 2, jobs: 1 } },
            tools: { value: [`${own}-tool`] },
            body: { tokens: { value: { contextUsed: used } } },
          },
          env: {
            activeJobs: { value: [{ id: `${own}-job` }] },
            where: { model: { value: { provider: `provider-${own}` } } },
          },
        },
      });
      const text = JSON.stringify(result.value);
      expect(text).not.toContain(`${other}-job`);
      expect(text).not.toContain(`provider-${other}`);
      expect(text).not.toContain('private-command');
      expect(JSON.stringify((await h.call('env_detail', {}, { session })).value)).not.toContain('private-command');
    }
  });

  it('proposes wake rules as an agent, does not remove user rules, and respects cancellation', async () => {
    const h = await fixture();
    const rule = { id: 'agent-wake', match: { kind: 'file.changed' }, level: 'wake' };
    expect(await h.call('env_watch', { action: 'add', rule })).toMatchObject({ isError: false });
    expect(h.live.rules.list().find((item) => item.id === rule.id)).toMatchObject({
      createdBy: 'agent',
      approved: false,
    });
    expect(await h.call('env_watch', { action: 'remove', id: 'app-activity' })).toMatchObject({
      isError: true,
      error: { info: { code: 'ASI_WATCH_FAILED' } },
    });
    expect(h.live.rules.list().some((item) => item.id === 'app-activity')).toBe(true);
    const controller = new AbortController();
    controller.abort();
    expect(await h.call('env_watch', { action: 'remove', id: rule.id }, { signal: controller.signal })).toMatchObject({
      isError: true,
      error: { info: { code: 'ABORTED_BEFORE_DISPATCH' } },
    });
    expect(h.live.rules.list().some((item) => item.id === rule.id)).toBe(true);
  });

  it('applies tuner guards to agent requests and reports rejected changes', async () => {
    const h = await fixture();
    const param = h.live.body.tuner.parameters().find((item) => typeof item.value === 'number' && item.value > 0);
    if (!param || typeof param.value !== 'number') throw new Error('numeric tuning parameter missing');
    await h.live.actions.lockParam(param.key, true);
    const result = await h.call('body_tune', { param: param.key, to: param.value * 1.1, reason: 'fixture' });
    expect(result).toMatchObject({
      isError: false,
      value: { applied: false, reason: 'param locked', change: { by: 'agent', param: param.key } },
    });
    expect(h.live.body.tuner.get(param.key)).toBe(param.value);
    expect(h.live.body.tuner.logs.at(-1)).toMatchObject({ by: 'agent', status: 'rejected' });
  });

  it('round-trips a special-character file burst alert from formatted delivery to feedback', async () => {
    const h = await fixture();
    const detector = new FileBurstDetector({ roots: ['/fixture/R&D'], maxDeleted: 1 });
    const emit = (id: string) =>
      detector.accept(
        {
          id,
          kind: 'file.changed',
          at: 1_000,
          subject: `/fixture/R&D/${id}`,
          source: { id: 'fs', api: 'test', host: 'local' },
          data: { change: 'delete' },
        },
        1_000,
      );
    emit('one');
    const alert = emit('two')[0];
    if (!alert) throw new Error('fixture alert missing');
    expect(await h.live.body.tuner.registerAlert(alert.id, 'file.burst', 'file.burst.maxDeleted')).toBe(true);
    alert.data.feedbackAvailable = true;
    const text = formatEnvUpdate({
      since: 1_000,
      at: 1_000,
      suppressed: 0,
      changes: [{ signal: alert, count: 1, level: 'context' }],
    });
    const encoded = /alertId="([A-Za-z0-9_-]+)"/.exec(text)?.[1];
    expect(encoded).toBeDefined();
    expect(await h.call('body_tune', { action: 'feedback', alertId: encoded, verdict: 'useful' })).toMatchObject({
      isError: false,
      value: { applied: true },
    });
    expect(h.live.body.tuner.hasAlert(alert.id)).toBe(false);
  });

  it('bounds complete results and removes tool and prompt contributions on disposal', async () => {
    const h = await fixture();
    if (!h.state.env.frontApp.value) throw new Error('fixture missing');
    h.state.env.frontApp.value.name = '汉'.repeat(20_000);
    const result = await h.call('env_state', { section: 'env' });
    expect(result).toMatchObject({ isError: false, value: { truncated: true } });
    expect(Buffer.byteLength(JSON.stringify(result.value), 'utf8')).toBeLessThan(32_768);
    expect((await h.ctx.systemPrompt.assemble()).sections.some((section) => section.name === 'asi-sense')).toBe(true);
    h.off();
    expect(h.ctx.tools.get('env_state')).toBeUndefined();
    expect((await h.ctx.systemPrompt.assemble()).sections.some((section) => section.name === 'asi-sense')).toBe(false);
  });
});
