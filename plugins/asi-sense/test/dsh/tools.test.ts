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
import type { SensePorts } from '../../src/host/runtime/ports.ts';
import { StateStore } from '../../src/host/state/store.ts';

async function fixture() {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolsService);
  ctx.tools.setExecutor(new NativeToolExecutor(ctx));
  const ports: SensePorts = {
    clock: { wall: () => 1_000, mono: () => 1_000 },
    dsh: {
      onAgentEvent: () => () => {},
      onTool: () => () => {},
      onJob: () => () => {},
      deliver: async () => {},
      tokenSnapshot: async () => undefined,
    },
    storage: { load: async () => undefined, save: async () => {} },
    helper: { spawn: () => undefined },
    probe: { create: () => ({ onSample: () => () => {}, start: () => {}, stop: async () => {} }) },
    files: { watch: () => ({ close: () => {} }) },
  };
  const live = createSenseRuntime(ports, { platform: 'linux' });
  await live.start();
  const state = new StateStore(() => 990).snapshot();
  state.env.frontApp.value = { name: 'Fixture App', bundleId: 'org.fixture.app', pid: 123, windowCount: 2 };
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
  const off = registerSenseTools(ctx, runtime, ports.clock.wall);
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
  const call = (name: string, args: object, options: { agent?: boolean; signal?: AbortSignal } = {}) =>
    executeToolFixture(ctx, {
      callId: ToolCallId(`call-${name}`),
      name,
      arguments: args,
      signal: options.signal ?? new AbortController().signal,
      ...(options.agent === false ? {} : { agent }),
    });
  return { ctx, live, state, call, off, setTitles: (value: boolean) => (titles = value) };
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
        app: { value: { name: 'Fixture App', bundleId: 'org.fixture.app', pid: 123, windowCount: 2 } },
        window: { value: { title: 'Synthetic title' } },
        pid: { value: 123, status: 'ok' },
        windowCount: { value: 2, status: 'ok' },
        recentEvents: [{ kind: 'window.focused' }],
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

  it('distinguishes denied and stale foreground details without inventing a count', async () => {
    const h = await fixture();
    h.state.env.frontApp.value = { name: 'Fixture App', bundleId: 'org.fixture.app', pid: 123 };
    h.state.observation.sources['helper.ax'] = { status: 'denied', lastSignalAt: 990 };
    expect(await h.call('env_detail', {})).toMatchObject({
      value: { pid: { value: 123, status: 'ok' }, windowCount: { value: null, status: 'denied' } },
    });
    h.state.env.frontApp.value.windowCount = 0;
    h.state.env.frontApp.status = 'stale';
    h.state.observation.sources['helper.ax'].status = 'ok';
    expect(await h.call('env_detail', {})).toMatchObject({
      value: { pid: { value: 123, status: 'stale' }, windowCount: { value: 0, status: 'stale' } },
    });
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
    expect(result).toMatchObject({ isError: false, value: { applied: false, change: { by: 'agent' } } });
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
