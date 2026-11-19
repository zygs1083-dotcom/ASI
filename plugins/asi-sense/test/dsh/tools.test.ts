import { createHash } from 'node:crypto';
import os from 'node:os';
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
import { createDelivery } from '../../src/host/dsh/deliver.ts';
import { environmentDetail, modelOutput, modelRules, modelState, modelTune } from '../../src/host/dsh/tool-output.ts';
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
  state.env.frontApp.value = { name: 'Fixture App', bundleId: 'org.fixture.app', pid: 123, windowCount: 2 };
  state.env.frontApp.status = 'ok';
  state.env.focusedWindow.value = { title: 'Synthetic title' };
  state.env.focusedWindow.status = 'ok';
  state.observation.sources.helper = { status: 'ok', lastSignalAt: 990 };
  let titles = true;
  let refresh = async () => true;
  const runtime = {
    ...live,
    tools: {
      ...live.tools,
      refreshDetail: () => refresh(),
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
    ports,
    live,
    state,
    call,
    off,
    agentEvent: (event: AgentEvent) => agentEvent(event),
    toolEvent: (event: ToolEvent) => toolEvent(event),
    jobEvent: (event: JobEvent) => jobEvent(event),
    setTitles: (value: boolean) => (titles = value),
    setRefresh: (value: () => Promise<boolean>) => (refresh = value),
  };
}

