import { createHash } from 'node:crypto';
import type { Body } from '@asi/sense-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeliveryFailure } from '../../src/host/attention/drain.ts';
import { DEFAULT_RULES } from '../../src/host/attention/rules.ts';
import { defaultBodyRules } from '../../src/host/body/index.ts';
import { createSenseRuntime } from '../../src/host/runtime/index.ts';
import type {
  AgentEvent,
  DshPort,
  FileChange,
  JobEvent,
  SenseOptions,
  SensePorts,
  TokenSnapshot,
  ToolEvent,
} from '../../src/host/runtime/ports.ts';
import { Settings } from '../../src/host/runtime/settings.ts';
import { pauseAction } from '../../src/host/runtime/tools.ts';
import type { NowReadings } from '../../src/host/sources/dsh.ts';
import { f, mkBody } from '../body/helpers.ts';

afterEach(() => vi.useRealTimers());

function harness(savedSettings?: string, options: SenseOptions = {}, nowReadings?: (session?: string) => NowReadings) {
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
      ...(nowReadings ? { nowReadings } : {}),
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
    ...options,
  });
  return {
    ports,
    runtime,
    delivered,
    agent: (event: AgentEvent) => agent(event),
    tool: (event: ToolEvent) => tool(event),
    job: (event: JobEvent) => job({ sessionId: runtime.currentSessionId(), ...event }),
    file: async (event: FileChange) => {
      file(event);
      await vi.advanceTimersByTimeAsync(0);
    },
    fileRaw: (event: FileChange) => file(event),
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
  it('publishes local location and configured paths while explaining absent session facts', async () => {
    const h = harness(undefined, { rules: [] });
    await h.runtime.start();
    const state = h.runtime.state();
    expect(state.env.where.harness).toMatchObject({
      status: 'ok',
      value: { host: expect.any(String), os: expect.any(String), pid: expect.any(Number) },
    });
    expect(state.env.where.observed).toMatchObject({
      status: 'ok',
      value: { host: expect.any(String), userSession: expect.any(String) },
    });
    expect(state.env.where.model).toMatchObject({ status: 'unknown', reason: '没有活动会话' });
    expect(state.env.where.toolExec).toMatchObject({ status: 'unknown', reason: expect.any(String) });
    expect(state.self.activity).toMatchObject({ status: 'unknown', reason: '没有活动会话' });
    expect(state.self.pending).toMatchObject({ status: 'unknown', reason: '没有活动会话' });
    expect(state.self.tools).toMatchObject({ status: 'unknown', reason: '没有活动会话' });
    expect(state.self.permissions).toMatchObject({ status: 'unknown', reason: expect.any(String) });
    expect(state.env.activeJobs).toMatchObject({ status: 'unknown', reason: expect.any(String) });
    expect(state.env.watchedPaths).toMatchObject({ status: 'ok', value: {} });
    await h.runtime.stop();
  });

  it('tracks configured file patterns before changes and removes them when disabled', async () => {
    const h = harness();
    await h.runtime.start();
    expect(h.runtime.state().env.watchedPaths.value?.['/workspace/**']).toEqual({ lastChange: 0, changes: 0 });
    await h.file({ path: '/workspace/fixture.txt', change: 'add' });
    expect(h.runtime.state().env.watchedPaths.value?.['/workspace/**']?.changes).toBe(1);
    await h.runtime.actions.toggleRule('files-wake', false);
    expect(h.runtime.state().env.watchedPaths.value).toEqual({});
    await h.runtime.stop();
  });

  it('refreshes DSH snapshots on the timer and disposes the timer on stop', async () => {
    let activity = 'idle';
    const h = harness(undefined, {}, () => ({ 'self.activity': { value: activity } }));
    await h.runtime.start();
    expect(h.runtime.state().self.activity.value).toBe('idle');
    activity = 'thinking';
    await h.advance(5_000);
    expect(h.runtime.state().self.activity.value).toBe('thinking');
    await h.runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the delivery target for now facts after the latest session closes', async () => {
    const h = harness(undefined, {}, (id) => ({ 'self.tools': { value: id ? [id] : [] } }));
    await h.runtime.start();
    for (const sessionId of ['a', 'b', 'c']) {
      await h.agent({ type: 'created', sessionId });
      await h.agent({ type: 'pre-step', sessionId });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(h.runtime.state().self.tools.value).toEqual(['c']);
    await h.agent({ type: 'disposed', sessionId: 'c' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.state().self.tools.value).toEqual(['b']);
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.state().self.tools.value).toEqual(['a']);
    await h.agent({ type: 'disposed', sessionId: 'b' });
    await h.agent({ type: 'disposed', sessionId: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.state().self.tools.value).toEqual([]);
    await h.runtime.stop();
  });

  it('never delivers foreign or unowned job commands after retargeting', async () => {
    const h = harness();
    await h.runtime.start();
    for (const sessionId of ['a', 'b']) await h.agent({ type: 'created', sessionId });
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    await h.job({ type: 'exited', id: 'a-job', sessionId: 'a', command: 'private-a-command', exitCode: 1 });
    await h.job({ type: 'exited', id: 'orphan', sessionId: undefined, command: 'private-orphan-command', exitCode: 1 });
    await h.agent({ type: 'pre-step', sessionId: 'b' });
    await h.advance(3_000);
    expect(JSON.stringify(h.delivered)).not.toContain('private-a-command');
    expect(JSON.stringify(h.delivered)).not.toContain('private-orphan-command');
    expect(JSON.stringify(h.delivered)).not.toContain('orphan');
    expect(h.runtime.events().some((event) => event.subject === 'private-orphan-command')).toBe(true);
    await h.job({ type: 'exited', id: 'b-job', sessionId: 'b', command: 'private-b-command', exitCode: 1 });
    await h.advance(3_000);
    expect(h.delivered).toContainEqual(
      expect.objectContaining({
        sessionId: 'b',
        kind: 'send',
        update: expect.objectContaining({
          changes: expect.arrayContaining([
            expect.objectContaining({ signal: expect.objectContaining({ subject: 'b-job' }) }),
          ]),
        }),
      }),
    );
    expect(JSON.stringify(h.delivered)).not.toContain('private-b-command');
    await h.runtime.stop();
  });

  it('does not transfer an old job to a recreated session with the same id', async () => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 'a' });
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    await h.job({ type: 'exited', id: 'old-job', sessionId: 'a', command: 'private-old-command', exitCode: 1 });
    await h.agent({ type: 'disposed', sessionId: 'a' });
    await h.agent({ type: 'created', sessionId: 'a' });
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    await h.advance(3_000);
    expect(JSON.stringify(h.delivered)).not.toContain('old-job');
    expect(JSON.stringify(h.delivered)).not.toContain('private-old-command');
    await h.runtime.stop();
  });

  it('keeps token read failures distinct from missing usage until session presence changes', async () => {
    const h = harness();
    h.ports.dsh.tokenSnapshot = async () => {
      throw new Error('private details');
    };
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 'a' });
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    expect(h.runtime.state().self.body.tokens).toMatchObject({ status: 'unavailable', reason: '用量读取失败' });
    expect(JSON.stringify(h.runtime.state().self.body.tokens)).not.toContain('private details');
    await h.agent({ type: 'created', sessionId: 'b' });
    await h.agent({ type: 'disposed', sessionId: 'b' });
    expect(h.runtime.state().self.body.tokens.reason).toBe('用量读取失败');
    await h.agent({ type: 'disposed', sessionId: 'a' });
    expect(h.runtime.state().self.body.tokens.reason).toBe('没有活动会话');
    await h.runtime.stop();
  });

  it('stops retrying after ten failures, reports degradation and recovers after a later delivery', async () => {
    const h = harness();
    let attempts = 0;
    let failing = true;
    h.ports.dsh.deliver = async () => {
      attempts++;
      if (failing) throw new Error('fixture failure');
    };
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's', userInitiated: true });
    await h.job({ type: 'exited', id: 'failed-job', exitCode: 1 });
    await h.advance(2_000);
    expect(attempts).toBe(1);
    expect(h.runtime.state().observation.sources.delivery).toMatchObject({
      status: 'unavailable',
      error: '投递失败，正在重试（1 次）',
    });
    for (let i = 0; i < 9; i++) {
      const delay = Math.min(1_000 * 2 ** i, 60_000);
      await h.advance(delay - 1);
      expect(attempts).toBe(i + 1);
      await h.advance(1);
      expect(attempts).toBe(i + 2);
    }
    expect(attempts).toBe(10);
    expect(h.runtime.state().observation.sources.delivery).toMatchObject({
      status: 'unavailable',
      error: '投递失败，已暂停重试（10 次）',
    });
    await h.advance(120_000);
    expect(attempts).toBe(10);
    failing = false;
    await h.job({ type: 'exited', id: 'later-job', exitCode: 1 });
    await h.advance(2_000);
    expect(attempts).toBe(11);
    expect(h.runtime.state().observation.sources.delivery).toMatchObject({ status: 'ok' });
    await h.runtime.stop();
  });

  it('resets the retry budget when the selected session changes', async () => {
    const h = harness();
    let attempts = 0;
    h.ports.dsh.deliver = async () => {
      attempts++;
      throw new Error('fixture failure');
    };
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 'a' });
    await h.agent({ type: 'created', sessionId: 'b' });
    await h.agent({ type: 'pre-step', sessionId: 'a', userInitiated: true });
    await h.file({ path: '/workspace/retry.txt', change: 'modify' });
    await h.advance(5_000);
    await h.advance(1_000);
    expect(attempts).toBe(2);
    await h.agent({ type: 'pre-step', sessionId: 'b', userInitiated: true }).catch(() => {});
    expect(attempts).toBe(3);
    for (let i = 0; i < 9; i++) await h.advance(Math.min(1_000 * 2 ** i, 60_000));
    expect(attempts).toBe(12);
    expect(h.runtime.state().observation.sources.delivery).toMatchObject({
      status: 'unavailable',
      error: '投递失败，已暂停重试（10 次）',
    });
    await h.runtime.stop();
  });

  it('expires a retry after ten monotonic minutes even if fewer than ten attempts ran', async () => {
    const h = harness();
    let attempts = 0;
    h.ports.dsh.deliver = async () => {
      attempts++;
      throw new Error('fixture failure');
    };
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    await h.job({ type: 'exited', id: 'failed-job', exitCode: 1 });
    await h.advance(2_000);
    await h.advance(600_000);
    expect(attempts).toBe(1);
    expect(h.runtime.state().observation.sources.delivery).toMatchObject({
      status: 'unavailable',
      error: '投递失败，已暂停重试（1 次）',
    });
    await h.runtime.stop();
  });

  it('records an unknown outcome without retrying it', async () => {
    const h = harness();
    let attempts = 0;
    h.ports.dsh.deliver = async () => {
      attempts++;
      throw new DeliveryFailure('unknown', 0, new Error('fixture'));
    };
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    await h.job({ type: 'exited', id: 'failed-job', exitCode: 1 });
    await h.advance(2_000);
    await h.advance(120_000);
    expect(attempts).toBe(1);
    expect(h.runtime.events().some((event) => event.kind === 'delivery-unknown')).toBe(true);
    expect(h.runtime.state().observation.sources.delivery).toMatchObject({
      status: 'unavailable',
      error: '投递结果未知，未重试',
    });
    await h.runtime.stop();
  });

  it('records an unknown in-flight outcome even when the selected session changes', async () => {
    const h = harness();
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let attempts = 0;
    h.ports.dsh.deliver = async () => {
      attempts++;
      entered();
      await pending;
      throw new DeliveryFailure('unknown', 0, new Error('fixture'));
    };
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 'a' });
    await h.agent({ type: 'created', sessionId: 'b' });
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    await h.job({ type: 'exited', id: 'completed-job', exitCode: 0 });
    const old = h.agent({ type: 'pre-step', sessionId: 'a' }).catch(() => {});
    await started;
    const next = h.agent({ type: 'pre-step', sessionId: 'b' }).catch(() => {});
    release();
    await Promise.all([old, next]);
    expect(attempts).toBe(1);
    expect(h.runtime.events().some((event) => event.kind === 'delivery-unknown')).toBe(true);
    expect(h.runtime.state().observation.sources.delivery?.status).toBe('unavailable');
    await h.runtime.stop();
  });

  it('waits for a staged context message to commit before clearing degradation', async () => {
    const h = harness();
    let committed = (_sessionId: string) => {};
    Object.assign(h.ports.dsh, {
      onDeliveryCommitted: (cb: (sessionId: string) => void) => {
        committed = cb;
        return () => {};
      },
    });
    let failing = true;
    h.ports.dsh.deliver = async () => {
      if (failing) throw new Error('fixture failure');
    };
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    await h.job({ type: 'exited', id: 'failed-job', exitCode: 1 });
    await h.advance(2_000);
    for (let i = 0; i < 9; i++) await h.advance(Math.min(1_000 * 2 ** i, 60_000));
    failing = false;
    await h.job({ type: 'exited', id: 'successful-job', exitCode: 0 });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    expect(h.runtime.state().observation.sources.delivery?.status).toBe('unavailable');
    committed('s');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.state().observation.sources.delivery?.status).toBe('ok');
    await h.runtime.stop();
  });

  it('notifies once after a body sample commits battery and memory alerts', async () => {
    const h = harness();
    await h.runtime.start();
    const body = (percent: number, pressure: 'normal' | 'critical') =>
      mkBody({
        battery: { ...f({ percent, charging: false }), observedAt: Date.now() },
        memory: { ...f({ total: 100, used: 50, pressure, swapUsed: 0 }), observedAt: Date.now() },
      });
    await h.sample(body(80, 'normal'));
    await h.advance(1_000);
    const frames: string[][] = [];
    h.runtime.onChange(() => {
      throw new Error('subscriber failure');
    });
    h.runtime.onChange(() => {
      frames.push(
        h.runtime
          .events()
          .filter((event) => event.kind === 'body.threshold')
          .map((event) => event.subject),
      );
    });
    await h.sample(body(3, 'critical'));
    expect(frames).toEqual([['battery', 'memory']]);
    expect(h.runtime.body.monitor.restoredState).toMatchObject({ battery: 'critical', memory: 'critical' });
    await h.runtime.stop();
  });

  it('notifies independent events and later samples while alert storage is hung', async () => {
    const h = harness();
    await h.runtime.start();
    const rss = (value: number) =>
      mkBody({
        harnessProcess: { ...f({ rss: value, cpu: 0, uptimeSec: 1 }), observedAt: Date.now() },
      });
    await h.sample(rss(100));
    await h.advance(5_000);
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saving = false;
    h.ports.storage.save = async (key) => {
      if (key === 'body') {
        saving = true;
        await stalled;
      }
    };
    const frames: string[][] = [];
    h.runtime.onChange(() => frames.push(h.runtime.events().map((event) => event.kind)));
    await h.sample(rss(200));
    expect(saving).toBe(true);
    expect(frames.some((events) => events.includes('body.rate'))).toBe(true);
    frames.length = 0;
    await h.job({ type: 'started', id: 'independent' });
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.some((events) => events.includes('job.started'))).toBe(true);
    await h.advance(2_000);
    await h.sample(rss(300));
    expect(h.runtime.state().self.body.harnessProcess.value?.rss).toBe(300);
    release();
    await h.runtime.stop();
  });

  it('does not notify old or new change subscribers after stop', async () => {
    const h = harness();
    await h.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    const old = vi.fn();
    const late = vi.fn();
    h.runtime.onChange(old);
    await h.runtime.stop();
    h.runtime.onChange(late);
    await expect(h.runtime.actions.pause(false)).rejects.toThrow('stopped');
    await vi.advanceTimersByTimeAsync(0);
    expect(old).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
  });

  it('rejects a start stopped while settings load is pending without installing resources', async () => {
    const h = harness();
    let resolve!: (value: string | undefined) => void;
    h.ports.storage.load = (key) =>
      key === 'settings'
        ? new Promise((done) => {
            resolve = done;
          })
        : Promise.resolve(undefined);
    const start = h.runtime.start();
    const rejected = expect(start).rejects.toThrow('stopped');
    await h.runtime.stop();
    resolve(undefined);
    await rejected;
    expect(h.probeCount()).toBe(0);
    expect(h.watcherCount()).toBe(0);
    await expect(h.runtime.actions.pause(false)).rejects.toThrow('stopped');
  });

  it('closes a body restore that finishes after stop without starting its probe', async () => {
    const h = harness();
    let resolve!: (value: string | undefined) => void;
    let entered!: () => void;
    const loading = new Promise<void>((done) => {
      entered = done;
    });
    h.ports.storage.load = (key) =>
      key === 'body'
        ? new Promise((done) => {
            resolve = done;
            entered();
          })
        : Promise.resolve(undefined);
    const start = h.runtime.start();
    const rejected = expect(start).rejects.toThrow('stopped');
    await loading;
    await h.runtime.stop();
    resolve(undefined);
    await rejected;
    expect(h.probeCount()).toBe(0);
    await expect(h.runtime.body.tuner.propose({ param: 'rate.rss.maxRatio', to: 0.6 })).rejects.toThrow('closed');
  });

  it('does not deliver when a stopped pre-step resumes after token lookup', async () => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.job({ type: 'exited', id: 'ok', exitCode: 0 });
    let resolve!: (value: TokenSnapshot | undefined) => void;
    h.ports.dsh.tokenSnapshot = () =>
      new Promise((done) => {
        resolve = done;
      });
    const step = h.agent({ type: 'pre-step', sessionId: 's' });
    await Promise.resolve();
    await Promise.resolve();
    const stop = h.runtime.stop();
    resolve(undefined);
    await Promise.all([step, stop]);
    expect(h.delivered).toEqual([]);
  });

  it('discards an older pre-step when another session pre-steps during token lookup', async () => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 'a' });
    await h.agent({ type: 'created', sessionId: 'b' });
    let release!: (value: TokenSnapshot | undefined) => void;
    h.ports.dsh.tokenSnapshot = (id) =>
      id === 'a'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(undefined);
    const old = h.agent({ type: 'pre-step', sessionId: 'a' });
    await Promise.resolve();
    await Promise.resolve();
    await h.agent({ type: 'pre-step', sessionId: 'b' });
    release(undefined);
    await old;
    await h.job({ type: 'exited', id: 'wake', exitCode: 1 });
    await h.advance(2_000);
    expect(h.delivered).toContainEqual(expect.objectContaining({ sessionId: 'b' }));
    expect(h.delivered.some((intent) => intent.sessionId === 'a')).toBe(false);
    await h.runtime.stop();
  });

  it('discards a pre-step for a disposed session even if the same id is recreated', async () => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 'a' });
    let release!: (value: TokenSnapshot | undefined) => void;
    h.ports.dsh.tokenSnapshot = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const old = h.agent({ type: 'pre-step', sessionId: 'a' });
    await Promise.resolve();
    await Promise.resolve();
    await h.agent({ type: 'disposed', sessionId: 'a' });
    await h.agent({ type: 'created', sessionId: 'a' });
    release(undefined);
    await old;
    await h.job({ type: 'exited', id: 'wake', exitCode: 1 });
    await h.advance(2_000);
    expect(h.delivered).toEqual([]);
    expect(h.runtime.events().find((event) => event.subject === 'wake')?.reason).toBe('session-private');
    await h.runtime.stop();
  });

  it('waits for an in-flight action and rejects it after the runtime stops', async () => {
    const h = harness();
    let release!: () => void;
    h.ports.dsh.openPermissionSettings = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    await h.runtime.start();
    const action = h.runtime.actions.openPermissionSettings();
    const rejected = expect(action).rejects.toThrow('stopped');
    let stopped = false;
    const stop = h.runtime.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await rejected;
    await stop;
    expect(stopped).toBe(true);
  });

  it('waits for a timer-triggered token callback and discards its late result', async () => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    let release!: (value: TokenSnapshot | undefined) => void;
    h.ports.dsh.tokenSnapshot = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    await h.advance(5_000);
    let stopped = false;
    const stop = h.runtime.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release(undefined);
    await stop;
    expect(stopped).toBe(true);
  });

  it('reassigns a pending wake to the busy selected session and charges its budget', async () => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 'a' });
    await h.agent({ type: 'created', sessionId: 'b' });
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    await h.agent({ type: 'post-step', sessionId: 'a' });
    await h.file({ path: '/workspace/first', change: 'modify' });
    const signalId = h.runtime.events().find((event) => event.subject === '/workspace/first')?.id;
    await h.agent({ type: 'pre-step', sessionId: 'b' });
    await h.advance(5_000);
    expect(h.delivered[0]).toMatchObject({ kind: 'send', sessionId: 'b', target: 'next-step' });
    expect(h.delivered[0]?.deliveryId).toBe(
      createHash('sha256')
        .update(JSON.stringify(['b', [signalId]]))
        .digest('hex'),
    );
    await h.file({ path: '/workspace/second', change: 'modify' });
    await h.advance(5_000);
    await h.agent({ type: 'pre-step', sessionId: 'b' });
    expect(h.delivered[1]).toMatchObject({ kind: 'inject', sessionId: 'b' });
    await h.runtime.stop();
  });

  it('retains a failed wake across disposal until another session pre-step', async () => {
    const h = harness();
    let fail = true;
    const deliver = h.ports.dsh.deliver;
    h.ports.dsh.deliver = async (id, intent) => {
      if (fail) {
        fail = false;
        throw new Error('not delivered');
      }
      await deliver(id, intent);
    };
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 'a' });
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    await h.agent({ type: 'post-step', sessionId: 'a' });
    await h.file({ path: '/workspace/failed', change: 'modify' });
    await h.advance(5_000);
    await h.agent({ type: 'disposed', sessionId: 'a' });
    await h.advance(1_000);
    expect(h.delivered).toEqual([]);
    await h.agent({ type: 'created', sessionId: 'b' });
    await h.agent({ type: 'pre-step', sessionId: 'b' });
    expect(h.delivered).toContainEqual(expect.objectContaining({ sessionId: 'b', kind: 'send' }));
    await h.runtime.stop();
  });

  it('classifies job and tool exits using the active tool pid window', async () => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    await h.tool({ type: 'pre-execute', sessionId: 's', toolCallId: 't', pid: 42, cwd: '/workspace' });
    await h.job({ type: 'exited', id: 'j', pid: 42, exitCode: 1 });
    await h.job({ type: 'started', id: 'child', ppid: 42 });
    await h.job({ type: 'exited', id: 'grandchild', ancestors: [1, 42], exitCode: 1 });
    await h.job({ type: 'exited', id: 'cwd', cwd: '/workspace/subdir', exitCode: 1 });
    await h.tool({ type: 'post-execute', sessionId: 's', toolCallId: 't', pid: 42, exitCode: 1 });
    expect(h.runtime.events().filter((e) => e.kind === 'job.exited')).toEqual([
      expect.objectContaining({ cause: 'agent', level: 'record' }),
      expect.objectContaining({ cause: 'agent', level: 'record' }),
      expect.objectContaining({ cause: 'agent', level: 'record' }),
      expect.objectContaining({ cause: 'agent', level: 'record' }),
    ]);
    expect(h.runtime.events().find((e) => e.kind === 'job.started')).toMatchObject({ cause: 'agent', level: 'record' });
    await h.runtime.stop();
  });

  it.each([
    { delay: 300, path: '/workspace/repo/a', agent: true },
    { delay: 1_500, path: '/workspace/repo/a', agent: true },
    { delay: 1_999, path: '/workspace/repo/a', agent: true },
    { delay: 2_000, path: '/workspace/repo/a', agent: false },
    { delay: 2_500, path: '/workspace/repo/a', agent: false },
    { delay: 300, path: '/workspace/other/a', agent: false },
    { delay: 2_500, path: '/workspace/repo/a', agent: false, oldMtime: true },
  ])('classifies a file callback after $delay ms at $path (agent=$agent)', async (scenario) => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    await h.agent({ type: 'post-step', sessionId: 's' });
    await h.tool({ type: 'pre-execute', sessionId: 's', toolCallId: 't', cwd: '/workspace/repo' });
    await h.advance(50);
    const mtime = Date.now();
    await h.advance(50);
    await h.tool({ type: 'post-execute', sessionId: 's', toolCallId: 't' });
    await h.advance(scenario.delay);
    await h.file({ path: scenario.path, change: 'modify', ...(scenario.oldMtime ? { at: mtime } : {}) });
    const event = h.runtime.events().find((entry) => entry.kind === 'file.changed');
    expect(event).toMatchObject(
      scenario.agent ? { cause: 'agent', level: 'record', reason: 'self-caused' } : { cause: 'unknown', level: 'wake' },
    );
    await h.advance(5_001);
    expect(h.delivered.map((intent) => intent.kind)).toEqual(scenario.agent ? [] : ['followup']);
    await h.runtime.stop();
  });

  it('uses monotonic receipt time despite a wall-clock rollback for file and same-pid job grace', async () => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    await h.agent({ type: 'post-step', sessionId: 's' });
    await h.tool({ type: 'pre-execute', sessionId: 's', toolCallId: 't', pid: 42, cwd: '/workspace/repo' });
    await h.advance(100);
    await h.tool({ type: 'post-execute', sessionId: 's', toolCallId: 't' });
    vi.setSystemTime(Date.now() - 10_000);
    await h.advance(300);
    await h.file({ path: '/workspace/repo/a', change: 'modify' });
    expect(h.runtime.events().find((entry) => entry.kind === 'file.changed')).toMatchObject({
      cause: 'agent',
      level: 'record',
    });
    await h.job({ type: 'exited', id: 'late-job', pid: 42, exitCode: 1, at: Date.now() + 10_000 });
    expect(h.runtime.events().find((entry) => entry.subject === 'late-job')).toMatchObject({
      cause: 'agent',
      level: 'record',
      reason: 'self-caused',
    });
    await h.runtime.stop();
  });

  it.each([
    { grace: 500, delay: 499, cause: 'agent', level: 'record' },
    { grace: 500, delay: 500, cause: 'unknown', level: 'wake' },
    { grace: 0, delay: 1, cause: 'unknown', level: 'wake' },
  ])('honors a configured $grace ms grace at $delay ms', async ({ grace, delay, cause, level }) => {
    const h = harness(undefined, { selfCauseGraceMs: grace });
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    await h.agent({ type: 'post-step', sessionId: 's' });
    await h.tool({ type: 'pre-execute', sessionId: 's', toolCallId: 't', cwd: '/workspace/repo' });
    await h.advance(100);
    await h.tool({ type: 'post-execute', sessionId: 's', toolCallId: 't' });
    await h.advance(delay);
    await h.file({ path: '/workspace/repo/a', change: 'modify' });
    expect(h.runtime.events().find((entry) => entry.kind === 'file.changed')).toMatchObject({
      cause,
      level,
    });
    await h.runtime.stop();
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid self-cause grace %s', (selfCauseGraceMs) => {
    expect(() => harness(undefined, { selfCauseGraceMs })).toThrow('selfCauseGraceMs');
  });

  it('notifies stale at the monotonic deadline after wall clock rollback', async () => {
    const h = harness();
    const frames: string[] = [];
    h.runtime.subscribe((state) => frames.push(state.self.body.cpu.status));
    await h.runtime.start();
    const cpu = {
      ...f({ usage: 0.2, perCore: [0.2], load1: 0, load5: 0, load15: 0 }),
      observedAt: Date.now(),
      ttlMs: 1_000,
    };
    await h.sample(mkBody({ cpu }));
    vi.setSystemTime(Date.now() - 10_000);
    await h.advance(1_000);
    expect(frames.at(-1)).toBe('stale');
    await h.runtime.stop();
  });

  it('renews a repeated fact on receipt even when its wall timestamp is unchanged', async () => {
    const h = harness();
    await h.runtime.start();
    const at = Date.now();
    const cpu = (usage: number) => ({
      ...f({ usage, perCore: [usage], load1: 0, load5: 0, load15: 0 }),
      observedAt: at,
      ttlMs: 1_000,
    });
    await h.sample(mkBody({ cpu: cpu(0.2) }));
    await h.advance(500);
    await h.sample(mkBody({ cpu: cpu(0.3) }));
    await h.advance(500);
    expect(h.runtime.state().self.body.cpu.status).toBe('ok');
    await h.advance(500);
    expect(h.runtime.state().self.body.cpu.status).toBe('stale');
    await h.runtime.stop();
  });

  it('notifies at independent disk-volume deadlines after wall-clock rollback', async () => {
    const h = harness();
    const frames: string[] = [];
    h.runtime.subscribe((state) => frames.push(state.self.body.disks.status));
    await h.runtime.start();
    const at = Date.now();
    const disks = {
      ...f([
        { mount: '/', total: 100, free: 50, observedAt: at, ttlMs: 1_000 },
        { mount: '/data', total: 100, free: 50, observedAt: at, ttlMs: 2_000, status: 'ok' as const },
      ]),
      kind: 'disks' as const,
      observedAt: at,
      ttlMs: 5_000,
    };
    await h.sample(mkBody({ disks }));
    vi.setSystemTime(at - 10_000);
    const count = frames.length;
    await h.advance(1_000);
    expect(frames.length).toBeGreaterThan(count);
    expect(h.runtime.state().self.body.disks.value?.[0]?.status).toBe('stale');
    expect(h.runtime.state().self.body.disks.status).toBe('ok');
    await h.advance(1_000);
    expect(h.runtime.state().self.body.disks.status).toBe('stale');
    expect(frames.at(-1)).toBe('stale');
    await h.runtime.stop();
  });

  it('serializes overlapping rule refreshes and never reopens deleted roots', async () => {
    const h = harness();
    const watched = new Set<string>();
    let release!: () => void;
    let closing!: () => void;
    const entered = new Promise<void>((resolve) => {
      closing = resolve;
    });
    h.ports.files.watch = (path) => {
      watched.add(path);
      return {
        close: async () => {
          watched.delete(path);
          if (path === '/workspace/') {
            closing();
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
        },
      };
    };
    await h.runtime.start();
    await h.runtime.tools.envWatch({
      action: 'add',
      rule: { id: 'b', match: { kind: 'file.changed', subject: '/other/**' }, level: 'context' },
    });
    const first = h.runtime.actions.deleteRule('files-wake');
    await entered;
    const second = h.runtime.actions.deleteRule('b');
    release();
    await Promise.all([first, second]);
    expect([...watched]).toEqual([]);
    await h.runtime.stop();
  });

  it('isolates failed restored file rules and keeps other watches active', async () => {
    const rules = [
      {
        id: 'bad',
        match: { kind: 'file.changed', subject: '/bad/**' },
        level: 'context',
        createdBy: 'user',
        approved: true,
      },
      {
        id: 'good',
        match: { kind: 'file.changed', subject: '/good/**' },
        level: 'context',
        createdBy: 'user',
        approved: true,
      },
    ] as const;
    const h = harness(JSON.stringify({ version: 1, paused: false, sendTitles: true, rules, disabled: [] }));
    let good: ((event: FileChange) => void) | undefined;
    h.ports.files.watch = (path, callback) => {
      if (path === '/bad/') throw new Error('synthetic watch failure');
      good = callback;
      return { close: () => {} };
    };
    await h.runtime.start();
    expect(h.runtime.state().observation.sources['files:bad']?.status).toBe('unavailable');
    expect(h.runtime.state().observation.sources['files:good']?.status).toBe('ok');
    good?.({ path: '/good/synthetic.txt', change: 'add' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.state().env.watchedPaths.value?.['/good/synthetic.txt']?.changes).toBe(1);
    expect(h.runtime.state().observation.sources['files:bad']?.status).toBe('unavailable');
    await h.runtime.stop();
  });

  it('marks only the affected rule unavailable on an asynchronous watcher error', async () => {
    const h = harness();
    const callbacks = new Map<string, (event: FileChange) => void>();
    const closed = new Set<string>();
    h.ports.files.watch = (path, callback) => {
      callbacks.set(path, callback);
      return {
        close: () => {
          closed.add(path);
        },
      };
    };
    await h.runtime.start();
    await h.runtime.tools.envWatch({
      action: 'add',
      rule: { id: 'other', match: { kind: 'file.changed', subject: '/other/**' }, level: 'context' },
    });
    const error = { path: '/other', change: 'modify' as const, watchError: true };
    callbacks.get('/other/')?.(error);
    await vi.advanceTimersByTimeAsync(0);
    expect(closed.has('/other/')).toBe(true);
    expect(h.runtime.state().observation.sources['files:other']?.status).toBe('unavailable');
    expect(h.runtime.state().observation.sources['files:files-wake']?.status).toBe('ok');
    callbacks.get('/workspace/')?.({ path: '/workspace/synthetic.txt', change: 'add' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.state().env.watchedPaths.value?.['/workspace/synthetic.txt']?.changes).toBe(1);
    await h.runtime.stop();
  });

  it('serializes a watcher error with later rule refresh and reports recovery', async () => {
    const h = harness();
    let callback: ((event: FileChange) => void) | undefined;
    let release!: () => void;
    let entered!: () => void;
    const closing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    h.ports.files.watch = (path, emit) => {
      if (path === '/workspace/') callback = emit;
      return {
        close: async () => {
          if (path === '/workspace/' && first) {
            first = false;
            entered();
            await barrier;
          }
        },
      };
    };
    await h.runtime.start();
    const error = { path: '/workspace', change: 'modify' as const, watchError: true };
    callback?.(error);
    await closing;
    const add = h.runtime.tools.envWatch({
      action: 'add',
      rule: { id: 'other', match: { kind: 'file.changed', subject: '/other/**' }, level: 'context' },
    });
    release();
    await add;
    expect(h.runtime.state().observation.sources['files:files-wake']?.status).toBe('ok');
    await h.runtime.stop();
  });

  it('does not persist a file rule if validation or watch activation fails', async () => {
    const h = harness();
    let settingsWrites = 0;
    h.ports.storage.save = async (key) => {
      if (key === 'settings') settingsWrites++;
    };
    h.ports.files.watch = (path) => {
      if (path === '/bad/') throw new Error('synthetic watch failure');
      return { close: () => {} };
    };
    await h.runtime.start();
    await expect(
      h.runtime.tools.envWatch({
        action: 'add',
        rule: { id: 'relative', match: { kind: 'file.changed', subject: 'relative/**' }, level: 'context' },
      }),
    ).rejects.toThrow();
    await expect(
      h.runtime.tools.envWatch({
        action: 'add',
        rule: { id: 'bad', match: { kind: 'file.changed', subject: '/bad/**' }, level: 'context' },
      }),
    ).rejects.toThrow('synthetic watch failure');
    expect(settingsWrites).toBe(0);
    expect(h.runtime.rules.list().some((rule) => rule.id === 'relative' || rule.id === 'bad')).toBe(false);
    await h.runtime.stop();
  });

  it('does not save a newly staged rule when its watcher fails before commit', async () => {
    const h = harness();
    let settingsWrites = 0;
    h.ports.storage.save = async (key) => {
      if (key === 'settings') settingsWrites++;
    };
    h.ports.files.watch = (path, callback) => {
      if (path === '/bad/') {
        const event = { path: '/bad', change: 'modify' as const, watchError: true };
        void Promise.resolve().then(() => callback(event));
      }
      return { close: () => {} };
    };
    await h.runtime.start();
    await expect(
      h.runtime.tools.envWatch({
        action: 'add',
        rule: { id: 'bad', match: { kind: 'file.changed', subject: '/bad/**' }, level: 'context' },
      }),
    ).rejects.toThrow();
    expect(settingsWrites).toBe(0);
    expect(h.runtime.rules.list().some((rule) => rule.id === 'bad')).toBe(false);
    await h.runtime.stop();
  });

  it('rechecks a staged watcher when its settings commit was queued', async () => {
    const h = harness();
    let release!: () => void;
    let entered!: () => void;
    let watching!: () => void;
    let callback: ((event: FileChange) => void) | undefined;
    const saving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      watching = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    h.ports.storage.save = async (key) => {
      if (key === 'settings') {
        writes++;
        entered();
        await barrier;
      }
    };
    h.ports.files.watch = (path, emit) => {
      if (path === '/bad/') {
        callback = emit;
        watching();
      }
      return { close: () => {} };
    };
    await h.runtime.start();
    const titles = h.runtime.actions.setSendTitles(false);
    await saving;
    const add = h.runtime.tools.envWatch({
      action: 'add',
      rule: { id: 'bad', match: { kind: 'file.changed', subject: '/bad/**' }, level: 'context' },
    });
    const rejected = expect(add).rejects.toThrow('file watch activation failed');
    await ready;
    const error = { path: '/bad', change: 'modify' as const, watchError: true };
    callback?.(error);
    release();
    await titles;
    await rejected;
    expect(writes).toBe(1);
    expect(h.runtime.rules.list().some((rule) => rule.id === 'bad')).toBe(false);
    await h.runtime.stop();
  });

  it('closes a staged watch when saving the new rule fails', async () => {
    const h = harness();
    const watched = new Set<string>();
    h.ports.files.watch = (path) => {
      watched.add(path);
      return {
        close: () => {
          watched.delete(path);
        },
      };
    };
    await h.runtime.start();
    h.failSave(true);
    await expect(
      h.runtime.tools.envWatch({
        action: 'add',
        rule: { id: 'new', match: { kind: 'file.changed', subject: '/new/**' }, level: 'context' },
      }),
    ).rejects.toThrow('uninstalled');
    expect(watched.has('/new/')).toBe(false);
    expect(h.runtime.rules.list().some((rule) => rule.id === 'new')).toBe(false);
    h.failSave(false);
    await h.runtime.stop();
    expect(watched.size).toBe(0);
  });

  it('closes staged watches when pausing during a pending rule save', async () => {
    const h = harness();
    const watched = new Set<string>();
    let release!: () => void;
    let entered!: () => void;
    const saving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.ports.files.watch = (path) => {
      watched.add(path);
      return {
        close: () => {
          watched.delete(path);
        },
      };
    };
    h.ports.storage.save = async (key, value) => {
      if (key === 'settings' && JSON.parse(value).rules.some((rule: { id: string }) => rule.id === 'new')) {
        entered();
        await barrier;
      }
    };
    await h.runtime.start();
    const add = h.runtime.tools.envWatch({
      action: 'add',
      rule: { id: 'new', match: { kind: 'file.changed', subject: '/new/**' }, level: 'context' },
    });
    await saving;
    const pause = h.runtime.actions.pause(true);
    await Promise.resolve();
    release();
    await Promise.all([add, pause]);
    expect(h.runtime.rules.settings().paused).toBe(true);
    expect(watched.size).toBe(0);
    await h.runtime.actions.pause(false);
    expect([...watched].sort()).toEqual(['/new/', '/workspace/']);
    await h.runtime.stop();
  });

  it('deduplicates one event delivered by overlapping watched roots', async () => {
    const h = harness();
    const watches = new Map<string, (event: FileChange) => void>();
    h.ports.files.watch = (path, cb) => {
      watches.set(path, cb);
      return {
        close: () => {
          watches.delete(path);
        },
      };
    };
    await h.runtime.start();
    await h.runtime.tools.envWatch({
      action: 'add',
      rule: { id: 'nested', match: { kind: 'file.changed', subject: '/workspace/src/**' }, level: 'context' },
    });
    for (let i = 0; i < 26; i++) {
      const event: FileChange = { path: `/workspace/src/${i}.ts`, change: 'delete', at: Date.now() };
      watches.get('/workspace/')?.(event);
      watches.get('/workspace/src/')?.(event);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.events().filter((event) => event.kind === 'file.changed')).toHaveLength(26);
    expect(h.runtime.events().filter((event) => event.kind === 'file.burst')).toHaveLength(0);
    await h.runtime.stop();
  });

  it('preserves same-root same-millisecond deletions while pairing overlapping copies', async () => {
    const h = harness();
    const watches = new Map<string, (event: FileChange) => void>();
    h.ports.files.watch = (path, cb) => {
      watches.set(path, cb);
      return {
        close: () => {
          watches.delete(path);
        },
      };
    };
    await h.runtime.start();
    await h.runtime.tools.envWatch({
      action: 'add',
      rule: { id: 'nested', match: { kind: 'file.changed', subject: '/workspace/src/**' }, level: 'context' },
    });
    const event: FileChange = { path: '/workspace/src/synthetic.ts', change: 'delete', at: Date.now() };
    watches.get('/workspace/')?.(event);
    watches.get('/workspace/')?.(event);
    watches.get('/workspace/src/')?.(event);
    watches.get('/workspace/src/')?.(event);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.events().filter((item) => item.kind === 'file.changed')).toHaveLength(2);
    expect(h.runtime.state().env.watchedPaths.value?.[event.path]?.changes).toBe(2);
    await h.runtime.stop();
  });

  it('counts same-root same-millisecond deletions toward the burst threshold', async () => {
    const h = harness();
    await h.runtime.start();
    for (let i = 0; i < 51; i++) h.fileRaw({ path: '/workspace/synthetic.ts', change: 'delete', at: Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.events().find((item) => item.kind === 'file.burst')?.detail?.deleted).toBe(51);
    await h.runtime.stop();
  });

  it('bounds no-session context by subject and reports evictions', async () => {
    const h = harness();
    await h.runtime.start();
    await h.runtime.actions.toggleRule('files-wake', false);
    await h.runtime.tools.envWatch({
      action: 'add',
      rule: { id: 'files-context', match: { kind: 'file.changed', subject: '/workspace/**' }, level: 'context' },
    });
    for (let i = 0; i < 205; i++) await h.file({ path: `/workspace/file-${i}`, change: 'modify' });
    await h.file({ path: '/workspace/file-204', change: 'modify' });
    expect(h.runtime.events().some((event) => event.reason === 'pending-evicted:5')).toBe(true);
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    const changes = h.delivered.flatMap((intent) => intent.update.changes);
    expect(changes).toHaveLength(200);
    expect(changes.find((change) => change.signal.subject === '/workspace/file-204')?.count).toBe(2);
    expect(changes.some((change) => change.signal.subject === '/workspace/file-0')).toBe(false);
    await h.runtime.stop();
  });

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
    await h.file({ path: '/workspace/failure', change: 'modify' });
    expect(h.runtime.events()).toContainEqual(
      expect.objectContaining({
        kind: 'file.changed',
        level: 'wake',
        reason: 'no-session',
      }),
    );
    await h.runtime.actions.toggleRule('files-wake', false);
    await h.runtime.tools.envWatch({
      action: 'add',
      rule: { id: 'files-context', match: { kind: 'file.changed', subject: '/workspace/**' }, level: 'context' },
    });
    await h.file({ path: '/workspace/success', change: 'modify' });
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]).toMatchObject({
      kind: 'inject',
      update: { changes: [{ signal: { subject: '/workspace/success' } }] },
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

  it('serializes overlapping pause and resume transactions until resources and storage agree', async () => {
    const h = harness();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closeStarted = false;
    let activeWatches = 0;
    let persisted = false;
    h.ports.files.watch = () => {
      activeWatches++;
      return {
        close: async () => {
          closeStarted = true;
          await barrier;
          activeWatches--;
        },
      };
    };
    h.ports.storage.save = async (key, value) => {
      if (key === 'settings') persisted = JSON.parse(value).paused;
    };
    await h.runtime.start();
    const pause = h.runtime.actions.pause(true);
    while (!closeStarted) await Promise.resolve();
    let secondFinished = false;
    const secondPause = h.runtime.actions.pause(true).then(() => {
      secondFinished = true;
    });
    const resume = h.runtime.actions.pause(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(secondFinished).toBe(false);
    expect(h.probeCount()).toBe(0);
    release();
    await Promise.all([pause, secondPause, resume]);
    expect(h.runtime.rules.settings().paused).toBe(false);
    expect(persisted).toBe(false);
    expect(h.probeCount()).toBe(1);
    expect(activeWatches).toBe(1);
    await h.runtime.stop();
    expect(activeWatches).toBe(0);
  });

  it('recovers from a failed pause save before processing the next pause intent', async () => {
    const h = harness();
    let fail = true;
    let persisted = false;
    h.ports.storage.save = async (key, value) => {
      if (key !== 'settings') return;
      if (fail) {
        fail = false;
        throw new Error('uninstalled');
      }
      persisted = JSON.parse(value).paused;
    };
    await h.runtime.start();
    const pause = h.runtime.actions.pause(true);
    const resume = h.runtime.actions.pause(false);
    await expect(pause).rejects.toThrow('uninstalled');
    await resume;
    expect(h.runtime.rules.settings().paused).toBe(false);
    expect(persisted).toBe(false);
    expect(h.probeCount()).toBe(1);
    expect(h.watcherCount()).toBe(1);
    await h.runtime.stop();
  });

  it('restores the paused resources if saving a resume fails', async () => {
    const h = harness();
    await h.runtime.start();
    await h.runtime.actions.pause(true);
    h.failSave(true);
    await expect(h.runtime.actions.pause(false)).rejects.toThrow('uninstalled');
    expect(h.runtime.rules.settings().paused).toBe(true);
    expect(h.probeCount()).toBe(0);
    expect(h.watcherCount()).toBe(0);
    h.failSave(false);
    await h.runtime.actions.pause(false);
    expect(h.probeCount()).toBe(1);
    expect(h.watcherCount()).toBe(1);
    await h.runtime.stop();
  });

  it('rejects subsequent pause requests after rollback fails', async () => {
    const settings = new Settings({ load: async () => undefined, save: async () => {} }, []);
    let paused = false;
    const pause = pauseAction(
      settings,
      () => paused,
      async (value) => {
        paused = value;
        throw new Error('synthetic resource failure');
      },
      () => {},
    );
    await expect(pause(true)).rejects.toThrow('pause failed and rollback failed');
    await expect(pause(false)).rejects.toThrow('pause state unavailable');
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

  it('marks an alert non-feedbackable when registration returns false', async () => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    h.runtime.body.tuner.registerAlert = async () => false;
    const rss = (value: number) => ({ ...f({ rss: value, cpu: 0, uptimeSec: 1 }), observedAt: Date.now() });
    await h.sample(mkBody({ harnessProcess: rss(100) }));
    await h.advance(5_000);
    await h.sample(mkBody({ harnessProcess: rss(200) }));
    await h.agent({ type: 'pre-step', sessionId: 's' });
    const alert = h.delivered
      .flatMap((intent) => intent.update.changes)
      .find((change) => change.signal.kind === 'body.rate');
    expect(alert?.signal.data.feedbackAvailable).toBe(false);
    await h.runtime.stop();
  });
});
