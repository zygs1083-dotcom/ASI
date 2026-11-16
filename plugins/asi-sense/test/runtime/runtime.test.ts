import { createHash } from 'node:crypto';
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
    ports,
    runtime,
    delivered,
    agent: (event: AgentEvent) => agent(event),
    tool: (event: ToolEvent) => tool(event),
    job: (event: JobEvent) => job(event),
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
    expect(h.runtime.events().find((event) => event.subject === 'wake')?.reason).toBe('no-session');
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
    await h.job({ type: 'exited', id: 'first', command: 'first', exitCode: 1 });
    const signalId = h.runtime.events().find((event) => event.subject === 'first')?.id;
    await h.agent({ type: 'pre-step', sessionId: 'b' });
    await h.advance(2_000);
    expect(h.delivered[0]).toMatchObject({ kind: 'send', sessionId: 'b', target: 'next-step' });
    expect(h.delivered[0]?.deliveryId).toBe(
      createHash('sha256')
        .update(JSON.stringify(['b', [signalId]]))
        .digest('hex'),
    );
    await h.job({ type: 'exited', id: 'second', command: 'second', exitCode: 1 });
    await h.advance(2_000);
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
    await h.job({ type: 'exited', id: 'failed', exitCode: 1 });
    await h.advance(2_000);
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
    for (let i = 0; i < 205; i++) await h.job({ type: 'exited', id: `job-${i}`, exitCode: 0 });
    await h.job({ type: 'exited', id: 'job-204', exitCode: 0 });
    expect(h.runtime.events().some((event) => event.reason === 'pending-evicted:5')).toBe(true);
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    const changes = h.delivered.flatMap((intent) => intent.update.changes);
    expect(changes).toHaveLength(200);
    expect(changes.find((change) => change.signal.subject === 'job-204')?.count).toBe(2);
    expect(changes.some((change) => change.signal.subject === 'job-0')).toBe(false);
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
