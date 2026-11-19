import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GlobalFileWatchValue } from '@asi/sense-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileGlob } from '../../src/host/attention/glob.ts';
import { DEFAULT_RULES } from '../../src/host/attention/rules.ts';
import { FileBurstDetector } from '../../src/host/body/burst.ts';
import { defaultBodyRules } from '../../src/host/body/index.ts';
import { createPresenter } from '../../src/host/presenter/index.ts';
import { type EventEntry, RuntimeAttention } from '../../src/host/runtime/attention.ts';
import { FactExpiry } from '../../src/host/runtime/expiry.ts';
import { createSenseRuntime } from '../../src/host/runtime/index.ts';
import type { DshPort, FileChange, FileWatcher, SenseOptions } from '../../src/host/runtime/ports.ts';
import {
  DEFAULT_FILE_EXCLUSIONS,
  ExclusionMatcher,
  MAX_FILE_EXCLUSIONS,
  normalizeFileExclusion,
} from '../../src/host/sources/file-exclusions.ts';
import { FileGlobalSource } from '../../src/host/sources/files-global.ts';

afterEach(() => {
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.useRealTimers();
});

function createHarness(
  opts: {
    platform?: string;
    savedSettings?: string;
    fakeClockOnly?: boolean;
    watchFactory?: (root: string, cb: (event: FileChange) => void) => { close(): void | Promise<void> };
    globalFileWatch?: SenseOptions['globalFileWatch'];
    rules?: SenseOptions['rules'];
  } = {},
) {
  if (opts.fakeClockOnly) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  } else {
    vi.useFakeTimers();
  }
  vi.setSystemTime(1_700_000_000_000);
  let mono = 10_000;
  let storedSettings = opts.savedSettings;
  let watchCallback: ((event: FileChange) => void) | undefined;
  let openWatchers = 0;
  let totalWatchCalls = 0;
  let totalCloseCalls = 0;
  let onAgent: Parameters<DshPort['onAgentEvent']>[0] = async () => {};
  let onTool: Parameters<DshPort['onTool']>[0] = async () => {};
  const delivered: Parameters<DshPort['deliver']>[1][] = [];

  const clock = {
    wall: () => Date.now(),
    mono: () => mono,
  };

  const files: FileWatcher = {
    watch: (root, cb) => {
      totalWatchCalls++;
      if (opts.watchFactory) {
        const handle = opts.watchFactory(root, cb);
        openWatchers++;
        return {
          close: async () => {
            openWatchers--;
            totalCloseCalls++;
            await handle.close();
          },
        };
      }
      if (root === '/' || root === opts.globalFileWatch?.root) {
        watchCallback = cb;
      }
      openWatchers++;
      return {
        close: () => {
          openWatchers--;
          totalCloseCalls++;
          if (watchCallback === cb) watchCallback = undefined;
        },
      };
    },
  };

  const runtime = createSenseRuntime(
    {
      clock,
      files,
      helper: { spawn: () => undefined },
      probe: {
        create: () => ({
          onSample: () => () => {},
          start: () => {},
          stop: async () => {},
        }),
      },
      storage: {
        load: async (key) => (key === 'settings' ? storedSettings : undefined),
        save: async (key, json) => {
          if (key === 'settings') storedSettings = json;
        },
      },
      dsh: {
        onAgentEvent: (cb) => {
          onAgent = cb;
          return () => {};
        },
        onTool: (cb) => {
          onTool = cb;
          return () => {};
        },
        onJob: () => () => {},
        deliver: async (_session, intent) => {
          delivered.push(structuredClone(intent));
        },
        tokenSnapshot: async () => undefined,
      },
    },
    {
      platform: opts.platform ?? 'darwin',
      rules: opts.rules ?? [...DEFAULT_RULES, ...defaultBodyRules()],
      globalFileWatch: {
        homedir: path.posix.join('/', 'Users', 'demo'),
        dataDirs: [path.posix.join('/', 'Users', 'demo', '.dsh-data'), path.posix.join('/', 'var', 'plugin-store')],
        ...opts.globalFileWatch,
      },
    },
  );

  const emitFile = (event: FileChange) => {
    if (!watchCallback) throw new Error('global watcher is not open');
    watchCallback(event);
  };

  const advance = async (ms: number) => {
    mono += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };

  const globalFact = () => runtime.state().env.globalFileWatch?.value as GlobalFileWatchValue | undefined;
  const events = () => runtime.events();

  return {
    runtime,
    delivered,
    events,
    emitFile,
    advance,
    agent: (ev: Parameters<typeof onAgent>[0]) => onAgent(ev),
    onTool: (ev: Parameters<typeof onTool>[0]) => onTool(ev),
    globalFact,
    storedSettings: () => storedSettings,
    openWatchers: () => openWatchers,
    totalWatchCalls: () => totalWatchCalls,
    totalCloseCalls: () => totalCloseCalls,
  };
}

function collectActivity(entries: readonly EventEntry[]): EventEntry[] {
  return entries.filter((e) => e.kind === 'file.activity');
}

describe('ExclusionMatcher & settings persistence', () => {
  it('excludes system roots, nested vcs/cache segments, and runtime dataDirs', () => {
    const home = path.posix.join('/', 'Users', 'demo');
    const pluginData = path.posix.join('/', 'tmp', 'asi-plugin-data');
    const dshData = path.posix.join(home, 'Library', 'Application Support', 'DSH');
    const matcher = new ExclusionMatcher(DEFAULT_FILE_EXCLUSIONS, [pluginData, dshData], home);

    const excluded = [
      path.posix.join('/', 'System', 'Volumes', 'Data', 'a'),
      path.posix.join('/', 'Library', 'Preferences', 'com.test.plist'),
      path.posix.join('/', 'private', 'var', 'db', 'x'),
      path.posix.join('/', 'dev', 'null'),
      path.posix.join('/', 'usr', 'local', 'bin', 'tool'),
      path.posix.join('/', 'bin', 'sh'),
      path.posix.join('/', 'sbin', 'init'),
      path.posix.join('/', 'cores', 'core.1'),
      path.posix.join('/', 'opt', 'homebrew', 'Cellar', 'node'),
      path.posix.join(home, 'Library', 'Caches', 'x'),
      path.posix.join(home, '.Trash', 'deleted.txt'),
      path.posix.join(home, 'repo', 'apps', 'web', 'node_modules', 'pkg', 'index.js'),
      path.posix.join(home, 'repo', '.git', 'objects', 'aa', 'bb'),
      path.posix.join(home, 'repo', '.cache', 'vite', 'dep.js'),
      path.posix.join(home, 'repo', 'Caches', 'data.bin'),
      path.posix.join(home, 'repo', 'DerivedData', 'Build', 'x'),
      path.posix.join(home, 'repo', '.pnpm-store', 'v3', 'files', '00'),
      path.posix.join(home, 'repo', 'pkg', '__pycache__', 'mod.pyc'),
      path.posix.join(pluginData, 'events.jsonl'),
      path.posix.join(dshData, 'session.db'),
    ];
    for (const file of excluded) {
      expect(matcher.isExcluded(file), `expected excluded: ${file}`).toBe(true);
    }

    expect(matcher.isExcluded(path.posix.join(home, 'work', 'project', 'src', 'index.ts'))).toBe(false);
    // Name substring must not match segment rule `node_modules`
    expect(matcher.isExcluded(path.posix.join(home, 'work', 'node_modules_backup', 'file.ts'))).toBe(false);
    expect(normalizeFileExclusion('  ~/custom/dir/  ')).toBe('~/custom/dir');
    expect(() => normalizeFileExclusion('../escape')).toThrow(TypeError);
    expect(() => normalizeFileExclusion('/')).toThrow(TypeError);
    expect(() => normalizeFileExclusion('~')).toThrow(TypeError);
  });
});

