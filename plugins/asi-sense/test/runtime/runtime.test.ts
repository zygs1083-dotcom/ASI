import type { Body } from '@asi/sense-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULES } from '../../src/host/attention/rules.ts';
import { defaultBodyRules } from '../../src/host/body/index.ts';
import { createSenseRuntime } from '../../src/host/runtime/index.ts';
import type {
  AgentEvent,
  DshPort,
  FileChange,
  JobEvent,
  SensePorts,
  TokenSnapshot,
  ToolEvent,
} from '../../src/host/runtime/ports.ts';
import { f, mkBody } from '../body/helpers.ts';

afterEach(() => vi.useRealTimers());

function harness(savedSettings?: string) {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  let mono = 0;
  let agent: (event: AgentEvent) => Promise<void> = async () => {};
  let tool: (event: ToolEvent) => Promise<void> = async () => {};
  let job: (event: JobEvent) => Promise<void> = async () => {};
  let file: (event: FileChange) => void = () => {};
  let sample: (body: Body) => void = () => {};
  let token: TokenSnapshot | undefined;
  let failSave = false;
  let watchers = 0;
  let probes = 0;
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
      tokenSnapshot: async () => token,
    },
    storage: {
      load: async (key) => (key === 'settings' ? savedSettings : undefined),
      save: async () => {
        if (failSave) throw new Error('uninstalled');
      },
    },
    helper: { spawn: () => undefined },
    probe: {
      create: () => ({
        onSample: (cb) => {
          sample = cb;
          return () => {};
        },
        start: () => {
          probes++;
        },
        stop: async () => {
          if (probes) probes--;
        },
      }),
    },
    files: {
      watch: (_path, cb) => {
        watchers++;
        file = cb;
        return {
          close: () => {
            watchers--;
          },
        };
      },
    },
  };
  const runtime = createSenseRuntime(ports, {
    platform: 'linux',
    rules: [
      ...DEFAULT_RULES,
      ...defaultBodyRules(),
      {
        id: 'files-wake',
        match: { kind: 'file.changed', subject: '/workspace/**' },
        level: 'wake',
        createdBy: 'user',
        approved: true,
      },
    ],
  });
  return {
    runtime,
    delivered,
    agent: (event: AgentEvent) => agent(event),
    tool: (event: ToolEvent) => tool(event),
    job: (event: JobEvent) => job(event),
    file: async (event: FileChange) => {
      file(event);
      await vi.advanceTimersByTimeAsync(0);
    },
    failSave: (value: boolean) => {
      failSave = value;
    },
    token: (value: TokenSnapshot | undefined) => {
      token = value;
    },
    sample: async (body = mkBody()) => {
      sample(body);
      await vi.advanceTimersByTimeAsync(0);
    },
    watcherCount: () => watchers,
    probeCount: () => probes,
    advance: async (ms: number) => {
      mono += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
}

describe('host runtime', () => {
  it('wakes once for a failed job and injects a successful exit at the next step', async () => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    await h.agent({ type: 'post-step', sessionId: 's' });
    await h.job({ type: 'exited', id: 'failed', command: 'pnpm test', exitCode: 1 });
    await h.advance(2_000);
    expect(h.delivered.map((d) => d.kind)).toEqual(['followup']);
    await h.job({ type: 'exited', id: 'ok', command: 'pnpm test', exitCode: 0 });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    expect(h.delivered.map((d) => d.kind)).toEqual(['followup', 'inject']);
    await h.runtime.stop();
  });

  it('suppresses file changes caused by an active tool under its cwd', async () => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    await h.agent({ type: 'post-step', sessionId: 's' });
    await h.tool({ type: 'pre-execute', sessionId: 's', toolCallId: 'write', cwd: '/workspace', pid: 42 });
    await h.file({ path: '/workspace/src/a.ts', change: 'modify' });
    await h.advance(5_000);
    expect(h.delivered).toEqual([]);
    expect(h.runtime.events()).toContainEqual(
      expect.objectContaining({
        kind: 'file.changed',
        level: 'record',
        cause: 'agent',
        reason: 'self-caused',
      }),
    );
    expect(h.watcherCount()).toBe(1);
    await h.runtime.stop();
    expect(h.watcherCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aggregates external deletions across subdirectories of a watched root', async () => {
    const h = harness();
    await h.runtime.start();
    await h.runtime.actions.deleteRule('files-wake');
    await h.runtime.tools.envWatch({
      action: 'add',
      rule: { id: 'context-files', match: { kind: 'file.changed', subject: '/workspace/**' }, level: 'context' },
    });
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    await h.agent({ type: 'post-step', sessionId: 's' });
    for (let i = 0; i < 51; i++) {
      await h.file({ path: `/workspace/${i % 2 ? 'a' : 'b'}/${i}.ts`, change: 'delete' });
    }
    await h.advance(2_000);
    expect(h.delivered).toContainEqual(
      expect.objectContaining({
        kind: 'followup',
        update: expect.objectContaining({
          changes: expect.arrayContaining([
            expect.objectContaining({ signal: expect.objectContaining({ kind: 'file.burst', subject: '/workspace' }) }),
          ]),
        }),
      }),
    );
    await h.runtime.stop();
  });

  it('records a no-session wake as suppressed and retains context for the first session', async () => {
    const h = harness();
    await h.runtime.start();
    await h.job({ type: 'exited', id: 'failure', command: 'pnpm test', exitCode: 1 });
    await h.job({ type: 'exited', id: 'success', command: 'pnpm test', exitCode: 0 });
    expect(h.runtime.events()).toContainEqual(
      expect.objectContaining({
        kind: 'job.exited',
        level: 'wake',
        reason: 'no-session',
      }),
    );
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]).toMatchObject({
      kind: 'inject',
      update: { changes: [{ signal: { data: { exitCode: 0 } } }] },
    });
    await h.runtime.stop();
  });

  it('keeps confirmed tuning when an atomic save rejects and disables AI tuning', async () => {
    const h = harness();
    await h.runtime.start();
    expect(await h.runtime.tools.bodyTune({ param: 'rate.rss.maxRatio', to: 0.6 })).toMatchObject({ applied: true });
    h.failSave(true);
    await expect(h.runtime.tools.bodyTune({ param: 'rate.rss.maxRatio', to: 0.7 })).rejects.toThrow('uninstalled');
    expect(h.runtime.body.tuner.get('rate.rss.maxRatio')).toBe(0.6);
    expect(h.runtime.body.tuner.tuningDisabled).toBe('storage-failed');
    h.failSave(false);
    await h.runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes tokens at steps and five seconds, excludes fallback capacity from alerts and clears missing data', async () => {
    const h = harness();
    const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 };
    h.token({ contextWindow: 100, contextUsed: 10, contextWindowSource: 'fallback', sessionUsage: usage });
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    await h.sample();
    await h.agent({ type: 'post-step', sessionId: 's' });
    h.token({ contextWindow: 100, contextUsed: 99, contextWindowSource: 'fallback', sessionUsage: usage });
    await h.advance(5_000);
    await h.sample();
    expect(h.runtime.state().self.body.tokens.value).toMatchObject({
      contextUsed: 99,
      contextWindowSource: 'fallback',
    });
    expect(h.runtime.events().filter((event) => event.kind === 'body.threshold')).toEqual([]);
    h.token(undefined);
    await h.agent({ type: 'post-step', sessionId: 's' });
    expect(h.runtime.state().self.body.tokens).toMatchObject({ status: 'unavailable', value: null });
    await h.runtime.stop();
  });

  it('honors disabled rules restored from storage without retaining constructor rules', async () => {
    const h = harness(
      JSON.stringify({
        version: 1,
        paused: false,
        sendTitles: true,
        rules: [...DEFAULT_RULES, ...defaultBodyRules()],
        disabled: ['job-failed'],
      }),
    );
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    await h.agent({ type: 'post-step', sessionId: 's' });
    await h.job({ type: 'exited', id: 'test', command: 'pnpm test', exitCode: 1 });
    await h.advance(2_000);
    expect(h.delivered).toEqual([]);
    await h.agent({ type: 'pre-step', sessionId: 's' });
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.kind).toBe('inject');
    await h.runtime.stop();
  });

  it('rejects unsupported tuning parameters explicitly', async () => {
    const h = harness();
    await h.runtime.start();
    await expect(h.runtime.tools.bodyTune({ param: 'mergeWindowMs', to: 1_000 })).rejects.toThrow('unsupported-param');
    await h.runtime.stop();
  });

  it('pauses and resumes collection and prevents queued wakes while paused', async () => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    await h.agent({ type: 'post-step', sessionId: 's' });
    await h.job({ type: 'exited', id: 'test', command: 'pnpm test', exitCode: 1 });
    await h.runtime.actions.pause(true);
    expect(h.probeCount()).toBe(0);
    expect(h.watcherCount()).toBe(0);
    await h.advance(3_000);
    expect(h.delivered).toEqual([]);
    await h.runtime.actions.pause(false);
    expect(h.probeCount()).toBe(1);
    expect(h.watcherCount()).toBe(1);
    await h.advance(1);
    expect(h.delivered.map((intent) => intent.kind)).toEqual(['followup']);
    await h.runtime.stop();
    expect(h.probeCount()).toBe(0);
  });

  it('notifies state subscribers at the earliest fact TTL deadline', async () => {
    const h = harness();
    const frames: string[] = [];
    h.runtime.subscribe((state) => {
      frames.push(state.self.body.cpu.status);
    });
    await h.runtime.start();
    const cpu = {
      ...f({ usage: 0.2, perCore: [0.2], load1: 0, load5: 0, load15: 0 }),
      observedAt: Date.now(),
      ttlMs: 1_000,
    };
    await h.sample(mkBody({ cpu }));
    const count = frames.length;
    await h.advance(999);
    expect(frames).toHaveLength(count);
    await h.advance(1);
    expect(frames.at(-1)).toBe('stale');
    expect(frames.length).toBeGreaterThan(count);
    await h.runtime.stop();
  });

  it('binds body alerts to feedback accepted through the agent tool', async () => {
    const h = harness();
    await h.runtime.start();
    const rss = (value: number) => ({
      ...f({ rss: value, cpu: 0, uptimeSec: 1 }),
      observedAt: Date.now(),
    });
    await h.sample(mkBody({ harnessProcess: rss(100) }));
    await h.advance(5_000);
    await h.sample(mkBody({ harnessProcess: rss(200) }));
    const alert = h.runtime.events().find((event) => event.kind === 'body.rate');
    expect(alert).toBeDefined();
    if (!alert) throw new Error('missing body alert');
    const result = await h.runtime.tools.bodyTune({ action: 'feedback', alertId: alert.id, verdict: 'useful' });
    expect(result).toMatchObject({ applied: true });
    expect(h.runtime.events().find((event) => event.id === alert.id)?.feedback).toBe('useful');
    await h.runtime.stop();
  });

  it('publishes post-commit events, settings and tuning changes even while paused', async () => {
    const h = harness();
    await h.runtime.start();
    const observed: { paused: boolean; locked: boolean; event: boolean }[] = [];
    const off = h.runtime.onChange(() =>
      observed.push({
        paused: h.runtime.rules.settings().paused,
        locked: h.runtime.body.tuner.parameters().find((item) => item.key === 'rate.rss.maxRatio')?.locked ?? false,
        event: h.runtime.events().some((item) => item.kind === 'job.exited'),
      }),
    );
    await h.job({ type: 'exited', id: 'synthetic', exitCode: 1 });
    await h.advance(0);
    expect(observed.at(-1)?.event).toBe(true);
    await h.runtime.actions.pause(true);
    await h.runtime.actions.lockParam('rate.rss.maxRatio', true);
    await h.advance(0);
    expect(observed.at(-1)).toMatchObject({ paused: true, locked: true });
    expect(h.runtime.body.monitor.parameters().find((item) => item.key === 'rate.rss.maxRatio')).toMatchObject({
      value: 0.5,
      locked: true,
      source: 'default',
    });
    off();
    await h.runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a body event source and known numeric detail without arbitrary payload', async () => {
    const h = harness();
    await h.runtime.start();
    const rss = (value: number) => ({
      ...f({ rss: value, cpu: 0, uptimeSec: 1 }),
      observedAt: Date.now(),
    });
    await h.sample(mkBody({ harnessProcess: rss(100) }));
    await h.advance(5_000);
    await h.sample(mkBody({ harnessProcess: rss(200) }));
    const alert = h.runtime.events().find((event) => event.kind === 'body.rate');
    expect(alert).toMatchObject({
      source: { id: 'body', api: 'probe', host: 'local' },
      detail: { metric: 'rss', delta: 100, windowMs: 300_000, slope: 20 },
    });
    expect(alert?.detail).not.toHaveProperty('title');
    await h.runtime.stop();
  });
});
