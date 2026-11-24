import { spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ARTIFACT_IDLE_THRESHOLD_MS,
  BLOAT_CRITICAL_BYTES,
  BLOAT_UNCOMFORTABLE_BYTES,
  cleanApprovedWorkspaceArtifact,
  scanWorkspaceArtifacts,
} from '../../src/care/host/artifact-scanner.js';
import { type CareExecFn, defaultCareExec } from '../../src/care/host/command.js';
import {
  type DiscoveryReport,
  discoverWorkspacesAndWorktrees,
  parseGitWorktreePorcelain,
} from '../../src/care/host/discovery.js';
import { evaluateCareDrives } from '../../src/care/host/evaluator.js';
import {
  checkLockFileHolders,
  cleanDeadGitLocks,
  inspectRepoHygiene,
  MERGED_WORKTREE_IDLE_MS,
  parseGitStatusPorcelainV1,
  removeApprovedMergedWorktree,
} from '../../src/care/host/git-inspector.js';
import {
  checkDirectoryProcessHolders,
  decodeLsofFieldPath,
  inspectOrphanRuntime,
  parseLsofCwdOutput,
  parseLsofListenOutput,
  parsePsElapsedMs,
  parsePsRuntimeTable,
  terminateApprovedOrphanPort,
} from '../../src/care/host/port-inspector.js';

const T0 = Math.max(Date.now(), 1_800_000_000_000);
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function setMtime(target: string, mtimeMs: number): Promise<void> {
  const sec = mtimeMs / 1000;
  await utimes(target, sec, sec);
}

async function setTreeMtime(root: string, mtimeMs: number): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await setTreeMtime(full, mtimeMs);
    } else {
      await setMtime(full, mtimeMs);
    }
  }
  await setMtime(root, mtimeMs);
}

