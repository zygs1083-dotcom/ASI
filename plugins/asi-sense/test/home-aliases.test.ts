import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULES } from '../src/host/attention/rules.ts';
import { defaultBodyRules } from '../src/host/body/index.ts';
import { createDelivery } from '../src/host/dsh/deliver.ts';
import { FileHistoryStoragePort } from '../src/host/dsh/history-storage.ts';
import { createSenseTools } from '../src/host/dsh/tools.ts';
import { createSenseRuntime } from '../src/host/runtime/index.ts';
import type { FileChange } from '../src/host/runtime/ports.ts';
import { DEFAULT_FILE_EXCLUSIONS } from '../src/host/sources/file-exclusions.ts';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'asi-home-alias-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeExec(tool: string): ToolRunContext {
  return {
    tool,
    callId: 'call-1',
    rootCallId: 'call-1',
    token: {} as ToolRunContext['token'],
    arguments: {},
    signal: new AbortController().signal,
    agent: { id: 'agent-test', mode: 'primary' },
    deferContext: () => {},
    concludesTurn: () => {},
  } as unknown as ToolRunContext;
}

function settingsWith(extraRules: unknown[] = []): Map<string, string> {
  return new Map([
    [
      'settings',
      JSON.stringify({
        version: 1,
        paused: false,
        sendTitles: true,
        globalFileWatch: true,
        fileExclusions: [...DEFAULT_FILE_EXCLUSIONS],
        disabled: [],
        rules: [...DEFAULT_RULES, ...defaultBodyRules(), ...extraRules],
      }),
    ],
  ]);
}

function basePorts(
  clock: { wall: () => number; mono: () => number },
  saved: Map<string, string>,
  onWatch: (cb: (event: FileChange) => void) => void,
  history?: FileHistoryStoragePort,
) {
  return {
    clock,
    ...(history ? { history } : {}),
    storage: {
      load: async (key: string) => saved.get(key),
      save: async (key: string, value: string) => {
        saved.set(key, value);
      },
    },
    dsh: {
      onAgentEvent: () => () => {},
      onTool: () => () => {},
      onJob: () => () => {},
      deliver: async () => {},
      tokenSnapshot: async () => undefined,
    },
    helper: { spawn: () => undefined },
    probe: { create: () => ({ onSample: () => () => {}, start: () => {}, stop: async () => {} }) },
    files: {
      watch: (_root: string, cb: (event: FileChange) => void) => {
        onWatch(cb);
        return { close: () => {} };
      },
    },
  };
}

async function deliverEvent(runtime: ReturnType<typeof createSenseRuntime>, at: number): Promise<string> {
  const event = runtime.events().find((entry) => entry.kind === 'file.activity');
  if (!event) throw new Error('missing file.activity event');
  const sent: string[] = [];
  const agent = { send: (message: { content: Array<{ text: string }> }) => sent.push(message.content[0]!.text) };
  const deliver = createDelivery(
    () => agent as never,
    () => true,
    async () => false,
  );
  await deliver('s1', {
    kind: 'send',
    target: 'user',
    wakeup: false,
    sessionId: 's1',
    deliveryId: 'home-alias',
    update: {
      since: at,
      suppressed: 0,
      summary: 'synthetic',
      changes: [
        {
          level: 'context',
          signal: {
            id: event.id,
            kind: event.kind,
            at: event.at,
            source: event.source,
            subject: event.subject,
            cause: 'unknown',
            data: event.detail ?? {},
          },
        },
      ],
    },
  } as never);
  return sent[0] ?? '';
}

