import type { StartOptions } from '@asi/body-probe';
import type { Body, SenseSnapshot } from '@asi/sense-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSenseRuntime } from '../../../src/sense/host/runtime/index.ts';
import type {
  AgentEvent,
  DshPort,
  JobEvent,
  SenseOptions,
  SensePorts,
  TokenSnapshot,
  ToolEvent,
} from '../../../src/sense/host/runtime/ports.ts';
import { Settings } from '../../../src/sense/host/runtime/settings.ts';
import type { NowReadings } from '../../../src/sense/host/sources/dsh.ts';
import { f, mkBody } from '../helpers.ts';

const activeRuntimes = new Set<ReturnType<typeof createSenseRuntime>>();

afterEach(async () => {
  try {
    await Promise.allSettled([...activeRuntimes].map((rt) => rt.stop()));
  } finally {
    activeRuntimes.clear();
    if (vi.isFakeTimers()) vi.clearAllTimers();
    vi.useRealTimers();
  }
});

function harness(
  savedSettings?: string,
  options: SenseOptions = {},
  nowReadings?: (session?: string) => NowReadings,
  modelJobs?: DshPort['modelJobs'],
) {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  let mono = 0;
  let agent: (event: AgentEvent) => Promise<void> = async () => {};
  let tool: (event: ToolEvent) => Promise<void> = async () => {};
  let job: (event: JobEvent) => Promise<void> = async () => {};
  let sample: (body: Body) => void = () => {};
  let token: (sessionId: string) => Promise<TokenSnapshot | undefined> = async () => undefined;
  const saved = new Map<string, string>();
  if (savedSettings !== undefined) saved.set('settings', savedSettings);
  let failSave = false;
  let probes = 0;
  const startCalls: StartOptions[] = [];

  const ports: SensePorts = {
    clock: { wall: () => Date.now(), mono: () => mono },
    dsh: {
      ...(nowReadings ? { nowReadings } : {}),
      ...(modelJobs ? { modelJobs } : {}),
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
      tokenSnapshot: (sessionId) => token(sessionId),
      openPermissionSettings: vi.fn(async () => {}),
    },
    storage: {
      load: async (key) => saved.get(key),
      save: async (key, json) => {
        if (failSave) throw new Error('storage write failed');
        saved.set(key, json);
      },
    },
    helper: { spawn: () => undefined },
    probe: {
      create: () => ({
        onSample: (cb) => {
          sample = cb;
          return () => {};
        },
        start: (opts?: StartOptions) => {
          probes++;
          startCalls.push(opts ?? {});
        },
        stop: async () => {
          if (probes) probes--;
        },
      }),
    },
  };
  const runtime = createSenseRuntime(ports, { platform: 'linux', ...options });
  activeRuntimes.add(runtime);
  return {
    ports,
    runtime,
    saved,
    startCalls,
    probes: () => probes,
    setFailSave: (v: boolean) => {
      failSave = v;
    },
    setTokenFn: (fn: (sessionId: string) => Promise<TokenSnapshot | undefined>) => {
      token = fn;
    },
    agent: (event: AgentEvent) => agent(event),
    tool: (event: ToolEvent) => tool(event),
    job: (event: JobEvent) => job(event),
    sample: async (body = mkBody({}, Date.now())) => {
      sample(body);
      await vi.advanceTimersByTimeAsync(0);
    },
    advance: async (ms: number) => {
      mono += ms;
      vi.setSystemTime(Date.now() + ms);
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
}

describe('pure sensory createSenseRuntime', () => {
  it('starts, publishes snapshots with 5-min history, and rejects restart after stop', async () => {
    const h = harness();
    const snapshots: SenseSnapshot[] = [];
    const off = h.runtime.subscribeSnapshot((snap) => snapshots.push(snap));
    await h.runtime.start();
    expect(h.probes()).toBe(1);
    expect(h.startCalls).toEqual([{ intervalMs: 2_000 }]);

    await h.sample(
      mkBody({ cpu: f({ usage: 0.33, perCore: [0.33], load1: 1, load5: 1, load15: 1 }, 'ok', Date.now()) }),
    );
    const snap = h.runtime.snapshot();
    expect(snap.state.self.body.cpu.value?.usage).toBe(0.33);
    expect(snap.history.cpu).toHaveLength(1);
    expect(snap.history.cpu[0]?.value).toBe(0.33);
    expect(snapshots.length).toBeGreaterThan(0);

    off();
    await h.runtime.stop();
    expect(h.probes()).toBe(0);
    await expect(h.runtime.start()).rejects.toThrow('runtime cannot be restarted');
  });

  it('switches probe cadence and refresh intervals between normal and eco power modes', async () => {
    const h = harness(undefined, { intervalMs: 2_000, ecoIntervalMs: 12_000 });
    await h.runtime.start();
    expect(h.runtime.getSettings()).toEqual({ paused: false, sendTitles: true, powerMode: 'normal' });
    expect(h.startCalls).toHaveLength(1);

    await h.runtime.actions.setPowerMode('eco', 'battery-low');
    expect(h.probes()).toBe(1);
    expect(h.startCalls).toHaveLength(2);
    expect(h.startCalls[1]).toMatchObject({
      intervalMs: 12_000,
      cadence: { memoryMs: 15_000, batteryMs: 60_000, disksMs: 30_000 },
    });
    expect(h.runtime.getSettings()).toEqual({
      paused: false,
      sendTitles: true,
      powerMode: 'eco',
      powerModeReason: 'battery-low',
    });
    expect(h.runtime.snapshot().sampleIntervalsMs.cpu).toBe(12_000);

    // Idempotent repeat does not restart probe unnecessarily
    await h.runtime.actions.setPowerMode('eco', 'battery-low');
    expect(h.startCalls).toHaveLength(2);

    await h.runtime.actions.setPowerMode('normal');
    expect(h.startCalls).toHaveLength(3);
    expect(h.startCalls[2]).toEqual({ intervalMs: 2_000 });
    expect(h.runtime.getSettings()).toEqual({ paused: false, sendTitles: true, powerMode: 'normal' });
    await h.runtime.stop();
  });

  it('pauses and resumes sampling cleanly and persists settings without legacy WatchRule bloat', async () => {
    // Legacy v0.1.x settings with rules/globalFileWatch/fileExclusions should upgrade cleanly
    const legacy = JSON.stringify({
      version: 1,
      paused: false,
      sendTitles: false,
      globalFileWatch: true,
      fileExclusions: ['/System'],
      rules: [{ id: 'old-rule', match: { kind: 'file.changed' }, level: 'wake' }],
      disabled: ['old-rule'],
    });
    const h = harness(legacy);
    await h.runtime.start();
    expect(h.runtime.getSettings()).toMatchObject({ paused: false, sendTitles: false });

    await h.runtime.actions.pause(true);
    expect(h.probes()).toBe(0);
    expect(h.runtime.getSettings().paused).toBe(true);
    const persisted = JSON.parse(h.saved.get('settings') ?? '{}');
    expect(persisted).toEqual({ version: 1, paused: true, sendTitles: false });

    await h.runtime.actions.pause(false);
    expect(h.probes()).toBe(1);
    expect(h.runtime.getSettings().paused).toBe(false);
    await h.runtime.stop();
  });

  it('excludes registered internal background sessions from foreground observation and token polling', async () => {
    const h = harness();
    const polled: string[] = [];
    h.setTokenFn(async (id) => {
      polled.push(id);
      return {
        contextUsed: id === 'user-1' ? 500 : 99_999,
        contextWindow: 100_000,
        sessionUsage: { input: 500, output: 50, cacheRead: 0, cacheWrite: 0 },
      };
    });
    await h.runtime.start();

    const unregisterInternal = h.runtime.registerInternalSession('needs-maint-1');
    await h.agent({ type: 'created', sessionId: 'user-1' });
    await h.agent({ type: 'created', sessionId: 'needs-maint-1' });
    await h.agent({ type: 'pre-step', sessionId: 'user-1', userInitiated: true });
    expect(h.runtime.currentSessionId()).toBe('user-1');

    // Internal maintenance session step must NOT hijack currentSessionId or overwrite user-1 token facts!
    await h.agent({ type: 'pre-step', sessionId: 'needs-maint-1', userInitiated: false });
    await h.agent({ type: 'post-step', sessionId: 'needs-maint-1' });
    expect(h.runtime.currentSessionId()).toBe('user-1');
    expect(h.runtime.snapshot().activeSessionId).toBe('user-1');
    expect(h.runtime.state().self.body.tokens.value?.contextUsed).toBe(500);
    expect(polled).not.toContain('needs-maint-1');

    // Even if an internal session was created first before registration, registering it demotes it immediately
    const h2 = harness();
    await h2.runtime.start();
    await h2.agent({ type: 'created', sessionId: 'maint-first' });
    expect(h2.runtime.currentSessionId()).toBe('maint-first');
    const off2 = h2.runtime.registerInternalSession('maint-first');
    expect(h2.runtime.currentSessionId()).toBeUndefined();
    off2();
    unregisterInternal();
    await h.runtime.stop();
    await h2.runtime.stop();
  });

  it('expires facts to stale when TTL elapses on monotonic clock', async () => {
    const h = harness();
    await h.runtime.start();
    await h.sample(
      mkBody({
        cpu: f({ usage: 0.25, perCore: [0.25], load1: 1, load5: 1, load15: 1 }, 'ok', Date.now(), 4_000),
      }),
    );
    expect(h.runtime.state().self.body.cpu.status).toBe('ok');
    await h.advance(3_999);
    expect(h.runtime.state().self.body.cpu.status).toBe('ok');
    await h.advance(2);
    expect(h.runtime.state().self.body.cpu.status).toBe('stale');
    await h.runtime.stop();
  });

  it('Settings defaults sendTitles to true and tolerates corrupt JSON gracefully', async () => {
    const s = new Settings({ load: async () => '{corrupt-json', save: async () => {} });
    await s.restore();
    expect(s.paused).toBe(false);
    expect(s.sendTitles).toBe(true);
  });

  it('extends token TTL in eco mode (45s), supports on-demand refresh(), and reports monotonic factStaleInMs()', async () => {
    const h = harness();
    let usedTokens = 90_000;
    h.setTokenFn(async () => ({
      contextUsed: usedTokens,
      contextWindow: 100_000,
      contextWindowSource: 'configured',
      sessionUsage: { input: usedTokens, output: 1_000, cacheRead: 0, cacheWrite: 0 },
    }));
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 'user-eco' });
    await h.agent({ type: 'pre-step', sessionId: 'user-eco', userInitiated: true });
    expect(h.runtime.state().self.body.tokens.value?.contextUsed).toBe(90_000);

    // Switch to eco mode: token poll interval is 15_000ms, TTL is 45_000ms so tokens never expire at 15s/20s
    await h.runtime.actions.setPowerMode('eco', 'test-eco');
    await h.advance(20_000);
    expect(h.runtime.state().self.body.tokens.status).toBe('ok');
    expect(h.runtime.state().self.body.tokens.ttlMs).toBe(45_000);

    // On-demand refresh() immediately reflects post-compaction token usage without waiting for next poll
    usedTokens = 12_000;
    await h.runtime.refresh();
    expect(h.runtime.state().self.body.tokens.value?.contextUsed).toBe(12_000);

    // Monotonic factStaleInMs stays accurate even if wall clock jumps forward by +1 hour
    vi.setSystemTime(Date.now() + 3_600_000);
    const rem = h.runtime.factStaleInMs('self.body.tokens');
    expect(rem).toBe(45_000);

    await h.runtime.stop();
  });
});