describe('MIT 内化解析器、安全护栏与三分评估器单测', () => {
  it('解析 git worktree list --porcelain（含主工作树、兄弟分支、detached、locked、prunable 与 bare）', () => {
    const sample = [
      'worktree /tmp/repo-main',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /tmp/repo-wt-feat',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feat/care',
      'locked active migration',
      '',
      'worktree /tmp/repo-wt-gone',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');

    const parsed = parseGitWorktreePorcelain(sample);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({
      worktreePath: '/tmp/repo-main',
      branch: 'main',
      detached: false,
      locked: false,
      prunable: false,
    });
    expect(parsed[1]).toMatchObject({
      worktreePath: '/tmp/repo-wt-feat',
      branch: 'feat/care',
      locked: true,
      lockReason: 'active migration',
    });
    expect(parsed[2]).toMatchObject({
      worktreePath: '/tmp/repo-wt-gone',
      detached: true,
      prunable: true,
    });
    expect(parseGitWorktreePorcelain('')).toEqual([]);
  });

  it('解析 git status --porcelain=v1 --branch（追踪分支 ahead/behind、冲突码、仅在 R/C 解析重命名、保留合法箭头文件名与忽略项识别）', () => {
    const raw = [
      '## feat/care...origin/feat/care [ahead 3, behind 1]',
      'M  src/a.ts',
      ' M src/flow -> next.ts', // 非 R/C 状态：必须完整保留含 ' -> ' 的合法文件名！
      'MM src/both.ts',
      'R  src/old.ts -> src/new.ts',
      'C  "src/old -> a.ts" -> "src/copied -> b.ts"',
      'UU src/conflict -> keep.ts',
      'AA src/both-added.ts',
      '?? notes/a -> b.md', // 未跟踪文件含 ' -> '：严禁截断！
      '??  leading-space.md', // 未加引号的前导空格文件名：严禁被 trim() 吞掉！
      '!! dist/ignored.js',
      '!! apps/web/.env.local',
    ].join('\n');

    const status = parseGitStatusPorcelainV1(raw);
    expect(status.branch).toBe('feat/care');
    expect(status.upstream).toBe('origin/feat/care');
    expect(status.ahead).toBe(3);
    expect(status.behind).toBe(1);
    expect(status.stagedCount).toBe(4); // M, MM, R, C
    expect(status.modifiedCount).toBe(2); // _M, MM
    expect(status.conflictCount).toBe(2); // UU, AA
    expect(status.untrackedCount).toBe(2); // ??
    expect(status.ignoredCount).toBe(2); // !!
    expect(status.hasEnvIgnored).toBe(true);
    expect(status.dirtyTotal).toBe(10);
    expect(status.dirtySamplePaths).toContain('src/flow -> next.ts');
    expect(status.dirtySamplePaths).toContain('notes/a -> b.md');
    expect(status.dirtySamplePaths).toContain(' leading-space.md');
    expect(status.dirtySamplePaths).toContain('src/conflict -> keep.ts');
    expect(status.dirtySamplePaths).toContain('src/new.ts');
    expect(status.dirtySamplePaths).toContain('src/copied -> b.ts');
    expect(status.dirtySamplePaths).not.toContain('dist/ignored.js');
  });

  it('Git 死锁 lsof 占用校验遵循 fail-closed：仅明确 exit 1 且无 stderr 为 free，有 PID 为 held，ENOENT/超时绝不误删', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-care-locks-'));
    tempDirs.push(dir);
    const wtDir = join(dir, 'wt');
    const gitDir = join(wtDir, '.git');
    await mkdir(gitDir, { recursive: true });
    const freeLock = join(gitDir, 'index.lock');
    const heldLock = join(gitDir, 'HEAD.lock');
    const unknownLock = join(gitDir, 'config.lock');
    await writeFile(freeLock, '');
    await writeFile(heldLock, '');
    await writeFile(unknownLock, '');

    const oldTime = T0 - 4 * 3_600_000;
    await setMtime(freeLock, oldTime);
    await setMtime(heldLock, oldTime);
    await setMtime(unknownLock, oldTime);
    await setMtime(wtDir, oldTime);

    const mockExec: CareExecFn = async (_bin, args) => {
      const target = args.at(-1) ?? '';
      if (target === freeLock) {
        return { ok: false, exitCode: 1, stdout: '', stderr: '' };
      }
      if (target === heldLock) {
        return { ok: true, exitCode: 0, stdout: 'p4321\n', stderr: '' };
      }
      return { ok: false, exitCode: null, stdout: '', stderr: 'lsof unavailable', errorCode: 'ENOENT' };
    };

    expect(await checkLockFileHolders(freeLock, mockExec)).toBe('free');
    expect(await checkLockFileHolders(heldLock, mockExec)).toBe('held');
    expect(await checkLockFileHolders(unknownLock, mockExec)).toBe('unknown');

    const cleaned = await cleanDeadGitLocks({
      locks: [
        {
          lockPath: freeLock,
          displayLockPath: '~/wt/.git/index.lock',
          lockName: 'index.lock',
          worktreePath: wtDir,
          displayWorktreePath: '~/wt',
          ageMs: 4 * 3_600_000,
          holderState: 'free',
        },
        {
          lockPath: heldLock,
          displayLockPath: '~/wt/.git/HEAD.lock',
          lockName: 'HEAD.lock',
          worktreePath: wtDir,
          displayWorktreePath: '~/wt',
          ageMs: 4 * 3_600_000,
          holderState: 'free',
        },
        {
          lockPath: unknownLock,
          displayLockPath: '~/wt/.git/config.lock',
          lockName: 'config.lock',
          worktreePath: wtDir,
          displayWorktreePath: '~/wt',
          ageMs: 4 * 3_600_000,
          holderState: 'free',
        },
      ],
      now: T0,
      exec: mockExec,
    });

    expect(cleaned.removedLocks).toEqual(['~/wt/.git/index.lock']);
    expect(cleaned.skippedLocks).toEqual(['~/wt/.git/HEAD.lock', '~/wt/.git/config.lock']);
    await expect(stat(freeLock)).rejects.toThrow();
    expect((await stat(heldLock)).isFile()).toBe(true);
    expect((await stat(unknownLock)).isFile()).toBe(true);
  });

  it('孤儿开发端口检测与 SIGTERM 释放：双栈去重、过滤数据库/GUI/活跃工作树，并在 PID 复用命令不符时拒绝发信号', async () => {
    expect(parsePsElapsedMs('05:30')).toBe(330_000);
    expect(parsePsElapsedMs('03:00:00')).toBe(3 * 3_600_000);
    expect(parsePsElapsedMs('2-01:00:00')).toBe(49 * 3_600_000);
    expect(parsePsElapsedMs('bad')).toBe(0);

    const lsofOut = [
      'p2001',
      'cnode',
      'n127.0.0.1:5173',
      'n[::1]:5173', // 同一 PID 双栈监听，应去重为单个端口条目
      'p2002',
      'cpostgres',
      'n127.0.0.1:5432',
      'p2003',
      'cnode',
      'n127.0.0.1:80', // < 1024 特权端口忽略
      'p2004',
      'cnode',
      'n127.0.0.1:3000', // 属于活跃工作树，应豁免
    ].join('\n');
    const listeners = parseLsofListenOutput(lsofOut);
    expect(listeners).toHaveLength(3);
    expect(listeners[0]).toEqual({
      pid: 2001,
      command: 'node',
      port: 5173,
      hosts: ['127.0.0.1', '[::1]'],
    });

    const psOut = [
      ' 2001 1 04:10:00 131072 S /opt/homebrew/bin/node',
      ' 2002 1 10:00:00 262144 S /opt/homebrew/bin/postgres',
      ' 2004 1 05:00:00 65536 S /opt/homebrew/bin/node',
      ' 2005 1 00:10:00 0 Z <defunct>',
    ].join('\n');
    expect(parsePsRuntimeTable(psOut).zombieCount).toBe(1);

    const dir = await mkdtemp(join(tmpdir(), 'asi-care-ports-'));
    tempDirs.push(dir);
    const idleWt = join(dir, 'idle-wt');
    const activeWt = join(dir, 'active-wt');
    await mkdir(idleWt, { recursive: true });
    await mkdir(activeWt, { recursive: true });

    const discovery: DiscoveryReport = {
      scannedAt: T0,
      repos: [],
      worktrees: [
        {
          path: idleWt,
          displayPath: '~/idle-wt',
          name: 'idle-wt',
          kind: 'git-worktree',
          isMainWorktree: true,
          detached: false,
          locked: false,
          latestActivityAt: T0 - 5 * 3_600_000,
          idleMs: 5 * 3_600_000,
          activeExempt: false,
          activeSessionIds: [],
        },
        {
          path: activeWt,
          displayPath: '~/active-wt',
          name: 'active-wt',
          kind: 'git-worktree',
          isMainWorktree: true,
          detached: false,
          locked: false,
          latestActivityAt: T0 - 10 * 60_000,
          idleMs: 10 * 60_000,
          activeExempt: true,
          exemptReason: 'recent-file-activity',
          activeSessionIds: [],
        },
      ],
    };

    const execReport: CareExecFn = async (bin, args) => {
      if (bin === 'ps') return { ok: true, exitCode: 0, stdout: psOut, stderr: '' };
      if (bin === 'lsof' && args.includes('-iTCP')) return { ok: true, exitCode: 0, stdout: lsofOut, stderr: '' };
      if (bin === 'lsof' && args.includes('cwd')) {
        return {
          ok: true,
          exitCode: 0,
          stdout: `p2001\nn${idleWt}\np2004\nn${activeWt}\n`,
          stderr: '',
        };
      }
      return { ok: false, exitCode: 1, stdout: '', stderr: '' };
    };

    const report = await inspectOrphanRuntime({
      now: T0,
      discovery,
      orphanDshJobCount: 0,
      exec: execReport,
    });
    expect(report.orphanPorts).toHaveLength(1);
    expect(report.orphanPorts[0]?.pid).toBe(2001);
    expect(report.orphanPorts[0]?.port).toBe(5173);
    expect(report.zombieCount).toBe(1);

    const candidate = report.orphanPorts[0];
    if (!candidate) throw new Error('missing orphan port candidate');

    // 负向边界 1：PID 回绕变成其他程序（如 python3）时严禁发信号！
    const killSpy = vi.fn();
    await expect(
      terminateApprovedOrphanPort({
        candidate,
        activeSessionCwds: [],
        exec: async (bin) => {
          if (bin === 'ps') {
            return { ok: true, exitCode: 0, stdout: ' 2001 1 00:01:00 10240 S /usr/bin/python3\n', stderr: '' };
          }
          return { ok: true, exitCode: 0, stdout: 'p2001\ncpython3\nn127.0.0.1:5173\n', stderr: '' };
        },
        killFn: killSpy,
      }),
    ).rejects.toThrow(/command changed/);
    expect(killSpy).not.toHaveBeenCalled();

    // 正向复核通过：仅发送一次 SIGTERM（绝不发送 SIGKILL）
    const res = await terminateApprovedOrphanPort({
      candidate,
      activeSessionCwds: [],
      exec: async (bin) => {
        if (bin === 'ps') return { ok: true, exitCode: 0, stdout: psOut, stderr: '' };
        return { ok: true, exitCode: 0, stdout: 'p2001\ncnode\nn127.0.0.1:5173\n', stderr: '' };
      },
      killFn: killSpy,
    });
    expect(res.terminated).toBe(true);
    expect(killSpy).toHaveBeenCalledExactlyOnceWith(2001, 'SIGTERM');
  });

  it('闲置构建产物扫描与清理：要求生态清单（手写无源码 dist 不误判）、跳过软链、区分 <1GiB/≥1GiB/≥8GiB，且在 2h 内出现新修改时拒绝删除', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asi-care-bloat-'));
    tempDirs.push(root);
    const fakeHome = join(root, 'home');
    const wt = join(fakeHome, 'projects', 'idle-app');
    const handDistRepo = join(fakeHome, 'projects', 'prebuilt-assets');
    await mkdir(join(wt, 'node_modules', 'pkg-a'), { recursive: true });
    await mkdir(join(handDistRepo, 'dist'), { recursive: true });
    await writeFile(join(wt, 'package.json'), '{"name":"idle-app"}');
    await writeFile(join(handDistRepo, 'package.json'), '{"name":"prebuilt-only"}'); // 无 tsconfig & 无 src 目录！
    await writeFile(join(handDistRepo, 'dist', 'bundle.js'), Buffer.alloc(4096));

    // 放入指向外部目录的符号链接，必须被零跟随忽略
    const outsideDir = join(root, 'outside-secret');
    await mkdir(outsideDir, { recursive: true });
    const outsideFile = join(outsideDir, 'keep.bin');
    await writeFile(outsideFile, Buffer.alloc(8192));
    await symlink(outsideDir, join(wt, 'node_modules', 'linked-outside'));

    // 使用稀疏文件瞬时构造 1.2 GiB 逻辑体积（占用 0 物理块）
    const bigBin = join(wt, 'node_modules', 'pkg-a', 'binary.bin');
    await writeFile(bigBin, '');
    await truncate(bigBin, Math.round(1.2 * 1024 ** 3));

    const eightDaysAgo = T0 - (ARTIFACT_IDLE_THRESHOLD_MS + 86_400_000);
    for (const p of [
      bigBin,
      join(wt, 'node_modules', 'pkg-a'),
      join(wt, 'node_modules'),
      join(wt, 'package.json'),
      wt,
      join(handDistRepo, 'dist', 'bundle.js'),
      join(handDistRepo, 'dist'),
      handDistRepo,
    ]) {
      await setMtime(p, eightDaysAgo);
    }

    const discovery: DiscoveryReport = {
      scannedAt: T0,
      repos: [],
      worktrees: [
        {
          path: wt,
          displayPath: '~/projects/idle-app',
          name: 'idle-app',
          kind: 'git-worktree',
          isMainWorktree: true,
          detached: false,
          locked: false,
          latestActivityAt: eightDaysAgo,
          idleMs: T0 - eightDaysAgo,
          activeExempt: false,
          activeSessionIds: [],
        },
        {
          path: handDistRepo,
          displayPath: '~/projects/prebuilt-assets',
          name: 'prebuilt-assets',
          kind: 'git-worktree',
          isMainWorktree: true,
          detached: false,
          locked: false,
          latestActivityAt: eightDaysAgo,
          idleMs: T0 - eightDaysAgo,
          activeExempt: false,
          activeSessionIds: [],
        },
      ],
    };

    const bloat = await scanWorkspaceArtifacts({
      now: T0,
      homeDir: fakeHome,
      discovery,
    });

    // 手写无 src/tsconfig 的 dist 绝不被误判为构建产物
    expect(bloat.idleArtifacts).toHaveLength(1);
    expect(bloat.idleArtifacts[0]?.displayArtifactPath).toBe('~/projects/idle-app/node_modules');
    expect(bloat.totalIdleBytes).toBeGreaterThanOrEqual(BLOAT_UNCOMFORTABLE_BYTES);

    const drivesUncomf = evaluateCareDrives({ discovery, bloat });
    const bloatDrive = drivesUncomf.find((d) => d.key === 'workspace_bloat');
    expect(bloatDrive?.satisfaction).toBeLessThan(60);
    expect(bloatDrive?.satisfaction).toBeGreaterThanOrEqual(25);

    const drivesCrit = evaluateCareDrives({
      discovery,
      bloat: { ...bloat, totalIdleBytes: BLOAT_CRITICAL_BYTES + 1024 },
    });
    expect(drivesCrit.find((d) => d.key === 'workspace_bloat')?.satisfaction).toBeLessThan(25);

    // 负向边界：若批准清理前 10 分钟刚修改过 node_modules 内文件，必须拒绝清理保护活跃编译！
    const target = bloat.idleArtifacts[0];
    if (!target) throw new Error('missing artifact target');
    await setMtime(bigBin, T0 - 10 * 60_000);
    await expect(
      cleanApprovedWorkspaceArtifact({
        candidate: target,
        now: T0,
        homeDir: fakeHome,
        activeSessionCwds: [],
      }),
    ).rejects.toThrow(/2-hour active protection window/);
    expect((await stat(bigBin)).isFile()).toBe(true);

    // 恢复为陈旧时间戳后批准清理：安全移除 node_modules，且软链指向的外部文件完好无损！
    await setMtime(bigBin, eightDaysAgo);
    const cleaned = await cleanApprovedWorkspaceArtifact({
      candidate: target,
      now: T0,
      homeDir: fakeHome,
      activeSessionCwds: [],
    });
    expect(cleaned.freedBytes).toBeGreaterThan(1024 ** 3);
    await expect(stat(join(wt, 'node_modules'))).rejects.toThrow();
    expect((await stat(outsideFile)).isFile()).toBe(true);
  });

  it('真实系统级 lsof + ps + SIGTERM 验证：真实文件句柄打开时保护 index.lock 不误删，真实子进程监听临时端口可精准识别并优雅 SIGTERM 终止', {
    timeout: 20_000,
  }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-care-real-os-'));
    tempDirs.push(dir);
    const realDir = await realpath(dir);
    const wt = join(realDir, 'idle-wt');
    const gitDir = join(wt, '.git');
    await mkdir(gitDir, { recursive: true });

    const lockFile = join(gitDir, 'index.lock');
    await writeFile(lockFile, 'lock');
    const nowWall = Date.now();
    const fourHoursAgo = nowWall - 4 * 3_600_000;
    await setMtime(lockFile, fourHoursAgo);
    await setMtime(wt, fourHoursAgo);

    // 1. 真实打开文件描述符持有 index.lock -> 真实 lsof 必须识别为 'held' 且拒绝删除
    const handle = await open(lockFile, 'r+');
    try {
      const heldState = await checkLockFileHolders(lockFile, defaultCareExec);
      expect(heldState).toBe('held');
      const skipClean = await cleanDeadGitLocks({
        locks: [
          {
            lockPath: lockFile,
            displayLockPath: '~/idle-wt/.git/index.lock',
            lockName: 'index.lock',
            worktreePath: wt,
            displayWorktreePath: '~/idle-wt',
            ageMs: 4 * 3_600_000,
            holderState: 'free',
          },
        ],
        now: nowWall,
        exec: defaultCareExec,
      });
      expect(skipClean.removedLocks).toEqual([]);
      expect((await stat(lockFile)).isFile()).toBe(true);
    } finally {
      await handle.close();
    }

    // 关闭句柄后 -> 真实 lsof 识别为 'free' 并安全清理
    expect(await checkLockFileHolders(lockFile, defaultCareExec)).toBe('free');
    const realClean = await cleanDeadGitLocks({
      locks: [
        {
          lockPath: lockFile,
          displayLockPath: '~/idle-wt/.git/index.lock',
          lockName: 'index.lock',
          worktreePath: wt,
          displayWorktreePath: '~/idle-wt',
          ageMs: 4 * 3_600_000,
          holderState: 'free',
        },
      ],
      now: nowWall,
      exec: defaultCareExec,
    });
    expect(realClean.removedLocks).toEqual(['~/idle-wt/.git/index.lock']);
    await expect(stat(lockFile)).rejects.toThrow();

    // 2. 启动真实本地 127.0.0.1 临时端口子进程（cwd 设为 wt），验证真实 lsof + ps 发现与 SIGTERM 释放
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const net = require('node:net');
         const srv = net.createServer();
         srv.listen(0, '127.0.0.1', () => {
           console.log(String(srv.address().port));
         });
         process.on('SIGTERM', () => srv.close(() => process.exit(0)));`,
      ],
      { cwd: wt, stdio: ['ignore', 'pipe', 'ignore'] },
    );

    try {
      const boundPort = await new Promise<number>((resolvePort, rejectPort) => {
        let buf = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          const line = buf.trim().split(/\r?\n/)[0];
          if (line && /^\d+$/.test(line)) {
            resolvePort(Number(line));
          }
        });
        child.once('error', rejectPort);
        child.once('exit', (code) => rejectPort(new Error(`child exited early: ${code}`)));
      });
      expect(boundPort).toBeGreaterThanOrEqual(1024);

      // 验证真实 lsof + ps 链路及 SIGTERM 释放
      const origPid = child.pid ?? 0;
      expect(origPid).toBeGreaterThan(1);

      const lsofListen = await defaultCareExec('lsof', [
        '-w',
        '-nP',
        '-a',
        '-p',
        String(origPid),
        '-iTCP',
        '-sTCP:LISTEN',
        '-Fpcn',
      ]);
      const parsedPorts = parseLsofListenOutput(lsofListen.stdout);
      expect(parsedPorts.some((p) => p.pid === origPid && p.port === boundPort)).toBe(true);

      const psSingle = await defaultCareExec('ps', [
        '-p',
        String(origPid),
        '-o',
        'pid=,ppid=,etime=,rss=,state=,comm=',
      ]);
      const parsedPs = parsePsRuntimeTable(psSingle.stdout);
      const childEntry = parsedPs.processes.get(origPid);
      expect(childEntry).toBeDefined();

      const exitPromise = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
      const termRes = await terminateApprovedOrphanPort({
        candidate: {
          targetId: 'port_real_test',
          pid: origPid,
          ppid: childEntry?.ppid ?? 1,
          command: childEntry?.comm ?? 'node',
          port: boundPort,
          hosts: ['127.0.0.1'],
          elapsedMs: 0,
          rssBytes: childEntry?.rssBytes ?? 0,
          worktreePath: wt,
          displayWorktreePath: '~/idle-wt',
        },
        activeSessionCwds: [],
        exec: defaultCareExec,
      });
      expect(termRes.terminated).toBe(true);
      expect(await exitPromise).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
  });

  it('UTF-8 中文路径与空格解码、深层嵌套源码修改 2h 活跃豁免、多跳子进程树保护、AbortSignal fail-closed 与冲突时间精确计算', {
    timeout: 20_000,
  }, async () => {
    // 1. Git C-quoted 八进制 UTF-8 与 lsof \xHH 十六进制路径解码
    const quotedPorcelain = ['## main', ' M "src/\\347\\273\\204\\344\\273\\266 a.tsx"'].join('\n');
    const parsedUtf8 = parseGitStatusPorcelainV1(quotedPorcelain);
    expect(parsedUtf8.dirtySamplePaths).toEqual(['src/组件 a.tsx']);

    const quotedWtList = [
      'worktree "/tmp/\\344\\270\\255\\346\\226\\207 \\345\\267\\245\\344\\275\\234\\346\\240\\221"',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
    ].join('\n');
    expect(parseGitWorktreePorcelain(quotedWtList)[0]?.worktreePath).toBe('/tmp/中文 工作树');

    const rawLsofHex = 'p9876\nn/tmp/\\xe4\\xb8\\xad\\xe6\\x96\\x87 \\xe5\\xb7\\xa5\\xe4\\xbd\\x9c\\xe6\\xa0\\x91\n';
    expect(decodeLsofFieldPath('/tmp/\\xe4\\xb8\\xad\\xe6\\x96\\x87')).toBe('/tmp/中文');
    expect(parseLsofCwdOutput(rawLsofHex).get(9876)).toBe('/tmp/中文 工作树');

    // 2. 深层嵌套源码修改触发 2h 活跃豁免（即使顶层目录与 .git/index 仍为 8 天前）
    const root = await mkdtemp(join(tmpdir(), 'asi-care-nested-'));
    tempDirs.push(root);
    const realRoot = await realpath(root);
    const fakeHome = join(realRoot, 'home');
    const wt = join(fakeHome, '中文 工作树');
    const deepDir = join(wt, 'packages', 'web', 'src', 'components');
    const deepFile = join(deepDir, 'App.tsx');
    const ignoredSubPkg = join(wt, 'packages', 'legacy-vendor');
    await mkdir(deepDir, { recursive: true });
    await mkdir(join(wt, 'node_modules', 'big'), { recursive: true });
    await mkdir(join(ignoredSubPkg, 'node_modules', 'old'), { recursive: true });
    await writeFile(join(wt, 'package.json'), '{"name":"mono"}');
    await writeFile(join(ignoredSubPkg, 'package.json'), '{"name":"legacy"}');
    await writeFile(deepFile, 'export const App = () => null;\n');

    const bigArtifact = join(wt, 'node_modules', 'big', 'bundle.bin');
    const ignoredArtifact = join(ignoredSubPkg, 'node_modules', 'old', 'vendor.bin');
    await writeFile(bigArtifact, '');
    await truncate(bigArtifact, Math.round(1.1 * 1024 ** 3));
    await writeFile(ignoredArtifact, '');
    await truncate(ignoredArtifact, Math.round(1.1 * 1024 ** 3));

    const eightDaysAgo = T0 - (ARTIFACT_IDLE_THRESHOLD_MS + 86_400_000);
    for (const p of [
      bigArtifact,
      join(wt, 'node_modules', 'big'),
      join(wt, 'node_modules'),
      ignoredArtifact,
      join(ignoredSubPkg, 'node_modules', 'old'),
      join(ignoredSubPkg, 'node_modules'),
      join(ignoredSubPkg, 'package.json'),
      ignoredSubPkg,
      deepFile,
      deepDir,
      join(wt, 'packages', 'web', 'src'),
      join(wt, 'packages', 'web'),
      join(wt, 'packages'),
      join(wt, 'package.json'),
      wt,
    ]) {
      await setMtime(p, eightDaysAgo);
    }

    // 仅修改第 4 层嵌套文件 App.tsx 为 5 分钟前（不改顶层目录 mtime！）
    await setMtime(deepFile, T0 - 5 * 60_000);

    const discActive = await discoverWorkspacesAndWorktrees({
      now: T0,
      homeDir: fakeHome,
      workspacePaths: [wt],
      sessions: [],
      exec: async () => ({ ok: false, exitCode: 128, stdout: '', stderr: 'not a git repo' }),
    });
    expect(discActive.worktrees[0]?.activeExempt).toBe(true);
    expect(discActive.worktrees[0]?.exemptReason).toBe('recent-file-activity');

    // 若候选产物是在早期非活跃快照生成的，审批瞬间深层源码刚修改 <2h 或 AbortSignal 已触发 -> 均必须 fail-closed 拒绝删除！
    await setMtime(deepFile, eightDaysAgo);
    const discIdle = await discoverWorkspacesAndWorktrees({
      now: T0,
      homeDir: fakeHome,
      workspacePaths: [wt],
      sessions: [],
      exec: async () => ({ ok: false, exitCode: 128, stdout: '', stderr: 'not a git repo' }),
    });
    expect(discIdle.worktrees[0]?.activeExempt).toBe(false);

    // 验证 ignorePaths 子目录在慢探针扫描阶段即被过滤（excludedReals）
    const bloatWithIgnore = await scanWorkspaceArtifacts({
      now: T0,
      homeDir: fakeHome,
      discovery: discIdle,
      excludedReals: [ignoredSubPkg],
    });
    expect(bloatWithIgnore.idleArtifacts.map((a) => a.artifactPath)).toEqual([join(wt, 'node_modules')]);

    const cand = bloatWithIgnore.idleArtifacts[0];
    if (!cand) throw new Error('missing cand');

    // (a) AbortSignal 已中止时绝不 fail-open 调 rm
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      cleanApprovedWorkspaceArtifact({
        candidate: cand,
        now: T0,
        homeDir: fakeHome,
        activeSessionCwds: [],
        signal: preAborted.signal,
      }),
    ).rejects.toThrow(/aborted/i);
    expect((await stat(join(wt, 'node_modules'))).isDirectory()).toBe(true);

    // (b) 审批前深层源码 App.tsx 在 10 分钟前被编辑 -> 拒绝删除 node_modules 且拒绝向同目录端口发 SIGTERM！
    await setMtime(deepFile, T0 - 10 * 60_000);
    await expect(
      cleanApprovedWorkspaceArtifact({
        candidate: cand,
        now: T0,
        homeDir: fakeHome,
        activeSessionCwds: [],
      }),
    ).rejects.toThrow(/source files in owning worktree were modified/);
    expect((await stat(join(wt, 'node_modules'))).isDirectory()).toBe(true);

    const killBlockedSpy = vi.fn();
    await expect(
      terminateApprovedOrphanPort({
        candidate: {
          targetId: 'port_nested_guard',
          pid: 43210,
          ppid: 1,
          command: 'node',
          port: 5173,
          hosts: ['127.0.0.1'],
          elapsedMs: 4 * 3_600_000,
          rssBytes: 64 * 1024 * 1024,
          worktreePath: wt,
          displayWorktreePath: '~/中文 工作树',
        },
        now: T0,
        activeSessionCwds: [],
        exec: async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '' }),
        killFn: killBlockedSpy,
      }),
    ).rejects.toThrow(/2-hour active window/);
    expect(killBlockedSpy).not.toHaveBeenCalled();

    // 3. 多跳 DSH 任务子孙进程保护（sh -> npm -> next-server (v15.2.0)）
    await setMtime(deepFile, eightDaysAgo);
    const multiHopPs = [
      ' 7000 1 05:00:00 4096 S /bin/sh',
      ' 7001 7000 05:00:00 32768 S /usr/local/bin/npm',
      ' 7002 7001 05:00:00 262144 S next-server (v15.2.0)',
      ' 7003 1 05:00:00 262144 S next-server (v15.2.0)',
    ].join('\n');
    const multiHopLsof = ['p7002', 'cnext-serv', 'n127.0.0.1:3000', 'p7003', 'cnext-serv', 'n127.0.0.1:3001'].join(
      '\n',
    );
    const multiHopReport = await inspectOrphanRuntime({
      now: T0,
      discovery: discIdle,
      protectedPids: new Set([7000]), // 仅顶层 DSH job sh (7000) 在受保护集合，孙进程 7002 必须沿 ppid 链受保护！
      orphanDshJobCount: 0,
      exec: async (bin, args) => {
        if (bin === 'ps') return { ok: true, exitCode: 0, stdout: multiHopPs, stderr: '' };
        if (bin === 'lsof' && args.includes('-iTCP')) {
          return { ok: true, exitCode: 0, stdout: multiHopLsof, stderr: '' };
        }
        return {
          ok: true,
          exitCode: 0,
          stdout: `p7002\nn${wt}\np7003\nn${wt}\n`,
          stderr: '',
        };
      },
    });
    expect(multiHopReport.orphanPorts.map((p) => p.pid)).toEqual([7003]);
    expect(multiHopReport.orphanPorts[0]?.command).toBe('next-server');

    // 4. 冲突静置时间取 Math.min(seq.ageMs, effectiveIdleMs)：72h 老工作树上刚发生 2.5h 的 REVERT_HEAD 冲突应为 2.5h uncomfortable 而非 72h critical
    const gitDir = join(wt, '.git');
    await mkdir(gitDir, { recursive: true });
    const revertHead = join(gitDir, 'REVERT_HEAD');
    await writeFile(revertHead, 'deadbeef\n');
    await setMtime(gitDir, T0 - 72 * 3_600_000);
    await setMtime(revertHead, T0 - 2.5 * 3_600_000);

    const discConflict: DiscoveryReport = {
      scannedAt: T0,
      repos: [],
      worktrees: [
        {
          path: wt,
          displayPath: '~/中文 工作树',
          name: '中文 工作树',
          kind: 'git-worktree',
          worktreeGitDir: gitDir,
          isMainWorktree: true,
          detached: false,
          locked: false,
          latestActivityAt: T0 - 72 * 3_600_000,
          idleMs: 72 * 3_600_000,
          activeExempt: false,
          activeSessionIds: [],
        },
      ],
    };
    const hygieneReport = await inspectRepoHygiene({
      now: T0,
      homeDir: fakeHome,
      discovery: discConflict,
      exec: async () => ({ ok: true, exitCode: 0, stdout: '## main\nUU src/a.ts\n', stderr: '' }),
    });
    expect(hygieneReport.conflictWorktrees).toHaveLength(1);
    expect(hygieneReport.conflictWorktrees[0]?.conflictIdleMs).toBeLessThan(3 * 3_600_000);
    const conflictEval = evaluateCareDrives({ discovery: discConflict, hygiene: hygieneReport });
    expect(conflictEval.find((d) => d.key === 'repo_hygiene')?.satisfaction).toBeGreaterThanOrEqual(25);
  });

  it('Python .venv 严格生态校验（要求 pyvenv.cfg + 父级 Python 清单，不向下递归嵌套 dist）与真实外部存活进程/忽略文件删除保护', {
    timeout: 25_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'asi-care-venv-proc-'));
    tempDirs.push(root);
    const realRoot = await realpath(root);
    const fakeHome = join(realRoot, 'home');

    // 1. 验证 .venv 扫描规则：
    // - validPy: 具备 pyproject.toml + .venv/pyvenv.cfg + 内部嵌套 site-packages/pkg/dist（绝不重复递归命中内层 dist）
    // - missingCfgPy: 具备 requirements.txt 但 .venv 内无 pyvenv.cfg（拒绝误判，且不向下递归）
    // - missingManifestPy: .venv 内有 pyvenv.cfg 但父目录无任何 Python 清单（拒绝误判）
    // - plainVenvPy: 目录名为 venv（保持 SKIP_DESCENT_DIRS 跳过）
    const validPy = join(fakeHome, 'py-valid');
    const missingCfgPy = join(fakeHome, 'py-no-cfg');
    const missingManifestPy = join(fakeHome, 'py-no-manifest');
    const plainVenvPy = join(fakeHome, 'py-plain-venv');

    await mkdir(join(validPy, '.venv', 'lib', 'site-packages', 'pkg', 'dist'), { recursive: true });
    await mkdir(join(validPy, '.venv', 'lib', 'site-packages', 'pkg', 'src'), { recursive: true });
    await writeFile(join(validPy, 'pyproject.toml'), '[project]\nname = "demo"\n');
    await writeFile(join(validPy, '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n');
    await writeFile(join(validPy, '.venv', 'lib', 'site-packages', 'pkg', 'package.json'), '{"name":"pkg"}');
    await writeFile(join(validPy, '.venv', 'lib', 'site-packages', 'pkg', 'tsconfig.json'), '{}');
    const venvWheel = join(validPy, '.venv', 'lib', 'site-packages', 'pkg', 'dist', 'wheel.bin');
    await writeFile(venvWheel, Buffer.alloc(16_384));

    await mkdir(join(missingCfgPy, '.venv', 'nested', 'node_modules', 'x'), { recursive: true });
    await writeFile(join(missingCfgPy, 'requirements.txt'), 'fastapi\n');
    await writeFile(join(missingCfgPy, '.venv', 'nested', 'package.json'), '{"name":"nested"}');
    await writeFile(join(missingCfgPy, '.venv', 'nested', 'node_modules', 'x', 'a.js'), '1');

    await mkdir(join(missingManifestPy, '.venv'), { recursive: true });
    await writeFile(join(missingManifestPy, '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n');

    await mkdir(join(plainVenvPy, 'venv'), { recursive: true });
    await writeFile(join(plainVenvPy, 'Pipfile'), '[[source]]\n');
    await writeFile(join(plainVenvPy, 'venv', 'pyvenv.cfg'), 'home = /usr/bin\n');

    const eightDaysAgo = T0 - (ARTIFACT_IDLE_THRESHOLD_MS + 86_400_000);
    const touchOld = async (dir: string) => {
      await setMtime(dir, eightDaysAgo);
    };
    for (const p of [
      venvWheel,
      join(validPy, '.venv', 'lib', 'site-packages', 'pkg', 'dist'),
      join(validPy, '.venv', 'lib', 'site-packages', 'pkg', 'src'),
      join(validPy, '.venv', 'lib', 'site-packages', 'pkg', 'package.json'),
      join(validPy, '.venv', 'lib', 'site-packages', 'pkg', 'tsconfig.json'),
      join(validPy, '.venv', 'lib', 'site-packages', 'pkg'),
      join(validPy, '.venv', 'lib', 'site-packages'),
      join(validPy, '.venv', 'lib'),
      join(validPy, '.venv', 'pyvenv.cfg'),
      join(validPy, '.venv'),
      join(validPy, 'pyproject.toml'),
      validPy,
      missingCfgPy,
      missingManifestPy,
      plainVenvPy,
    ]) {
      await touchOld(p);
    }

    const pyDiscovery: DiscoveryReport = {
      scannedAt: T0,
      repos: [],
      worktrees: [validPy, missingCfgPy, missingManifestPy, plainVenvPy].map((p, idx) => ({
        path: p,
        displayPath: `~/py-${idx}`,
        name: `py-${idx}`,
        kind: 'git-worktree' as const,
        isMainWorktree: true,
        detached: false,
        locked: false,
        latestActivityAt: eightDaysAgo,
        idleMs: T0 - eightDaysAgo,
        activeExempt: false,
        activeSessionIds: [],
      })),
    };

    const pyBloat = await scanWorkspaceArtifacts({
      now: T0,
      homeDir: fakeHome,
      discovery: pyDiscovery,
    });
    expect(pyBloat.idleArtifacts).toHaveLength(1);
    expect(pyBloat.idleArtifacts[0]?.dirName).toBe('.venv');
    expect(pyBloat.idleArtifacts[0]?.ecosystem).toBe('python-venv');
    expect(pyBloat.idleArtifacts[0]?.artifactPath).toBe(join(validPy, '.venv'));

    const venvCandidate = pyBloat.idleArtifacts[0];
    if (!venvCandidate) throw new Error('missing venvCandidate');

    // 2. 启动真实外部子进程（cwd 位于 validPy，模拟运行 >2h 未改源码的本地服务或外部终端 shell cwd）：
    //    cleanApprovedWorkspaceArtifact 及 checkDirectoryProcessHolders 必须 fail-closed 拒绝删除！
    const shellHolder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); console.log("ready");'], {
      cwd: validPy,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    try {
      await new Promise<void>((resReady, rejReady) => {
        shellHolder.stdout?.once('data', () => resReady());
        shellHolder.once('error', rejReady);
      });

      const holderCheck = await checkDirectoryProcessHolders({
        targetPaths: [validPy],
        exec: defaultCareExec,
      });
      expect(holderCheck.state).toBe('held');
      expect(holderCheck.holderPid).toBe(shellHolder.pid);

      // 模拟软链/大小写折叠前缀路径：即使 lsof 返回未解析软链路径，也能经 realpath 复核精准捕获！
      const aliasLink = join(fakeHome, 'Py-Valid');
      const { symlink } = await import('node:fs/promises');
      await symlink(validPy, aliasLink);
      const aliasHolderCheck = await checkDirectoryProcessHolders({
        targetPaths: [validPy],
        exec: async (bin) => {
          if (bin === 'ps') {
            return { ok: true, exitCode: 0, stdout: ` ${shellHolder.pid} 1 00:05:00 10240 S node\n`, stderr: '' };
          }
          return { ok: true, exitCode: 0, stdout: `p${shellHolder.pid}\nn${aliasLink}\n`, stderr: '' };
        },
      });
      expect(aliasHolderCheck.state).toBe('held');
      expect(aliasHolderCheck.holderPid).toBe(shellHolder.pid);

      await expect(
        cleanApprovedWorkspaceArtifact({
          candidate: venvCandidate,
          now: T0,
          homeDir: fakeHome,
          activeSessionCwds: [],
          exec: defaultCareExec,
        }),
      ).rejects.toThrow(/live external process/);
      expect((await stat(join(validPy, '.venv'))).isDirectory()).toBe(true);

      // lsof/ps 不可用（ENOENT）时也必须 fail-closed 拒绝删除
      await expect(
        cleanApprovedWorkspaceArtifact({
          candidate: venvCandidate,
          now: T0,
          homeDir: fakeHome,
          activeSessionCwds: [],
          exec: async () => ({ ok: false, exitCode: null, stdout: '', stderr: 'missing', errorCode: 'ENOENT' }),
        }),
      ).rejects.toThrow(/fail-closed/);
    } finally {
      const exited = new Promise<void>((r) => shellHolder.once('exit', () => r()));
      shellHolder.kill('SIGTERM');
      await exited;
    }

    // 外部占用进程退出后，清理 .venv 顺利完成！
    const venvCleaned = await cleanApprovedWorkspaceArtifact({
      candidate: venvCandidate,
      now: T0,
      homeDir: fakeHome,
      activeSessionCwds: [],
      exec: defaultCareExec,
    });
    expect(venvCleaned.freedBytes).toBeGreaterThanOrEqual(16_384);
    await expect(stat(join(validPy, '.venv'))).rejects.toThrow();

    // 3. 验证 Git 链接工作树含 .gitignore 忽略文件（.env / config/.env / node_modules）或外部进程占用时的保护：
    const mainRepo = join(fakeHome, 'git-main');
    const wtEnv = join(fakeHome, 'git-wt-env');
    const wtNestedEnv = join(fakeHome, 'git-wt-nested-env');
    const wtClean = join(fakeHome, 'git-wt-clean');
    await mkdir(mainRepo, { recursive: true });
    const initRes = await defaultCareExec('git', ['init', '-b', 'main'], { cwd: mainRepo });
    expect(initRes.ok, initRes.stderr).toBe(true);
    await writeFile(join(mainRepo, '.gitignore'), '.env*\nnode_modules/\n');
    await writeFile(join(mainRepo, 'index.ts'), 'export const v = 1;\n');
    await defaultCareExec('git', ['add', '.'], { cwd: mainRepo });
    const commitRes = await defaultCareExec(
      'git',
      ['-c', 'user.name=asi-fixture', '-c', 'user.email=fixture-noreply', 'commit', '-m', 'init'],
      { cwd: mainRepo },
    );
    expect(commitRes.ok, commitRes.stderr).toBe(true);

    for (const [wtPath, branch] of [
      [wtEnv, 'feat/with-env'],
      [wtNestedEnv, 'feat/with-nested-env'],
      [wtClean, 'feat/truly-clean'],
    ] as const) {
      const addRes = await defaultCareExec('git', ['-C', mainRepo, 'worktree', 'add', '-b', branch, wtPath, 'main']);
      expect(addRes.ok, addRes.stderr).toBe(true);
    }

    // wtEnv 含顶层被忽略的 .env.local；wtNestedEnv 含未跟踪子目录下唯一被忽略的 config/.env
    await writeFile(join(wtEnv, '.env.local'), 'PORT=3000\n');
    await mkdir(join(wtNestedEnv, 'config'), { recursive: true });
    await writeFile(join(wtNestedEnv, 'config', '.env'), 'MODE=dev\n');

    const fourDaysAgo = Date.now() - (MERGED_WORKTREE_IDLE_MS + 86_400_000);
    for (const wtPath of [wtEnv, wtNestedEnv, wtClean]) {
      const gd = (
        await defaultCareExec('git', ['-C', wtPath, 'rev-parse', '--absolute-git-dir'], { readOnlyGit: true })
      ).stdout.trim();
      await setTreeMtime(wtPath, fourDaysAgo);
      if (gd) await setTreeMtime(gd, fourDaysAgo);
    }

    const nowCheck = Date.now();
    const discGit = await discoverWorkspacesAndWorktrees({
      now: nowCheck,
      homeDir: fakeHome,
      workspacePaths: [mainRepo],
      sessions: [],
      exec: defaultCareExec,
    });
    const hygieneGit = await inspectRepoHygiene({
      now: nowCheck,
      homeDir: fakeHome,
      discovery: discGit,
      exec: defaultCareExec,
    });

    // 含 .env.local 或 config/.env 的已合入工作树绝不被提议移除；仅真正干净的 wtClean 进入候选！
    expect(hygieneGit.cleanMergedWorktrees.map((c) => c.worktreePath)).toEqual([wtClean]);

    const cleanCand = hygieneGit.cleanMergedWorktrees[0];
    if (!cleanCand) throw new Error('missing cleanCand');

    // 若用户在点击批准前于 wtClean 写入了被忽略的 .env，或有外部存活进程 cwd 占用 wtClean -> 均必须 fail-closed 拒绝移除！
    const suddenEnv = join(wtClean, '.env');
    await writeFile(suddenEnv, 'FLAG=1\n');
    await setMtime(suddenEnv, fourDaysAgo);
    await setMtime(wtClean, fourDaysAgo);
    await expect(
      removeApprovedMergedWorktree({
        candidate: cleanCand,
        now: nowCheck,
        activeSessionCwds: [],
        exec: defaultCareExec,
      }),
    ).rejects.toThrow(/ignored \.env/);
    await rm(suddenEnv);
    await setMtime(wtClean, fourDaysAgo);

    const wtHolder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); console.log("ok");'], {
      cwd: wtClean,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    try {
      await new Promise<void>((r, rej) => {
        wtHolder.stdout?.once('data', () => r());
        wtHolder.once('error', rej);
      });
      await expect(
        removeApprovedMergedWorktree({
          candidate: cleanCand,
          now: nowCheck,
          activeSessionCwds: [],
          exec: defaultCareExec,
        }),
      ).rejects.toThrow(/live external process/);
    } finally {
      const done = new Promise<void>((r) => wtHolder.once('exit', () => r()));
      wtHolder.kill('SIGTERM');
      await done;
    }

    // 排除占用后，真实 git worktree remove（无 --force）干净移除 wtClean！
    const removedWt = await removeApprovedMergedWorktree({
      candidate: cleanCand,
      now: nowCheck,
      activeSessionCwds: [],
      exec: defaultCareExec,
    });
    expect(removedWt.removed).toBe(true);
    await expect(stat(wtClean)).rejects.toThrow();

    // 4. 验证无 .gitmodules 的嵌套 gitlink 子模块 (160000) 及 --skip-worktree 本地隐藏改动的工作树绝不被提议或误删！
    const wtSkip = join(fakeHome, 'git-wt-skip-worktree');
    const wtGitlink = join(fakeHome, 'git-wt-gitlink');
    await defaultCareExec('git', ['-C', mainRepo, 'worktree', 'add', '-b', 'feat/skip-wt', wtSkip, 'main']);
    await defaultCareExec('git', ['update-index', '--skip-worktree', 'index.ts'], { cwd: wtSkip });
    await writeFile(join(wtSkip, 'index.ts'), 'export const v = 999; // hidden local edit\n');

    const headSha = (
      await defaultCareExec('git', ['-C', mainRepo, 'rev-parse', 'HEAD'], { readOnlyGit: true })
    ).stdout.trim();
    await defaultCareExec('git', ['-C', mainRepo, 'worktree', 'add', '-b', 'feat/gitlink-wt', wtGitlink, 'main']);
    await defaultCareExec('git', ['update-index', '--add', '--cacheinfo', `160000,${headSha},vendor/sub`], {
      cwd: wtGitlink,
    });
    await mkdir(join(wtGitlink, 'vendor', 'sub'), { recursive: true });
    await defaultCareExec(
      'git',
      ['-c', 'user.name=asi-fixture', '-c', 'user.email=fixture-noreply', 'commit', '-m', 'add gitlink'],
      { cwd: wtGitlink },
    );
    await defaultCareExec('git', ['-C', mainRepo, 'merge', '--ff-only', 'feat/gitlink-wt']);

    for (const wtPath of [wtSkip, wtGitlink]) {
      const gd = (
        await defaultCareExec('git', ['-C', wtPath, 'rev-parse', '--absolute-git-dir'], { readOnlyGit: true })
      ).stdout.trim();
      await setTreeMtime(wtPath, fourDaysAgo);
      if (gd) await setTreeMtime(gd, fourDaysAgo);
    }

    const discSpecial = await discoverWorkspacesAndWorktrees({
      now: nowCheck,
      homeDir: fakeHome,
      workspacePaths: [mainRepo],
      sessions: [],
      exec: defaultCareExec,
    });
    const hygieneSpecial = await inspectRepoHygiene({
      now: nowCheck,
      homeDir: fakeHome,
      discovery: discSpecial,
      exec: defaultCareExec,
    });
    expect(hygieneSpecial.cleanMergedWorktrees).toEqual([]);

    await expect(
      removeApprovedMergedWorktree({
        candidate: {
          targetId: 'wt_skip',
          worktreePath: wtSkip,
          displayWorktreePath: '~/git-wt-skip-worktree',
          mainWorktreePath: mainRepo,
          branch: 'feat/skip-wt',
          baseRef: 'refs/heads/main',
          idleMs: nowCheck - fourDaysAgo,
        },
        now: nowCheck,
        activeSessionCwds: [],
        exec: defaultCareExec,
      }),
    ).rejects.toThrow(/skip-worktree/);

    await expect(
      removeApprovedMergedWorktree({
        candidate: {
          targetId: 'wt_gitlink',
          worktreePath: wtGitlink,
          displayWorktreePath: '~/git-wt-gitlink',
          mainWorktreePath: mainRepo,
          branch: 'feat/gitlink-wt',
          baseRef: 'refs/heads/main',
          idleMs: nowCheck - fourDaysAgo,
        },
        now: nowCheck,
        activeSessionCwds: [],
        exec: defaultCareExec,
      }),
    ).rejects.toThrow(/submodule gitlinks/);
  });
});