describe('model-facing tools', () => {
  it('reports a pinned target mode without exposing its conversation title', async () => {
    const h = await fixture(true, true);
    h.ports.dsh.listSessions = async () => [
      { id: 'session-a', title: 'Private Synthetic Conversation', updatedAt: 1, running: false },
    ];
    h.ports.dsh.ensureSession = async () => {};
    await h.agentEvent({ type: 'created', sessionId: 'session-a' });
    await h.live.actions.selectTarget?.('session-a');
    const result = await h.call('env_state', {}, { session: 'session-a' });
    expect(result).toMatchObject({ isError: false, value: { deliveryTarget: 'pinned' } });
    expect(JSON.stringify(result.value)).not.toContain('Private Synthetic Conversation');
  });
  it('returns fact age and redacts titles when disabled; rejects calls without an agent', async () => {
    const h = await fixture();
    expect(await h.call('env_state', {}, { agent: false })).toMatchObject({
      isError: true,
      error: { info: { code: 'TOOL_CONTEXT_UNAVAILABLE' } },
    });
    const first = await h.call('env_state', { section: 'env' });
    expect(first).toMatchObject({
      isError: false,
      value: {
        deliveryTarget: 'auto',
        frontApp: { ageMs: 10 },
        focusedWindow: { value: { title: 'Synthetic title' } },
      },
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
        app: { value: { name: 'Fixture App', bundleId: 'org.fixture.app', pid: 123, windowCount: 2 } },
        window: { value: { title: 'Synthetic title' } },
        pid: { value: 123, status: 'ok' },
        windowCount: { value: 2, status: 'ok' },
        recentEvents: [{ kind: 'window.focused', source: { id: 'helper', api: 'test' } }],
        sources: { helper: { status: 'ok' } },
        guidance: '如需查看窗口内容，请使用当前会话可用的 computer-use 工具（需经其授权流程）',
      },
    });
    expect(await h.call('env_detail', { app: 'not-current' })).toMatchObject({
      isError: false,
      value: {
        match: 'not-current',
        app: null,
        window: null,
        recentEvents: [],
        pid: { value: null, status: 'unknown' },
        windowCount: { value: null, status: 'unknown' },
      },
    });
    h.setTitles(false);
    const hidden = await h.call('env_detail', { window: 'Synthetic title' });
    expect(hidden).toMatchObject({ isError: false, value: { match: 'unknown', window: { value: null } } });
    expect(JSON.stringify(hidden.value)).not.toContain('Synthetic title');
  });

  it('exposes stable permission and source keys to model tools', async () => {
    const h = await fixture();
    h.state.self.permissions.value = { 辅助功能: 'denied', '其他权限（DSH 未提供）': 'unknown' };
    h.state.self.permissions.source = { id: 'helper.ax', api: 'accessibility', host: 'local' };
    h.state.observation.sources['helper.ax'] = { status: 'denied', lastSignalAt: 990 };
    h.state.observation.sources['helper.window'] = { status: 'unknown', lastSignalAt: 990 };
    const state = await h.call('env_state', {});
    expect(state.value).toMatchObject({
      self: {
        permissions: {
          value: { accessibility: 'denied', other: 'unknown' },
          source: { id: 'helper.ax', api: 'accessibility' },
        },
      },
      observation: { sources: { 'helper.ax': { status: 'denied' }, 'helper.window': { status: 'unknown' } } },
    });
    expect((await h.call('env_detail', {})).value).toMatchObject({
      sources: { 'helper.ax': { status: 'denied' }, 'helper.window': { status: 'unknown' } },
    });
  });

  it('projects file and helper source identifiers stably regardless of source order', async () => {
    const h = await fixture();
    const hash = (id: string) => `files:r-${createHash('sha256').update(id).digest('hex').slice(0, 8)}`;
    const sources = {
      'files:ascii.rule-1': { status: 'unavailable' as const, lastSignalAt: 990 },
      'files:/Users/example/private/work/project': { status: 'unavailable' as const, lastSignalAt: 989 },
      'files:规则一': { status: 'denied' as const, lastSignalAt: 991 },
      'files:规则二': { status: 'unknown' as const, lastSignalAt: 992 },
      'helper.frontApp': { status: 'ok' as const, lastSignalAt: 993 },
      'helper.focusedWindow': { status: 'unknown' as const, lastSignalAt: 994 },
    };
    const expected = {
      [hash('ascii.rule-1')]: { status: 'unavailable' },
      [hash('/Users/example/private/work/project')]: { status: 'unavailable' },
      [hash('规则一')]: { status: 'denied' },
      [hash('规则二')]: { status: 'unknown' },
      'helper.frontApp': { status: 'ok' },
      'helper.focusedWindow': { status: 'unknown' },
    };
    for (const entries of [Object.entries(sources), Object.entries(sources).reverse()]) {
      h.state.observation.sources = Object.fromEntries(entries);
      h.state.env.frontApp.source = { id: 'helper.frontApp', api: 'ndjson', host: 'local' };
      h.state.env.focusedWindow.source = { id: 'helper.focusedWindow', api: 'ndjson', host: 'local' };
      h.state.env.watchedPaths.source = { id: 'files:规则一', api: 'watch', host: 'local' };
      const state = (await h.call('env_state', {})).value;
      expect(state).toMatchObject({
        observation: { sources: expected },
        env: {
          frontApp: { source: { id: 'helper.frontApp' } },
          focusedWindow: { source: { id: 'helper.focusedWindow' } },
          watchedPaths: { source: { id: hash('规则一') } },
        },
      });
      expect((await h.call('env_detail', {})).value).toMatchObject({ sources: expected });
      expect(JSON.stringify(state)).not.toContain('规则');
      expect(JSON.stringify(state)).not.toContain('/Users/example/private/work/project');
    }
    expect(h.state.observation.sources).toHaveProperty('files:规则一');
    const collision = {
      'files:synthetic-rule-43351': { status: 'ok' as const, lastSignalAt: 995 },
      'files:synthetic-rule-66854': { status: 'denied' as const, lastSignalAt: 991 },
    };
    expect(hash('synthetic-rule-43351')).toBe(hash('synthetic-rule-66854'));
    for (const entries of [Object.entries(collision), Object.entries(collision).reverse()]) {
      h.state.observation.sources = Object.fromEntries(entries);
      const state = (await h.call('env_state', { section: 'observation' })).value;
      expect(state).toMatchObject({
        sources: { [hash('synthetic-rule-43351')]: { status: 'unknown', ambiguous: true } },
      });
      expect(JSON.stringify(state)).not.toContain(' (2)');
    }
  });

  it('F3: projects capped in env_state observation.sources without affecting other fields', async () => {
    const h = await fixture();
    h.state.observation.sources['history'] = { status: 'ok', lastSignalAt: 990, capped: true };
    h.state.observation.sources['helper.ax'] = { status: 'denied', lastSignalAt: 991, error: 'boom' };
    const state = (await h.call('env_state', { section: 'observation' })).value;
    const sources = (state as { sources: Record<string, Record<string, unknown>> }).sources;
    expect(sources['history']).toEqual({ status: 'ok', lastSignalAt: 990, capped: true });
    expect(sources['helper.ax']).toEqual({ status: 'denied', lastSignalAt: 991 });
    expect(JSON.stringify(state)).not.toContain('boom');
  });

  it('projects raw file source identifiers instead of exempting paths', () => {
    const value = modelOutput({
      observation: { sources: { 'files:/Users/example/private/work/project': { status: 'ok' } } },
      source: { id: 'files:/Users/example/private/work/project', api: 'watch' },
    });
    expect(JSON.stringify(value)).not.toContain('/Users/example/private/work/project');
  });

  it('projects a file rule whose ID is the full watched path', async () => {
    const h = await fixture();
    const id = '/Users/example/private/work/project';
    const hash = `files:r-${createHash('sha256').update(id).digest('hex').slice(0, 8)}`;
    h.state.observation.sources[`files:${id}`] = { status: 'unavailable', lastSignalAt: 990 };
    h.state.env.watchedPaths.source = { id: `files:${id}`, api: 'watch', host: 'local' };
    const projectedRule = modelRules([
      { id, match: { kind: 'file.changed', subject: id }, level: 'context', createdBy: 'user', approved: true },
    ]);
    expect(projectedRule).toMatchObject([{ id: '[redacted]', match: { subject: 'project' } }]);
    const state = (await h.call('env_state', {})).value;
    expect(state).toMatchObject({
      observation: { sources: { [hash]: { status: 'unavailable' } } },
      env: { watchedPaths: { source: { id: hash } } },
    });
    expect(JSON.stringify(state)).not.toContain(id);
  });

  it('hides a watched path used as a rule ID in the live file-source tool flow', async () => {
    const h = await fixture(true);
    const id = '/Users/example/private/work/project';
    const hash = `files:r-${createHash('sha256').update(id).digest('hex').slice(0, 8)}`;
    const rules = await h.call('env_watch', {
      action: 'add',
      rule: { id, match: { kind: 'file.changed', subject: id }, level: 'context' },
    });
    expect(rules.isError).toBe(false);
    expect(rules.value).toContainEqual(
      expect.objectContaining({ id: '[redacted]', match: { kind: 'file.changed', subject: 'project' } }),
    );
    expect(h.live.state().observation.sources[`files:${id}`]?.status).toBe('ok');
    const state = await h.call('env_state', { section: 'observation' });
    expect(state.value).toMatchObject({ sources: { [hash]: { status: 'ok' } } });
    expect(JSON.stringify(state.value)).not.toContain(id);
  });

  it('keeps projected file hashes stable even when the host name occurs in the hash', async () => {
    const hostname = vi.spyOn(os, 'hostname').mockReturnValue('a44b3008');
    try {
      const h = await fixture();
      const id = '/Users/example/private/work/project';
      const hash = `files:r-${createHash('sha256').update(id).digest('hex').slice(0, 8)}`;
      h.state.observation.sources[`files:${id}`] = { status: 'unavailable', lastSignalAt: 990 };
      h.state.env.watchedPaths.source = { id: `files:${id}`, api: 'watch', host: 'local' };
      expect((await h.call('env_state', {})).value).toMatchObject({
        observation: { sources: { [hash]: { status: 'unavailable' } } },
        env: { watchedPaths: { source: { id: hash } } },
      });
    } finally {
      hostname.mockRestore();
    }
  });

  it('retains fixed source keys without exempting matching window titles from host redaction', async () => {
    const hostname = vi.spyOn(os, 'hostname').mockReturnValue('helper');
    try {
      const h = await fixture();
      h.state.self.permissions.value = { 辅助功能: 'granted', '其他权限（DSH 未提供）': 'unknown' };
      h.state.self.permissions.source = { id: 'helper.ax', api: 'accessibility', host: 'local' };
      h.state.observation.sources['helper.ax'] = { status: 'ok', lastSignalAt: 990 };
      h.state.env.focusedWindow.value = { title: 'helper' };
      expect((await h.call('env_state', {})).value).toMatchObject({
        self: { permissions: { source: { id: 'helper.ax' }, value: { accessibility: 'granted', other: 'unknown' } } },
        observation: { sources: { helper: { status: 'ok' }, 'helper.ax': { status: 'ok' } } },
        env: { focusedWindow: { value: { title: '<host>' } } },
      });
      expect((await h.call('env_detail', { window: '<host>' })).value).toMatchObject({
        current: true,
        sources: { helper: { status: 'ok' }, 'helper.ax': { status: 'ok' } },
      });
    } finally {
      hostname.mockRestore();
    }
  });

  it('preserves bounded application names and matches the name visible to the model', async () => {
    const h = await fixture();
    if (!h.state.env.frontApp.value) throw new Error('fixture missing');
    h.state.env.frontApp.value.name = 'Fixture (Preview)';
    expect((await h.call('env_state', { section: 'env' })).value).toMatchObject({
      frontApp: { value: { name: 'Fixture (Preview)' } },
    });
    expect((await h.call('env_detail', { app: 'Fixture (Preview)' })).value).toMatchObject({
      current: true,
      app: { value: { name: 'Fixture (Preview)' } },
    });
    expect((await h.call('env_detail', { app: 'org.fixture.app' })).value).toMatchObject({ current: true });
    h.state.env.frontApp.value.name = `Fixture\n(App) /fixture/preview ${'x'.repeat(300)}`;
    const env = (await h.call('env_state', { section: 'env' })).value as { frontApp: { value: { name: string } } };
    const name = env.frontApp.value.name;
    expect(name.startsWith('Fixture (App) /fixture/preview ')).toBe(true);
    expect(Array.from(name).length).toBeLessThanOrEqual(256);
    expect((await h.call('env_detail', { app: name })).value).toMatchObject({
      current: true,
      app: { value: { name } },
    });
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
    const title = 'open </private/fixture/report> ssh user@build-node:22 README.md';
    const projected = 'open [path] ssh <host> README.md';
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
      frontApp: { value: { name: 'Fixture App', bundleId: 'backup.example.invalid' } },
      focusedWindow: { value: { title: projected } },
      watchedPaths: { value: { project: { changes: 1 }, 'project (2)': { changes: 2 }, '[path]': { changes: 3 } } },
    });
    expect(Object.hasOwn((state.value as unknown as SenseState['env']).watchedPaths.value ?? {}, '__proto__')).toBe(
      true,
    );
    expect((await h.call('env_detail', {})).value).toMatchObject({
      app: { value: { bundleId: 'backup.example.invalid' } },
      window: { value: { title: projected } },
    });
    expect((await h.call('env_detail', { window: projected })).value).toMatchObject({
      current: true,
      match: 'current',
      window: { value: { title: projected } },
      pid: { value: 123, status: 'ok' },
      windowCount: { value: 2, status: 'ok' },
      recentEvents: [{ kind: 'window.focused' }],
    });
    expect((await h.call('env_detail', { window: title })).value).toMatchObject({ match: 'not-current' });
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

  it('hides a host with port and following path in both model tools', async () => {
    const h = await fixture();
    h.state.env.focusedWindow.value = { title: 'ssh build-node:22/tmp/report' };
    expect((await h.call('env_state', { section: 'env' })).value).toMatchObject({
      focusedWindow: { value: { title: 'ssh <host>' } },
    });
    expect((await h.call('env_detail', { window: 'ssh <host>' })).value).toMatchObject({
      current: true,
      window: { value: { title: 'ssh <host>' } },
    });
  });

  it.each([
    ['ssh user@服务器:22/tmp/report', 'ssh <host>'],
    ['ssh 服务器:22/tmp/report', 'ssh <host>'],
    ['ssh u\u0301ser@se\u0301rver:22/tmp/report', 'ssh <host>'],
    ['ssh se\u0301rver:22/tmp/report', 'ssh <host>'],
    ['open re\u0301po/se\u0301cret/README.md', 'open README.md'],
  ])('hides Unicode hosts and paths in both model tools: %s', async (title, expected) => {
    const h = await fixture();
    h.state.env.focusedWindow.value = { title };
    expect((await h.call('env_state', { section: 'env' })).value).toMatchObject({
      focusedWindow: { value: { title: expected } },
    });
    expect((await h.call('env_detail', { window: expected })).value).toMatchObject({
      current: true,
      window: { value: { title: expected } },
    });
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

  it('distinguishes denied and stale foreground details without inventing a count', async () => {
    const h = await fixture();
    h.state.env.frontApp.value = { name: 'Fixture App', bundleId: 'org.fixture.app', pid: 123 };
    h.state.observation.sources['helper.ax'] = { status: 'denied', lastSignalAt: 990 };
    expect(await h.call('env_detail', {})).toMatchObject({
      value: { pid: { value: 123, status: 'ok' }, windowCount: { value: null, status: 'denied' } },
    });
    h.state.env.frontApp.value.windowCount = 0;
    const denied = await h.call('env_detail', {});
    expect((denied.value as { app: { value: { windowCount?: number } } }).app.value.windowCount).toBeUndefined();
    h.state.env.frontApp.status = 'stale';
    h.state.observation.sources['helper.ax'].status = 'ok';
    expect(await h.call('env_detail', {})).toMatchObject({
      value: { pid: { value: 123, status: 'stale' }, windowCount: { value: 0, status: 'stale' } },
    });
  });

  it('awaits a fresh detail snapshot and does not expose a count when refresh fails', async () => {
    const h = await fixture();
    h.setRefresh(async () => {
      if (!h.state.env.frontApp.value) throw new Error('fixture missing');
      h.state.env.frontApp.value.windowCount = 1;
      return true;
    });
    expect(await h.call('env_detail', {})).toMatchObject({ value: { windowCount: { value: 1, status: 'ok' } } });
    h.setRefresh(async () => false);
    const result = await h.call('env_detail', {});
    expect(result).toMatchObject({ value: { windowCount: { value: null, status: 'unknown' } } });
    expect((result.value as { app: { value: { windowCount?: number } } }).app.value.windowCount).toBeUndefined();
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

  it('preserves allowed runtime tuning parameters and level values without exposing arbitrary strings', async () => {
    const h = await fixture();
    for (const [param, to, from] of [
      ['mergeWindowMs', 2500, 2000],
      ['fileMergeWindowMs', 6000, 5000],
      ['deliveryLevel.body.rate', 'record', 'context'],
      ['deliveryLevel.body.anomaly', 'record', 'context'],
      ['deliveryLevel.file.burst', 'context', 'wake'],
    ] as const) {
      expect(await h.call('body_tune', { param, to })).toMatchObject({
        isError: false,
        value: { applied: true, change: { param, from, to } },
      });
    }
    expect(modelTune({ applied: true, change: { param: 'secret', from: '/private/file', to: 'secret' } })).toEqual({
      applied: true,
      change: { param: '[redacted]' },
    });
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
    const update = {
      since: 1_000,
      at: 1_000,
      suppressed: 0,
      changes: [{ signal: alert, count: 1, level: 'context' as const }],
    };
    const agent = { inject: vi.fn(), followup: vi.fn(), send: vi.fn() };
    const deliver = createDelivery(
      () => agent,
      () => true,
      async () => false,
    );
    await deliver('session-a', { kind: 'followup', sessionId: 'session-a', update });
    const text = JSON.stringify(agent.followup.mock.calls).replaceAll('\\"', '"');
    const encoded = /alertId="([A-Za-z0-9_-]+)"/.exec(text)?.[1];
    expect(encoded).toBeDefined();
    expect(text).toContain('feedbackAvailable="true"');
    const decoded = Buffer.from(encoded as string, 'base64url').toString('utf8');
    expect(decoded).toBe(alert.id);
    expect(decoded).not.toContain('/fixture/');
    expect(await h.call('body_tune', { action: 'feedback', alertId: encoded, verdict: 'useful' })).toMatchObject({
      isError: false,
      value: { applied: true },
    });
    expect(h.live.body.tuner.hasAlert(alert.id)).toBe(false);
  });

  it('bounds complete results and removes tool and prompt contributions on disposal', async () => {
    const h = await fixture();
    h.state.env.focusedWindow.value = { title: '汉'.repeat(20_000) };
    const longSingle = await h.call('env_state', { section: 'env' });
    expect(longSingle).toMatchObject({ isError: false, value: { focusedWindow: { value: { title: '[long]' } } } });

    h.state.env.focusedWindow.value = { title: '汉 '.repeat(20_000) };
    const result = await h.call('env_state', { section: 'env' });
    expect(result).toMatchObject({ isError: false, value: { focusedWindow: { value: { title: '汉 '.repeat(256) } } } });
    expect(Buffer.byteLength(JSON.stringify(result.value), 'utf8')).toBeLessThan(32_768);
    expect(modelOutput({ text: 'x '.repeat(17_000) })).toMatchObject({ truncated: true });
    expect((await h.ctx.systemPrompt.assemble()).sections.some((section) => section.name === 'asi-sense')).toBe(true);
    h.off();
    expect(h.ctx.tools.get('env_state')).toBeUndefined();
    expect((await h.ctx.systemPrompt.assemble()).sections.some((section) => section.name === 'asi-sense')).toBe(false);
  });

  it('keeps file.activity rule kind unredacted in modelRules and projects globalFileWatch summary without leaking exclusions', () => {
    const projectedRules = modelRules([
      {
        id: 'file-activity',
        approved: true,
        level: 'record',
        createdBy: 'user',
        match: { kind: 'file.activity', subject: '/Users/alice/secret-repo/src' },
      },
      {
        id: 'burst-rule',
        approved: true,
        level: 'wake',
        createdBy: 'user',
        match: { kind: 'file.burst', subject: '/Users/alice/other-repo' },
      },
    ]);
    const rulesJson = JSON.stringify(projectedRules);
    expect(rulesJson).toContain('"kind":"file.activity"');
    expect(rulesJson).toContain('"kind":"file.burst"');
    expect(rulesJson).not.toContain('[redacted]');
    expect(rulesJson).not.toContain('/Users/alice');

    const store = new StateStore(
      () => 1_000,
      60_000,
      () => 1_000,
    );
    store.apply({
      id: 'gfw-fact',
      kind: 'fact.updated',
      at: 1_000,
      source: { id: 'files-global', api: 'watch', host: 'local' },
      subject: 'env.globalFileWatch',
      data: {
        path: 'env.globalFileWatch',
        ttlMs: 60_000,
        status: 'ok',
        value: {
          enabled: true,
          status: 'partial-denied',
          root: '/Users/alice/custom-root',
          windowMs: 10_000,
          eventsPerSec: 42,
          degraded: false,
          countOnly: false,
          deniedPaths: ['/Users/alice/Library/Mail', '/Users/alice/Library/Messages'],
          exclusions: ['/System', '~/SecretVault'],
        },
      },
    });
    const envProjected = modelState(store.snapshot(), 1_000, 'env') as Record<string, unknown>;
    const gfw = envProjected.globalFileWatch as { value?: Record<string, unknown>; status?: string };
    expect(gfw.status).toBe('ok');
    expect(gfw.value).toEqual({
      enabled: true,
      status: 'partial-denied',
      windowMs: 10_000,
      eventsPerSec: 42,
      degraded: false,
      countOnly: false,
      deniedCount: 2,
      exclusionCount: 2,
    });
    const stateJson = JSON.stringify(envProjected);
    expect(stateJson).not.toContain('SecretVault');
    expect(stateJson).not.toContain('Mail');
    expect(stateJson).not.toContain('custom-root');
  });

  it('masks home-root rule subjects in modelRules but keeps child directory names', () => {
    const projected = JSON.parse(
      JSON.stringify(
        modelRules([
          {
            id: 'root-activity',
            approved: true,
            level: 'context',
            createdBy: 'user',
            match: { kind: 'file.activity', subject: '/Users/alice' },
          },
          {
            id: 'root-burst',
            approved: true,
            level: 'wake',
            createdBy: 'user',
            match: { kind: 'file.burst', subject: '/home/bob-dev' },
          },
          {
            id: 'root-changed',
            approved: true,
            level: 'record',
            createdBy: 'user',
            match: { kind: 'file.changed', subject: os.homedir() },
          },
          {
            id: 'child-changed',
            approved: true,
            level: 'context',
            createdBy: 'user',
            match: { kind: 'file.changed', subject: '/Users/alice/secret-repo/src' },
          },
        ]),
      ),
    ) as Array<{ id: string; match: { subject: string } }>;
    const subjects = new Map(projected.map((rule) => [rule.id, rule.match.subject]));
    expect(subjects.get('root-activity')).toBe('~');
    expect(subjects.get('root-burst')).toBe('~');
    expect(subjects.get('root-changed')).toBe('~');
    expect(subjects.get('child-changed')).toBe('src');
  });

  it('exposes env.system in env_state and keeps system/screen/session/job.failed rule kinds unredacted in modelRules', async () => {
    const h = await fixture();
    h.state.env.system = {
      value: { locked: true, lastSleepAt: 500, lastWakeAt: 900 },
      status: 'ok',
      source: { id: 'helper', api: 'ndjson', host: 'local' },
      observedAt: 900,
      ttlMs: 86_400_000,
    };
    const envResult = (await h.call('env_state', { section: 'env' })).value as Record<string, unknown>;
    expect(envResult.system).toMatchObject({
      status: 'ok',
      value: { locked: true, lastSleepAt: 500, lastWakeAt: 900 },
    });

    const kinds = [
      'system.sleep',
      'system.wake',
      'screen.locked',
      'screen.unlocked',
      'session.active',
      'session.inactive',
      'job.failed',
    ];
    const projected = JSON.parse(
      JSON.stringify(
        modelRules(
          kinds.map((kind, i) => ({
            id: `sys-rule-${i}`,
            approved: true,
            level: 'context' as const,
            createdBy: 'user' as const,
            match: { kind },
          })),
        ),
      ),
    ) as Array<{ match: { kind: string } }>;
    expect(projected.map((item) => item.match.kind)).toEqual(kinds);
  });

  it('registers env_metrics and rejects unknown metrics, inverted ranges and invalid steps', async () => {
    const h = await fixture();
    const unknown = await h.call('env_metrics', { metric: 'gpu' });
    expect(unknown.isError).toBe(true);
    const inverted = await h.call('env_metrics', { metric: 'cpu', from: 2_000, to: 1_000 });
    expect(inverted.isError).toBe(true);
    const badStep = await h.call('env_metrics', { metric: 'cpu', step: 299 });
    expect(badStep.isError).toBe(true);
    for (const badDate of [
      '2026-02-30',
      '2026-02-30T12:00:00Z',
      '2026-02-29T00:00:00Z',
      '2026-04-31T00:00:00Z',
      '2026-02-30Z',
      '2026-2-30',
      '2026/02/30',
      'Feb 30, 2026',
    ]) {
      expect((await h.call('env_metrics', { metric: 'cpu', from: badDate })).isError).toBe(true);
    }
    const valid = await h.call('env_metrics', { metric: 'cpu', step: 300 });
    expect(valid).toMatchObject({
      isError: false,
      value: { available: false, metric: 'cpu', unit: 'ratio', stepMs: 300_000, points: [] },
    });
  });

  it('filters email and secret shapes in env_detail event subjects and frontApp bundleId while keeping ~', async () => {
    const h = await fixture();
    const sk = `${'sk-'}${'a'.repeat(22)}12`;
    const ghp = `${'ghp_'}${'b'.repeat(24)}`;
    if (!h.state.env.frontApp.value) throw new Error('fixture missing');
    h.state.env.frontApp.value.bundleId = `user@corp.invalid ${sk}`;
    const src = { id: 'helper.ax', api: 'accessibility', host: 'fixture-host.invalid' };
    const events = [
      { id: 'e1', kind: 'app.activated', subject: os.homedir(), level: 'record' as const, at: 991, source: src },
      {
        id: 'e2',
        kind: 'window.focused',
        subject: `Mail alice@corp.invalid ${sk} ${ghp}`,
        level: 'context' as const,
        at: 992,
        source: src,
      },
    ];
    const rt = {
      ...h.live,
      tools: { ...h.live.tools, envState: () => structuredClone(h.state) },
      events: () => events,
    };
    const res = environmentDetail(rt) as { app: { value: { bundleId: string } }; recentEvents: unknown[] };
    expect(res.app.value.bundleId).not.toMatch(/user@corp\.invalid|sk-aaa/);
    expect(res.recentEvents).toEqual([
      expect.objectContaining({ subject: '~', source: { id: 'helper.ax', api: 'accessibility' } }),
      expect.objectContaining({ subject: 'Mail [host] [redacted] [redacted]' }),
    ]);
    expect(JSON.stringify(res)).not.toMatch(/alice@corp\.invalid|fixture-host\.invalid|sk-aaa|ghp_bbb/);
  });

  it('redacts credential shapes in env_detail/env_state without breaking normal bundleIds or word subjects', async () => {
    const h = await fixture();
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const sg = `SG.${'a'.repeat(16)}.${'b'.repeat(16)}`;
    const hf = `hf_${'c'.repeat(16)}`;
    const pkLive = `pk_live_${'d'.repeat(16)}`;
    const rkTest = `rk_test_${'e'.repeat(16)}`;
    const xoxc = `xoxc-${'1'.repeat(8)}-${'f'.repeat(16)}`;
    const secrets = [
      'token-abc_def_123456',
      'secret_my-key-123456',
      `com.example.sk-${'a'.repeat(18)}12`,
      jwt,
      sg,
      hf,
      pkLive,
      rkTest,
      xoxc,
      'com.example.token-abc-def-123456',
    ];
    const src = { id: 'helper.ax', api: 'accessibility', host: 'fixture-host.invalid' };
    const safeWords = ['SyntaxEditor', 'app-activated', 'token-count', 'secret_note', 'README.md'];
    const events = [
      ...secrets.map((secret, i) => ({
        id: `sec-${i}`,
        kind: 'window.focused',
        subject: secret,
        level: 'record' as const,
        at: 1000 + i,
        source: src,
      })),
      ...safeWords.map((word, i) => ({
        id: `ok-${i}`,
        kind: 'app.activated',
        subject: word,
        level: 'record' as const,
        at: 1100 + i,
        source: src,
      })),
    ];
    const rt = {
      ...h.live,
      tools: {
        ...h.live.tools,
        envState: (section?: 'self' | 'env' | 'observation') =>
          section ? structuredClone(h.state[section]) : structuredClone(h.state),
      },
      events: () => events,
    };

    for (const secret of secrets) {
      if (!h.state.env.frontApp.value) throw new Error('fixture missing');
      h.state.env.frontApp.value.bundleId = secret;
      const stateOut = modelState(h.state, 990, 'env') as { frontApp: { value: { bundleId: string } } };
      expect(stateOut.frontApp.value.bundleId).toBe('[redacted]');
      const detailOut = environmentDetail(rt) as {
        app: { value: { bundleId: string } };
        recentEvents: Array<{ subject: string }>;
      };
      expect(detailOut.app.value.bundleId).toBe('[redacted]');
      for (const s of secrets) {
        expect(JSON.stringify(stateOut.frontApp)).not.toContain(s);
        expect(JSON.stringify(detailOut.app)).not.toContain(s);
        expect(JSON.stringify(detailOut.recentEvents)).not.toContain(s);
      }
      expect(detailOut.recentEvents.slice(-safeWords.length).map((e) => e.subject)).toEqual(safeWords);
    }

    for (const badBundleId of [
      'SingleSegment',
      'com.123.app',
      'com.example.my_app',
      'a.b.c.d.e.f.g.h.i',
      `com.${'a'.repeat(60)}.${'b'.repeat(60)}.app`,
    ]) {
      if (!h.state.env.frontApp.value) throw new Error('fixture missing');
      h.state.env.frontApp.value.bundleId = badBundleId;
      const stateOut = modelState(h.state, 990, 'env') as { frontApp: { value: { bundleId: string } } };
      const detailOut = environmentDetail(rt) as { app: { value: { bundleId: string } } };
      expect(stateOut.frontApp.value.bundleId).toBe('[redacted]');
      expect(detailOut.app.value.bundleId).toBe('[redacted]');
    }

    for (const safeBundleId of ['com.example.App', 'org.mozilla.firefox']) {
      if (!h.state.env.frontApp.value) throw new Error('fixture missing');
      h.state.env.frontApp.value.bundleId = safeBundleId;
      const stateOut = modelState(h.state, 990, 'env') as { frontApp: { value: { bundleId: string } } };
      const detailOut = environmentDetail(rt) as { app: { value: { bundleId: string } } };
      expect(stateOut.frontApp.value.bundleId).toBe(safeBundleId);
      expect(detailOut.app.value.bundleId).toBe(safeBundleId);
    }
  });
});