describe('home aliases (B1/B2/S1)', () => {
  it('B1: masks a symlinked home root, its realpath, and the home-root entry itself', async () => {
    // Keep the fixture outside /private (default exclusion) so the global watcher accepts events.
    const base = await mkdtemp(join(process.cwd(), '.tmp-home-alias-b1-'));
    tempDirs.push(base);
    const realHome = join(base, 'ext_vol', 'alice_real');
    const linkHome = join(base, 'links', 'alice_link');
    const dataDir = join(base, 'data');
    await mkdir(realHome, { recursive: true });
    await mkdir(join(base, 'links'), { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await symlink(realHome, linkHome);

    const previousHome = process.env.HOME;
    process.env.HOME = linkHome;
    let wall = Date.UTC(2026, 10, 18, 12, 0, 0);
    let mono = 1_000;
    let watchCb: ((event: FileChange) => void) | undefined;
    const saved = settingsWith([
      {
        id: 'watch-home',
        approved: true,
        level: 'context',
        createdBy: 'user',
        match: { kind: 'file.changed', subject: realHome },
      },
    ]);
    const runtime = createSenseRuntime(
      basePorts(
        { wall: () => wall, mono: () => mono },
        saved,
        (cb) => {
          watchCb = cb;
        },
        new FileHistoryStoragePort(dataDir),
      ),
      {
        platform: 'linux',
        timeZone: 'UTC',
        intervalMs: 600_000,
        globalFileWatch: { root: '/', allowNonDarwinRoot: true, windowMs: 30, dataDirs: [dataDir] },
      },
    );
    try {
      await runtime.start();
      expect(watchCb).toBeDefined();
      watchCb?.({ path: linkHome, change: 'modify', at: wall });
      watchCb?.({ path: join(realHome, 'doc.txt'), change: 'modify', at: wall });
      wall += 100;
      mono += 100;
      await new Promise((resolve) => setTimeout(resolve, 80));

      const tools = createSenseTools(runtime, () => wall);
      const watch = (await tools
        .find((tool) => tool.name === 'env_watch')!
        .execute({ action: 'list' }, makeExec('env_watch'))) as Array<{
        id: string;
        match: { subject?: string };
      }>;
      expect(watch.find((rule) => rule.id === 'watch-home')?.match.subject).toBe('~');

      const state = (await tools
        .find((tool) => tool.name === 'env_state')!
        .execute({ section: 'env' }, makeExec('env_state'))) as {
        watchedPaths: { value: Record<string, unknown> };
      };
      const watchedKeys = Object.keys(state.watchedPaths.value);
      expect(watchedKeys).toContain('~');
      expect(JSON.stringify(watchedKeys)).not.toContain('alice');

      const history = (await tools
        .find((tool) => tool.name === 'env_history')!
        .execute({ kinds: ['file.activity'] }, makeExec('env_history'))) as {
        events: Array<{ subject: string; detail?: { directory?: string; files?: string[] } }>;
      };
      expect(history.events.length).toBeGreaterThan(0);
      expect(JSON.stringify(history)).not.toContain('alice_real');
      expect(JSON.stringify(history)).not.toContain('alice_link');

      const delivered = await deliverEvent(runtime, wall);
      expect(delivered).toContain('~');
      expect(delivered).not.toContain('alice_real');
      expect(delivered).not.toContain('alice_link');
    } finally {
      process.env.HOME = previousHome;
      await runtime.stop().catch(() => {});
    }
  });

  it('B2: masks env_state.watchedPaths keys that are the home root', async () => {
    const base = await makeTempDir();
    const fakeHome = join(base, 'home', 'alice_acct');
    await mkdir(fakeHome, { recursive: true });
    const previousHome = process.env.HOME;
    process.env.HOME = fakeHome;
    const saved = settingsWith([
      {
        id: 'watch-home',
        approved: true,
        level: 'context',
        createdBy: 'user',
        match: { kind: 'file.changed', subject: fakeHome },
      },
    ]);
    const runtime = createSenseRuntime(
      basePorts({ wall: () => 1_700_000_000_000, mono: () => 1_000 }, saved, () => {}),
      {
        platform: 'darwin',
        globalFileWatch: { disableInTests: true },
      },
    );
    try {
      await runtime.start();
      const tools = createSenseTools(runtime, () => 1_700_000_000_000);
      const watch = (await tools
        .find((tool) => tool.name === 'env_watch')!
        .execute({ action: 'list' }, makeExec('env_watch'))) as Array<{
        id: string;
        match: { subject?: string };
      }>;
      expect(watch.find((rule) => rule.id === 'watch-home')?.match.subject).toBe('~');

      const state = (await tools
        .find((tool) => tool.name === 'env_state')!
        .execute({ section: 'env' }, makeExec('env_state'))) as {
        watchedPaths: { value: Record<string, unknown> };
      };
      const keys = Object.keys(state.watchedPaths.value);
      expect(keys).toContain('~');
      expect(keys.some((key) => key.includes('alice_acct'))).toBe(false);
      expect(JSON.stringify(state)).not.toContain('alice_acct');
    } finally {
      process.env.HOME = previousHome;
      await runtime.stop().catch(() => {});
    }
  });

  it('S1: masks a custom globalFileWatch.homedir in env_history, <env-update>, and env_summary', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const dir = await makeTempDir();
    const port = new FileHistoryStoragePort(dir);
    let wall = Date.UTC(2026, 9, 15, 23, 59, 0);
    let mono = 1_000;
    let watchCb: ((event: FileChange) => void) | undefined;
    const saved = settingsWith();
    const runtime = createSenseRuntime(
      basePorts(
        { wall: () => wall, mono: () => mono },
        saved,
        (cb) => {
          watchCb = cb;
        },
        port,
      ),
      {
        platform: 'darwin',
        timeZone: 'UTC',
        intervalMs: 600_000,
        globalFileWatch: { root: '/', windowMs: 30, homedir: '/srv/home/demo_acct', dataDirs: [dir] },
      },
    );
    try {
      await runtime.start();
      expect(watchCb).toBeDefined();
      watchCb?.({ path: '/srv/home/demo_acct/note.md', change: 'modify', at: wall });
      wall += 100;
      mono += 100;
      await vi.advanceTimersByTimeAsync(100);

      const tools = createSenseTools(runtime, () => wall);
      const history = (await tools
        .find((tool) => tool.name === 'env_history')!
        .execute({ kinds: ['file.activity'] }, makeExec('env_history'))) as {
        events: Array<{ subject: string; detail?: { directory?: string; files?: string[] } }>;
      };
      expect(history.events).toHaveLength(1);
      expect(history.events[0]?.subject).toBe('~');
      expect(history.events[0]?.detail).toMatchObject({ directory: '~', files: ['note.md'] });
      expect(JSON.stringify(history)).not.toContain('demo_acct');

      const delivered = await deliverEvent(runtime, wall);
      expect(delivered).toContain('~');
      expect(delivered).not.toContain('demo_acct');

      // Cross midnight so the daily summary (and later the monthly synthesis) is written.
      wall = Date.UTC(2026, 9, 16, 0, 1, 0);
      mono += 120_000;
      await vi.advanceTimersByTimeAsync(120_000);
      await runtime.tools.envHistory({});
      await runtime.stop();

      const novWall = Date.UTC(2026, 10, 2, 10, 0, 0);
      const savedNov = new Map<string, string>();
      const summaryRuntime = createSenseRuntime(
        basePorts({ wall: () => novWall, mono: () => 1_000 }, savedNov, () => {}, port),
        { platform: 'linux', timeZone: 'UTC', intervalMs: 600_000 },
      );
      try {
        await summaryRuntime.start();
        const summaryTools = createSenseTools(summaryRuntime, () => novWall);
        const summary = (await summaryTools
          .find((tool) => tool.name === 'env_summary')!
          .execute({ month: '2026-10' }, makeExec('env_summary'))) as {
          available: boolean;
          summary?: { fileActivity: Record<string, { events: number }> };
        };
        expect(summary.available).toBe(true);
        expect(summary.summary?.fileActivity['~']).toMatchObject({ events: 1 });
        expect(JSON.stringify(summary)).not.toContain('demo_acct');
      } finally {
        await summaryRuntime.stop().catch(() => {});
      }
    } finally {
      await runtime.stop().catch(() => {});
    }
  });
});
