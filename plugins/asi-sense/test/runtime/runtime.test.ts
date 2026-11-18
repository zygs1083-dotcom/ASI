import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Body, SenseState } from '@asi/sense-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeliveryFailure } from '../../src/host/attention/drain.ts';
import { AttentionPipeline } from '../../src/host/attention/pipeline.ts';
import { DEFAULT_RULES } from '../../src/host/attention/rules.ts';
import { defaultBodyRules } from '../../src/host/body/index.ts';
import { FileStoragePort } from '../../src/host/dsh/storage.ts';
import { createPresenter } from '../../src/host/presenter/index.ts';
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
import { TokenFacts } from '../../src/host/sources/token-facts.ts';
import { diskFact, f, mkBody } from '../body/helpers.ts';

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
  syncMono = false,
) {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  const monoStart = performance.now();
  let mono = 0;
  let agent: (event: AgentEvent) => Promise<void> = async () => {};
  let tool: (event: ToolEvent) => Promise<void> = async () => {};
  let job: (event: JobEvent) => Promise<void> = async () => {};
  let file: (event: FileChange) => void = () => {};
  let sample: (body: Body) => void = () => {};
  let token: TokenSnapshot | undefined;
  const startedJobs = new Set<string>();
  let failSave = false;
  let watchers = 0;
  let probes = 0;
  const delivered: Parameters<DshPort['deliver']>[1][] = [];
  const ports: SensePorts = {
    clock: { wall: () => Date.now(), mono: () => (syncMono ? performance.now() - monoStart : mono) },
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
    globalFileWatch: { disableInTests: true },
    ...options,
  });
  activeRuntimes.add(runtime);
  return {
    ports,
    runtime,
    delivered,
    agent: (event: AgentEvent) => agent(event),
    tool: (event: ToolEvent) => tool(event),
    job: async (event: JobEvent) => {
      const item = { sessionId: runtime.currentSessionId(), ...event };
      if (item.type === 'exited' && item.sessionId && !startedJobs.has(item.id)) {
        await job({ ...item, type: 'started' });
      }
      if (item.type === 'started') startedJobs.add(item.id);
      else startedJobs.delete(item.id);
      await job(item);
    },
    jobRaw: (event: JobEvent) => job(event),
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
    sampleRaw: (body = mkBody()) => sample(body),
    watcherCount: () => watchers,
    probeCount: () => probes,
    advance: async (ms: number) => {
      mono += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
    // Jump monotonic/wall time directly when testing long deadlines without spinning 5s polling ticks.
    jump: async (ms: number) => {
      mono += ms;
      vi.setSystemTime(Date.now() + ms);
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

describe('host runtime', () => {
  it('never watches pending or expired rules and closes a root on expiration', async () => {
    const now = 1_700_000_000_000;
    const h = harness(undefined, {
      rules: [
        {
          id: 'pending',
          match: { kind: 'file.changed', subject: '/pending/**' },
          level: 'wake',
          createdBy: 'agent',
          approved: false,
        },
        {
          id: 'expired',
          match: { kind: 'file.changed', subject: '/expired/**' },
          level: 'context',
          createdBy: 'user',
          approved: true,
          expiresAt: now - 1,
        },
        {
          id: 'temporary',
          match: { kind: 'file.changed', subject: '/temporary/**' },
          level: 'context',
          createdBy: 'user',
          approved: true,
          expiresAt: now + 1_000,
        },
      ],
    });
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
    expect([...watched]).toEqual(['/temporary']);
    await h.advance(1_000);
    expect([...watched]).toEqual([]);
    await h.runtime.stop();
  });

  it('does not stage an unapproved agent watch before confirmation', async () => {
    const h = harness(undefined, { rules: [] });
    await h.runtime.start();
    await h.runtime.tools.envWatch({
      action: 'add',
      rule: { id: 'pending', match: { kind: 'file.changed', subject: '/missing/**' }, level: 'wake' },
    });
    expect(h.watcherCount()).toBe(0);
    await h.runtime.actions.confirmRule('pending');
    expect(h.watcherCount()).toBe(1);
    await h.runtime.stop();
  });

  it('watches a directory named by a file.burst rule without file.changed rules', async () => {
    const h = harness(undefined, {
      rules: [
        {
          id: 'burst',
          match: { kind: 'file.burst', subject: '/workspace' },
          level: 'wake',
          createdBy: 'user',
          approved: true,
        },
      ],
    });
    await h.runtime.start();
    expect(h.watcherCount()).toBe(1);
    for (let i = 0; i < 51; i++) h.fileRaw({ path: `/workspace/${i}.json`, change: 'delete' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.events().find((item) => item.kind === 'file.burst')).toMatchObject({
      ruleId: 'burst',
      level: 'wake',
      detail: { deleted: 51 },
    });
    await h.runtime.stop();
  });

  it('delivers a burst rule scoped to a recursive directory glob', async () => {
    const h = harness(undefined, {
      rules: [
        {
          id: 'burst-glob',
          match: { kind: 'file.burst', subject: '/workspace/**' },
          level: 'wake',
          createdBy: 'user',
          approved: true,
        },
      ],
    });
    await h.runtime.start();
    expect(h.watcherCount()).toBe(1);
    for (let i = 0; i < 51; i++) h.fileRaw({ path: `/workspace/${i}.json`, change: 'delete' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.events().find((item) => item.kind === 'file.burst')).toMatchObject({
      ruleId: 'burst-glob',
      level: 'wake',
      detail: { deleted: 51 },
    });
    await h.runtime.stop();
  });

  it('ignores files outside a glob rule scope for burst detection', async () => {
    const h = harness(undefined, {
      rules: [
        {
          id: 'ts',
          match: { kind: 'file.changed', subject: '/workspace/*.ts' },
          level: 'context',
          createdBy: 'user',
          approved: true,
        },
        ...defaultBodyRules(),
      ],
    });
    await h.runtime.start();
    for (let i = 0; i < 51; i++) h.fileRaw({ path: `/workspace/${i}.json`, change: 'delete' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.events().filter((item) => item.kind === 'file.changed')).toHaveLength(0);
    // `.json` siblings are unobservable to `/workspace/*.ts`: they must not
    // feed the burst window (a glob rule's scope is its own matchable set).
    expect(h.runtime.events().filter((item) => item.kind === 'file.burst')).toHaveLength(0);
    await h.runtime.stop();
  });

  it('counts unmatched files within an approved directory rule toward burst detection', async () => {
    const h = harness(undefined, {
      rules: [
        {
          id: 'dir',
          match: { kind: 'file.changed', subject: '/workspace' },
          level: 'context',
          createdBy: 'user',
          approved: true,
        },
        ...defaultBodyRules(),
      ],
    });
    await h.runtime.start();
    for (let i = 0; i < 51; i++) h.fileRaw({ path: `/workspace/${i}.json`, change: 'delete' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.events().filter((item) => item.kind === 'file.changed')).toHaveLength(0);
    expect(h.runtime.events().find((item) => item.kind === 'file.burst')?.detail?.deleted).toBe(51);
    await h.runtime.stop();
  });

  it('does not count unrelated ancestor events toward a burst', async () => {
    const h = harness(undefined, {
      rules: [
        {
          id: 'target',
          match: { kind: 'file.changed', subject: '/workspace/target/**' },
          level: 'context',
          createdBy: 'user',
          approved: true,
        },
        ...defaultBodyRules(),
      ],
    });
    await h.runtime.start();
    for (let i = 0; i < 51; i++) h.fileRaw({ path: `/workspace/sibling/${i}`, change: 'delete' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.events().filter((item) => item.kind === 'file.burst')).toHaveLength(0);
    await h.runtime.stop();
  });

  it('scopes an in-segment prefix glob to matching subtrees only', async () => {
    const h = harness(undefined, {
      rules: [
        {
          id: 'proj',
          match: { kind: 'file.changed', subject: '/demo/proj-*/**' },
          level: 'context',
          createdBy: 'user',
          approved: true,
        },
        ...defaultBodyRules(),
      ],
    });
    await h.runtime.start();
    // Unapproved sibling subtree: the recursive /demo watch may deliver these,
    // but they must never reach attention or the burst detector.
    for (let i = 0; i < 51; i++) h.fileRaw({ path: `/demo/cache/${i}`, change: 'delete' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.events().filter((item) => item.kind === 'file.changed')).toHaveLength(0);
    expect(h.runtime.events().filter((item) => item.kind === 'file.burst')).toHaveLength(0);
    for (let i = 0; i < 51; i++) h.fileRaw({ path: `/demo/proj-x/${i}`, change: 'delete' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.events().find((item) => item.kind === 'file.burst')).toMatchObject({
      subject: '/demo/proj-x',
      detail: { deleted: 51 },
    });
    await h.runtime.stop();
  });

  it('requests non-recursive watches for single-level globs and recursive ones for deep subjects', async () => {
    const h = harness(undefined, {
      rules: [
        {
          id: 'flat',
          match: { kind: 'file.changed', subject: '/workspace/*.ts' },
          level: 'context',
          createdBy: 'user',
          approved: true,
        },
        {
          id: 'prefix',
          match: { kind: 'file.changed', subject: '/demo/proj-*/**' },
          level: 'context',
          createdBy: 'user',
          approved: true,
        },
        {
          id: 'dir',
          match: { kind: 'file.changed', subject: '/plain' },
          level: 'context',
          createdBy: 'user',
          approved: true,
        },
      ],
    });
    const calls: { path: string; recursive?: boolean }[] = [];
    h.ports.files.watch = (path, _callback, opts) => {
      calls.push({ path, recursive: opts?.recursive });
      return { close: () => {} };
    };
    await h.runtime.start();
    expect(calls).toEqual([
      { path: '/workspace', recursive: false },
      { path: '/demo', recursive: true },
      { path: '/plain', recursive: true },
    ]);
    await h.runtime.stop();
  });

  it.each([
    ['/workspace/', '/workspace/x', '/workspace'],
    ['/workspace/*', '/workspace', '/workspace'],
    ['/workspace/pkg-*/**', '/workspace/pkg-a/x', '/workspace/pkg-a'],
    ['/workspace/**/', '/workspace', '/workspace'],
  ])('delivers a file.burst to a directory rule spelled %s', async (subject, dir, emitted) => {
    const h = harness(undefined, {
      rules: [
        {
          id: 'burst',
          match: { kind: 'file.burst', subject },
          level: 'wake',
          createdBy: 'user',
          approved: true,
        },
      ],
    });
    await h.runtime.start();
    for (let i = 0; i < 51; i++) h.fileRaw({ path: `${dir}/${i}.f`, change: 'delete' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.events().find((item) => item.kind === 'file.burst')).toMatchObject({
      ruleId: 'burst',
      subject: emitted,
      level: 'wake',
      detail: { deleted: 51 },
    });
    await h.runtime.stop();
  });

  it('keeps sibling glob rules on one watch root latched independently', async () => {
    const mk = (id: string, subject: string) => ({
      id,
      match: { kind: 'file.burst', subject },
      level: 'wake' as const,
      createdBy: 'user' as const,
      approved: true,
    });
    const h = harness(undefined, {
      rules: [mk('tmp-burst', '/demo/tmp-*/**'), mk('proj-burst', '/demo/proj-*/**')],
    });
    await h.runtime.start();
    // tmp-1 bursts first and latches its own scope only.
    for (let i = 0; i < 51; i++) h.fileRaw({ path: `/demo/tmp-1/${i}`, change: 'delete' });
    await vi.advanceTimersByTimeAsync(0);
    // The burst is attributed to tmp's scope — the proj rule must not wake on it.
    expect(h.runtime.events().filter((item) => item.kind === 'file.burst')).toEqual([
      expect.objectContaining({ ruleId: 'tmp-burst', subject: '/demo/tmp-1' }),
    ]);
    // A fresh burst in proj-b1 is not masked by tmp-1's latch (old shared-bucket bug).
    for (let i = 0; i < 51; i++) h.fileRaw({ path: `/demo/proj-b1/${i}`, change: 'delete' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.events().filter((item) => item.kind === 'file.burst')).toEqual([
      expect.objectContaining({ ruleId: 'tmp-burst', subject: '/demo/tmp-1' }),
      expect.objectContaining({ ruleId: 'proj-burst', subject: '/demo/proj-b1' }),
    ]);
    await h.runtime.stop();
  });

  it('does not let a single-level glob rule claim a deeper subtree burst', async () => {
    const h = harness(undefined, {
      rules: [
        {
          id: 'burst',
          match: { kind: 'file.burst', subject: '/workspace/*' },
          level: 'wake',
          createdBy: 'user',
          approved: true,
        },
        {
          id: 'deep',
          match: { kind: 'file.changed', subject: '/workspace/sub/**' },
          level: 'record',
          createdBy: 'user',
          approved: true,
        },
      ],
    });
    await h.runtime.start();
    // Deletes deep inside /workspace/sub burst under the `dir:/workspace/sub`
    // scope — `/workspace/*` only covers one level, so the burst is claimed
    // by the catch-all system rule and never by the single-level glob.
    for (let i = 0; i < 51; i++) h.fileRaw({ path: `/workspace/sub/deep/${i}`, change: 'delete' });
    await vi.advanceTimersByTimeAsync(0);
    const deepBursts = h.runtime.events().filter((item) => item.kind === 'file.burst');
    expect(deepBursts).toHaveLength(1);
    expect(deepBursts.some((item) => item.ruleId === 'burst')).toBe(false);
    // A burst directly under /workspace does belong to the single-level scope.
    for (let i = 0; i < 51; i++) h.fileRaw({ path: `/workspace/${i}.f`, change: 'delete' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.events().find((item) => item.kind === 'file.burst' && item.ruleId === 'burst')).toMatchObject({
      ruleId: 'burst',
      subject: '/workspace',
      level: 'wake',
    });
    await h.runtime.stop();
  });

  it('aggregates child-root events into the parent burst window', async () => {
    const h = harness(undefined, {
      rules: [
        {
          id: 'burst',
          match: { kind: 'file.burst', subject: '/workspace' },
          level: 'wake',
          createdBy: 'user',
          approved: true,
        },
        {
          id: 'src',
          match: { kind: 'file.changed', subject: '/workspace/src/**' },
          level: 'context',
          createdBy: 'user',
          approved: true,
        },
      ],
    });
    await h.runtime.start();
    // 30 deletes each under two nested roots: exclusive longest-root
    // bucketing would split 60 into two sub-threshold windows.
    for (let i = 0; i < 30; i++) h.fileRaw({ path: `/workspace/a/${i}.f`, change: 'delete' });
    for (let i = 0; i < 30; i++) h.fileRaw({ path: `/workspace/src/${i}.f`, change: 'delete' });
    await vi.advanceTimersByTimeAsync(0);
    // The parent window aggregates both roots and emits at the 51st delete —
    // exclusive longest-root bucketing would split 30+30 below threshold.
    expect(
      h.runtime.events().find((item) => item.kind === 'file.burst' && item.subject === '/workspace'),
    ).toMatchObject({ ruleId: 'burst', level: 'wake', detail: { deleted: 51 } });
    await h.runtime.stop();
  });

  it('preserves burst history for unchanged roots across rule refresh', async () => {
    const h = harness();
    const watches = new Map<string, (event: FileChange) => void>();
    h.ports.files.watch = (path, callback) => {
      watches.set(path, callback);
      return {
        close: () => {
          watches.delete(path);
        },
      };
    };
    await h.runtime.start();
    for (let i = 0; i < 25; i++) watches.get('/workspace')?.({ path: `/workspace/${i}`, change: 'delete' });
    await vi.advanceTimersByTimeAsync(0);
    await h.runtime.tools.envWatch({
      action: 'add',
      rule: { id: 'other', match: { kind: 'file.changed', subject: '/other/**' }, level: 'context' },
    });
    for (let i = 25; i < 51; i++) watches.get('/workspace')?.({ path: `/workspace/${i}`, change: 'delete' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.events().find((item) => item.kind === 'file.burst')?.detail?.deleted).toBe(51);
    await h.runtime.stop();
  });

  it('routes unowned signals automatically during recovery and ignores a late restored archived target', async () => {
    const h = harness();
    const saved = new Map<string, string>();
    let notify: (closed?: string) => void = () => {};
    let archived = false;
    let release = () => {};
    let attempts = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.ports.storage.load = async (key) => saved.get(key);
    h.ports.storage.save = async (key, value) => {
      saved.set(key, value);
    };
    h.ports.dsh.listSessions = async () =>
      ['a', ...(archived ? [] : ['b'])].map((id) => ({ id, title: '', updatedAt: 1, running: false }));
    h.ports.dsh.onSessionsChanged = (cb) => {
      notify = cb;
      return () => {};
    };
    await h.runtime.start();
    for (const sessionId of ['b', 'a']) {
      await h.agent({ type: 'created', sessionId });
      await h.agent({ type: 'pre-step', sessionId });
      await h.agent({ type: 'post-step', sessionId });
    }
    await h.runtime.actions.selectTarget?.('b');
    await h.agent({ type: 'disposed', sessionId: 'b' });
    h.ports.dsh.ensureSession = async (id) => {
      attempts++;
      await gate;
      await h.agent({ type: 'created', sessionId: id });
    };
    try {
      await h.file({ path: '/workspace/fixture', change: 'modify' });
      expect(attempts).toBe(1);
      await h.advance(5_000);
      expect(h.delivered.map((intent) => [intent.sessionId, intent.kind])).toEqual([['a', 'followup']]);
      archived = true;
      notify('b');
      await vi.advanceTimersByTimeAsync(0);
      expect(h.runtime.target()).toMatchObject({ mode: 'auto', notice: true });
      expect(h.runtime.currentSessionId()).toBe('a');
      expect(saved.get('session-target')).toContain('"sessionId":null');
      expect(h.runtime.events().filter((event) => event.kind === 'delivery.target-unavailable')).toHaveLength(1);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.runtime.target()).toMatchObject({ mode: 'auto', notice: true });
      expect(h.runtime.currentSessionId()).toBe('a');
    } finally {
      release();
      await vi.advanceTimersByTimeAsync(0);
      await h.runtime.stop();
    }
  });

  it('completes the owner pre-step after its wake while another target is still restoring', async () => {
    const h = harness();
    let release = () => {};
    let attempts = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.ports.dsh.listSessions = async () => ['a', 'b'].map((id) => ({ id, title: '', updatedAt: 1, running: false }));
    await h.runtime.start();
    for (const sessionId of ['b', 'a']) {
      await h.agent({ type: 'created', sessionId });
      await h.agent({ type: 'pre-step', sessionId });
      await h.agent({ type: 'post-step', sessionId });
    }
    await h.runtime.actions.selectTarget?.('b');
    await h.agent({ type: 'disposed', sessionId: 'b' });
    h.ports.dsh.ensureSession = async (id) => {
      attempts++;
      await gate;
      await h.agent({ type: 'created', sessionId: id });
    };
    try {
      await h.jobRaw({ type: 'started', id: 'fixture-job', sessionId: 'a' });
      await h.jobRaw({ type: 'exited', id: 'fixture-job', sessionId: 'a', exitCode: 1 });
      await h.advance(2_000);
      expect(h.delivered.map((intent) => [intent.sessionId, intent.kind])).toEqual([['a', 'followup']]);
      let completed = false;
      const step = h.agent({ type: 'pre-step', sessionId: 'a' }).then(() => {
        completed = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      expect(completed).toBe(true);
      await step;
    } finally {
      release();
      await vi.advanceTimersByTimeAsync(0);
      await h.runtime.stop();
    }
  });

  it('uses automatic routing until recovery finishes, then routes later signals to the pinned target', async () => {
    const h = harness();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.ports.dsh.listSessions = async () => ['a', 'b'].map((id) => ({ id, title: '', updatedAt: 1, running: false }));
    await h.runtime.start();
    for (const sessionId of ['b', 'a']) {
      await h.agent({ type: 'created', sessionId });
      await h.agent({ type: 'pre-step', sessionId });
      await h.agent({ type: 'post-step', sessionId });
    }
    await h.runtime.actions.selectTarget?.('b');
    await h.agent({ type: 'disposed', sessionId: 'b' });
    h.ports.dsh.ensureSession = async (id) => {
      await gate;
      await h.agent({ type: 'created', sessionId: id });
    };
    try {
      await h.file({ path: '/workspace/first', change: 'modify' });
      await h.advance(5_000);
      expect(h.delivered.map((intent) => [intent.sessionId, intent.kind])).toEqual([['a', 'followup']]);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.runtime.currentSessionId()).toBe('b');
      await h.file({ path: '/workspace/second', change: 'modify' });
      await h.advance(5_000);
      expect(h.delivered.map((intent) => [intent.sessionId, intent.kind])).toEqual([
        ['a', 'followup'],
        ['b', 'followup'],
      ]);
    } finally {
      release();
      await vi.advanceTimersByTimeAsync(0);
      await h.runtime.stop();
    }
  });

  it('retains an already queued wake while the only pinned agent temporarily fails to restore', async () => {
    const h = harness();
    let failing = true;
    let attempts = 0;
    h.ports.dsh.listSessions = async () => [{ id: 'b', title: '', updatedAt: 1, running: false }];
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 'b' });
    await h.agent({ type: 'pre-step', sessionId: 'b' });
    await h.agent({ type: 'post-step', sessionId: 'b' });
    await h.runtime.actions.selectTarget?.('b');
    await h.file({ path: '/workspace/fixture', change: 'modify' });
    await h.agent({ type: 'disposed', sessionId: 'b' });
    h.ports.dsh.ensureSession = async (id) => {
      attempts++;
      if (failing) throw new Error('temporary failure');
      await h.agent({ type: 'created', sessionId: id });
    };
    await h.advance(5_000);
    expect(attempts).toBe(1);
    expect(h.delivered).toEqual([]);
    expect(h.runtime.target()).toMatchObject({ mode: 'pinned', sessionId: 'b', unavailable: true });
    failing = false;
    await h.advance(1_000);
    expect(attempts).toBe(2);
    await h.advance(250);
    expect(h.delivered.map((intent) => [intent.sessionId, intent.kind])).toEqual([['b', 'followup']]);
    await h.runtime.stop();
  });

  it('wakes an available owner even when restoring an unloaded pinned target is blocked', async () => {
    const h = harness();
    h.ports.dsh.listSessions = async () => ['a', 'b'].map((id) => ({ id, title: '', updatedAt: 1, running: false }));
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await h.runtime.start();
    for (const sessionId of ['b', 'a']) {
      await h.agent({ type: 'created', sessionId });
      await h.agent({ type: 'pre-step', sessionId });
      await h.agent({ type: 'post-step', sessionId });
    }
    await h.runtime.actions.selectTarget?.('b');
    await h.agent({ type: 'disposed', sessionId: 'b' });
    h.ports.dsh.ensureSession = async (id) => {
      await gate;
      await h.agent({ type: 'created', sessionId: id });
    };
    await h.jobRaw({ type: 'started', id: 'fixture-job', sessionId: 'a' });
    await h.jobRaw({ type: 'exited', id: 'fixture-job', sessionId: 'a', exitCode: 1 });
    try {
      await h.advance(2_000);
      expect(h.delivered.map((intent) => [intent.sessionId, intent.kind])).toEqual([['a', 'followup']]);
    } finally {
      release();
      await vi.advanceTimersByTimeAsync(0);
      await h.runtime.stop();
    }
  });

  it.each([
    { recreated: false, other: true },
    { recreated: true, other: true },
    { recreated: false, other: false },
    { recreated: true, other: false },
  ])(
    'routes an already queued wake without waiting for an unloaded target (recreated=$recreated other=$other)',
    async ({ recreated, other }) => {
      const h = harness();
      let attempts = 0;
      h.ports.dsh.listSessions = async () => ['a', 'b'].map((id) => ({ id, title: '', updatedAt: 1, running: false }));
      await h.runtime.start();
      for (const sessionId of other ? ['b', 'a'] : ['b']) {
        await h.agent({ type: 'created', sessionId });
        await h.agent({ type: 'pre-step', sessionId });
        await h.agent({ type: 'post-step', sessionId });
      }
      await h.runtime.actions.selectTarget?.('b');
      await h.file({ path: '/workspace/fixture', change: 'modify' });
      await h.agent({ type: 'disposed', sessionId: 'b' });
      if (recreated) await h.agent({ type: 'created', sessionId: 'b' });
      h.ports.dsh.ensureSession = async (id) => {
        attempts++;
        if (!recreated) await h.agent({ type: 'created', sessionId: id });
      };
      await h.advance(5_000);
      expect(attempts).toBe(1);
      expect(h.runtime.target()).toMatchObject({ mode: 'pinned', sessionId: 'b' });
      if (!other) await h.advance(250);
      expect(h.delivered.map((intent) => [intent.sessionId, intent.kind])).toEqual([[other ? 'a' : 'b', 'followup']]);
      await h.runtime.stop();
    },
  );

  it.each(['restored', 'missing', 'temporary'] as const)(
    'preserves a pinned session through agent disposal and resolves it on delivery: %s',
    async (result) => {
      const h = harness();
      const saved = new Map<string, string>();
      let notify: (closed?: string) => void = () => {};
      let attempts = 0;
      let recovering = result;
      h.ports.storage.load = async (key) => saved.get(key);
      h.ports.storage.save = async (key, value) => {
        saved.set(key, value);
      };
      h.ports.dsh.listSessions = async () => ['a', 'b'].map((id) => ({ id, title: '', updatedAt: 1, running: false }));
      h.ports.dsh.onSessionsChanged = (cb) => {
        notify = cb;
        return () => {};
      };
      await h.runtime.start();
      for (const sessionId of ['b', 'a']) {
        await h.agent({ type: 'created', sessionId });
        await h.agent({ type: 'pre-step', sessionId });
        await h.agent({ type: 'post-step', sessionId });
      }
      await h.runtime.actions.selectTarget?.('b');
      h.ports.dsh.ensureSession = async (id) => {
        attempts++;
        if (recovering === 'missing') throw Object.assign(new Error('missing'), { code: 'session/not-found' });
        if (recovering === 'temporary') throw new Error('temporarily unavailable');
        await h.agent({ type: 'created', sessionId: id });
      };
      await h.agent({ type: 'disposed', sessionId: 'b' });
      notify();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.runtime.target()).toMatchObject({ mode: 'pinned', sessionId: 'b' });
      expect(saved.get('session-target')).toContain('"b"');
      expect(attempts).toBe(0);
      await h.file({ path: '/workspace/fixture', change: 'modify' });
      expect(attempts).toBe(1);
      if (result === 'missing') {
        expect(h.runtime.target()).toMatchObject({ mode: 'auto', notice: true });
        expect(saved.get('session-target')).toContain('"sessionId":null');
      } else if (result === 'temporary') {
        expect(h.runtime.target()).toMatchObject({ mode: 'pinned', sessionId: 'b', unavailable: true });
        expect(saved.get('session-target')).toContain('"b"');
      }
      await h.advance(5_000);
      expect(h.delivered.map((intent) => [intent.sessionId, intent.kind])).toEqual([
        [result === 'restored' ? 'b' : 'a', 'followup'],
      ]);
      if (result === 'temporary') {
        recovering = 'restored';
        await h.advance(10_000);
        expect(h.runtime.currentSessionId()).toBe('b');
        expect(h.runtime.target()).toMatchObject({ mode: 'pinned', sessionId: 'b' });
        expect(saved.get('session-target')).toContain('"b"');
      }
      await h.runtime.stop();
    },
  );

  it('keeps running in automatic routing while a saved target is temporarily unavailable, then restores it', async () => {
    const h = harness();
    const saved = JSON.stringify({ version: 1, sessionId: 'a' });
    let unavailable = true;
    const writes: string[] = [];
    h.ports.storage.load = async (key) => (key === 'session-target' ? saved : undefined);
    h.ports.storage.save = async (key, value) => {
      if (key === 'session-target') writes.push(value);
    };
    h.ports.dsh.listSessions = async () => ['a', 'b'].map((id) => ({ id, title: '', updatedAt: 1, running: false }));
    h.ports.dsh.ensureSession = async (id) => {
      if (unavailable) throw new Error('temporary failure');
      await h.agent({ type: 'created', sessionId: id });
    };
    await expect(h.runtime.start()).resolves.toBeUndefined();
    await h.agent({ type: 'created', sessionId: 'b' });
    await h.agent({ type: 'pre-step', sessionId: 'b' });
    expect(h.runtime.target()).toMatchObject({ mode: 'pinned', sessionId: 'a', unavailable: true });
    expect(h.runtime.currentSessionId()).toBe('b');
    expect(writes).toEqual([]);
    unavailable = false;
    await h.advance(1_000);
    expect(h.runtime.target()).toMatchObject({ mode: 'pinned', sessionId: 'a' });
    expect(h.runtime.currentSessionId()).toBe('a');
    expect(writes).toEqual([]);
    await h.runtime.stop();
  });

  it('retries a non-target private wake without charging the budget twice', async () => {
    const h = harness(undefined, {
      rules: [{ id: 'failed-job', match: { kind: 'job.exited' }, level: 'wake', createdBy: 'user', approved: true }],
    });
    const attempts: string[] = [];
    h.ports.dsh.listSessions = async () => ['a', 'b'].map((id) => ({ id, title: '', updatedAt: 1, running: false }));
    h.ports.dsh.deliver = async (id) => {
      attempts.push(id);
      if (attempts.length === 1) throw new Error('temporary failure');
    };
    await h.runtime.start();
    for (const sessionId of ['a', 'b']) {
      await h.agent({ type: 'created', sessionId });
      await h.agent({ type: 'pre-step', sessionId });
      await h.agent({ type: 'post-step', sessionId });
    }
    await h.runtime.actions.selectTarget?.('b');
    await h.jobRaw({ type: 'started', id: 'fixture-job', sessionId: 'a' });
    await h.jobRaw({ type: 'exited', id: 'fixture-job', sessionId: 'a', exitCode: 1 });
    await h.advance(2_000);
    expect(attempts).toEqual(['a']);
    await h.advance(1_000);
    expect(attempts).toEqual(['a', 'a']);
    await h.advance(10_000);
    expect(attempts).toEqual(['a', 'a']);
    await h.runtime.stop();
  });

  it.each([true, false])('wakes an idle non-target job owner with pinned=%s', async (pinned) => {
    const h = harness(undefined, {
      rules: [{ id: 'failed-job', match: { kind: 'job.exited' }, level: 'wake', createdBy: 'user', approved: true }],
    });
    h.ports.dsh.listSessions = async () => ['a', 'b'].map((id) => ({ id, title: '', updatedAt: 1, running: false }));
    await h.runtime.start();
    for (const sessionId of ['a', 'b']) {
      await h.agent({ type: 'created', sessionId });
      await h.agent({ type: 'pre-step', sessionId });
      await h.agent({ type: 'post-step', sessionId });
    }
    if (pinned) await h.runtime.actions.selectTarget?.('b');
    await h.jobRaw({ type: 'started', id: 'fixture-job', sessionId: 'a' });
    await h.jobRaw({ type: 'exited', id: 'fixture-job', sessionId: 'a', exitCode: 1 });
    await h.advance(2_000);
    await h.advance(5_000);
    expect(h.runtime.currentSessionId()).toBe('b');
    expect(h.delivered.map((intent) => [intent.sessionId, intent.kind])).toEqual([['a', 'followup']]);
    await h.runtime.stop();
  });

  it.each([
    { pinned: true, other: true, expected: 'a' },
    { pinned: false, other: true, expected: 'a' },
    { pinned: true, other: false, expected: undefined },
    { pinned: false, other: false, expected: undefined },
  ])(
    'removes an archived loaded session from automatic routing: $pinned / $other',
    async ({ pinned, other, expected }) => {
      const h = harness();
      let notify: (closed?: string) => void = () => {};
      let archived = false;
      h.ports.dsh.listSessions = async () =>
        [other ? 'a' : undefined, archived ? undefined : 'b']
          .filter((id): id is string => id !== undefined)
          .map((id) => ({ id, title: '', updatedAt: 1, running: false }));
      h.ports.dsh.onSessionsChanged = (cb) => {
        notify = cb;
        return () => {};
      };
      await h.runtime.start();
      if (other) {
        await h.agent({ type: 'created', sessionId: 'a' });
        await h.agent({ type: 'pre-step', sessionId: 'a' });
        await h.agent({ type: 'post-step', sessionId: 'a' });
      }
      await h.agent({ type: 'created', sessionId: 'b' });
      await h.agent({ type: 'pre-step', sessionId: 'b' });
      await h.agent({ type: 'post-step', sessionId: 'b' });
      if (pinned) await h.runtime.actions.selectTarget?.('b');
      archived = true;
      notify('b');
      await vi.advanceTimersByTimeAsync(0);
      expect(h.runtime.target()).toMatchObject({ mode: 'auto', ...(pinned ? { notice: true } : {}) });
      expect(h.runtime.currentSessionId()).toBe(expected);
      await h.agent({ type: 'pre-step', sessionId: 'b' });
      expect(h.runtime.currentSessionId()).toBe(expected);
      await h.file({ path: '/workspace/fixture', change: 'modify' });
      await h.advance(5_000);
      expect(h.delivered.map((intent) => intent.sessionId)).toEqual(expected ? [expected] : []);
      expect(h.runtime.events().filter((event) => event.kind === 'delivery.target-unavailable')).toHaveLength(
        pinned ? 1 : 0,
      );
      await h.runtime.stop();
    },
  );

  it('restores a selected delivery target and keeps it when another session pre-steps', async () => {
    const h = harness();
    const stored = new Map<string, string>();
    h.ports.storage.load = async (key) => stored.get(key);
    h.ports.storage.save = async (key, value) => {
      stored.set(key, value);
    };
    h.ports.dsh.listSessions = async () => [
      { id: 'a', title: 'Fixture A', updatedAt: 1, running: false },
      { id: 'b', title: 'Fixture B', updatedAt: 2, running: false },
    ];
    h.ports.dsh.ensureSession = async () => {};
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 'a' });
    await h.agent({ type: 'created', sessionId: 'b' });
    await h.agent({ type: 'pre-step', sessionId: 'b' });
    await h.runtime.actions.selectTarget?.('a');
    await h.agent({ type: 'pre-step', sessionId: 'b' });
    expect(h.runtime.currentSessionId()).toBe('a');
    expect(h.runtime.target()).toMatchObject({ mode: 'pinned', sessionId: 'a' });
    expect(stored.get('session-target')).toContain('"a"');
    await h.runtime.stop();
  });
  it('keeps pending token alerts with their source session and drops closed generations', async () => {
    const h = harness();
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let a = 0;
    h.ports.dsh.tokenSnapshot = async (session) => ({
      contextWindow: 1000,
      contextUsed: session === 'a' ? a : 0,
      sessionUsage: usage,
    });
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 'a' });
    await h.agent({ type: 'created', sessionId: 'b' });
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    await h.sample();
    await h.advance(1000);
    a = 900;
    await h.agent({ type: 'post-step', sessionId: 'a' });
    await h.sample();
    expect(h.runtime.events().some((event) => event.kind === 'body.threshold' && event.subject === 'context')).toBe(
      true,
    );
    await h.advance(2_000);
    await h.agent({ type: 'pre-step', sessionId: 'b' });
    expect(
      h.delivered.filter((intent) => intent.sessionId === 'b').flatMap((intent) => intent.update.changes),
    ).not.toContainEqual(
      expect.objectContaining({ signal: expect.objectContaining({ kind: 'body.threshold', subject: 'context' }) }),
    );
    expect(
      h.delivered.filter((intent) => intent.sessionId === 'b').flatMap((intent) => intent.update.changes),
    ).not.toContainEqual(
      expect.objectContaining({
        signal: expect.objectContaining({ kind: 'body.rate', data: expect.objectContaining({ metric: 'context' }) }),
      }),
    );
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    expect(
      h.delivered.filter((intent) => intent.sessionId === 'a').flatMap((intent) => intent.update.changes),
    ).toContainEqual(
      expect.objectContaining({ signal: expect.objectContaining({ kind: 'body.threshold', subject: 'context' }) }),
    );
    await h.agent({ type: 'disposed', sessionId: 'a' });
    await h.agent({ type: 'created', sessionId: 'a' });
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    expect(
      h.delivered
        .filter((intent) => intent.sessionId === 'a')
        .flatMap((intent) => intent.update.changes)
        .filter(({ signal }) => signal.kind === 'body.threshold' && signal.subject === 'context'),
    ).toHaveLength(1);
    await h.runtime.stop();
  });

  it('keeps token rate windows and latches separate across interleaved sessions', async () => {
    const h = harness();
    const used: Record<string, number> = { a: 200, b: 600 };
    h.ports.dsh.tokenSnapshot = async (session) => ({
      contextWindow: 1000,
      contextUsed: used[session],
      sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    await h.runtime.start();
    for (const sessionId of ['a', 'b']) await h.agent({ type: 'created', sessionId });
    for (const sessionId of ['a', 'b']) {
      await h.agent({ type: 'pre-step', sessionId });
      await h.sample();
      await h.advance(1000);
    }
    expect(
      h.runtime.events().filter((event) => event.kind === 'body.rate' && event.detail?.metric === 'context'),
    ).toHaveLength(0);
    used.a = 300;
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    await h.sample();
    await h.advance(1000);
    used.b = 610;
    await h.agent({ type: 'pre-step', sessionId: 'b' });
    await h.sample();
    expect(
      h.runtime.events().filter((event) => event.kind === 'body.rate' && event.detail?.metric === 'context'),
    ).toHaveLength(2);
    await h.runtime.stop();
  });

  it('discards a delayed token sample from a disposed session generation', async () => {
    const h = harness();
    let used = 0;
    h.ports.dsh.tokenSnapshot = async () => ({
      contextWindow: 1000,
      contextUsed: used,
      sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 'a' });
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    await h.sample();
    await h.advance(1000);
    used = 900;
    await h.agent({ type: 'post-step', sessionId: 'a' });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const waiting = new Promise<void>((resolve) => (entered = resolve));
    const original = h.runtime.body.monitor.evaluateAuto;
    vi.spyOn(h.runtime.body.monitor, 'evaluateAuto').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    h.sampleRaw();
    await waiting;
    await h.agent({ type: 'disposed', sessionId: 'a' });
    used = 0;
    await h.agent({ type: 'created', sessionId: 'a' });
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    release();
    await vi.advanceTimersByTimeAsync(0);
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    expect(h.runtime.events()).toContainEqual(
      expect.objectContaining({
        kind: 'body.threshold',
        subject: 'context',
        level: 'record',
        reason: 'session-private',
      }),
    );
    expect(
      h.delivered
        .flatMap((intent) => intent.update.changes)
        .some(({ signal }) => signal.kind === 'body.threshold' && signal.subject === 'context'),
    ).toBe(false);
    await h.runtime.stop();
  });

  it('keeps a delayed token alert with its live source after another session pre-steps', async () => {
    const h = harness();
    let a = 0;
    h.ports.dsh.tokenSnapshot = async (session) => ({
      contextWindow: 1000,
      contextUsed: session === 'a' ? a : 0,
      sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    await h.runtime.start();
    for (const sessionId of ['a', 'b']) await h.agent({ type: 'created', sessionId });
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    await h.sample();
    await h.advance(1000);
    a = 900;
    await h.agent({ type: 'post-step', sessionId: 'a' });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const waiting = new Promise<void>((resolve) => (entered = resolve));
    const original = h.runtime.body.monitor.evaluateAuto;
    vi.spyOn(h.runtime.body.monitor, 'evaluateAuto').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    h.sampleRaw();
    await waiting;
    await h.agent({ type: 'pre-step', sessionId: 'b' });
    release();
    await vi.advanceTimersByTimeAsync(0);
    await h.agent({ type: 'pre-step', sessionId: 'b' });
    expect(
      h.delivered
        .filter((intent) => intent.sessionId === 'b')
        .flatMap((intent) => intent.update.changes)
        .some(({ signal }) => signal.kind === 'body.threshold' && signal.subject === 'context'),
    ).toBe(false);
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    expect(
      h.delivered
        .filter((intent) => intent.sessionId === 'a')
        .flatMap((intent) => intent.update.changes)
        .some(({ signal }) => signal.kind === 'body.threshold' && signal.subject === 'context'),
    ).toBe(true);
    await h.runtime.stop();
  });

  it('projects session state for expiry notifications after a foreign job event', async () => {
    const h = harness(undefined, { rules: [] });
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 'a' });
    await h.agent({ type: 'created', sessionId: 'b' });
    await h.agent({ type: 'pre-step', sessionId: 'b' });
    await h.sample(mkBody());
    await h.job({ type: 'started', id: 'foreign-job', sessionId: 'a', command: 'foreign-private-command' });
    const states: SenseState[] = [];
    const off = h.runtime.subscribe((state) => states.push(state));
    await h.advance(60_000);
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) expect(JSON.stringify(state)).not.toContain('foreign-private-command');
    off();
    await h.runtime.stop();
  });

  it('isolates concurrent session facts and restores the selected token on disposal', async () => {
    const values = {
      a: { activity: 'tool', pending: { inbox: 1, jobs: 1 }, tools: ['a-tool'], provider: 'provider-a', used: 11 },
      b: { activity: 'thinking', pending: { inbox: 2, jobs: 2 }, tools: ['b-tool'], provider: 'provider-b', used: 22 },
    } as const;
    const h = harness(
      undefined,
      { rules: [] },
      (session): NowReadings => {
        const value = values[session as 'a' | 'b'];
        return value
          ? {
              'self.activity': { value: value.activity },
              'self.pending': { value: value.pending },
              'self.tools': { value: value.tools },
              'env.where.model': { value: { provider: value.provider, endpoint: 'local', local: true } },
            }
          : {};
      },
      (session) => [{ id: `${session}-job`, status: 'running', startedAt: 1 }],
    );
    h.ports.dsh.tokenSnapshot = async (session) => ({
      contextUsed: values[session as 'a' | 'b'].used,
      sessionUsage: { input: values[session as 'a' | 'b'].used, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    await h.runtime.start();
    for (const sessionId of ['a', 'b']) {
      await h.agent({ type: 'created', sessionId });
      await h.agent({ type: 'pre-step', sessionId });
    }
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    await h.agent({ type: 'post-step', sessionId: 'b' });
    for (const session of ['a', 'b'] as const) {
      const state = h.runtime.tools.envState(undefined, session) as SenseState;
      expect(state.self.activity.value).toBe(values[session].activity);
      expect(state.self.pending.value).toEqual(values[session].pending);
      expect(state.self.tools.value).toEqual(values[session].tools);
      expect(state.self.body.tokens.value?.contextUsed).toBe(values[session].used);
      expect(state.env.where.model.value?.provider).toBe(values[session].provider);
      expect(state.env.activeJobs.value?.map((job) => job.id)).toEqual([`${session}-job`]);
    }
    expect(h.runtime.state().self.body.tokens.value?.contextUsed).toBe(11);
    await h.agent({ type: 'disposed', sessionId: 'a' });
    expect(h.runtime.state().self.body.tokens.value?.contextUsed).toBe(22);
    const disposed = h.runtime.tools.envState(undefined, 'a') as SenseState;
    expect(disposed.self.body.tokens.value).toBeNull();
    expect(disposed.env.activeJobs.value).toBeNull();
    expect(disposed.self.tools.value).toBeNull();
    await h.agent({ type: 'disposed', sessionId: 'b' });
    expect(h.runtime.state().self.body.tokens.value).toBeNull();
    await h.runtime.stop();
  });

  it('rejects a delayed token read from a disposed session generation', async () => {
    const h = harness(undefined, { rules: [] });
    let used = 1;
    let release!: (value: TokenSnapshot) => void;
    let delayed = false;
    const snapshot = (value: number): TokenSnapshot => ({
      contextUsed: value,
      sessionUsage: { input: value, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    h.ports.dsh.tokenSnapshot = () =>
      delayed
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(snapshot(used));
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 'a' });
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    delayed = true;
    const old = h.agent({ type: 'post-step', sessionId: 'a' });
    await Promise.resolve();
    await h.agent({ type: 'disposed', sessionId: 'a' });
    await h.agent({ type: 'created', sessionId: 'a' });
    delayed = false;
    used = 2;
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    release(snapshot(1));
    await old;
    expect(h.runtime.state().self.body.tokens.value?.contextUsed).toBe(2);
    expect((h.runtime.tools.envState(undefined, 'a') as SenseState).self.body.tokens.value?.contextUsed).toBe(2);
    await h.runtime.stop();
  });

  it('keeps a cached token deadline when switching back to its session', async () => {
    const h = harness(undefined, { rules: [] });
    let mono = 0;
    const written: Body['tokens'][] = [];
    const facts = new TokenFacts(
      h.ports.dsh,
      { wall: () => mono, mono: () => mono },
      () => written.at(-1) ?? mkBody().tokens,
      (fact) => written.push(fact),
      () => {},
    );
    h.ports.dsh.tokenSnapshot = async () => ({
      contextUsed: 1,
      sessionUsage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    facts.sessionsChanged(true);
    await facts.tokens('a');
    facts.select('a');
    facts.select('b');
    mono = 14_000;
    facts.select('a');
    expect(written.at(-1)?.ttlMs).toBe(1_000);
    mono = 15_000;
    expect(facts.fact('a').status).toBe('stale');
    await facts.stop();
  });
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
    await h.agent({ type: 'created', sessionId: 'a' });
    await h.agent({ type: 'pre-step', sessionId: 'a' });
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
    expect(h.runtime.state().self.tools.value).toBeNull();
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

  it.each([0, 1])('retains an owned job exit %i received while another session is selected', async (exitCode) => {
    const h = harness();
    await h.runtime.start();
    for (const sessionId of ['a', 'b']) await h.agent({ type: 'created', sessionId });
    await h.agent({ type: 'pre-step', sessionId: 'b' });
    await h.job({ type: 'exited', id: 'owned-job', sessionId: 'a', command: 'fixture-command', exitCode });
    await h.advance(3_000);
    const initial = h.delivered.flatMap((intent) => intent.update.changes);
    if (exitCode === 0)
      expect(initial).not.toContainEqual(
        expect.objectContaining({ signal: expect.objectContaining({ subject: 'owned-job' }) }),
      );
    else expect(h.delivered).toMatchObject([{ sessionId: 'a', kind: 'followup' }]);
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    await h.advance(3_000);
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    const jobs = h.delivered.flatMap((intent) =>
      intent.update.changes
        .filter(({ signal }) => signal.subject === 'owned-job')
        .map((change) => ({ sessionId: intent.sessionId, kind: intent.kind, level: change.level })),
    );
    expect(jobs).toEqual([
      { sessionId: 'a', kind: exitCode === 0 ? 'inject' : 'followup', level: exitCode === 0 ? 'context' : 'wake' },
    ]);
    expect(JSON.stringify(h.delivered)).not.toContain('fixture-command');
    await h.runtime.stop();
  });

  it('wakes a live owner job when no session has yet been selected', async () => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 'a' });
    await h.job({ type: 'exited', id: 'owned-job', sessionId: 'a', command: 'fixture-command', exitCode: 1 });
    await h.advance(3_000);
    expect(h.delivered).toContainEqual(
      expect.objectContaining({
        sessionId: 'a',
        kind: 'followup',
        update: expect.objectContaining({
          changes: expect.arrayContaining([
            expect.objectContaining({ level: 'wake', signal: expect.objectContaining({ subject: 'owned-job' }) }),
          ]),
        }),
      }),
    );
    await h.runtime.stop();
  });

  it.each([0, 1])('retains owned job exit %i across a switch during the merge window', async (exitCode) => {
    const h = harness();
    await h.runtime.start();
    for (const sessionId of ['a', 'b']) await h.agent({ type: 'created', sessionId });
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    await h.job({ type: 'exited', id: 'owned-job', sessionId: 'a', command: 'fixture-command', exitCode });
    await h.agent({ type: 'pre-step', sessionId: 'b' });
    await h.advance(3_000);
    if (exitCode === 0)
      expect(h.delivered.flatMap((intent) => intent.update.changes)).not.toContainEqual(
        expect.objectContaining({ signal: expect.objectContaining({ subject: 'owned-job' }) }),
      );
    else expect(h.delivered).toMatchObject([{ sessionId: 'a', kind: 'send' }]);
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    const jobs = h.delivered.flatMap((intent) =>
      intent.update.changes
        .filter(({ signal }) => signal.subject === 'owned-job')
        .map((change) => ({ sessionId: intent.sessionId, kind: intent.kind, level: change.level })),
    );
    expect(jobs).toEqual([
      { sessionId: 'a', kind: exitCode === 0 ? 'inject' : 'send', level: exitCode === 0 ? 'context' : 'wake' },
    ]);
    await h.runtime.stop();
  });

  it('discards a foreign-target owned job when its owner closes and retains its local log', async () => {
    const h = harness();
    await h.runtime.start();
    for (const sessionId of ['a', 'b']) await h.agent({ type: 'created', sessionId });
    await h.agent({ type: 'pre-step', sessionId: 'b' });
    await h.job({ type: 'exited', id: 'old-job', sessionId: 'a', command: 'fixture-command', exitCode: 1 });
    await h.agent({ type: 'disposed', sessionId: 'a' });
    await h.agent({ type: 'created', sessionId: 'a' });
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    await h.advance(3_000);
    expect(JSON.stringify(h.delivered)).not.toContain('old-job');
    expect(h.runtime.events().some((event) => event.subject === 'fixture-command')).toBe(true);
    await h.runtime.stop();
  });

  it('applies the owner wake budget to a job that waits behind another session', async () => {
    const h = harness();
    await h.runtime.start();
    for (const sessionId of ['a', 'b']) await h.agent({ type: 'created', sessionId });
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    await h.job({ type: 'exited', id: 'first-job', sessionId: 'a', command: 'fixture-first', exitCode: 1 });
    await h.advance(3_000);
    await h.agent({ type: 'pre-step', sessionId: 'b' });
    await h.job({ type: 'exited', id: 'second-job', sessionId: 'a', command: 'fixture-second', exitCode: 1 });
    await h.advance(3_000);
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    const second = h.delivered.filter((intent) =>
      intent.update.changes.some(({ signal }) => signal.subject === 'second-job'),
    );
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      sessionId: 'a',
      kind: 'inject',
      update: { changes: [expect.objectContaining({ level: 'context', reason: 'wake-budget' })] },
    });
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

  it('logs a late old-generation job exit without delivering it to the recreated session', async () => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 'a' });
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    await h.job({ type: 'started', id: 'synthetic-old-job', sessionId: 'a' });
    await h.agent({ type: 'disposed', sessionId: 'a' });
    await h.agent({ type: 'created', sessionId: 'a' });
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    await h.job({ type: 'exited', id: 'synthetic-old-job', sessionId: 'a', exitCode: 1 });
    await h.advance(3_000);
    expect(JSON.stringify(h.delivered)).not.toContain('synthetic-old-job');
    expect(h.runtime.events()).toContainEqual(
      expect.objectContaining({ kind: 'job.exited', subject: 'synthetic-old-job', reason: 'session-private' }),
    );
    await h.runtime.stop();
  });

  it('does not attach an unregistered job exit to the current generation', async () => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 'a' });
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    await h.jobRaw({ type: 'exited', id: 'unknown-job', sessionId: 'a', exitCode: 1 });
    await h.advance(3_000);
    expect(JSON.stringify(h.delivered)).not.toContain('unknown-job');
    expect(h.runtime.events()).toContainEqual(expect.objectContaining({ subject: 'unknown-job', level: 'record' }));
    await h.runtime.stop();
  });

  it('uses the registered job owner even if an exit reports another session', async () => {
    const h = harness();
    await h.runtime.start();
    for (const sessionId of ['a', 'b']) await h.agent({ type: 'created', sessionId });
    await h.agent({ type: 'pre-step', sessionId: 'b' });
    await h.jobRaw({ type: 'started', id: 'owned-job', sessionId: 'a' });
    await h.jobRaw({ type: 'exited', id: 'owned-job', sessionId: 'b', exitCode: 1 });
    await h.advance(3_000);
    expect(h.delivered).toMatchObject([
      { sessionId: 'a', kind: 'followup', update: { changes: [{ signal: { subject: 'owned-job' } }] } },
    ]);
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
    const h = harness(undefined, {}, undefined, undefined, true);
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
  }, 20_000);

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

  it('records an unknown outcome once without transiently marking delivery ok', async () => {
    const h = harness();
    let attempts = 0;
    h.ports.dsh.deliver = async () => {
      attempts++;
      if (attempts === 1) throw new Error('transient failure');
      throw new DeliveryFailure('unknown', 0, new Error('fixture'));
    };
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    await h.job({ type: 'exited', id: 'failed-job', exitCode: 1 });
    await h.advance(2_000);
    expect(h.runtime.state().observation.sources.delivery?.status).toBe('unavailable');
    const before = h.runtime.events().filter((event) => event.source.id === 'delivery').length;
    const statuses: (string | undefined)[] = [];
    const off = h.runtime.subscribe((state) => {
      statuses.push(state.observation.sources.delivery?.status);
    });
    await h.advance(1_000);
    off();
    expect(attempts).toBe(2);
    expect(statuses).not.toContain('ok');
    expect(statuses.at(-1)).toBe('unavailable');
    const added = h.runtime
      .events()
      .filter((event) => event.source.id === 'delivery')
      .slice(before);
    expect(added.map((event) => event.kind)).toEqual(['delivery-unknown']);
    expect(h.runtime.state().observation.sources.delivery).toMatchObject({
      status: 'unavailable',
      error: '投递结果未知，未重试',
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
    expect(
      h.runtime.events().find((entry) => entry.subject === 'late-job' && entry.kind === 'job.exited'),
    ).toMatchObject({
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
          if (path === '/workspace') {
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
      if (path === '/bad') throw new Error('synthetic watch failure');
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
    callbacks.get('/other')?.(error);
    await vi.advanceTimersByTimeAsync(0);
    expect(closed.has('/other')).toBe(true);
    expect(h.runtime.state().observation.sources['files:other']?.status).toBe('unavailable');
    expect(h.runtime.state().observation.sources['files:files-wake']?.status).toBe('ok');
    callbacks.get('/workspace')?.({ path: '/workspace/synthetic.txt', change: 'add' });
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
      if (path === '/workspace') callback = emit;
      return {
        close: async () => {
          if (path === '/workspace' && first) {
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
      if (path === '/bad') throw new Error('synthetic watch failure');
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
      if (path === '/bad') {
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
      if (path === '/bad') {
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
    expect(watched.has('/new')).toBe(false);
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
    expect([...watched].sort()).toEqual(['/new', '/workspace']);
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
      watches.get('/workspace')?.(event);
      watches.get('/workspace/src')?.(event);
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
    watches.get('/workspace')?.(event);
    watches.get('/workspace')?.(event);
    watches.get('/workspace/src')?.(event);
    watches.get('/workspace/src')?.(event);
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
    for (let i = 0; i < 205; i++) h.fileRaw({ path: `/workspace/file-${i}`, change: 'modify' });
    await vi.advanceTimersByTimeAsync(0);
    await h.file({ path: '/workspace/file-204', change: 'modify' });
    expect(h.runtime.events().some((event) => event.reason === 'pending-evicted:5')).toBe(true);
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    const changes = h.delivered.flatMap((intent) => intent.update.changes);
    expect(changes).toHaveLength(200);
    expect(changes.find((change) => change.signal.subject === '/workspace/file-204')?.count).toBe(2);
    expect(changes.some((change) => change.signal.subject === '/workspace/file-0')).toBe(false);
    await h.runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
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

  it('delivers offline context at its original level after the agent lowers the rule', async () => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 'old' });
    await h.agent({ type: 'pre-step', sessionId: 'old' });
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocked = false;
    h.ports.storage.save = async (key) => {
      if (key === 'body' && !blocked) {
        blocked = true;
        started();
        await gate;
      }
    };
    const tuning = h.runtime.tools.bodyTune({ param: 'deliveryLevel.body.rate', to: 'record' });
    await entered;
    await h.agent({ type: 'disposed', sessionId: 'old' });
    const rss = (value: number) =>
      mkBody({ harnessProcess: { ...f({ rss: value, cpu: 0, uptimeSec: 0 }), observedAt: Date.now() } });
    await h.sample(rss(100));
    await h.advance(1_000);
    await h.sample(rss(200));
    const alert = h.runtime.events().find((event) => event.kind === 'body.rate');
    expect(alert).toMatchObject({ level: 'context' });
    release();
    expect(await tuning).toMatchObject({
      applied: true,
    });
    await h.agent({ type: 'created', sessionId: 'new' });
    await h.agent({ type: 'pre-step', sessionId: 'new' });
    expect(h.delivered.flatMap((intent) => intent.update.changes)).toContainEqual(
      expect.objectContaining({ level: 'context', signal: expect.objectContaining({ id: alert?.id }) }),
    );
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

  it('keeps displayed tuning and the actual pipeline equal through restore, retry, tuning, revert and reset', async () => {
    const levels = vi.spyOn(AttentionPipeline.prototype, 'setDeliveryLevels');
    let saved: string | undefined;
    let failRead = false;
    const storage = {
      load: async (key: string) => {
        if (key !== 'body') return undefined;
        if (failRead) throw Object.assign(new Error('fixture'), { code: 'EACCES' });
        return saved;
      },
      save: async (key: string, value: string) => {
        if (key === 'body') saved = value;
      },
      backup: async () => 'body.json.bak-fixture',
    };
    const check = (h: ReturnType<typeof harness>) => {
      const presenter = createPresenter(h.runtime, { clock: h.ports.clock });
      const params = Object.fromEntries(presenter.snapshot().tuning.parameters.map((item) => [item.key, item.value]));
      presenter.close();
      const pipeline = levels.mock.contexts.at(-1) as AttentionPipeline;
      const actual = pipeline as unknown as {
        levels: Record<string, string>;
        mergeWindowMs: number;
        fileMergeWindowMs: number;
      };
      expect(actual.levels).toEqual({
        'body.rate': params['deliveryLevel.body.rate'],
        'body.anomaly': params['deliveryLevel.body.anomaly'],
        'file.burst': params['deliveryLevel.file.burst'],
      });
      for (const kind of ['body.rate', 'body.anomaly', 'file.burst'] as const) {
        const rule = pipeline.selectRule({
          id: 'fixture',
          kind,
          at: Date.now(),
          source: { id: 'fixture', api: 'fixture', host: 'local' },
          subject: 'fixture',
          data: { severity: 'warn', externalDeletionExceeded: true },
        });
        expect(rule?.level).toBe(params[`deliveryLevel.${kind}`]);
      }
      expect(actual.mergeWindowMs).toBe(params.mergeWindowMs);
      expect(actual.fileMergeWindowMs).toBe(params.fileMergeWindowMs);
    };
    try {
      const first = harness();
      Object.assign(first.ports.storage, storage);
      await first.runtime.start();
      check(first);
      for (const [param, to] of [
        ['mergeWindowMs', 4_000],
        ['fileMergeWindowMs', 10_000],
        ['deliveryLevel.body.rate', 'record'],
        ['deliveryLevel.body.anomaly', 'record'],
      ] as const) {
        expect(await first.runtime.tools.bodyTune({ param, to })).toMatchObject({ applied: true });
        check(first);
      }
      await first.runtime.stop();

      failRead = true;
      const restored = harness();
      Object.assign(restored.ports.storage, storage);
      await restored.runtime.start();
      expect(restored.runtime.body.monitor.backupError).toEqual({ code: 'EACCES', stage: 'backup' });
      check(restored);
      const mismatches: string[] = [];
      const unwatch = restored.runtime.onChange(() => {
        try {
          check(restored);
        } catch (error) {
          mismatches.push(String(error));
        }
      });
      expect(restored.runtime.body.tuner.get('deliveryLevel.file.burst')).toBe('context');
      failRead = false;
      await restored.runtime.actions.retryTuningBackup();
      expect(restored.runtime.body.tuner.get('deliveryLevel.file.burst')).toBe('wake');
      check(restored);
      await restored.runtime.actions.deleteRule('files-wake');
      await restored.runtime.tools.envWatch({
        action: 'add',
        rule: { id: 'context-files', match: { kind: 'file.changed', subject: '/workspace/**' }, level: 'context' },
      });
      await restored.agent({ type: 'created', sessionId: 's' });
      await restored.agent({ type: 'pre-step', sessionId: 's' });
      await restored.agent({ type: 'post-step', sessionId: 's' });
      for (let i = 0; i < 51; i++) await restored.file({ path: `/workspace/${i}.ts`, change: 'delete' });
      await restored.advance(4_000);
      expect(restored.delivered).toContainEqual(
        expect.objectContaining({
          kind: 'followup',
          update: expect.objectContaining({
            changes: expect.arrayContaining([
              expect.objectContaining({ signal: expect.objectContaining({ kind: 'file.burst' }) }),
            ]),
          }),
        }),
      );
      const change = await restored.runtime.tools.bodyTune({ param: 'deliveryLevel.file.burst', to: 'context' });
      expect(change).toMatchObject({ applied: true });
      check(restored);
      await restored.runtime.actions.revertTuning(change.change.id);
      check(restored);
      expect(mismatches).toEqual([]);
      unwatch();
      await restored.runtime.stop();

      const normal = harness();
      Object.assign(normal.ports.storage, storage);
      await normal.runtime.start();
      check(normal);
      await normal.runtime.stop();
      saved = '{broken';
      const reset = harness();
      Object.assign(reset.ports.storage, storage);
      await reset.runtime.start();
      check(reset);
      await reset.runtime.actions.resetTuning();
      check(reset);
      await reset.runtime.stop();
    } finally {
      levels.mockRestore();
    }
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
    await expect(h.runtime.tools.bodyTune({ param: 'not-a-parameter', to: 1_000 })).rejects.toThrow(
      'unsupported-param',
    );
    await h.runtime.stop();
  });

  it('keeps the ten-minute ETA floor for direct and automatic noise tuning', async () => {
    const h = harness();
    await h.runtime.start();
    const param = 'rate.context.maxEtaMs';
    expect(await h.runtime.tools.bodyTune({ param, to: 300_000 })).toMatchObject({ applied: false });
    for (let i = 0; i < 3; i++) {
      const id = `eta-alert-${i}`;
      await h.runtime.body.tuner.registerAlert(id, 'context-eta', param);
      expect(await h.runtime.tools.bodyTune({ action: 'feedback', alertId: id, verdict: 'noise' })).toMatchObject({
        applied: true,
      });
    }
    expect(h.runtime.body.tuner.get(param)).toBe(600_000);
    expect(await h.runtime.tools.bodyTune({ param, to: 900_000 })).toMatchObject({ applied: true });
    expect(await h.runtime.tools.bodyTune({ param, to: 600_000 })).toMatchObject({
      applied: false,
      reason: 'safety: cannot loosen',
    });
    await h.runtime.stop();
  });

  it.each(['record', 'context'] as const)(
    'delivers the ten-minute disk warning while a %s rate warning stays latched',
    async (level) => {
      const h = harness();
      await h.runtime.start();
      await h.agent({ type: 'created', sessionId: 's' });
      await h.agent({ type: 'pre-step', sessionId: 's' });
      await h.agent({ type: 'post-step', sessionId: 's' });
      if (level === 'record') await h.runtime.tools.bodyTune({ param: 'deliveryLevel.body.rate', to: level });
      const gib = 1024 ** 3;
      const disk = (free: number) =>
        mkBody({
          disks: {
            ...diskFact([{ mount: '/fixture', total: 500 * gib, free: free * gib, observedAt: Date.now() }]),
            observedAt: Date.now(),
          },
        });
      await h.sample(disk(88));
      await h.advance(60_000);
      await h.sample(disk(85));
      expect(h.runtime.events().find((event) => event.subject === 'rate:disk-drop:disk:/fixture')).toMatchObject({
        level,
      });
      for (let minute = 2; minute <= 10; minute++) {
        await h.advance(60_000);
        await h.sample(disk(88 - 3 * minute));
      }
      expect(h.runtime.events().filter((event) => event.subject === 'rate:disk-drop:disk:/fixture')).toHaveLength(1);
      await h.advance(60_000);
      await h.sample(disk(55));
      await h.agent({ type: 'pre-step', sessionId: 's' });
      expect(h.delivered.flatMap((intent) => intent.update.changes)).toContainEqual(
        expect.objectContaining({
          level: 'context',
          signal: expect.objectContaining({
            subject: 'rate:disk-drop:disk:/fixture',
            data: expect.objectContaining({ timeToFloorMs: 600_000 }),
          }),
        }),
      );
      await h.advance(60_000);
      await h.sample(disk(52));
      expect(h.runtime.events().filter((event) => event.subject === 'rate:disk-drop:disk:/fixture')).toHaveLength(2);
      await h.runtime.stop();
    },
  );

  it('delivers the ten-minute context warning after a tuned twenty-minute warning stays latched', async () => {
    const h = harness();
    await h.runtime.start();
    await h.runtime.tools.bodyTune({ param: 'deliveryLevel.body.rate', to: 'record' });
    await h.runtime.tools.bodyTune({ param: 'rate.context.maxEtaMs', to: 900_000 });
    await h.runtime.tools.bodyTune({ param: 'rate.context.maxEtaMs', to: 1_200_000 });
    await h.agent({ type: 'created', sessionId: 's' });
    const sample = async (minute: number) => {
      h.token({
        contextWindow: 25_000,
        contextUsed: 4_000 + 1_000 * minute,
        contextWindowSource: 'configured',
        sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
      await h.agent({ type: 'pre-step', sessionId: 's' });
      await h.sample();
      await h.agent({ type: 'post-step', sessionId: 's' });
    };
    await sample(0);
    for (let minute = 1; minute <= 11; minute++) {
      await h.advance(60_000);
      await sample(minute);
      if (minute === 1) {
        expect(h.runtime.events().find((event) => event.subject === 'rate:context-eta')).toMatchObject({
          level: 'record',
        });
      }
    }
    await h.agent({ type: 'pre-step', sessionId: 's' });
    expect(h.delivered.flatMap((intent) => intent.update.changes)).toContainEqual(
      expect.objectContaining({
        level: 'context',
        signal: expect.objectContaining({
          subject: 'rate:context-eta',
          data: expect.objectContaining({ timeToFloorMs: 600_000 }),
        }),
      }),
    );
    await h.runtime.stop();
  });

  it.each(['context', 'record'] as const)(
    'emits one context ETA warning at the ten-minute boundary when rate delivery is %s',
    async (level) => {
      const h = harness();
      await h.runtime.start();
      if (level === 'record') await h.runtime.tools.bodyTune({ param: 'deliveryLevel.body.rate', to: 'record' });
      await h.agent({ type: 'created', sessionId: 's' });
      const sample = async (minute: number) => {
        h.token({
          contextWindow: 25_000,
          contextUsed: 4_000 + 1_000 * minute,
          contextWindowSource: 'configured',
          sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        });
        await h.agent({ type: 'pre-step', sessionId: 's' });
        await h.sample();
        await h.agent({ type: 'post-step', sessionId: 's' });
      };
      await sample(0);
      for (let minute = 1; minute <= 11; minute++) {
        await h.advance(60_000);
        await sample(minute);
      }
      await h.agent({ type: 'pre-step', sessionId: 's' });
      const warnings = h.runtime
        .events()
        .filter((event) => event.kind === 'body.rate' && event.subject.includes('context'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0].level).toBe('context');
      const changes = h.delivered
        .flatMap((intent) => intent.update.changes)
        .filter((change) => change.signal.kind === 'body.rate' && change.signal.subject.includes('context'));
      expect(changes).toHaveLength(1);
      expect(changes[0].level).toBe('context');
      await h.runtime.stop();
    },
  );

  it.each(['context', 'wake'] as const)(
    'routes the single ten-minute context ETA warning through a custom %s rule',
    async (level) => {
      const h = harness(undefined, {
        rules: [
          ...DEFAULT_RULES,
          ...defaultBodyRules(),
          {
            id: 'custom-context-eta',
            match: { kind: 'body.rate', where: { ruleId: 'context-eta' } },
            level,
            createdBy: 'user',
            approved: true,
          },
        ],
      });
      await h.runtime.start();
      await h.runtime.actions.toggleRule('body-rate-warn', false);
      await h.agent({ type: 'created', sessionId: 's' });
      const sample = async (minute: number) => {
        h.token({
          contextWindow: 25_000,
          contextUsed: 4_000 + 1_000 * minute,
          contextWindowSource: 'configured',
          sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        });
        await h.agent({ type: 'pre-step', sessionId: 's' });
        await h.sample();
        await h.agent({ type: 'post-step', sessionId: 's' });
      };
      await sample(0);
      for (let minute = 1; minute <= 11; minute++) {
        await h.advance(60_000);
        await sample(minute);
      }
      await h.advance(2_000);
      await h.agent({ type: 'pre-step', sessionId: 's' });
      const warnings = h.runtime
        .events()
        .filter((event) => event.kind === 'body.rate' && event.subject.includes('context'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ subject: 'rate:context-eta', level, ruleId: 'custom-context-eta' });
      const changes = h.delivered
        .flatMap((intent) => intent.update.changes)
        .filter((change) => change.signal.kind === 'body.rate' && change.signal.subject.includes('context'));
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ level, signal: { data: { ruleId: 'context-eta', timeToFloorMs: 600_000 } } });
      await h.runtime.stop();
    },
  );

  it.each(['context', 'wake'] as const)(
    'routes the hard context boundary to a custom %s rule after an earlier tuned alert',
    async (level) => {
      const h = harness(undefined, {
        rules: [
          ...DEFAULT_RULES,
          ...defaultBodyRules(),
          {
            id: 'custom-hard-context',
            match: { kind: 'body.rate', where: { ruleId: 'context-eta', timeToFloorMs: { '<=': 600_000 } } },
            level,
            createdBy: 'user',
            approved: true,
          },
        ],
      });
      await h.runtime.start();
      await h.runtime.tools.bodyTune({ param: 'rate.context.maxEtaMs', to: 900_000 });
      await h.runtime.tools.bodyTune({ param: 'rate.context.maxEtaMs', to: 1_200_000 });
      await h.runtime.actions.toggleRule('body-rate-warn', false);
      await h.agent({ type: 'created', sessionId: 's' });
      for (let minute = 0; minute <= 11; minute++) {
        if (minute) await h.advance(60_000);
        h.token({
          contextWindow: 25_000,
          contextUsed: 4_000 + 1_000 * minute,
          contextWindowSource: 'configured',
          sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        });
        await h.agent({ type: 'pre-step', sessionId: 's' });
        await h.sample();
        await h.agent({ type: 'post-step', sessionId: 's' });
      }
      await h.advance(2_000);
      await h.agent({ type: 'pre-step', sessionId: 's' });
      const hardEvents = h.runtime
        .events()
        .filter((event) => event.kind === 'body.rate' && event.detail?.timeToFloorMs === 600_000);
      expect(hardEvents).toHaveLength(1);
      expect(hardEvents[0]).toMatchObject({ subject: 'rate:context-eta', ruleId: 'custom-hard-context', level });
      const hardChanges = h.delivered
        .flatMap((intent) => intent.update.changes)
        .filter((change) => change.signal.data.timeToFloorMs === 600_000 && change.signal.kind === 'body.rate');
      expect(hardChanges).toHaveLength(1);
      expect(hardChanges[0]).toMatchObject({ level, signal: { data: { ruleId: 'context-eta' } } });
      await h.runtime.stop();
    },
  );

  it('emits one disk warning when the rate and ten-minute ETA thresholds coincide', async () => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    const gib = 1024 ** 3;
    const disk = (free: number) =>
      mkBody({
        disks: {
          ...diskFact([{ mount: '/fixture', total: 500 * gib, free: free * gib, observedAt: Date.now() }]),
          observedAt: Date.now(),
        },
      });
    await h.sample(disk(33));
    await h.advance(60_000);
    await h.sample(disk(30));
    await h.agent({ type: 'pre-step', sessionId: 's' });
    const warnings = h.runtime.events().filter((event) => event.kind === 'body.rate' && event.subject.includes('disk'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].subject).toBe('rate:disk-drop:disk:/fixture');
    await h.runtime.stop();
  });

  it('applies, guards and reverts merge windows and delivery levels', async () => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    await h.agent({ type: 'post-step', sessionId: 's' });
    await h.job({ type: 'exited', id: 'pending', exitCode: 1 });
    await h.advance(500);
    const window = await h.runtime.tools.bodyTune({ param: 'mergeWindowMs', to: 1_000 });
    expect(window).toMatchObject({ applied: true, change: { from: 2_000, to: 1_000 } });
    await h.advance(500);
    expect(h.delivered).toHaveLength(1);
    expect(await h.runtime.tools.bodyTune({ param: 'fileMergeWindowMs', to: 999 })).toMatchObject({
      applied: false,
      reason: 'out of bounds',
    });
    expect(await h.runtime.tools.bodyTune({ param: 'fileMergeWindowMs', to: 60_001 })).toMatchObject({
      applied: false,
      reason: 'out of bounds',
    });
    expect(await h.runtime.tools.bodyTune({ param: 'fileMergeWindowMs', to: 10_001 })).toMatchObject({
      applied: false,
    });
    expect(await h.runtime.tools.bodyTune({ param: 'fileMergeWindowMs', to: 10_000 })).toMatchObject({ applied: true });
    expect(await h.runtime.tools.bodyTune({ param: 'deliveryLevel.body.rate', to: 'wake' })).toMatchObject({
      applied: false,
    });
    expect(await h.runtime.tools.bodyTune({ param: 'deliveryLevel.body.rate', to: 'record' })).toMatchObject({
      applied: true,
    });
    const burst = await h.runtime.tools.bodyTune({ param: 'deliveryLevel.file.burst', to: 'record' });
    expect(burst).toMatchObject({
      applied: true,
    });
    expect(await h.runtime.tools.bodyTune({ param: 'deliveryLevel.file.burst', to: 'wake' })).toMatchObject({
      applied: false,
    });
    await h.runtime.actions.revertTuning(window.change.id);
    expect(await h.runtime.actions.revertTuning(burst.change.id)).toMatchObject({ applied: true });
    expect(h.runtime.body.tuner.get('deliveryLevel.file.burst')).toBe('wake');
    for (let i = 0; i < 51; i++) await h.file({ path: `/workspace/${i}.ts`, change: 'delete' });
    expect(h.runtime.events().find((event) => event.kind === 'file.burst')).toMatchObject({ level: 'wake' });
    expect(h.runtime.body.tuner.get('mergeWindowMs')).toBe(2_000);
    await h.runtime.stop();
  });

  it('restores tuning and migrates the exact previous whitelist without losing locks or quotas', async () => {
    let saved: string | undefined;
    const storage = {
      load: async (key: string) => (key === 'body' ? saved : undefined),
      save: async (key: string, value: string) => {
        if (key === 'body') saved = value;
      },
    };
    const first = harness();
    Object.assign(first.ports.storage, storage);
    await first.runtime.start();
    await first.runtime.tools.bodyTune({ param: 'rate.rss.maxRatio', to: 0.6 });
    await first.runtime.tools.bodyTune({ param: 'rate.rss.maxRatio', to: 0.7 });
    await first.runtime.actions.lockParam('floor.disk.warn', true);
    await first.runtime.stop();
    if (!saved) throw new Error('missing snapshot');
    const legacy = JSON.parse(saved);
    legacy.version = 1;
    const tuner = JSON.parse(legacy.tuner);
    tuner.values = tuner.values.filter(
      ([key]: [string, unknown]) =>
        key !== 'mergeWindowMs' && key !== 'fileMergeWindowMs' && !key.startsWith('deliveryLevel.'),
    );
    legacy.tuner = JSON.stringify(tuner);
    saved = JSON.stringify(legacy);
    const restored = harness();
    Object.assign(restored.ports.storage, storage);
    await restored.runtime.start();
    expect(restored.runtime.body.tuner.tuningDisabled).toBeUndefined();
    expect(restored.runtime.body.tuner.get('mergeWindowMs')).toBe(2_000);
    expect(restored.runtime.body.tuner.get('rate.rss.maxRatio')).toBe(0.7);
    expect(await restored.runtime.tools.bodyTune({ param: 'rate.rss.maxRatio', to: 0.8 })).toMatchObject({
      reason: 'hourly change limit',
    });
    expect(await restored.runtime.tools.bodyTune({ param: 'floor.disk.warn', to: 0.11 })).toMatchObject({
      reason: 'param locked',
    });
    const applied = await restored.runtime.tools.bodyTune({ param: 'mergeWindowMs', to: 4_000 });
    const level = await restored.runtime.tools.bodyTune({ param: 'deliveryLevel.body.rate', to: 'record' });
    expect(applied.applied && level.applied).toBe(true);
    await restored.runtime.stop();
    const restarted = harness();
    Object.assign(restarted.ports.storage, storage);
    await restarted.runtime.start();
    expect(restarted.runtime.body.tuner.get('mergeWindowMs')).toBe(4_000);
    expect(restarted.runtime.body.tuner.get('deliveryLevel.body.rate')).toBe('record');
    await restarted.agent({ type: 'created', sessionId: 'restored' });
    await restarted.agent({ type: 'pre-step', sessionId: 'restored' });
    await restarted.agent({ type: 'post-step', sessionId: 'restored' });
    await restarted.job({ type: 'exited', id: 'restored-job', exitCode: 1 });
    await restarted.advance(3_999);
    expect(restarted.delivered).toHaveLength(0);
    await restarted.advance(1);
    expect(restarted.delivered).toHaveLength(1);
    await restarted.runtime.actions.revertTuning(applied.change.id);
    expect(restarted.runtime.body.tuner.get('mergeWindowMs')).toBe(2_000);
    await restarted.runtime.stop();
  });

  it.each([false, true])(
    'migrates a legacy ETA below the new floor (history only: %s) without losing state',
    async (historyOnly) => {
      let saved: string | undefined;
      const storage = {
        load: async (key: string) => (key === 'body' ? saved : undefined),
        save: async (key: string, value: string) => {
          if (key === 'body') saved = value;
        },
      };
      const first = harness();
      Object.assign(first.ports.storage, storage);
      await first.runtime.start();
      await first.sample(
        mkBody({ cpu: { ...f({ usage: 0.42, perCore: [], load1: 0, load5: 0, load15: 0 }), observedAt: Date.now() } }),
      );
      await first.runtime.tools.bodyTune({ param: 'rate.rss.maxRatio', to: 0.6 });
      await first.runtime.tools.bodyTune({ param: 'rate.rss.maxRatio', to: 0.7 });
      await first.runtime.actions.lockParam('floor.disk.warn', true);
      await first.runtime.stop();
      if (!saved) throw new Error('missing snapshot');
      const legacy = JSON.parse(saved);
      const tuner = JSON.parse(legacy.tuner);
      legacy.version = 1;
      tuner.values = tuner.values.filter(
        ([key]: [string, unknown]) =>
          key !== 'mergeWindowMs' && key !== 'fileMergeWindowMs' && !key.startsWith('deliveryLevel.'),
      );
      const entry = (from: number, to: number) => ({
        id: `${tuner.idPrefix}-${tuner.nextId++}`,
        param: 'rate.context.maxEtaMs',
        from,
        to,
        by: 'user',
        reason: 'legacy user change',
        at: Date.now(),
        operation: 'propose',
        status: 'applied',
      });
      const history = [entry(600_000, 300_000), ...(historyOnly ? [entry(300_000, 600_000)] : [])];
      tuner.log.push(...history);
      tuner.applied.push(...history);
      tuner.values.find(([key]: [string, unknown]) => key === 'rate.context.maxEtaMs')[1] = historyOnly
        ? 600_000
        : 300_000;
      legacy.tuner = JSON.stringify(tuner);
      saved = JSON.stringify(legacy);
      const restored = harness();
      Object.assign(restored.ports.storage, storage);
      await restored.runtime.start();
      expect(restored.runtime.body.tuner.tuningDisabled).toBeUndefined();
      expect(restored.runtime.body.tuner.get('rate.context.maxEtaMs')).toBe(600_000);
      expect(restored.runtime.body.tuner.get('rate.rss.maxRatio')).toBe(0.7);
      expect(restored.runtime.body.tuner.logs).toEqual(expect.arrayContaining(history));
      const floorChanges = restored.runtime.body.tuner.logs.filter((entry) => entry.reason === '新版底线');
      expect(floorChanges).toHaveLength(historyOnly ? 0 : 1);
      if (!historyOnly) {
        expect(floorChanges[0]).toMatchObject({ from: 300_000, to: 600_000, by: 'auto', status: 'applied' });
        expect(restored.runtime.body.tuner.undoableChanges).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ id: floorChanges[0].id })]),
        );
        expect(await restored.runtime.actions.revertTuning(floorChanges[0].id)).toMatchObject({
          applied: false,
          reason: 'out of bounds',
        });
      }
      expect(await restored.runtime.tools.bodyTune({ param: 'rate.rss.maxRatio', to: 0.8 })).toMatchObject({
        reason: 'hourly change limit',
      });
      expect(await restored.runtime.tools.bodyTune({ param: 'floor.disk.warn', to: 0.11 })).toMatchObject({
        reason: 'param locked',
      });
      await restored.runtime.stop();
      if (!saved) throw new Error('missing migrated snapshot');
      const migrated = JSON.parse(saved);
      const migratedTuner = JSON.parse(migrated.tuner);
      expect(migrated.baseline).toBe(legacy.baseline);
      expect(migrated.history).toEqual(legacy.history);
      expect(migrated.latch).toEqual(legacy.latch);
      for (const [key, value] of tuner.values) {
        expect(migratedTuner.values.find(([name]: [string, unknown]) => name === key)?.[1]).toBe(
          key === 'rate.context.maxEtaMs' ? 600_000 : value,
        );
      }
      expect(migratedTuner.locked).toEqual(tuner.locked);
      expect(migratedTuner.log.slice(0, tuner.log.length)).toEqual(tuner.log);
      expect(migratedTuner.applied.slice(0, tuner.applied.length)).toEqual(tuner.applied);
      expect(migratedTuner.hour).toEqual(tuner.hour);
      expect(migratedTuner.day).toEqual(tuner.day);
      expect(migratedTuner.dayAll).toEqual(tuner.dayAll);
      const restarted = harness();
      Object.assign(restarted.ports.storage, storage);
      await restarted.runtime.start();
      expect(restarted.runtime.body.tuner.tuningDisabled).toBeUndefined();
      expect(restarted.runtime.body.tuner.logs).toEqual(expect.arrayContaining(history));
      expect(restarted.runtime.body.tuner.logs.filter((entry) => entry.reason === '新版底线')).toHaveLength(
        historyOnly ? 0 : 1,
      );
      expect(restarted.runtime.body.tuner.get('rate.rss.maxRatio')).toBe(0.7);
      await restarted.runtime.stop();
    },
  );

  it('backs up an unrecognized v1 snapshot before falling back to safe defaults', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'asi-tuning-backup-'));
    try {
      const reportBackup = vi.fn();
      const storage = new FileStoragePort(root, fs, () => {}, reportBackup);
      const first = harness();
      Object.assign(first.ports.storage, {
        load: storage.load.bind(storage),
        save: storage.save.bind(storage),
        backup: (...args: [string, string]) => storage.backup(...args),
      });
      await first.runtime.start();
      await first.runtime.tools.bodyTune({ param: 'rate.rss.maxRatio', to: 0.6 });
      await first.runtime.stop();
      const snapshot = JSON.parse((await storage.load('body')) as string);
      snapshot.version = 1;
      const original = JSON.stringify(snapshot);
      await storage.save('body', original);
      const restored = harness();
      Object.assign(restored.ports.storage, first.ports.storage);
      await restored.runtime.start();
      expect(restored.runtime.body.tuner.tuningDisabled).toBe('restore-failed');
      expect(restored.runtime.body.tuner.get('rate.rss.maxRatio')).toBe(0.5);
      expect(restored.runtime.body.tuner.get('deliveryLevel.file.burst')).toBe('context');
      const presenter = createPresenter(restored.runtime, { clock: restored.ports.clock });
      expect(presenter.snapshot().tuning.disabled).toEqual({ reason: 'restore-failed' });
      presenter.close();
      const backups = (await fs.readdir(root)).filter((name) => name.startsWith('body.json.bak-'));
      expect(backups).toHaveLength(1);
      expect(await fs.readFile(join(root, backups[0]), 'utf8')).toBe(original);
      expect((await fs.stat(join(root, backups[0]))).mode & 0o777).toBe(0o600);
      expect(reportBackup).toHaveBeenCalledOnce();
      await restored.runtime.stop();
      const restarted = harness();
      Object.assign(restarted.ports.storage, first.ports.storage);
      await restarted.runtime.start();
      expect(restarted.runtime.body.tuner.tuningDisabled).toBe('restore-failed');
      expect((await fs.readdir(root)).filter((name) => name.startsWith('body.json.bak-'))).toHaveLength(1);
      expect(reportBackup).toHaveBeenCalledOnce();
      await restarted.runtime.actions.resetTuning();
      expect(restarted.runtime.body.tuner.tuningDisabled).toBeUndefined();
      await restarted.runtime.stop();
      const reset = harness();
      Object.assign(reset.ports.storage, first.ports.storage);
      await reset.runtime.start();
      expect(reset.runtime.body.tuner.tuningDisabled).toBeUndefined();
      await reset.runtime.stop();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('never overwrites an unrecognized snapshot when its backup fails', async () => {
    let saved = '{"version":99}';
    const original = saved;
    let failed = true;
    const report = vi.fn();
    const h = harness();
    Object.assign(h.ports.storage, {
      load: async (key: string) => (key === 'body' ? saved : undefined),
      save: async (key: string, value: string) => {
        if (key === 'body') saved = value;
      },
      backup: async () => {
        if (failed) throw Object.assign(new Error('private path'), { code: 'ENOSPC' });
        expect(saved).toBe(original);
        return 'body.json.bak-fixture';
      },
      reportBackupFailure: report,
    });
    await h.runtime.start();
    const presenter = createPresenter(h.runtime, { clock: h.ports.clock });
    expect(h.runtime.body.tuner.tuningDisabled).toBe('restore-failed');
    expect(presenter.snapshot().tuning.backupError).toEqual({ code: 'ENOSPC', stage: 'backup' });
    expect(report).toHaveBeenCalledWith('ENOSPC');
    await expect(h.runtime.actions.resetTuning()).rejects.toThrow();
    await expect(h.runtime.actions.retryTuningBackup()).rejects.toThrow();
    expect(saved).toBe(original);
    failed = false;
    await h.runtime.actions.retryTuningBackup();
    expect(presenter.snapshot().tuning.backupError).toBeUndefined();
    expect(presenter.snapshot().tuning.backupNotice).toEqual({
      kind: 'unknown-version',
      fileName: 'body.json.bak-fixture',
    });
    await h.runtime.actions.resetTuning();
    presenter.close();
    await h.runtime.stop();
    expect(saved).not.toBe(original);
  });

  it('shows a completed backup when marker saving fails and reuses it on retries and restart', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'asi-tuning-save-failed-'));
    try {
      const storage = new FileStoragePort(root, fs, () => {});
      const original = '{"version":99}';
      await storage.save('body', original);
      let failSave = true;
      const create = async () => {
        const h = harness();
        const port = new FileStoragePort(root, fs, () => {});
        Object.assign(h.ports.storage, {
          load: port.load.bind(port),
          save: async (key: string, value: string) => {
            if (key === 'body' && failSave) throw Object.assign(new Error('fixture'), { code: 'ENOSPC' });
            await port.save(key, value);
          },
          backup: port.backup.bind(port),
        });
        await h.runtime.start();
        return h;
      };
      const first = await create();
      const presenter = createPresenter(first.runtime, { clock: first.ports.clock });
      const notice = presenter.snapshot().tuning.backupNotice;
      expect(notice).toEqual({ kind: 'unknown-version', fileName: expect.stringMatching(/^body\.json\.bak-/) });
      if (!notice) throw new Error('missing backup notice');
      expect(await fs.readFile(join(root, notice.fileName), 'utf8')).toBe(original);
      expect((await fs.stat(join(root, notice.fileName))).mode & 0o777).toBe(0o600);
      expect(presenter.snapshot().tuning.backupError).toEqual({ code: 'ENOSPC', stage: 'save' });
      await expect(first.runtime.actions.resetTuning()).rejects.toThrow();
      await expect(first.runtime.actions.retryTuningBackup()).rejects.toThrow();
      expect(await storage.load('body')).toBe(original);
      expect((await fs.readdir(root)).filter((name) => name.startsWith('body.json.bak-'))).toEqual([notice.fileName]);
      presenter.close();
      await first.runtime.stop();

      const restarted = await create();
      expect(restarted.runtime.body.monitor.backupNotice).toEqual(notice);
      expect((await fs.readdir(root)).filter((name) => name.startsWith('body.json.bak-'))).toEqual([notice.fileName]);
      failSave = false;
      await restarted.runtime.actions.retryTuningBackup();
      expect(restarted.runtime.body.monitor.backupNotice).toEqual(notice);
      expect(restarted.runtime.body.monitor.backupError).toBeUndefined();
      await restarted.runtime.actions.resetTuning();
      await restarted.runtime.stop();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('classifies supported but corrupt v1 and v2 snapshots separately from unknown versions', async () => {
    let saved: string | undefined;
    const storage = {
      load: async (key: string) => (key === 'body' ? saved : undefined),
      save: async (key: string, value: string) => {
        if (key === 'body') saved = value;
      },
      backup: async () => 'body.json.bak-fixture',
    };
    const first = harness();
    Object.assign(first.ports.storage, storage);
    await first.runtime.start();
    await first.runtime.stop();
    if (!saved) throw new Error('missing snapshot');
    const v2 = JSON.parse(saved);
    const v1 = structuredClone(v2);
    v1.version = 1;
    const tuner = JSON.parse(v1.tuner);
    tuner.values = tuner.values.filter(
      ([key]: [string, unknown]) =>
        key !== 'mergeWindowMs' && key !== 'fileMergeWindowMs' && !key.startsWith('deliveryLevel.'),
    );
    v1.tuner = JSON.stringify(tuner);
    v1.baseline = 'invalid';
    const fullV1 = { ...v2, version: 1 };
    const corruptV2 = { ...v2, baseline: 'invalid' };
    for (const [input, kind] of [
      [v1, 'corrupt'],
      [fullV1, 'corrupt'],
      [corruptV2, 'corrupt'],
      [{ version: 99 }, 'unknown-version'],
    ] as const) {
      saved = JSON.stringify(input);
      const h = harness();
      Object.assign(h.ports.storage, storage);
      await h.runtime.start();
      expect(h.runtime.body.monitor.backupNotice).toMatchObject({ kind });
      await h.runtime.stop();
    }
  });

  it.each([
    ['corrupt', '{broken'],
    ['unknown-version', '{"version":99}'],
  ] as const)('keeps the %s backup notice until acknowledged across restarts', async (kind, original) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'asi-tuning-notice-'));
    try {
      const storage = new FileStoragePort(root, fs, () => {});
      await storage.save('body', original);
      const create = async () => {
        const h = harness();
        Object.assign(h.ports.storage, {
          load: storage.load.bind(storage),
          save: storage.save.bind(storage),
          backup: storage.backup.bind(storage),
        });
        await h.runtime.start();
        const presenter = createPresenter(h.runtime, { clock: h.ports.clock });
        return { h, presenter };
      };
      const first = await create();
      const notice = first.presenter.snapshot().tuning.backupNotice;
      expect(notice).toEqual({ kind, fileName: expect.stringMatching(/^body\.json\.bak-/) });
      if (!notice) throw new Error('missing backup notice');
      expect(notice?.fileName).not.toContain('/');
      expect(await fs.readFile(join(root, notice.fileName), 'utf8')).toBe(original);
      first.presenter.close();
      await first.h.runtime.stop();
      const second = await create();
      expect(second.presenter.snapshot().tuning.backupNotice).toEqual(notice);
      await second.h.runtime.actions.dismissTuningBackup();
      expect(second.presenter.snapshot().tuning.backupNotice).toBeUndefined();
      expect(second.presenter.snapshot().tuning.restoreKind).toBe(kind);
      second.presenter.close();
      await second.h.runtime.stop();
      const third = await create();
      expect(third.presenter.snapshot().tuning.backupNotice).toBeUndefined();
      expect(third.presenter.snapshot().tuning.restoreKind).toBe(kind);
      third.presenter.close();
      await third.h.runtime.stop();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('blocks reset while a backup retry is pending and preserves the original until backup completes', async () => {
    let saved = '{"version":99}';
    let allow = false;
    let finish!: () => void;
    const h = harness();
    Object.assign(h.ports.storage, {
      load: async (key: string) => (key === 'body' ? saved : undefined),
      save: async (key: string, value: string) => {
        if (key === 'body') saved = value;
      },
      backup: async () => {
        if (!allow) throw Object.assign(new Error('fixture'), { code: 'EACCES' });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        expect(saved).toBe('{"version":99}');
        return 'body.json.bak-fixture';
      },
    });
    await h.runtime.start();
    allow = true;
    const retry = h.runtime.actions.retryTuningBackup();
    await vi.waitFor(() => expect(finish).toBeDefined());
    await expect(h.runtime.actions.resetTuning()).rejects.toThrow();
    expect(saved).toBe('{"version":99}');
    finish();
    await retry;
    await h.runtime.actions.resetTuning();
    await h.runtime.stop();
  });

  it('stays disabled if the original disappears before a backup retry', async () => {
    let saved: string | undefined = '{"version":99}';
    const h = harness();
    Object.assign(h.ports.storage, {
      load: async (key: string) => (key === 'body' ? saved : undefined),
      save: async (key: string, value: string) => {
        if (key === 'body') saved = value;
      },
      backup: async () => {
        throw Object.assign(new Error('fixture'), { code: 'EACCES' });
      },
    });
    await h.runtime.start();
    saved = undefined;
    await expect(h.runtime.actions.retryTuningBackup()).rejects.toThrow();
    expect(h.runtime.body.monitor.backupError).toEqual({ code: 'SNAPSHOT_MISSING', stage: 'backup' });
    await expect(h.runtime.actions.resetTuning()).rejects.toThrow();
    expect(saved).toBeUndefined();
    await h.runtime.stop();
  });

  it('does not overwrite a replacement that appeared during backup', async () => {
    let saved = '{"version":99}';
    const backedUp: string[] = [];
    const h = harness();
    Object.assign(h.ports.storage, {
      load: async (key: string) => (key === 'body' ? saved : undefined),
      save: async (key: string, value: string) => {
        if (key === 'body') saved = value;
      },
      backup: async (_key: string, original: string) => {
        backedUp.push(original);
        if (backedUp.length === 1) saved = '{"version":98}';
        return 'body.json.bak-fixture';
      },
    });
    await h.runtime.start();
    expect(saved).toBe('{"version":98}');
    expect(h.runtime.body.monitor.backupError).toEqual({ code: 'SNAPSHOT_CHANGED', stage: 'backup' });
    await expect(h.runtime.actions.resetTuning()).rejects.toThrow();
    await h.runtime.actions.retryTuningBackup();
    expect(backedUp).toEqual(['{"version":99}', '{"version":98}']);
    await h.runtime.stop();
  });

  it('does not lose a backup notice when acknowledging it fails', async () => {
    let saved = '{"version":99}';
    let failSave = false;
    const h = harness();
    Object.assign(h.ports.storage, {
      load: async (key: string) => (key === 'body' ? saved : undefined),
      save: async (key: string, value: string) => {
        if (key === 'body' && failSave) throw new Error('fixture');
        if (key === 'body') saved = value;
      },
      backup: async () => 'body.json.bak-fixture',
    });
    await h.runtime.start();
    failSave = true;
    await expect(h.runtime.actions.dismissTuningBackup()).rejects.toThrow();
    expect(h.runtime.body.monitor.backupNotice).toEqual({ kind: 'unknown-version', fileName: 'body.json.bak-fixture' });
    expect(JSON.parse(saved).backupNotice.fileName).toBe('body.json.bak-fixture');
    failSave = false;
    await h.runtime.actions.dismissTuningBackup();
    await h.runtime.stop();
  });

  it('fails closed for incomplete legacy and partially migrated tuning snapshots', async () => {
    let saved: string | undefined;
    const storage = {
      load: async (key: string) => (key === 'body' ? saved : undefined),
      save: async (key: string, value: string) => {
        if (key === 'body') saved = value;
      },
    };
    const first = harness();
    Object.assign(first.ports.storage, storage);
    await first.runtime.start();
    await first.runtime.stop();
    if (!saved) throw new Error('missing snapshot');
    const valid = saved;
    for (const missing of ['rate.rss.maxRatio', 'fileMergeWindowMs']) {
      const body = JSON.parse(valid);
      const tuner = JSON.parse(body.tuner);
      tuner.values = tuner.values.filter(([key]: [string, unknown]) => key !== missing);
      body.tuner = JSON.stringify(tuner);
      saved = JSON.stringify(body);
      const restored = harness();
      Object.assign(restored.ports.storage, storage);
      await restored.runtime.start();
      expect(restored.runtime.body.tuner.tuningDisabled).toBe('restore-failed');
      await restored.runtime.stop();
    }
  });

  it('rejects damaged or disguised snapshots without silently restoring wake', async () => {
    let saved: string | undefined;
    const storage = {
      load: async (key: string) => (key === 'body' ? saved : undefined),
      save: async (key: string, value: string) => {
        if (key === 'body') saved = value;
      },
    };
    const first = harness();
    Object.assign(first.ports.storage, storage);
    await first.runtime.start();
    await first.runtime.tools.bodyTune({ param: 'deliveryLevel.file.burst', to: 'context' });
    await first.jump(86_400_001);
    await first.runtime.stop();
    if (!saved) throw new Error('missing snapshot');
    const valid = saved;
    expect(JSON.parse(valid).version).toBe(2);
    for (const damage of [
      'missing-added',
      'disguised-legacy',
      'disguised-history-only',
      'unknown-applied',
      'bad-baseline',
      'forged-wake',
    ]) {
      const snapshot = JSON.parse(valid);
      const tuner = JSON.parse(snapshot.tuner);
      if (damage === 'missing-added' || damage === 'disguised-legacy' || damage === 'disguised-history-only') {
        tuner.values = tuner.values.filter(
          ([key]: [string, unknown]) =>
            key !== 'mergeWindowMs' && key !== 'fileMergeWindowMs' && !key.startsWith('deliveryLevel.'),
        );
        if (damage !== 'missing-added') snapshot.version = 1;
        if (damage === 'disguised-history-only') tuner.applied = [];
      }
      if (damage === 'unknown-applied') {
        tuner.applied[0].param = 'unknown-param';
        tuner.log[0].param = 'unknown-param';
      }
      if (damage === 'bad-baseline') snapshot.baseline = 'broken';
      if (damage === 'forged-wake') {
        tuner.values.find(([key]: [string, unknown]) => key === 'deliveryLevel.file.burst')[1] = 'wake';
      }
      snapshot.tuner = JSON.stringify(tuner);
      saved = JSON.stringify(snapshot);
      const restored = harness();
      Object.assign(restored.ports.storage, storage);
      await restored.runtime.start();
      expect(restored.runtime.body.tuner.tuningDisabled, damage).toBe('restore-failed');
      expect(restored.runtime.body.tuner.get('deliveryLevel.file.burst'), damage).not.toBe('wake');
      await expect(restored.runtime.tools.bodyTune({ param: 'rate.rss.maxRatio', to: 0.6 })).rejects.toThrow(
        'restore-failed',
      );
      await restored.runtime.stop();
    }
  });

  it('does not change the active deadline before a tuning save succeeds', async () => {
    const h = harness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    await h.agent({ type: 'post-step', sessionId: 's' });
    await h.job({ type: 'exited', id: 'pending-save', exitCode: 1 });
    h.failSave(true);
    await expect(h.runtime.tools.bodyTune({ param: 'mergeWindowMs', to: 1_000 })).rejects.toThrow('uninstalled');
    await h.advance(1_000);
    expect(h.delivered).toHaveLength(0);
    h.failSave(false);
    await h.advance(1_000);
    expect(h.delivered).toHaveLength(1);
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

  it('publishes successful registration to a queued alert and the presenter', async () => {
    const h = harness();
    await h.runtime.start();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const register = h.runtime.body.tuner.registerAlert.bind(h.runtime.body.tuner);
    h.runtime.body.tuner.registerAlert = async (...args) => {
      await blocked;
      return register(...args);
    };
    const presenter = createPresenter(h.runtime, { clock: h.ports.clock });
    const rss = (value: number) => ({ ...f({ rss: value, cpu: 0, uptimeSec: 1 }), observedAt: Date.now() });
    await h.sample(mkBody({ harnessProcess: rss(100) }));
    await h.advance(5_000);
    await h.sample(mkBody({ harnessProcess: rss(200) }));
    const alert = h.runtime.events().find((event) => event.kind === 'body.rate');
    if (!alert) throw new Error('missing alert');
    expect(
      presenter.snapshot().events.find((event) => event.signal.id === alert.id)?.signal.data.feedbackAvailable,
    ).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      presenter.snapshot().events.find((event) => event.signal.id === alert.id)?.signal.data.feedbackAvailable,
    ).toBe(true);
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    expect(
      h.delivered.flatMap((intent) => intent.update.changes).find((change) => change.signal.id === alert.id)?.signal
        .data.feedbackAvailable,
    ).toBe(true);
    expect(await h.runtime.tools.bodyTune({ action: 'feedback', alertId: alert.id, verdict: 'useful' })).toMatchObject({
      applied: true,
    });
    expect(
      presenter.snapshot().events.find((event) => event.signal.id === alert.id)?.signal.data.feedbackAvailable,
    ).toBe(false);
    presenter.close();
    await h.runtime.stop();
  });

  it('does not rewrite a failed alert delivery when registration finishes later', async () => {
    const h = harness();
    const attempts: Parameters<DshPort['deliver']>[1][] = [];
    h.ports.dsh.deliver = async (_session, intent) => {
      attempts.push(structuredClone(intent));
      if (attempts.length === 1) throw new Error('offline');
    };
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const register = h.runtime.body.tuner.registerAlert.bind(h.runtime.body.tuner);
    h.runtime.body.tuner.registerAlert = async (...args) => {
      await blocked;
      return register(...args);
    };
    const rss = (value: number) => ({ ...f({ rss: value, cpu: 0, uptimeSec: 1 }), observedAt: Date.now() });
    await h.sample(mkBody({ harnessProcess: rss(100) }));
    await h.advance(5_000);
    await h.sample(mkBody({ harnessProcess: rss(200) }));
    await expect(h.agent({ type: 'pre-step', sessionId: 's' })).rejects.toThrow('offline');
    expect(attempts[0]?.update.changes[0]?.signal.data.feedbackAvailable).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await h.advance(1_000);
    await h.agent({ type: 'pre-step', sessionId: 's' });
    expect(attempts[1]).toEqual(attempts[0]);
    await h.runtime.stop();
  });

  it('persists globalFileWatch toggle and exclusions across runtime restarts when enabled', async () => {
    let saved: string | undefined;
    let watchOpens = 0;
    let watchCloses = 0;
    const h1 = harness(undefined, {
      platform: 'darwin',
      globalFileWatch: { homedir: '/Users/demo' },
    });
    h1.ports.storage.load = async (key) => (key === 'settings' ? saved : undefined);
    h1.ports.storage.save = async (key, json) => {
      if (key === 'settings') saved = json;
    };
    h1.ports.files.watch = () => {
      watchOpens++;
      return {
        close: () => {
          watchCloses++;
        },
      };
    };

    await h1.runtime.start();
    // 1 watcher for legacy files-wake rule (/workspace/**) + 1 watcher for files-global (/)
    expect(watchOpens).toBe(2);
    expect(h1.runtime.state().env.globalFileWatch?.value?.status).toBe('running');

    await h1.runtime.actions.addFileExclusion?.('~/PrivateTmp');
    expect(h1.runtime.state().env.globalFileWatch?.value?.exclusions).toContain('~/PrivateTmp');
    await h1.runtime.actions.removeFileExclusion?.('~/PrivateTmp');
    expect(h1.runtime.state().env.globalFileWatch?.value?.exclusions).not.toContain('~/PrivateTmp');
    await h1.runtime.actions.addFileExclusion?.('/custom/cache');
    await h1.runtime.actions.setGlobalFileWatch?.(false);
    expect(watchCloses).toBe(1);
    expect(h1.runtime.state().env.globalFileWatch?.value?.status).toBe('disabled');
    await h1.runtime.stop();

    const h2 = harness(saved, {
      platform: 'darwin',
      globalFileWatch: { homedir: '/Users/demo' },
    });
    h2.ports.storage.load = async (key) => (key === 'settings' ? saved : undefined);
    h2.ports.files.watch = () => {
      watchOpens++;
      return { close: () => {} };
    };
    await h2.runtime.start();
    // Only legacy files-wake rule watcher opens on restart; files-global stays disabled
    expect(watchOpens).toBe(3);
    expect(h2.runtime.state().env.globalFileWatch?.value?.enabled).toBe(false);
    expect(h2.runtime.state().env.globalFileWatch?.value?.exclusions).toContain('/custom/cache');
    await h2.runtime.stop();
  });
});