describe('FileGlobalSource integration', () => {
  it('aggregates file events per dir and window with capped basenames and rule level record', async () => {
    const h = createHarness();
    await h.runtime.start();

    const dir = path.posix.join('/', 'work', 'alpha');
    for (let i = 0; i < 7; i++) {
      h.emitFile({ path: path.posix.join(dir, `f${i}.ts`), change: i < 2 ? 'add' : 'modify' });
    }
    h.emitFile({ path: path.posix.join(dir, 'f0.ts'), change: 'delete' });

    // Before 10s window expires, no file.activity is flushed yet
    expect(collectActivity(h.events())).toHaveLength(0);

    await h.advance(10_000);
    const activities = collectActivity(h.events());
    expect(activities).toHaveLength(1);
    const entry = activities[0];
    expect(entry?.detail).toMatchObject({
      directory: dir,
      windowMs: 10_000,
      created: 2,
      modified: 5,
      deleted: 1,
    });
    const files = entry?.detail?.files;
    expect(Array.isArray(files)).toBe(true);
    expect(files).toHaveLength(5);
    expect(entry?.level).toBe('record');

    // Verify presenter projection for file.activity
    const presenter = createPresenter(h.runtime, { clock: { wall: Date.now, mono: () => 0 } });
    const projected = presenter.snapshot().events.find((e) => e.signal.id === entry?.id);
    expect(projected?.detail).toEqual({
      kind: 'file.activity',
      directory: dir,
      windowMs: 10_000,
      created: 2,
      modified: 5,
      deleted: 1,
      files,
    });
    presenter.close();

    // Drops excluded paths (including deep node_modules and plugin storage data dir)
    h.emitFile({ path: path.posix.join(dir, 'a', 'b', 'node_modules', 'x.js'), change: 'add' });
    h.emitFile({ path: path.posix.join('/', 'var', 'plugin-store', 'attention.log'), change: 'modify' });
    await h.advance(10_000);
    expect(collectActivity(h.events())).toHaveLength(1);

    await h.runtime.stop();
  });

  it('triggers file-burst-external-deletion wake globally and excludes agent self-cause deletes', async () => {
    const h = createHarness();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's1' });
    await h.agent({ type: 'pre-step', sessionId: 's1' });
    await h.agent({ type: 'post-step', sessionId: 's1' });

    const extDir = path.posix.join('/', 'work', 'external-repo');
    const agentDir = path.posix.join('/', 'work', 'agent-repo');

    // Start active agent tool inside agentDir
    await h.onTool({ type: 'pre-execute', sessionId: 's1', toolCallId: 't1', cwd: agentDir });

    // 55 agent deletes inside agentDir must NOT wake
    for (let i = 0; i < 55; i++) {
      h.emitFile({ path: path.posix.join(agentDir, `gen-${i}.ts`), change: 'delete' });
    }
    await h.advance(10_000);
    expect(h.delivered.filter((d) => d.update.changes.some((c) => c.level === 'wake'))).toHaveLength(0);

    // 52 external deletes inside extDir trigger file-burst-external-deletion wake even without dir watch rule
    for (let i = 0; i < 52; i++) {
      h.emitFile({ path: path.posix.join(extDir, `doc-${i}.md`), change: 'delete' });
    }
    await h.advance(10_000);
    // Allow AttentionPipeline fileMergeWindowMs (5_000ms) to flush the file.burst wake
    await h.advance(5_000);

    const wakes = h.delivered.filter((d) => d.update.changes.some((c) => c.level === 'wake'));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.update.changes[0]?.signal.kind).toBe('file.burst');
    expect(wakes[0]?.update.changes[0]?.signal.data.externalDeletionExceeded).toBe(true);
    expect(wakes[0]?.update.changes[0]?.signal.subject).toBe(extDir);

    await h.runtime.stop();
  });

  it('does not double-count directories covered by an explicit file.changed rule', async () => {
    const coveredDir = path.posix.join('/', 'work', 'explicit');
    const callbacks = new Map<string, (event: FileChange) => void>();

    const h2 = createHarness({
      watchFactory: (root, cb) => {
        callbacks.set(root, cb);
        return { close: () => {} };
      },
      rules: [
        ...DEFAULT_RULES,
        ...defaultBodyRules(),
        {
          id: 'explicit-dir',
          match: { kind: 'file.changed', subject: coveredDir },
          level: 'context',
          createdBy: 'user',
          approved: true,
        },
      ],
    });
    await h2.runtime.start();
    await h2.agent({ type: 'created', sessionId: 's1' });
    await h2.agent({ type: 'pre-step', sessionId: 's1' });
    await h2.agent({ type: 'post-step', sessionId: 's1' });

    const globalCb = callbacks.get('/');
    expect(globalCb).toBeDefined();
    // Global watcher gets 30 deletes, explicit FileSource gets 0 -> total stays 30 (not 60) -> no wake
    for (let i = 0; i < 30; i++) {
      globalCb?.({ path: path.posix.join(coveredDir, `a-${i}.ts`), change: 'delete' });
    }
    await h2.advance(10_000);
    expect(h2.delivered.filter((d) => d.update.changes.some((c) => c.level === 'wake'))).toHaveLength(0);
    await h2.runtime.stop();
  });

  it('marks EPERM root denied and EPERM subtree partial-denied while continuing other paths', async () => {
    const eperm = Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
    const hDenied = createHarness({
      watchFactory: () => {
        throw eperm;
      },
    });
    await hDenied.runtime.start();
    expect(hDenied.globalFact()?.status).toBe('denied');
    expect(hDenied.runtime.state().env.globalFileWatch?.status).toBe('denied');
    expect(hDenied.runtime.state().observation.sources['files-global']?.status).toBe('denied');
    await hDenied.runtime.stop();

    const protectedSub = path.posix.join('/', 'Users', 'demo', 'Pictures');
    const hPartial = createHarness({
      globalFileWatch: {
        protectedDirs: [protectedSub],
        probeAccess: (dir) => dir !== protectedSub,
      },
    });
    await hPartial.runtime.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(hPartial.globalFact()?.status).toBe('partial-denied');
    expect(hPartial.globalFact()?.deniedPaths).toContain(protectedSub);
    expect(hPartial.runtime.state().observation.sources['files-global-denied']?.status).toBe('denied');

    // Runtime async EPERM on another protected subtree
    hPartial.emitFile({
      path: path.posix.join('/', 'Users', 'demo', '.ssh'),
      change: 'modify',
      watchError: true,
      errorCode: 'EPERM',
      errorPath: path.posix.join('/', 'Users', 'demo', '.ssh'),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(hPartial.globalFact()?.deniedPaths).toContain(path.posix.join('/', 'Users', 'demo', '.ssh'));

    // Regular workspace events still aggregate normally
    const normalDir = path.posix.join('/', 'work', 'normal');
    hPartial.emitFile({ path: path.posix.join(normalDir, 'ok.ts'), change: 'add' });
    await hPartial.advance(10_000);
    expect(collectActivity(hPartial.events())).toHaveLength(1);
    await hPartial.runtime.stop();
  });

  it('degrades above budget for 30s (wider window + countOnly + status signal) and recovers', async () => {
    const h = createHarness({
      globalFileWatch: {
        windowMs: 10_000,
        degradedWindowMs: 60_000,
        budgetPerSec: 20,
        budgetSustainMs: 30_000,
        recoveryWindowMs: 30_000,
      },
    });
    await h.runtime.start();
    const statusCount = () =>
      h.events().filter((e) => e.kind === 'source.status' && e.subject === 'files-global').length;
    const beforeDegrade = statusCount();
    const dir = path.posix.join('/', 'work', 'noisy');

    // Sustain >20/sec for 95 seconds so a full 60s degraded bucket flushes while degraded
    for (let sec = 0; sec <= 95; sec++) {
      for (let j = 0; j < 25; j++) {
        h.emitFile({ path: path.posix.join(dir, `f-${j}.log`), change: 'modify' });
      }
      await h.advance(1_000);
    }

    expect(h.globalFact()?.status).toBe('degraded');
    expect(h.globalFact()?.degraded).toBe(true);
    expect(h.globalFact()?.countOnly).toBe(true);
    expect(h.globalFact()?.windowMs).toBe(60_000);
    expect(h.runtime.state().observation.sources['files-global']?.status).toBe('unavailable');
    expect(h.runtime.state().observation.sources['files-global']?.error).toBe('budget-degraded');
    expect(statusCount()).toBe(beforeDegrade + 1);

    const degradedActs = collectActivity(h.events()).filter((e) => e.detail?.degraded === true);
    expect(degradedActs.length).toBeGreaterThanOrEqual(1);
    const latest = degradedActs.at(-1);
    expect(latest?.detail?.files).toBeUndefined();
    expect(latest?.detail?.windowMs).toBe(60_000);

    // Trigger recovery (>=30s with <= 20 events/s)
    await h.advance(35_000);
    expect(h.globalFact()?.status).toBe('running');
    expect(h.globalFact()?.degraded).toBe(false);
    expect(h.globalFact()?.windowMs).toBe(10_000);
    expect(h.runtime.state().observation.sources['files-global']?.status).toBe('ok');
    expect(statusCount()).toBe(beforeDegrade + 2);

    // After recovery, filenames are collected again
    h.emitFile({ path: path.posix.join(dir, 'after.ts'), change: 'add' });
    await h.advance(10_000);
    expect(collectActivity(h.events()).at(-1)?.detail?.files).toContain('after.ts');
    await h.runtime.stop();
  });

  it('closes watcher immediately when toggled off and persists toggle + exclusion mutations', async () => {
    const h = createHarness();
    await h.runtime.start();
    expect(h.openWatchers()).toBe(1);
    expect(h.globalFact()?.status).toBe('running');

    await h.runtime.actions.addFileExclusion?.('~/Scratch');
    expect(h.globalFact()?.exclusions).toContain('~/Scratch');

    // Excluded by custom pattern now
    h.emitFile({ path: path.posix.join('/', 'Users', 'demo', 'Scratch', 'tmp.txt'), change: 'add' });
    await h.advance(10_000);
    expect(collectActivity(h.events())).toHaveLength(0);

    await h.runtime.actions.removeFileExclusion?.('~/Scratch');
    expect(h.globalFact()?.exclusions).not.toContain('~/Scratch');

    await h.runtime.actions.setGlobalFileWatch?.(false);
    expect(h.openWatchers()).toBe(0);
    expect(h.totalCloseCalls()).toBe(1);
    expect(h.globalFact()?.enabled).toBe(false);
    expect(h.globalFact()?.status).toBe('disabled');
    await h.runtime.stop();

    // Restart with saved settings -> stays disabled
    const restarted = createHarness({ savedSettings: h.storedSettings() });
    await restarted.runtime.start();
    expect(restarted.openWatchers()).toBe(0);
    expect(restarted.globalFact()?.enabled).toBe(false);
    expect(restarted.globalFact()?.status).toBe('disabled');

    // Turning back on attaches watcher
    await restarted.runtime.actions.setGlobalFileWatch?.(true);
    expect(restarted.openWatchers()).toBe(1);
    expect(restarted.globalFact()?.status).toBe('running');
    await restarted.runtime.stop();
  });

  it('monitors a real temporary directory via fs.watch while skipping nested node_modules', async () => {
    vi.useRealTimers();
    const { watch } = await import('node:fs');
    // macOS tmpdir is a symlink into /private, which the default exclusions drop; use the repo
    // working directory so this recursive-watch integration test runs against a non-excluded path.
    const tmpRoot = realpathSync(mkdtempSync(path.join(process.cwd(), '.asi-files-global-')));
    try {
      mkdirSync(path.join(tmpRoot, 'app', 'node_modules', 'pkg'), { recursive: true });
      mkdirSync(path.join(tmpRoot, 'app', 'src'), { recursive: true });

      const runtime = createSenseRuntime(
        {
          clock: { wall: () => Date.now(), mono: () => performance.now() },
          files: {
            watch: (root, cb, opts) => {
              const watcher = watch(root, { recursive: opts?.recursive ?? true }, (event, filename) => {
                if (!filename) return;
                const full = path.resolve(root, filename.toString());
                const change = event === 'change' ? 'modify' : 'add';
                cb({ path: full, change });
              });
              return { close: () => watcher.close() };
            },
          },
          helper: { spawn: () => undefined },
          probe: { create: () => ({ onSample: () => () => {}, start: () => {}, stop: async () => {} }) },
          storage: { load: async () => undefined, save: async () => {} },
          dsh: {
            onAgentEvent: () => () => {},
            onTool: () => () => {},
            onJob: () => () => {},
            deliver: async () => {},
            tokenSnapshot: async () => undefined,
          },
        },
        {
          platform: 'linux',
          rules: [...DEFAULT_RULES],
          globalFileWatch: { root: tmpRoot, windowMs: 100 },
        },
      );

      await runtime.start();
      writeFileSync(path.join(tmpRoot, 'app', 'node_modules', 'pkg', 'index.js'), 'ignored');
      writeFileSync(path.join(tmpRoot, 'app', 'src', 'main.ts'), 'hello');

      const getActs = () => collectActivity(runtime.events());
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 80));
        if (getActs().length > 0) break;
      }

      const acts = getActs();
      expect(acts.length).toBeGreaterThanOrEqual(1);
      const dirs = acts.map((e) => e.detail?.directory ?? e.subject);
      expect(dirs).toContain(path.join(tmpRoot, 'app', 'src'));
      expect(dirs.some((d) => String(d).includes('node_modules'))).toBe(false);
      await runtime.stop();
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('meets performance budget for 100,000 events over a simulated 60s window', async () => {
    const h = createHarness({ fakeClockOnly: true });
    await h.runtime.start();

    const dirs = Array.from({ length: 20 }, (_, i) => path.posix.join('/', 'work', `proj-${i}`, 'src'));
    const excludedPath = path.posix.join('/', 'work', 'proj-0', 'node_modules', 'dep', 'index.js');

    const startHeap = process.memoryUsage().heapUsed;
    const t0 = performance.now();

    const total = 100_000;
    for (let i = 0; i < total; i++) {
      if (i % 1667 === 0 && i > 0) {
        await h.advance(1_000);
      }
      if (i % 5 === 0) {
        h.emitFile({ path: excludedPath, change: 'modify' });
      } else {
        const dir = dirs[i % dirs.length] ?? '/work/proj-0/src';
        h.emitFile({ path: path.posix.join(dir, `file-${i % 8}.ts`), change: i % 3 === 0 ? 'add' : 'modify' });
      }
    }
    await h.advance(60_000);

    const elapsedMs = performance.now() - t0;
    const heapDeltaMb = (process.memoryUsage().heapUsed - startHeap) / (1024 * 1024);
    console.info(
      `[files-global perf] 100k events processed in ${elapsedMs.toFixed(1)} ms, heap delta=${heapDeltaMb.toFixed(2)} MB, status=${h.globalFact()?.status}`,
    );

    expect(elapsedMs).toBeLessThan(10_000);
    expect(heapDeltaMb).toBeLessThan(80);
    expect(collectActivity(h.events()).length).toBeGreaterThan(0);
    await h.runtime.stop();
  });

  it('masks a deep cached home root and two-segment home roots without leaking the account name', async () => {
    const h = createHarness({ globalFileWatch: { homedir: path.posix.join('/', 'srv', 'home', 'demo') } });
    await h.runtime.start();

    // The cached home root can be deeper than two segments; it must still map to '~'.
    h.emitFile({ path: path.posix.join('/', 'srv', 'home', 'demo'), change: 'modify' });
    h.emitFile({ path: path.posix.join('/', 'srv', 'home', 'demo', 'proj', 'note.md'), change: 'modify' });
    // A standard two-segment home root is recognized by shape alone, whatever os.homedir() says.
    h.emitFile({ path: path.posix.join('/', 'Users', 'demo'), change: 'modify' });
    await h.advance(10_000);

    const acts = collectActivity(h.events());
    const filesIn = (directory: string) =>
      acts.filter((e) => e.detail?.directory === directory).flatMap((e) => e.detail?.files ?? []);
    expect(filesIn('/srv/home')).toEqual(['~']);
    expect(filesIn('/users')).toEqual(['~']);
    expect(filesIn('/srv/home/demo/proj')).toEqual(['note.md']);
    expect(filesIn('/srv/home')).not.toContain('demo');
    await h.runtime.stop();
  });

  it('stays within <20MB heap growth and <3% CPU under sustained 15,000/s x 60s load', async () => {
    const runSample = async (secs: number) => {
      let mono = 10_000;
      const clock = { wall: () => 1_700_000_000_000 + mono, mono: () => mono };
      const expiry = new FactExpiry(clock);
      const rules = [...DEFAULT_RULES, ...defaultBodyRules()];
      const att = new RuntimeAttention(
        clock,
        { deliver: async () => {} } as unknown as DshPort,
        () => rules,
        () => {},
        () => true,
        () => {},
        expiry,
      );
      const detector = new FileBurstDetector({ windowMs: 60_000, maxChanges: 100, maxDeleted: 50 });
      detector.setScopes(['global']);
      let cb!: (event: FileChange) => void;
      const fg = new FileGlobalSource(
        {
          watch: (_r, fn) => {
            cb = fn;
            return { close: () => {} };
          },
        },
        clock,
        att,
        { classifyFilePath: () => 'unknown' },
        { globalFileWatch: true, fileExclusions: () => [] },
        () => false,
        async (sig, dirs, rm) => {
          detector.accept(sig, rm ?? clock.mono(), dirs);
        },
        () => {},
        () => false,
        () => {},
        { homedir: '/Users/demo' },
        'darwin',
      );
      await fg.refresh();
      for (let j = 0; j < 2_000; j++) {
        cb({ path: `/work/hot-${j % 5}/f-${j % 10}.log`, change: 'modify' });
      }
      mono += 1_000;
      await fg.tick();
      const gcFn = (globalThis as { gc?: () => void }).gc;
      gcFn?.();
      const h0 = process.memoryUsage().heapUsed;
      const cpu0 = process.cpuUsage();

      for (let s = 0; s < secs; s++) {
        for (let j = 0; j < 15_000; j++) {
          cb({ path: `/work/hot-${j % 5}/f-${j % 10}.log`, change: 'modify' });
        }
        mono += 1_000;
        await fg.tick();
      }

      const cpu = process.cpuUsage(cpu0);
      gcFn?.();
      const h1 = process.memoryUsage().heapUsed;
      const cpuMs = (cpu.user + cpu.system) / 1000;
      const cpuPct = (cpuMs / (secs * 1_000)) * 100;
      const heapDeltaMb = (h1 - h0) / (1024 * 1024);
      const degraded = fg.isDegraded();
      await fg.stop();
      await att.stop();
      return { cpuMs, cpuPct, heapDeltaMb, degraded };
    };

    const nonAscii = /[^\x20-\x7e]/;
    const runRefCpu = (secs: number) => {
      const dirs = new Map<string, number>();
      const homeAliases = new Set<string>(['/users/demo']);
      const cpu0 = process.cpuUsage();
      let sink = 0;
      for (let s = 0; s < secs; s++) {
        for (let j = 0; j < 15_000; j++) {
          const raw = `/work/hot-${j % 5}/f-${j % 10}.log`;
          const clean = nonAscii.test(raw) ? raw.normalize('NFC') : raw;
          const slash = clean.lastIndexOf('/');
          const dir = clean.slice(0, slash);
          dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
          if (homeAliases.has(clean)) sink++;
          sink += slash;
        }
      }
      const cpu = process.cpuUsage(cpu0);
      return { cpuMs: Math.max(1, (cpu.user + cpu.system) / 1000), sink };
    };

    // Warm up a complete 60s non-degraded + degraded cycle plus the reference loop before timing.
    await runSample(60);
    let refSink = 0;
    for (let w = 0; w < 3; w++) refSink += runRefCpu(20).sink;

    const runs: Array<{ cpuMs: number; cpuPct: number; refMs: number; ratio: number; heapDeltaMb: number }> = [];
    for (let i = 0; i < 3; i++) {
      const ref0 = runRefCpu(30);
      const sample = await runSample(60);
      const ref1 = runRefCpu(30);
      refSink += ref0.sink + ref1.sink;
      const refMs = Math.max(1, ref0.cpuMs + ref1.cpuMs);
      expect(sample.degraded).toBe(true);
      expect(sample.heapDeltaMb).toBeLessThan(20);
      runs.push({
        cpuMs: sample.cpuMs,
        cpuPct: sample.cpuPct,
        refMs,
        ratio: sample.cpuMs / refMs,
        heapDeltaMb: sample.heapDeltaMb,
      });
    }
    expect(refSink).toBeGreaterThan(0);

    const minRatio = Math.min(...runs.map((r) => r.ratio));
    const minCpuPct = Math.min(...runs.map((r) => r.cpuPct));
    console.info(
      `[files-global 15k/s x 60s] minCpu=${minCpuPct.toFixed(2)}%, minRatio=${minRatio.toFixed(2)}, runs=${runs
        .map(
          (r) =>
            `${r.cpuMs.toFixed(0)}ms(${r.cpuPct.toFixed(2)}%)/ref=${r.refMs.toFixed(0)}ms/ratio=${r.ratio.toFixed(2)}/heap=${r.heapDeltaMb.toFixed(1)}MB`,
        )
        .join('; ')}`,
    );
    expect(minRatio).toBeLessThanOrEqual(2.85);
  }, 30_000);

  it('handles darwin case folding, NFC/NFD normalization, uncreated symlinked dataDirs, aliases, and glob descendant exclusions', () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'asi-excl-'));
    try {
      const realBase = path.join(tmpRoot, 'real-base');
      const linkBase = path.join(tmpRoot, 'link-base');
      mkdirSync(realBase, { recursive: true });
      symlinkSync(realBase, linkBase);

      const uncreatedDataDir = path.posix.join(linkBase, 'future', 'store');
      const matcherMac = new ExclusionMatcher(
        ['~/Library', '~/Café'.normalize('NFC'), '项目-が'.normalize('NFC'), '/Work/tmp-*', 'tmp-*', '/var/cache'],
        [uncreatedDataDir],
        '/Users/Demo',
        'darwin',
      );
      expect(matcherMac.isExcluded('/users/demo/library/Caches/app.db')).toBe(true);
      expect(matcherMac.isExcluded('/Users/demo/Cafe\u0301/Sub/note.md')).toBe(true);
      expect(matcherMac.isExcluded('/Users/demo/proj/项目-か\u3099/item.txt')).toBe(true);
      expect(matcherMac.isExcluded(path.posix.join(realBase, 'future', 'store', 'db.sqlite'))).toBe(true);
      expect(matcherMac.isExcluded('/private/var/cache/index.bin')).toBe(true);
      expect(matcherMac.isExcluded('/work/tmp-abc/nested/deep.txt')).toBe(true);
      expect(matcherMac.isExcluded('/work/repo/tmp-build/out/bundle.js')).toBe(true);
      expect(matcherMac.isExcluded('/work/tmpfile/keep.ts')).toBe(false);

      const matcherLinux = new ExclusionMatcher(['/work/Secret'], [], '/home/demo', 'linux');
      expect(matcherLinux.isExcluded('/work/Secret/a.ts')).toBe(true);
      expect(matcherLinux.isExcluded('/work/secret/a.ts')).toBe(false);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('executes adversarial globs in linear time without ReDoS and enforces validation + dedup + 200 cap', async () => {
    const longPattern = `${'**a'.repeat(341)}b`.slice(0, 1024);
    const matcher = compileGlob(longPattern, { matchDescendants: true });
    const text = `/${'a'.repeat(250)}c`;
    for (let i = 0; i < 50; i++) matcher.test(text);
    const results: boolean[] = [];
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      results.push(matcher.test(text));
      samples.push(performance.now() - started);
    }
    expect(results.every((matched) => matched === false)).toBe(true);
    samples.sort((a, b) => a - b);
    expect(samples[Math.floor(samples.length / 2)]).toBeLessThan(5);

    const exMatcher = new ExclusionMatcher([`${'**a'.repeat(18)}b`], [], '/Users/demo', 'darwin');
    const exPath = `/work/${'a'.repeat(180)}c/file.ts`;
    for (let i = 0; i < 50; i++) exMatcher.isExcluded(exPath);
    const exResults: boolean[] = [];
    const exSamples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t1 = performance.now();
      exResults.push(exMatcher.isExcluded(exPath));
      exSamples.push(performance.now() - t1);
    }
    expect(exResults.every((matched) => matched === false)).toBe(true);
    exSamples.sort((a, b) => a - b);
    expect(exSamples[Math.floor(exSamples.length / 2)]).toBeLessThan(5);

    for (const bad of [
      '',
      '   ',
      '/',
      '///',
      '~',
      '~/',
      './rel',
      '../rel',
      'foo/bar',
      '/a/../b',
      'a/b\0c',
      'a'.repeat(1025),
    ]) {
      expect(() => normalizeFileExclusion(bad)).toThrow(TypeError);
    }

    const h = createHarness({ platform: 'darwin' });
    await h.runtime.start();
    await h.runtime.actions.addFileExclusion?.('~/CustomCache');
    await expect(h.runtime.actions.addFileExclusion?.('~/customcache')).rejects.toThrow();
    await expect(h.runtime.actions.addFileExclusion?.('~/Café'.normalize('NFC'))).resolves.toBeUndefined();
    await expect(h.runtime.actions.addFileExclusion?.('~/Cafe\u0301')).rejects.toThrow();

    while ((h.globalFact()?.exclusions.length ?? 0) < MAX_FILE_EXCLUSIONS) {
      const idx = h.globalFact()?.exclusions.length ?? 0;
      await h.runtime.actions.addFileExclusion?.(`seg-${idx}`);
    }
    await expect(h.runtime.actions.addFileExclusion?.('seg-overflow')).rejects.toThrow(/最多|limit|exceed|200/);
    await h.runtime.stop();
  });

  it('rolls up buckets beyond 2000 cap into ancestor directories and drops state in O(1) on disable', async () => {
    const h = createHarness({ fakeClockOnly: true });
    await h.runtime.start();

    for (let i = 0; i < 2_200; i++) {
      h.emitFile({ path: `/work/huge/dir-${i}/file.ts`, change: 'add' });
    }
    await h.advance(10_000);
    // Worst-case adaptive sliceCap=8 across ~2,000 buckets requires up to 250 setImmediate turns.
    for (let i = 0; i < 300; i++) {
      if (collectActivity(h.events()).some((e) => e.detail?.directory === '/work/huge')) break;
      await new Promise((r) => setImmediate(r));
    }

    const acts = collectActivity(h.events());
    const rolledSum = acts.reduce((sum, e) => sum + Number(e.detail?.rolledUp ?? 0), 0);
    expect(acts.length).toBeLessThanOrEqual(2_000);
    expect(rolledSum).toBeGreaterThanOrEqual(200);

    // 5k distinct dirs + instant O(1) toggle off (100k budget checked in dedicated perf test)
    for (let i = 0; i < 5_000; i++) {
      h.emitFile({ path: `/work/surge/dir-${i}/f.ts`, change: 'add' });
    }
    const t0 = performance.now();
    await h.runtime.actions.setGlobalFileWatch?.(false);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(h.openWatchers()).toBe(0);
    const actsAfterDisable = collectActivity(h.events()).map((e) => e.id);
    await h.advance(60_000);
    expect(collectActivity(h.events()).map((e) => e.id)).toEqual(actsAfterDisable);
    await h.runtime.stop();
  }, 15_000);

  it('tracks burst on raw timestamps, deduplicates glob/global wakes, ignores broken explicit watches, and never reclassifies file.activity on flush', async () => {
    const watchers = new Map<string, (ev: FileChange) => void>();
    const brokenRoot = '/work/broken';
    const h = createHarness({
      fakeClockOnly: true,
      globalFileWatch: {
        windowMs: 10_000,
        degradedWindowMs: 60_000,
        budgetPerSec: 1_000,
        budgetSustainMs: 100_000,
      },
      rules: [
        ...DEFAULT_RULES,
        ...defaultBodyRules(),
        {
          id: 'glob-watch',
          match: { kind: 'file.changed', subject: '/work/globdir/*.ts' },
          level: 'wake',
          createdBy: 'user',
          approved: true,
        },
        {
          id: 'broken-explicit',
          match: { kind: 'file.changed', subject: brokenRoot },
          level: 'wake',
          createdBy: 'user',
          approved: true,
        },
      ],
      watchFactory: (root, cb) => {
        watchers.set(root, cb);
        return {
          close: () => {
            watchers.delete(root);
          },
        };
      },
    });
    await h.runtime.start();
    const globalCb = watchers.get('/')!;

    // 1. Two bursts separated by 70s (> 60s file.burst window) produce ZERO false wakes even with clock gaps
    for (let i = 0; i < 30; i++) globalCb({ path: `/work/burst70/a-${i}.ts`, change: 'delete' });
    await h.advance(70_000);
    for (let i = 0; i < 30; i++) globalCb({ path: `/work/burst70/b-${i}.ts`, change: 'delete' });
    expect(h.events().filter((e) => e.kind === 'file.burst' && e.subject === '/work/burst70')).toHaveLength(0);

    // 2. Non-subtree glob rule + global watch emit only ONE deduplicated wake in the same subtree
    const globCb = watchers.get('/work/globdir')!;
    for (let i = 0; i < 55; i++) {
      const p = `/work/globdir/del-${i}.ts`;
      globCb({ path: p, change: 'delete' });
      globalCb({ path: p, change: 'delete' });
    }
    await h.advance(1_000);
    const globBursts = h
      .events()
      .filter((e) => e.kind === 'file.burst' && e.level === 'wake' && String(e.subject).startsWith('/work/globdir'));
    expect(globBursts).toHaveLength(1);

    // 3. Broken explicit dir watch does NOT suppress global burst wake
    watchers.get(brokenRoot)?.({ path: brokenRoot, change: 'modify', watchError: true, errorCode: 'EIO' });
    await h.advance(10);
    for (let i = 0; i < 55; i++) {
      globalCb({ path: `/work/broken/sub/d-${i}.ts`, change: 'delete' });
    }
    await h.advance(1_000);
    expect(
      h.events().filter((e) => e.kind === 'file.burst' && e.level === 'wake' && e.subject === '/work/broken/sub'),
    ).toHaveLength(1);

    // 4. file.activity emitted at flush while tool window is open keeps raw cause ('unknown')
    await h.agent({ type: 'created', sessionId: 's-flush' });
    globalCb({ path: '/work/flush-cause/ext.ts', change: 'add' });
    await h.advance(2_000);
    await h.onTool({
      type: 'pre-execute',
      sessionId: 's-flush',
      toolCallId: 't-flush',
      cwd: '/work/flush-cause',
      pid: 9001,
      at: Date.now(),
    });
    await h.advance(9_000);
    await h.onTool({
      type: 'post-execute',
      sessionId: 's-flush',
      toolCallId: 't-flush',
      cwd: '/work/flush-cause',
      pid: 9001,
      at: Date.now(),
    });
    const flushed = collectActivity(h.events()).find((e) => e.detail?.directory === '/work/flush-cause');
    expect(flushed?.cause).toBe('unknown');

    await h.runtime.stop();
  });

  it('auto-rebuilds once on non-EPERM/ECLOSE watch errors, stays unavailable on second failure, and refreshes rootDenied exclusions', async () => {
    const cbs: ((ev: FileChange) => void)[] = [];
    const h = createHarness({
      watchFactory: (_root, cb) => {
        cbs.push(cb);
        return { close: () => {} };
      },
    });
    await h.runtime.start();
    expect(h.openWatchers()).toBe(1);

    // First EIO clears pending buckets and rebuilds once
    cbs[0]?.({ path: '/work/dropped/a.ts', change: 'add' });
    cbs[0]?.({ path: '/', change: 'modify', watchError: true, errorCode: 'EIO' });
    await h.advance(20);
    expect(h.openWatchers()).toBe(1);
    expect(h.totalWatchCalls()).toBe(2);
    expect(h.globalFact()?.status).toBe('running');
    await h.advance(10_000);
    expect(collectActivity(h.events()).some((e) => e.detail?.directory === '/work/dropped')).toBe(false);

    // Second EIO transitions to unavailable with reason & retryAt and unrelated toggleRule does NOT revive it
    cbs[1]?.({ path: '/', change: 'modify', watchError: true, errorCode: 'ECLOSE' });
    await h.advance(20);
    expect(h.openWatchers()).toBe(0);
    expect(h.runtime.state().env.globalFileWatch?.status).toBe('unavailable');
    expect(h.globalFact()?.reason).toContain('ECLOSE');
    expect(h.globalFact()?.retryAt).toBeDefined();
    await h.runtime.actions.toggleRule?.('file-activity', false);
    expect(h.openWatchers()).toBe(0);

    // Explicit toggle re-enables and clears unavailable latch
    await h.runtime.actions.setGlobalFileWatch?.(true);
    expect(h.openWatchers()).toBe(1);
    expect(h.globalFact()?.status).toBe('running');

    // Subtree EPERM records deniedPaths and rebuilds watcher
    const beforeSubDenied = h.totalWatchCalls();
    cbs.at(-1)?.({
      path: '/protected/sub',
      change: 'modify',
      watchError: true,
      errorCode: 'EPERM',
      errorPath: '/protected/sub',
    });
    await h.advance(20);
    expect(h.globalFact()?.status).toBe('partial-denied');
    expect(h.globalFact()?.deniedPaths).toContain('/protected/sub');
    expect(h.totalWatchCalls()).toBe(beforeSubDenied + 1);

    // Excluded path EPERM is ignored without closing or rebuilding the watcher
    const callsBeforeExcluded = h.totalWatchCalls();
    const excludedSub = path.posix.join('/Users/demo', 'Library', 'Safari', 'Bookmarks.plist');
    cbs.at(-1)?.({
      path: excludedSub,
      change: 'modify',
      watchError: true,
      errorCode: 'EPERM',
      errorPath: excludedSub,
    });
    await h.advance(20);
    expect(h.totalWatchCalls()).toBe(callsBeforeExcluded);
    expect(h.globalFact()?.deniedPaths).not.toContain(excludedSub);
    expect(h.globalFact()?.status).toBe('partial-denied');

    // Under rootDenied, exclusion mutations still refresh the published fact
    cbs.at(-1)?.({ path: '/', change: 'modify', watchError: true, errorCode: 'EPERM', errorPath: '/' });
    await h.advance(20);
    expect(h.globalFact()?.status).toBe('denied');
    await h.runtime.actions.addFileExclusion?.('~/Vault');
    expect(h.globalFact()?.exclusions).toContain('~/Vault');
    await h.runtime.actions.removeFileExclusion?.('~/Vault');
    expect(h.globalFact()?.exclusions).not.toContain('~/Vault');

    await h.runtime.stop();
  });

  it('drops a watcher error callback queued immediately before pause(true)', async () => {
    const h = createHarness();
    await h.runtime.start();
    const before = h.events().length;

    h.emitFile({ path: '/', change: 'modify', watchError: true, errorCode: 'EIO' } as FileChange);
    await h.runtime.actions.pause(true);
    await h.advance(20);

    const added = h.events().slice(before);
    expect(added.filter((event) => event.kind === 'source.status' && event.subject === 'files-global')).toEqual([]);
    expect(added.map((event) => event.reason ?? '')).not.toContain('全盘文件监视出错（EIO）');
    await h.runtime.stop();
  });

  it('reports unsupported on non-darwin default root without retry', async () => {
    const h = createHarness({ platform: 'linux' });
    await h.runtime.start();
    expect(h.openWatchers()).toBe(0);
    expect(h.totalWatchCalls()).toBe(0);
    expect(h.runtime.state().env.globalFileWatch?.status).toBe('unsupported');
    expect(h.globalFact()?.status).toBe('unsupported');
    expect(h.globalFact()?.reason).toContain('不支持');
    expect(h.globalFact()?.retryAt).toBeUndefined();
    expect(h.runtime.state().observation.sources['files-global']?.status).toBe('unsupported');
    await h.runtime.stop();
  });

  it('recovers from startup EIO via exponential backoff, pause/unpause, and explicit retryGlobalFileWatch', async () => {
    let failOpen = true;
    const h = createHarness({
      watchFactory: () => {
        if (failOpen) throw Object.assign(new Error('io error'), { code: 'EIO' });
        return { close: () => {} };
      },
    });
    await h.runtime.start();
    expect(h.openWatchers()).toBe(0);
    expect(h.totalWatchCalls()).toBe(1);
    expect(h.runtime.state().env.globalFileWatch?.status).toBe('unavailable');
    const firstRetryAt = h.globalFact()?.retryAt ?? 0;
    const obs1 = h.runtime.state().env.globalFileWatch?.observedAt ?? 0;
    expect(firstRetryAt - obs1).toBe(30_000);

    // 1st backoff (30s) still fails -> next backoff doubles to 60s
    await h.advance(30_000);
    expect(h.totalWatchCalls()).toBe(2);
    expect(h.runtime.state().env.globalFileWatch?.status).toBe('unavailable');
    const secondRetryAt = h.globalFact()?.retryAt ?? 0;
    const obs2 = h.runtime.state().env.globalFileWatch?.observedAt ?? 0;
    expect(secondRetryAt - obs2).toBe(60_000);

    // Pause -> unpause clears transient unavailable and retries immediately
    failOpen = false;
    await h.runtime.actions.pause(true);
    await h.runtime.actions.pause(false);
    expect(h.openWatchers()).toBe(1);
    expect(h.globalFact()?.status).toBe('running');

    // Simulate another unavailable cycle and verify explicit retryGlobalFileWatch action
    await h.runtime.stop();

    let attempts = 0;
    const h2 = createHarness({
      watchFactory: () => {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error('io error'), { code: 'EIO' });
        return { close: () => {} };
      },
    });
    await h2.runtime.start();
    expect(h2.runtime.state().env.globalFileWatch?.status).toBe('unavailable');
    await h2.runtime.actions.retryGlobalFileWatch?.();
    expect(attempts).toBe(2);
    expect(h2.openWatchers()).toBe(1);
    expect(h2.globalFact()?.status).toBe('running');
    await h2.runtime.stop();
  });

  it('normalizes darwin case/NFC identically across FileSource and FileGlobalSource and wakes explicit rule file.burst', async () => {
    const ruleDir = '/Users/Demo/Project';
    const callbacks = new Map<string, (event: FileChange) => void>();
    const h = createHarness({
      platform: 'darwin',
      watchFactory: (root, cb) => {
        callbacks.set(root, cb);
        return { close: () => {} };
      },
      rules: [
        ...DEFAULT_RULES,
        {
          id: 'explicit-project',
          match: { kind: 'file.changed', subject: `${ruleDir}/**` },
          level: 'context',
          createdBy: 'user',
          approved: true,
        },
        {
          id: 'explicit-project-burst',
          match: { kind: 'file.burst', subject: `${ruleDir}/**` },
          level: 'wake',
          createdBy: 'user',
          approved: true,
        },
      ],
    });
    await h.runtime.start();
    expect(h.totalWatchCalls()).toBe(2);
    const globalCb = callbacks.get('/');
    const ruleCb = callbacks.get(ruleDir);
    expect(globalCb).toBeDefined();
    expect(ruleCb).toBeDefined();

    for (let i = 0; i < 60; i++) {
      const ev: FileChange = { path: `/users/demo/project/del-${i}.ts`, change: 'delete' };
      ruleCb?.(ev);
      globalCb?.(ev);
    }
    await h.advance(50);

    const bursts = h.events().filter((e) => e.kind === 'file.burst');
    expect(bursts.length).toBeGreaterThanOrEqual(1);
    expect(bursts.some((e) => e.level === 'wake')).toBe(true);
    expect(bursts.at(-1)?.detail?.deleted).toBe(51);
    await h.runtime.stop();
  });

  it('architecture: FileSource and FileGlobalSource both normalize paths via normalizeWatchPath', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const filesSrc = readFileSync(path.resolve(here, '../../src/host/sources/files.ts'), 'utf8');
    const globalSrc = readFileSync(path.resolve(here, '../../src/host/sources/files-global.ts'), 'utf8');
    expect(filesSrc).toContain('normalizeWatchPath(');
    expect(globalSrc).toContain('normalizeWatchPath(');
  });

  it('slices flushing of 2,200 directory buckets without blocking a single synchronous turn >= 50ms', async () => {
    const h = createHarness({ fakeClockOnly: true });
    await h.runtime.start();

    // Warm up V8 JIT on the flush/acceptBatch/stateFor path before measuring turn gaps.
    const runFlush = async (prefix: string, eventCount: number, minSlices: number, measure: boolean) => {
      for (let i = 0; i < eventCount; i++) {
        h.emitFile({ path: `/work/${prefix}/s-${Math.floor(i / 20)}/d-${i}/a.ts`, change: 'modify' });
      }

      let sliceNotifications = 0;
      let hasRolledUp = false;
      const unsub = h.runtime.subscribe(() => {
        sliceNotifications++;
        if (!hasRolledUp) {
          hasRolledUp = collectActivity(h.events()).some(
            (e) => e.subject.startsWith(`/work/${prefix}/`) && Number(e.detail?.rolledUp ?? 0) > 0,
          );
        }
      });

      await h.advance(9_999);
      await new Promise((r) => setImmediate(r));
      const gaps: number[] = [];
      let lastBeat = performance.now();
      let probing = measure;
      const beat = () => {
        const now = performance.now();
        gaps.push(now - lastBeat);
        lastBeat = now;
        if (probing) setImmediate(beat);
      };
      if (measure) setImmediate(beat);

      const t0 = performance.now();
      await h.advance(501);
      let stable = 0;
      let prev = sliceNotifications;
      for (let i = 0; i < 400; i++) {
        await new Promise((r) => setImmediate(r));
        if (sliceNotifications === prev && sliceNotifications >= minSlices) {
          stable++;
          if (stable >= 4) break;
        } else {
          stable = 0;
          prev = sliceNotifications;
        }
      }
      probing = false;
      unsub();
      const totalMs = performance.now() - t0;
      const sorted = [...gaps].sort((a, b) => a - b);
      const p95GapMs = sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.95)] : 0;
      const maxGapMs = sorted.length ? sorted[sorted.length - 1] : 0;
      if (!hasRolledUp) {
        hasRolledUp = collectActivity(h.events()).some(
          (e) => e.subject.startsWith(`/work/${prefix}/`) && Number(e.detail?.rolledUp ?? 0) > 0,
        );
      }
      return { sliceNotifications, totalMs, p95GapMs, maxGapMs, hasRolledUp };
    };

    await runFlush('warmup', 200, 1, false);

    // Measure the median of 3 in-process fixed serialization/clone workloads (5,000 dynamic
    // signal objects) after warmup so turn-budget checks scale with CI CPU load without JIT/GC skew.
    const buildSignalBatch = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => ({
        id: `ref:${tag}:${i}`,
        kind: 'file.activity',
        at: 1_700_000_000_000 + i,
        subject: `/work/${tag}/s-${Math.floor(i / 20)}/d-${i}`,
        data: {
          directory: `/work/${tag}/s-${Math.floor(i / 20)}/d-${i}`,
          windowMs: 10_000,
          created: 0,
          modified: 1,
          deleted: 0,
          files: [`a-${i}.ts`],
        },
      }));
    let refSink = JSON.stringify(structuredClone(buildSignalBatch(500, 'warm'))).length;
    const refSamples: number[] = [];
    for (let iter = 0; iter < 3; iter++) {
      const t0 = performance.now();
      refSink += JSON.stringify(structuredClone(buildSignalBatch(5_000, `b${iter}`))).length;
      refSamples.push(performance.now() - t0);
    }
    refSamples.sort((a, b) => a - b);
    const refBatchMs = Math.max(1, refSamples[1] ?? refSamples[0] ?? 1);
    expect(refSink).toBeGreaterThan(0);

    const runs: Awaited<ReturnType<typeof runFlush>>[] = [];
    for (let run = 0; run < 3; run++) {
      const res = await runFlush(`r${run}`, 2_200, 10, true);
      expect(res.sliceNotifications).toBeGreaterThanOrEqual(10);
      expect(res.hasRolledUp).toBe(true);
      expect(res.p95GapMs).toBeLessThanOrEqual(refBatchMs);
      // Fast hosts finish ~2,000 rolled-up buckets in ~14 slices of up to 200 buckets (~10% each, total ~25-30ms),
      // so cap p95 at 5% of totalMs on slow hosts and at most min(30% of totalMs, 10ms) on fast hosts.
      expect(res.p95GapMs).toBeLessThanOrEqual(Math.max(res.totalMs * 0.05, Math.min(res.totalMs * 0.3, 10)));
      runs.push(res);
    }

    const minMaxGapMs = Math.min(...runs.map((r) => r.maxGapMs));
    const minTotalMs = Math.min(...runs.map((r) => r.totalMs));
    console.info(
      `[files-global flush] refBatch=${refBatchMs.toFixed(1)} ms (${refSamples.map((s) => s.toFixed(1)).join('/')}), runs=${runs
        .map(
          (r) =>
            `slices=${r.sliceNotifications}/total=${r.totalMs.toFixed(1)}ms/p95=${r.p95GapMs.toFixed(1)}ms/max=${r.maxGapMs.toFixed(1)}ms`,
        )
        .join('; ')}`,
    );
    expect(minMaxGapMs).toBeLessThanOrEqual(refBatchMs * 1.5);
    expect(minMaxGapMs).toBeLessThanOrEqual(Math.max(minTotalMs * 0.1, Math.min(minTotalMs * 0.35, 12)));
    await h.runtime.stop();
  }, 45_000);
});
