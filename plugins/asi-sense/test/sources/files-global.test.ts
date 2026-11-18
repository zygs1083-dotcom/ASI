import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GlobalFileWatchValue } from '@asi/sense-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileGlob } from '../../src/host/attention/glob.ts';
import { DEFAULT_RULES } from '../../src/host/attention/rules.ts';
import { defaultBodyRules } from '../../src/host/body/index.ts';
import { createPresenter } from '../../src/host/presenter/index.ts';
import type { EventEntry } from '../../src/host/runtime/attention.ts';
import { createSenseRuntime } from '../../src/host/runtime/index.ts';
import type { DshPort, FileChange, FileWatcher, SenseOptions } from '../../src/host/runtime/ports.ts';
import {
  DEFAULT_FILE_EXCLUSIONS,
  ExclusionMatcher,
  MAX_FILE_EXCLUSIONS,
  normalizeFileExclusion,
} from '../../src/host/sources/file-exclusions.ts';

afterEach(() => vi.useRealTimers());

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
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'asi-files-global-'));
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
    const t0 = performance.now();
    expect(matcher.test(text)).toBe(false);
    const globMs = performance.now() - t0;
    expect(globMs).toBeLessThan(1);

    const exMatcher = new ExclusionMatcher([`${'**a'.repeat(18)}b`], [], '/Users/demo', 'darwin');
    const t1 = performance.now();
    expect(exMatcher.isExcluded(`/work/${'a'.repeat(180)}c/file.ts`)).toBe(false);
    expect(performance.now() - t1).toBeLessThan(5);

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

    // Second EIO transitions permanently to unavailable and unrelated toggleRule does NOT revive it
    cbs[1]?.({ path: '/', change: 'modify', watchError: true, errorCode: 'ECLOSE' });
    await h.advance(20);
    expect(h.openWatchers()).toBe(0);
    expect(h.runtime.state().env.globalFileWatch?.status).toBe('unavailable');
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
});
