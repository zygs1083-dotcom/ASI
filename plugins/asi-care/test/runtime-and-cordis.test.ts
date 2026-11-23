import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AsiDrivesServiceApi, AsiDrivesSnapshot, DriveSourceRegistration } from '@asi/sense-types';
import { Context } from '@deepseek-ai/cordis';
import { type Agent, emitAgentEvent } from '@deepseek-ai/dsh-agent';
import { createScope } from '@deepseek-ai/dsh-scope';
import { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native';
import ToolsService, { defineTool } from '@deepseek-ai/dsh-tools';
import * as AsiNeedsPlugin from 'asi-needs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockSenseService, fact, makeSnapshot } from '../../asi-needs/test/fixtures.js';
import { ARTIFACT_IDLE_THRESHOLD_MS } from '../src/host/artifact-scanner.js';
import { defaultCareExec } from '../src/host/command.js';
import * as AsiCarePlugin from '../src/host/dsh/index.js';
import { MERGED_WORKTREE_IDLE_MS } from '../src/host/git-inspector.js';
import { createCareRuntime } from '../src/host/runtime.js';

const execFile = promisify(execFileCb);
const T0 = Date.now();
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
});

async function setMtime(path: string, mtimeMs: number): Promise<void> {
  const sec = mtimeMs / 1000;
  await utimes(path, sec, sec);
}

async function setTreeMtime(rootPath: string, mtimeMs: number): Promise<void> {
  const entries = await readdir(rootPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await setTreeMtime(full, mtimeMs);
    } else {
      await setMtime(full, mtimeMs);
    }
  }
  await setMtime(rootPath, mtimeMs);
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile('git', [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Bot',
      GIT_AUTHOR_EMAIL: 'bot@test.local',
      GIT_COMMITTER_NAME: 'Test Bot',
      GIT_COMMITTER_EMAIL: 'bot@test.local',
    },
  });
  return String(stdout);
}

describe('asi-care 端到端多工作树发现、三级自治护栏、零对话打断与 ctx.asiDrives 联动验证', () => {
  it('自动展开兄弟 worktree、豁免 2h 活跃工作树、沙盒执行一级零损收尾、侧栏一键批准二级清理记入收益账本、三级未提交/冲突严格只读且全程零 <asi-cry> 打扰', {
    timeout: 30_000,
  }, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'asi-care-e2e-'));
    tempDirs.push(rootDir);

    const fakeHome = join(rootDir, 'home');
    const secretsDir = join(fakeHome, '.secrets');
    const ignoredDir = join(fakeHome, 'ignored-repo');
    await mkdir(secretsDir, { recursive: true });
    await mkdir(ignoredDir, { recursive: true });
    await writeFile(join(secretsDir, 'token.txt'), 'secret');

    // 1. 创建真实 Git 主仓库 + 4 个兄弟工作树：
    // - wtMain: 当前活跃 DSH 会话所在工作树（享 2h 活跃豁免，即使有未提交文件也不扣分！）
    // - wtMerged: 分支已合入 main、干净且闲置 4 天 + 含陈旧 8 天 1.2 GiB node_modules + 陈旧无进程死锁 index.lock
    // - wtPrunable: 创建后直接 rm -rf 目录，留下悬空 git worktree 元数据（测试一级无人值守 prune）
    // - wtDirtyConflict: 含 >30h 未提交改动与 >5h MERGE_HEAD 冲突残留（测试三级只读提示，绝不修改工作区文件）
    const wtMain = join(fakeHome, 'work', 'app-main');
    const wtMerged = join(fakeHome, 'work', 'app-wt-merged');
    const wtPrunable = join(fakeHome, 'work', 'app-wt-prunable');
    const wtDirtyConflict = join(fakeHome, 'work', 'app-wt-conflict');
    await mkdir(wtMain, { recursive: true });

    await runGit(wtMain, ['init', '-b', 'main']);
    await writeFile(join(wtMain, '.gitignore'), 'node_modules/\n');
    await writeFile(join(wtMain, 'package.json'), '{"name":"demo-app"}');
    await writeFile(join(wtMain, 'README.md'), `# Demo\nghp_${'x'.repeat(36)}\n`);
    await runGit(wtMain, ['add', '.']);
    await runGit(wtMain, ['commit', '-m', 'init main']);

    await runGit(wtMain, ['worktree', 'add', '-b', 'feat/merged', wtMerged, 'main']);
    await writeFile(join(wtMerged, 'merged.txt'), 'done\n');
    await runGit(wtMerged, ['add', 'merged.txt']);
    await runGit(wtMerged, ['commit', '-m', 'feat merged']);
    await runGit(wtMain, ['merge', '--no-ff', 'feat/merged', '-m', 'merge feat/merged']);

    await runGit(wtMain, ['worktree', 'add', '-b', 'feat/prunable', wtPrunable, 'main']);
    await rm(wtPrunable, { recursive: true, force: true }); // 制造悬空 prunable worktree

    await runGit(wtMain, ['worktree', 'add', '-b', 'feat/conflict', wtDirtyConflict, 'main']);
    const preciousDirtyFile = join(wtDirtyConflict, 'user-precious-wip.ts');
    const preciousContent = 'export const wip = "DO NOT STASH OR RESET ME";\n';
    await writeFile(preciousDirtyFile, preciousContent);

    // 在 wtMain 放入未提交文件，但 wtMain 有活跃 DSH 会话 -> 必须享受 2h 活跃豁免！
    await writeFile(join(wtMain, 'active-edit.ts'), 'export const live = 1;\n');

    // 在 wtMerged 放入陈旧死锁 index.lock（位于 .git/worktrees/app-wt-merged/index.lock）+ 1.2 GiB 闲置 node_modules
    const wtMergedGitDir = (await runGit(wtMerged, ['rev-parse', '--git-dir'])).trim();
    const deadLockPath = join(wtMergedGitDir, 'index.lock');
    await writeFile(deadLockPath, '');

    await mkdir(join(wtMerged, 'node_modules', 'heavy-pkg'), { recursive: true });
    const bloatedBin = join(wtMerged, 'node_modules', 'heavy-pkg', 'cache.bin');
    await writeFile(bloatedBin, '');
    await truncate(bloatedBin, Math.round(1.2 * 1024 ** 3));

    // 在 wtDirtyConflict 的 gitdir 放入陈旧 MERGE_HEAD 模拟 >5h 冲突残留
    const wtConflictGitDir = (await runGit(wtDirtyConflict, ['rev-parse', '--git-dir'])).trim();
    const mergeHeadPath = join(wtConflictGitDir, 'MERGE_HEAD');
    await writeFile(mergeHeadPath, '1111111111111111111111111111111111111111\n');

    // 设置各工作树文件历史时间戳（超过各自闲置阈值）
    const fourDaysAgo = T0 - (MERGED_WORKTREE_IDLE_MS + 86_400_000);
    const eightDaysAgo = T0 - (ARTIFACT_IDLE_THRESHOLD_MS + 86_400_000);
    const thirtyHoursAgo = T0 - 30 * 3_600_000;
    const fiveHoursAgo = T0 - 5 * 3_600_000;

    await setTreeMtime(wtMerged, fourDaysAgo);
    await setTreeMtime(wtMergedGitDir, fourDaysAgo);
    await setTreeMtime(join(wtMerged, 'node_modules'), eightDaysAgo);

    await setTreeMtime(wtDirtyConflict, thirtyHoursAgo);
    await setTreeMtime(wtConflictGitDir, thirtyHoursAgo);
    await setMtime(mergeHeadPath, fiveHoursAgo);

    // 2. 组装完整 Cordis 容器（asi-sense + asi-needs + asi-care runtime）
    const root = new Context();
    await root.plugin(SystemPrompt);
    await root.plugin(ToolsService);
    root.tools.setExecutor(new NativeToolExecutor(root));
    root.tools.register(
      defineTool({
        name: 'shell',
        description: 'dangerous shell',
        parameters: {},
        output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        async execute() {
          return { ok: true };
        },
      }),
    );

    const agentsList: Agent[] = [];
    const cryCalls: string[] = [];
    let l1OrphanJobAlive = true;
    let careOrphanJobAlive = true;
    let orphanPortAlive = true;
    const killSignals: { pid: number; sig: string | number }[] = [];

    // 普通活跃用户会话位于 wtMain（验证零配置会话发现 + 兄弟工作树自动展开 + 2h 活跃豁免）
    const userAgent = {
      id: SessionId('user-main-session'),
      status: 'thinking' as const,
      session: { header: { cwd: wtMain } },
      followup: (msg: { content: { text: string }[] }) => {
        cryCalls.push(msg.content[0]?.text ?? '');
      },
      send: (msg: { content: { text: string }[] }) => {
        cryCalls.push(msg.content[0]?.text ?? '');
      },
    } as unknown as Agent & { ctx: Context };
    userAgent.ctx = createScope(root, userAgent).ctx;
    agentsList.push(userAgent);

    root.provide('agents', {
      list: () => agentsList,
      get: (id: string) => agentsList.find((a) => a.id === id),
    });
    root.provide('jobs', {
      list: () =>
        l1OrphanJobAlive
          ? [
              {
                id: 'job-l1-stuck-1',
                owner: SessionId('deleted-ghost-session'),
                label: 'stuck-l1-build',
                status: 'running',
                startedAt: T0 - 4 * 3_600_000,
              },
            ]
          : [],
      kill: (id: string) => {
        if (id === 'job-l1-stuck-1' && l1OrphanJobAlive) {
          l1OrphanJobAlive = false;
          return 'requested';
        }
        return 'already-finished';
      },
      events: { subscribe: () => () => {} },
    });
    root.provide('llm', {
      listConfigurableProviders: () => [],
      resolveModelInfo: async () => undefined,
    });
    root.provide('sessionProjections', { snapshot: () => ({ values: {} }) });
    root.provide('sessions', {
      list: () => [{ id: SessionId('user-main-session'), header: { cwd: wtMain } }],
    });
    root.provide('workspaceRegistry', {
      archivedSessionIds: [],
      list: () => [{ id: 'ws-ignored', path: ignoredDir, sessionIds: [] }],
      create: async (p: string, title?: string) => ({ id: `ws-${title}`, path: p, sessionIds: [] }),
    });
    root.provide('tokenMeter', { contextPressure: () => ({}) });
    root.provide('profileContext', {
      name: 'fixture',
      dir: rootDir,
      patchPath: '',
      installAnchor: '',
      cwd: '',
      home: fakeHome,
      startedBundles: [],
      overlays: [],
      telemetryDisabledEnv: undefined,
    });

    let maintAgentRef: (Agent & { ctx: Context }) | undefined;
    root.provide('sessionController', {
      create: async (req: { cwd?: string; sessionId?: string }) => {
        const sid = req.sessionId ?? 'maint-care-1';
        const maintAgent = {
          id: SessionId(sid),
          status: 'idle' as const,
          session: { header: { cwd: req.cwd ?? '' } },
          followup: () => {},
          send: () => {},
          cancel: () => {},
          whenIdle: async () => {},
        } as unknown as Agent & { ctx: Context };
        maintAgent.ctx = createScope(root, maintAgent).ctx;
        maintAgentRef = maintAgent;
        agentsList.push(maintAgent);
        emitAgentEvent(root, maintAgent, 'agent/created', { source: 'startup' });
        return { sessionId: SessionId(sid) };
      },
      rename: async () => ({ title: 'ASI 自维护', seq: 1 }),
      resolveAgent: async (sid: string) => {
        const found = agentsList.find((a) => a.id === sid);
        return found ? { agent: found } : { error: new Error('not found') };
      },
    });

    const calmSnap = makeSnapshot({ now: T0, mono: 10_000 });
    calmSnap.state.self.body.disks = {
      kind: 'disks',
      ...fact([{ mount: '/', total: 500 * 1024 ** 3, free: 200 * 1024 ** 3 }], { observedAt: T0 - 1_000 }),
    };
    calmSnap.state.self.body.network = fact({ online: true, rxBps: 1_000, txBps: 500 }, { observedAt: T0 - 1_000 });
    calmSnap.state.self.body.battery = fact(null, { observedAt: T0 - 1_000 });
    calmSnap.state.self.body.memory = fact(
      { total: 32 * 1024 ** 3, used: 12 * 1024 ** 3, pressure: 'normal', swapUsed: 0 },
      { observedAt: T0 - 1_000 },
    );
    calmSnap.state.self.body.thermal = fact('nominal', { observedAt: T0 - 1_000 });
    calmSnap.state.self.body.cpu = fact(
      { usage: 0.15, perCore: [0.15], load1: 1, load5: 1, load15: 1 },
      { observedAt: T0 - 1_000 },
    );
    const mockSense = createMockSenseService(calmSnap, join(rootDir, 'sense-data'));
    root.provide('asiSense', mockSense);

    const needsFork = await root.plugin(AsiNeedsPlugin, {
      storageRoot: join(rootDir, 'needs-data'),
    });

    // 注入真实 git 执行 + 可控 lsof/ps（使锁文件验证零占用且模拟 wtMerged 下 1 个运行 4h 的孤儿 vite 端口 5173）
    const hybridExec: typeof defaultCareExec = async (bin, args, opts) => {
      if (bin === 'git') {
        return await defaultCareExec('git', args, opts);
      }
      if (bin === 'ps') {
        return {
          ok: true,
          exitCode: 0,
          stdout: orphanPortAlive ? ' 34567 1 04:20:00 262144 S /opt/homebrew/bin/node\n' : '',
          stderr: '',
        };
      }
      if (bin === 'lsof') {
        if (args.includes('--')) {
          // 零进程持有死锁文件
          return { ok: false, exitCode: 1, stdout: '', stderr: '' };
        }
        if (args.includes('-iTCP')) {
          return {
            ok: true,
            exitCode: 0,
            stdout: orphanPortAlive ? 'p34567\ncnode\nn127.0.0.1:5173\n' : '',
            stderr: '',
          };
        }
        if (args.includes('cwd')) {
          return {
            ok: true,
            exitCode: 0,
            stdout: orphanPortAlive ? `p34567\nn${wtMerged}\n` : '',
            stderr: '',
          };
        }
      }
      return { ok: false, exitCode: 1, stdout: '', stderr: '' };
    };

    const carePorts = AsiCarePlugin.name
      ? {
          storageRoot: join(rootDir, 'care-data'),
          homeDir: fakeHome,
          sense: root.asiSense,
          drives: root.asiDrives,
          listWorkspacePaths: () => [ignoredDir],
          listSessions: () => [{ id: 'user-main-session', cwd: wtMain, active: true }],
          listInternalRoots: () => [join(rootDir, 'sense-data'), join(rootDir, 'needs-data')],
          jobs: {
            listOrphanJobs: () =>
              careOrphanJobAlive
                ? [{ id: 'job-care-orphan-1', owner: 'deleted-care-session', startedAt: T0 - 3 * 3_600_000 }]
                : [],
            listProtectedJobPids: () => [],
            killOrphanJob: () => {
              careOrphanJobAlive = false;
              return 'requested' as const;
            },
          },
          exec: hybridExec,
          killProcess: (pid: number, sig: NodeJS.Signals | 0) => {
            killSignals.push({ pid, sig });
            orphanPortAlive = false;
          },
          clock: { wall: () => T0, mono: () => 10_000 },
        }
      : undefined;
    if (!carePorts) throw new Error('missing carePorts');

    const careRuntime = createCareRuntime(carePorts, {
      ignorePaths: ['~/ignored-repo'],
    });
    const offCareTool = root.tools.register(
      (await import('../src/host/dsh/tools.js')).createCareStatusTool(careRuntime),
    );

    await careRuntime.start();
    await careRuntime.runSlowProbe();

    try {
      // A. 验证工具隔离：普通用户对话仅见只读 care_status，绝不见任何 care_* 沙盒工具
      emitAgentEvent(root, userAgent, 'agent/created', { source: 'startup' });
      const userToolNames = root.tools.definitions(userAgent).map((d) => d.name);
      expect(userToolNames).toContain('care_status');
      expect(userToolNames).not.toContain('care_sniff_workspaces');
      expect(userToolNames).not.toContain('care_prune_worktrees');
      expect(userToolNames).not.toContain('care_clean_git_locks');
      expect(userToolNames).not.toContain('care_stop_orphan_jobs');
      expect(userToolNames).not.toContain('care_request_help');

      // 调用只读 care_status：发现 3 个现有兄弟工作树（排除 ignored-repo 与 .secrets），wtMain 享 activeExempt
      const careStatusExec = root.tools.executable('care_status', userAgent);
      expect(careStatusExec).toBeDefined();
      const statusOut = (await careStatusExec?.execute({ aspect: 'all' }, {
        agent: userAgent,
        signal: new AbortController().signal,
        callId: 'c-care-1' as never,
      } as never)) as {
        discovery: {
          worktreeCount: number;
          activeExemptCount: number;
          worktrees: { displayPath: string; activeExempt: boolean }[];
        };
        drives: { key: string; zone: string }[];
      };
      expect(statusOut.discovery.worktreeCount).toBe(3);
      expect(statusOut.discovery.activeExemptCount).toBe(1);
      expect(statusOut.discovery.worktrees.find((w) => w.displayPath === '~/work/app-main')?.activeExempt).toBe(true);
      expect(JSON.stringify(statusOut)).not.toContain('.secrets');
      expect(JSON.stringify(statusOut)).not.toContain('ignored-repo');

      // 三条正交 L3 驱动全部注册且均进入 uncomfortable（因当前存在 L1 无主卡死任务，初始被马斯洛 L1 压制挂起！）
      const initialDrivesSnap = root.asiDrives.snapshot();
      expect(initialDrivesSnap.higherOrderSuppressed).toBe(true);
      const l3Drives = initialDrivesSnap.drives.filter((d) => d.sourceId === 'asi-care');
      expect(l3Drives.map((d) => d.key)).toEqual([
        'asi-care:repo_hygiene',
        'asi-care:orphan_runtime',
        'asi-care:workspace_bloat',
      ]);
      expect(l3Drives.every((d) => d.tier === 3 && d.zone === 'uncomfortable' && d.suppressed)).toBe(true);

      // B. 先在后台自维护会话中由 L1 needs_stop_job 解除生理层卡死任务 -> L3 自动即时解除压制并同步挂出静默求助卡！
      await vi.waitFor(() => {
        expect(maintAgentRef).toBeDefined();
      });
      if (!maintAgentRef) throw new Error('missing maintAgentRef');

      const l1StopTool = root.tools.executable('needs_stop_job', maintAgentRef);
      await l1StopTool?.execute({}, {
        agent: maintAgentRef,
        signal: new AbortController().signal,
        callId: 'call-l1-stop' as never,
      } as never);
      expect(l1OrphanJobAlive).toBe(false);
      expect(root.asiDrives.snapshot().higherOrderSuppressed).toBe(false);
      await vi.waitFor(
        async () => {
          const snapCheck = (await root.tools.executable('needs_status', userAgent)?.execute({}, {
            agent: userAgent,
            signal: new AbortController().signal,
            callId: 'c-wait' as never,
          } as never)) as { helpCards: { status: string; driveKey?: string }[] };
          expect(
            snapCheck.helpCards.filter((c) => c.status === 'open' && c.driveKey?.startsWith('asi-care:')).length,
          ).toBeGreaterThanOrEqual(3);
        },
        { timeout: 5_000 },
      );

      const maintToolNames = root.tools.definitions(maintAgentRef).map((d) => d.name);
      expect(maintToolNames).toContain('care_status');
      expect(maintToolNames).toContain('care_prune_worktrees');
      expect(maintToolNames).toContain('care_clean_git_locks');
      expect(maintToolNames).toContain('care_stop_orphan_jobs');

      for (const toolName of ['care_prune_worktrees', 'care_clean_git_locks', 'care_stop_orphan_jobs']) {
        const t = root.tools.executable(toolName, maintAgentRef);
        expect(t).toBeDefined();
        await t?.execute({}, {
          agent: maintAgentRef,
          signal: new AbortController().signal,
          callId: `call-${toolName}` as never,
        } as never);
      }

      // 悬空 worktree 元数据已 prune、死锁 index.lock 已移除、孤儿 DSH 任务已停止！
      await expect(stat(deadLockPath)).rejects.toThrow();
      expect(careOrphanJobAlive).toBe(false);
      const postPruneList = await runGit(wtMain, ['worktree', 'list', '--porcelain']);
      expect(postPruneList).not.toContain('app-wt-prunable');

      // C. 二级受控动作必须由用户在侧栏求助卡一键批准，且自动计入 ActionOutcomeLedger！
      const remoteNeeds = root.get('asiNeeds') as {
        approveHelp(cardId: string): Promise<void>;
      };
      expect(remoteNeeds).toBeDefined();

      const needsStatusTool = root.tools.executable('needs_status', userAgent);
      const readNeedsSnap = async () =>
        (await needsStatusTool?.execute({}, {
          agent: userAgent,
          signal: new AbortController().signal,
          callId: 'c-ns' as never,
        } as never)) as {
          helpCards: {
            id: string;
            driveKey?: string;
            actionKind: string;
            actionTarget?: string;
            approveLabel?: string;
            silent?: boolean;
            status: string;
          }[];
          actionLedger: {
            need: string;
            action: string;
            totalFreedBytes: number;
            totalStoppedJobs: number;
            effectiveCount: number;
          }[];
        };

      const beforeApprove = await readNeedsSnap();
      const openCareCards = beforeApprove.helpCards.filter(
        (c) => c.status === 'open' && c.driveKey?.startsWith('asi-care:'),
      );
      expect(openCareCards.length).toBeGreaterThanOrEqual(3);
      expect(openCareCards.every((c) => c.silent === true)).toBe(true);
      // 当 wtMerged 仍含被 .gitignore 忽略的 node_modules 时，严禁提前挂出必败的「批准移除闲置工作树」卡片！
      expect(
        openCareCards.some((c) => c.driveKey === 'asi-care:repo_hygiene' && c.actionKind === 'run-drive-action'),
      ).toBe(false);

      const bloatCard = openCareCards.find((c) => c.driveKey === 'asi-care:workspace_bloat');
      expect(bloatCard?.approveLabel).toBe('批准清理构建产物');
      if (!bloatCard) throw new Error('missing bloatCard');

      const portCard = openCareCards.find((c) => c.driveKey === 'asi-care:orphan_runtime');
      expect(portCard?.approveLabel).toBe('批准释放孤儿端口');
      if (!portCard) throw new Error('missing portCard');

      // 负向护栏验证 1：当孤儿服务 node (PID 34567) 仍以 cwd=wtMerged 存活运行时，拒绝删除其所在工作树的 node_modules！
      await expect(remoteNeeds.approveHelp(bloatCard.id)).rejects.toThrow(/live external process/);
      expect((await stat(join(wtMerged, 'node_modules'))).isDirectory()).toBe(true);

      // 1) 先批准释放孤儿开发端口 -> 发送 SIGTERM，orphan_runtime 立即恢复 comfortable 且记入账本！
      await remoteNeeds.approveHelp(portCard.id);
      expect(killSignals).toEqual([{ pid: 34567, sig: 'SIGTERM' }]);
      expect(root.asiDrives.snapshot().drives.find((d) => d.key === 'asi-care:orphan_runtime')?.zone).toBe(
        'comfortable',
      );

      // 2) 存活进程释放后批准清理 1.2 GiB 闲置构建产物 -> workspace_bloat 恢复 comfortable，且自动复核发现 wtMerged 现已完全干净并挂出工作树移除卡！
      await remoteNeeds.approveHelp(bloatCard.id);
      await expect(stat(join(wtMerged, 'node_modules'))).rejects.toThrow();
      expect(root.asiDrives.snapshot().drives.find((d) => d.key === 'asi-care:workspace_bloat')?.zone).toBe(
        'comfortable',
      );

      // 3) 负向护栏验证 2 + 正向批准移除已合入工作树：
      // 若在点击「批准移除闲置工作树」瞬间用户刚在 wtMerged 新建了未跟踪文件，必须拒绝删除！
      const afterBloatSnap = await readNeedsSnap();
      const wtCard = afterBloatSnap.helpCards.find(
        (c) => c.status === 'open' && c.driveKey === 'asi-care:repo_hygiene' && c.actionKind === 'run-drive-action',
      );
      expect(wtCard?.approveLabel).toBe('批准移除闲置工作树');
      if (!wtCard) throw new Error('missing wtCard');

      const lastMinuteUntracked = join(wtMerged, 'sudden-draft.txt');
      await writeFile(lastMinuteUntracked, 'wait!');
      await setMtime(lastMinuteUntracked, fourDaysAgo);
      await setMtime(wtMerged, fourDaysAgo);
      await expect(remoteNeeds.approveHelp(wtCard.id)).rejects.toThrow(/uncommitted files/);
      expect((await stat(wtMerged)).isDirectory()).toBe(true);

      // 移除临时草稿文件后再次点击批准：git worktree remove 成功移除 wtMerged！
      await rm(lastMinuteUntracked);
      await setMtime(wtMerged, fourDaysAgo);
      await remoteNeeds.approveHelp(wtCard.id);
      await expect(stat(wtMerged)).rejects.toThrow();

      // 验证 ActionOutcomeLedger 已准确记录 3 项 L3 批准动作收益
      const afterApprove = await readNeedsSnap();
      expect(
        afterApprove.actionLedger.some(
          (e) =>
            e.need === 'asi-care:workspace_bloat' &&
            e.action === 'clean-workspace-artifact:node_modules' &&
            e.totalFreedBytes > 1024 ** 3 &&
            e.effectiveCount === 1,
        ),
      ).toBe(true);
      expect(
        afterApprove.actionLedger.some(
          (e) =>
            e.need === 'asi-care:orphan_runtime' && e.action === 'stop-orphan-port:node' && e.totalStoppedJobs === 1,
        ),
      ).toBe(true);
      expect(
        afterApprove.actionLedger.some(
          (e) => e.need === 'asi-care:repo_hygiene' && e.action === 'remove-merged-worktree' && e.effectiveCount === 1,
        ),
      ).toBe(true);

      // D. 三级只读铁律验证：wtDirtyConflict 内的未提交改动与冲突残留文件逐字节完好无损！
      expect(await readFile(preciousDirtyFile, 'utf8')).toBe(preciousContent);
      expect((await stat(mergeHeadPath)).isFile()).toBe(true);

      // E. 马斯洛压制联动验证：进入 eco 模式后，L3 驱动与 care_* 沙盒工具立即挂起
      await mockSense.setPowerMode('eco', '测试节能挂起');
      mockSense.emit((s) => s);
      await vi.waitFor(() => {
        expect(root.asiDrives.snapshot().higherOrderSuppressed).toBe(true);
      });
      expect(
        root.asiDrives
          .snapshot()
          .drives.filter((d) => d.sourceId === 'asi-care')
          .every((d) => d.suppressed),
      ).toBe(true);
      const guardBlocked = root.tools.checkGuards({
        name: 'care_prune_worktrees',
        agent: maintAgentRef,
      } as never);
      expect(guardBlocked?.reason).toContain('高阶需求已挂起');

      // F. 全程零对话打断铁律：即使经历多轮 L3 不适、求助卡挂出与批准，前台用户会话收到的 <asi-cry> 严格为 0！
      expect(cryCalls).toHaveLength(0);
    } finally {
      offCareTool();
      await careRuntime.stop();
      await needsFork.dispose();
    }
  });

  it('真实挂载 AsiCarePlugin Cordis 插件：验证 Config 注入、workspaceRegistry 零配置发现与插件卸载清理', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'asi-care-plugin-mount-'));
    tempDirs.push(rootDir);
    const wsDir = join(rootDir, 'plain-ws');
    await mkdir(wsDir, { recursive: true });

    const root = new Context();
    await root.plugin(SystemPrompt);
    await root.plugin(ToolsService);
    root.tools.setExecutor(new NativeToolExecutor(root));

    const agentsList: Agent[] = [];
    root.provide('agents', { list: () => agentsList, get: (id: string) => agentsList.find((a) => a.id === id) });
    root.provide('jobs', { list: () => [], kill: () => 'already-finished', events: { subscribe: () => () => {} } });
    root.provide('llm', { listConfigurableProviders: () => [], resolveModelInfo: async () => undefined });
    root.provide('sessions', { list: () => [] });
    root.provide('workspaceRegistry', {
      archivedSessionIds: [],
      list: () => [{ id: 'ws-1', path: wsDir, sessionIds: [] }],
      create: async (p: string) => ({ id: 'ws-created', path: p, sessionIds: [] }),
    });
    root.provide('sessionController', {
      create: async () => ({ sessionId: SessionId('m1') }),
      rename: async () => ({ title: 'ASI 自维护', seq: 1 }),
      resolveAgent: async () => ({ error: new Error('none') }),
    });
    root.provide('asiSense', createMockSenseService(makeSnapshot({ now: T0 }), join(rootDir, 'sense')));

    const needsFork = await root.plugin(AsiNeedsPlugin, { storageRoot: join(rootDir, 'needs') });
    const careFork = await root.plugin(AsiCarePlugin, {
      storageRoot: join(rootDir, 'care'),
      fastIntervalMs: 60_000,
      slowIntervalMs: 300_000,
    });

    try {
      expect(root.asiDrives.snapshot().drives.filter((d) => d.sourceId === 'asi-care')).toHaveLength(3);
      const user = {
        id: SessionId('u1'),
        status: 'idle' as const,
      } as unknown as Agent & { ctx: Context };
      user.ctx = createScope(root, user).ctx;
      const tool = root.tools.executable('care_status', user);
      expect(tool).toBeDefined();
      const res = (await tool?.execute({ aspect: 'all' }, {
        agent: user,
        signal: new AbortController().signal,
        callId: 'c1' as never,
      } as never)) as { discovery: { worktreeCount: number } };
      expect(res.discovery.worktreeCount).toBe(1);
    } finally {
      await careFork.dispose();
      // 卸载 asi-care 后，其 L3 驱动与 care_status 工具全部从宿主干净移除
      expect(root.asiDrives.snapshot().drives.filter((d) => d.sourceId === 'asi-care')).toHaveLength(0);
      expect(root.tools.definitions().some((d) => d.name === 'care_status')).toBe(false);
      await needsFork.dispose();
    }
  });

  it('边界竞态与生命周期回归：并发双击审批幂等、多产物顺延挂卡、>24h 未提交只读卡与跨仓冲突忽略恢复、内部 asi-needs 沙盒排除及 start/stop 并发零定时器泄漏', {
    timeout: 30_000,
  }, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'asi-care-races-'));
    tempDirs.push(rootDir);
    const fakeHome = join(rootDir, 'home');
    const dataRoot = join(rootDir, 'dsh-data');
    const careData = join(dataRoot, 'asi-care');
    const needsData = join(dataRoot, 'asi-needs');
    const senseData = join(dataRoot, 'asi-sense');

    // 创建 2 个独立仓库：
    // - repoA: 含合并冲突 (>5h) + 1.2 GiB 闲置构建产物
    // - repoB: 含 >30h 未提交改动（无冲突，测试 dirty_* 三级只读卡）+ 1.1 GiB 闲置构建产物
    const repoA = join(fakeHome, 'work', 'repo-a');
    const repoB = join(fakeHome, 'work', 'repo-b');
    await mkdir(join(repoA, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(repoB, 'node_modules', 'pkg'), { recursive: true });

    for (const r of [repoA, repoB]) {
      await runGit(r, ['init', '-b', 'main']);
      await writeFile(join(r, '.gitignore'), 'node_modules/\n');
      await writeFile(join(r, 'package.json'), '{"name":"pkg"}');
      await runGit(r, ['add', '.']);
      await runGit(r, ['commit', '-m', 'init']);
    }

    const binA = join(repoA, 'node_modules', 'pkg', 'a.bin');
    const binB = join(repoB, 'node_modules', 'pkg', 'b.bin');
    await writeFile(binA, '');
    await truncate(binA, Math.round(1.2 * 1024 ** 3));
    await writeFile(binB, '');
    await truncate(binB, Math.round(1.1 * 1024 ** 3));

    const dirtyB = join(repoB, 'draft.ts');
    await writeFile(dirtyB, 'export const draft = 1;\n');

    const gitDirA = (await runGit(repoA, ['rev-parse', '--absolute-git-dir'])).trim();
    const gitDirB = (await runGit(repoB, ['rev-parse', '--absolute-git-dir'])).trim();
    const mergeHeadA = join(gitDirA, 'MERGE_HEAD');
    await writeFile(mergeHeadA, '1111111111111111111111111111111111111111\n');

    const eightDaysAgo = T0 - (ARTIFACT_IDLE_THRESHOLD_MS + 86_400_000);
    const thirtyHoursAgo = T0 - 30 * 3_600_000;
    const fiveHoursAgo = T0 - 5 * 3_600_000;

    await setTreeMtime(repoA, eightDaysAgo);
    await setTreeMtime(gitDirA, eightDaysAgo);
    await setMtime(mergeHeadA, fiveHoursAgo);

    await setTreeMtime(repoB, thirtyHoursAgo);
    await setTreeMtime(gitDirB, thirtyHoursAgo);
    await setTreeMtime(join(repoB, 'node_modules'), eightDaysAgo);
    await setMtime(repoB, thirtyHoursAgo);

    // 真实持久化行为的 workspaceRegistry：asi-needs 创建自维护会话时会把 asi-needs/sandbox 写入 list()！
    const registeredWorkspaces: { id: string; path: string; sessionIds: SessionId[] }[] = [
      { id: 'ws-a', path: repoA, sessionIds: [] },
      { id: 'ws-b', path: repoB, sessionIds: [] },
    ];
    const persistedSessions: { id: SessionId; header?: { cwd?: string; origin?: string } }[] = [];
    const agentsList: Agent[] = [];

    const root = new Context();
    await root.plugin(SystemPrompt);
    await root.plugin(ToolsService);
    root.tools.setExecutor(new NativeToolExecutor(root));

    root.provide('agents', { list: () => agentsList, get: (id: string) => agentsList.find((a) => a.id === id) });
    root.provide('jobs', { list: () => [], kill: () => 'already-finished', events: { subscribe: () => () => {} } });
    root.provide('llm', { listConfigurableProviders: () => [], resolveModelInfo: async () => undefined });
    root.provide('sessions', { list: () => persistedSessions });
    root.provide('profileContext', {
      name: 'fixture',
      dir: rootDir,
      patchPath: '',
      installAnchor: '',
      cwd: '',
      home: fakeHome,
      startedBundles: [],
      overlays: [],
      telemetryDisabledEnv: undefined,
    });
    root.provide('workspaceRegistry', {
      archivedSessionIds: [],
      list: () => registeredWorkspaces,
      create: async (p: string, title?: string) => {
        const entry = { id: `ws-${title ?? registeredWorkspaces.length}`, path: p, sessionIds: [] as SessionId[] };
        registeredWorkspaces.push(entry);
        return entry;
      },
    });
    root.provide('sessionController', {
      create: async (req: { cwd?: string; sessionId?: string }) => {
        const sid = SessionId(req.sessionId ?? 'asi-maint-auto');
        const cwd = req.cwd ?? join(needsData, 'sandbox');
        persistedSessions.push({ id: sid, header: { cwd } });
        const a = {
          id: sid,
          status: 'idle' as const,
          session: { header: { cwd } },
          followup: () => {},
          send: () => {},
          cancel: () => {},
          whenIdle: async () => {},
        } as unknown as Agent & { ctx: Context };
        a.ctx = createScope(root, a).ctx;
        agentsList.push(a);
        emitAgentEvent(root, a, 'agent/created', { source: 'startup' });
        return { sessionId: sid };
      },
      rename: async () => ({ title: 'ASI 自维护', seq: 1 }),
      resolveAgent: async (sid: string) => {
        const found = agentsList.find((a) => a.id === sid);
        return found ? { agent: found } : { error: new Error('none') };
      },
    });

    const calmSnap = makeSnapshot({ now: T0, mono: 20_000 });
    calmSnap.state.self.body.disks = {
      kind: 'disks',
      ...fact([{ mount: '/', total: 500 * 1024 ** 3, free: 200 * 1024 ** 3 }], { observedAt: T0 - 1_000 }),
    };
    root.provide('asiSense', createMockSenseService(calmSnap, senseData));

    const needsFork = await root.plugin(AsiNeedsPlugin, { storageRoot: needsData });

    // 先触发自维护建会话（这会把 asi-needs/sandbox 真实写入 workspaceRegistry 与 sessions），再挂载 AsiCarePlugin！
    const remoteNeeds = root.get('asiNeeds') as {
      openMaintenanceSession(): Promise<string>;
      approveHelp(cardId: string): Promise<void>;
      dismissHelp(cardId: string): Promise<void>;
    };
    const maintSid = await remoteNeeds.openMaintenanceSession();

    // 验证 start() 期间并发调用 stop() 无泄漏定时器或未捕获异常
    const racePorts = (await import('../src/host/dsh/ports.js')).createDshCarePorts(root, join(rootDir, 'race-care'), {
      homeDir: fakeHome,
    });
    const raceRuntime = createCareRuntime(racePorts, { fastIntervalMs: 5_000, slowIntervalMs: 15_000 });
    const startP = raceRuntime.start();
    await raceRuntime.stop();
    await startP;

    // 正式挂载真实 AsiCarePlugin（晚于自维护会话创建，验证动态同步 restrict 允许 care_status！）
    const careFork = await root.plugin(AsiCarePlugin, {
      storageRoot: careData,
      fastIntervalMs: 600_000,
      slowIntervalMs: 600_000,
    });

    try {
      const maintAgent = agentsList.find((a) => a.id === maintSid);
      expect(maintAgent).toBeDefined();
      if (!maintAgent) throw new Error('missing maintAgent');
      // 即使 AsiCarePlugin 晚于 maintAgent 挂载，maintAgent 内也能访问只读 care_status！
      expect(root.tools.executable('care_status', maintAgent)).toBeDefined();

      // 触发慢探针（通过沙盒嗅探工具 refreshSlowBloat=true）
      const sniffTool = root.tools.executable('care_sniff_workspaces', maintAgent);
      await sniffTool?.execute({ refreshSlowBloat: true }, {
        agent: maintAgent,
        signal: new AbortController().signal,
        callId: 'c-sniff' as never,
      } as never);

      const user = { id: SessionId('u-race'), status: 'idle' as const } as unknown as Agent & { ctx: Context };
      user.ctx = createScope(root, user).ctx;
      const careSnap = (await root.tools.executable('care_status', user)?.execute({ aspect: 'all' }, {
        agent: user,
        signal: new AbortController().signal,
        callId: 'c-cs' as never,
      } as never)) as { discovery: { worktrees: { displayPath: string }[] } };

      // 1) 验证 asi-needs/sandbox 被 createDshCarePorts 严格排除，仅发现 repo-a 与 repo-b
      expect(careSnap.discovery.worktrees.map((w) => w.displayPath).sort()).toEqual(['~/work/repo-a', '~/work/repo-b']);

      const readNeeds = async () =>
        (await root.tools.executable('needs_status', user)?.execute({}, {
          agent: user,
          signal: new AbortController().signal,
          callId: 'c-ns2' as never,
        } as never)) as {
          helpCards: {
            id: string;
            driveKey?: string;
            title: string;
            actionKind: string;
            actionTarget?: string;
            status: string;
          }[];
          actionLedger: { need: string; action: string; attempts: number; effectiveCount: number }[];
        };

      const snap1 = await readNeeds();
      const open1 = snap1.helpCards.filter((c) => c.status === 'open' && c.driveKey?.startsWith('asi-care:'));

      // 2) 同时存在 repo-a 的 conflict_* 只读卡与 repo-b 的 dirty_* (>24h 未提交) 只读卡！
      const conflictCardA = open1.find((c) => c.actionTarget?.startsWith('conflict_'));
      const dirtyCardB = open1.find((c) => c.actionTarget?.startsWith('dirty_'));
      expect(conflictCardA?.title).toContain('repo-a');
      expect(dirtyCardB?.title).toContain('repo-b');

      // 点击 dirtyCardB 的「我已处理」(approveHelp)：在未提交文件仍存在时转为 approved 且下轮巡检绝不重弹重复卡片！
      if (!dirtyCardB || !conflictCardA) throw new Error('missing read-only cards');
      await remoteNeeds.approveHelp(dirtyCardB.id);
      await sniffTool?.execute({ refreshSlowBloat: false }, {
        agent: maintAgent,
        signal: new AbortController().signal,
        callId: 'c-sniff-2' as never,
      } as never);
      const snapAfterAck = await readNeeds();
      expect(
        snapAfterAck.helpCards.some((c) => c.status === 'open' && c.actionTarget === dirtyCardB.actionTarget),
      ).toBe(false);

      // 忽略 repoA 的冲突卡，随后解决 repoA 冲突 -> dismissedTargets 自动释放该令牌；再次制造冲突后能重新正常提示！
      await remoteNeeds.dismissHelp(conflictCardA.id);
      await rm(mergeHeadA);
      await setMtime(gitDirA, eightDaysAgo);
      await sniffTool?.execute({ refreshSlowBloat: false }, {
        agent: maintAgent,
        signal: new AbortController().signal,
        callId: 'c-sniff-3' as never,
      } as never);
      await writeFile(mergeHeadA, '2222222222222222222222222222222222222222\n');
      await setMtime(mergeHeadA, fiveHoursAgo);
      await setMtime(gitDirA, eightDaysAgo);
      await sniffTool?.execute({ refreshSlowBloat: false }, {
        agent: maintAgent,
        signal: new AbortController().signal,
        callId: 'c-sniff-4' as never,
      } as never);
      const snapReconflict = await readNeeds();
      expect(
        snapReconflict.helpCards.some((c) => c.status === 'open' && c.actionTarget === conflictCardA.actionTarget),
      ).toBe(true);

      // 3) 并发双击批准第 1 个构建产物卡片：严格只执行 1 次记账，且因第 2 个产物仍 ≥1GiB 立即顺延挂出第 2 张构建产物卡！
      const bloatCard1 = snapReconflict.helpCards.find(
        (c) => c.status === 'open' && c.driveKey === 'asi-care:workspace_bloat',
      );
      expect(bloatCard1).toBeDefined();
      if (!bloatCard1) throw new Error('missing bloatCard1');

      await Promise.all([
        remoteNeeds.approveHelp(bloatCard1.id),
        remoteNeeds.approveHelp(bloatCard1.id),
        remoteNeeds.dismissHelp(bloatCard1.id),
      ]);

      const snapAfterFirstBloat = await readNeeds();
      expect(snapAfterFirstBloat.helpCards.find((c) => c.id === bloatCard1.id)?.status).toBe('approved');
      const ledgerEntry = snapAfterFirstBloat.actionLedger.find(
        (e) => e.need === 'asi-care:workspace_bloat' && e.action === 'clean-workspace-artifact:node_modules',
      );
      expect(ledgerEntry?.attempts).toBe(1);
      expect(ledgerEntry?.effectiveCount).toBe(1);

      const bloatCard2 = snapAfterFirstBloat.helpCards.find(
        (c) => c.status === 'open' && c.driveKey === 'asi-care:workspace_bloat',
      );
      expect(bloatCard2).toBeDefined();
      expect(bloatCard2?.actionTarget).not.toBe(bloatCard1.actionTarget);
    } finally {
      await careFork.dispose();
      await needsFork.dispose();
    }
  });

  it('L1 生理压制与 eco 抢占信号全链路贯穿：5 个沙盒工具立即中止不跑后续探针、压制瞬间中断在途探针、压制期 fastTimer 零子进程并在恢复时自动补跑基线', {
    timeout: 25_000,
  }, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'asi-care-preempt-'));
    tempDirs.push(rootDir);
    const fakeHome = join(rootDir, 'home');
    const repoDir = join(fakeHome, 'work', 'preempt-repo');
    const wtGone = join(fakeHome, 'work', 'preempt-gone');
    await mkdir(join(repoDir, 'node_modules', 'pkg'), { recursive: true });
    await runGit(repoDir, ['init', '-b', 'main']);
    await writeFile(join(repoDir, '.gitignore'), 'node_modules/\n');
    await writeFile(join(repoDir, 'package.json'), '{"name":"preempt"}');
    await runGit(repoDir, ['add', '.']);
    await runGit(repoDir, ['commit', '-m', 'init']);
    await runGit(repoDir, ['worktree', 'add', '-b', 'feat/gone', wtGone, 'main']);
    await rm(wtGone, { recursive: true, force: true }); // prunable entry

    const gitDir = (await runGit(repoDir, ['rev-parse', '--absolute-git-dir'])).trim();
    const deadLock = join(gitDir, 'index.lock');
    await writeFile(deadLock, '');
    const heavyFile = join(repoDir, 'node_modules', 'pkg', 'big.bin');
    await writeFile(heavyFile, Buffer.alloc(4096));

    const eightDaysAgo = T0 - (ARTIFACT_IDLE_THRESHOLD_MS + 86_400_000);
    await setTreeMtime(repoDir, eightDaysAgo);
    await setTreeMtime(gitDir, eightDaysAgo);

    let execCount = 0;
    let blockNextGit = false;
    const blockedSignals: (AbortSignal | undefined)[] = [];
    let notifyBlockedStarted: (() => void) | undefined;

    const controlledExec: typeof defaultCareExec = async (bin, args, opts) => {
      execCount += 1;
      if (blockNextGit && bin === 'git') {
        blockedSignals.push(opts?.signal);
        notifyBlockedStarted?.();
        return await new Promise((resolveExec) => {
          if (opts?.signal?.aborted) {
            resolveExec({ ok: false, exitCode: null, stdout: '', stderr: 'aborted', errorCode: 'ABORT_ERR' });
            return;
          }
          opts?.signal?.addEventListener(
            'abort',
            () => resolveExec({ ok: false, exitCode: null, stdout: '', stderr: 'aborted', errorCode: 'ABORT_ERR' }),
            { once: true },
          );
        });
      }
      if (bin === 'git') return await defaultCareExec('git', args, opts);
      if (bin === 'ps') return { ok: true, exitCode: 0, stdout: '', stderr: '' };
      return { ok: false, exitCode: 1, stdout: '', stderr: '' };
    };

    const calmSnap = makeSnapshot({ now: T0, mono: 5_000 });
    calmSnap.state.self.body.disks = {
      kind: 'disks',
      ...fact([{ mount: '/', total: 500 * 1024 ** 3, free: 200 * 1024 ** 3 }], { observedAt: T0 - 1_000 }),
    };
    const sense = createMockSenseService(calmSnap, join(rootDir, 'sense'));

    let registeredSource: DriveSourceRegistration | undefined;
    const driveSubscribers = new Set<(snap: AsiDrivesSnapshot) => void>();
    let suppressed = false;
    let powerMode: 'normal' | 'eco' = 'normal';
    const proposedCards: string[] = [];

    const readDrivesSnap = (): AsiDrivesSnapshot => ({
      now: T0,
      powerMode,
      higherOrderSuppressed: suppressed,
      ...(suppressed ? { suppressionReason: 'L1 压制或节能模式' } : {}),
      activeTier: suppressed ? 1 : 3,
      drives: [],
    });

    const rootDrives: AsiDrivesServiceApi = {
      snapshot: readDrivesSnap,
      subscribe: (fn) => {
        driveSubscribers.add(fn);
        return () => {
          driveSubscribers.delete(fn);
        };
      },
      registerSource: (reg) => {
        registeredSource = reg;
        return () => {
          registeredSource = undefined;
        };
      },
      notifySourceChanged: () => {},
      proposeHelpCard: async (_src, proposal) => {
        proposedCards.push(proposal.title);
        return {
          id: `card-${proposedCards.length}`,
          silent: true,
          severity: 'uncomfortable',
          title: proposal.title,
          summary: '',
          actionKind: proposal.actionKind ?? 'acknowledge',
          ...(proposal.actionTarget ? { actionTarget: proposal.actionTarget } : {}),
          status: 'open',
          createdAt: T0,
          updatedAt: T0,
        };
      },
      resolveHelpCards: async () => 0,
    };

    const emitSuppression = (nextSuppressed: boolean, nextPower: 'normal' | 'eco' = 'normal') => {
      suppressed = nextSuppressed;
      powerMode = nextPower;
      const snap = readDrivesSnap();
      for (const fn of [...driveSubscribers]) fn(snap);
    };

    let orphanJobsCount = 1;
    let onAfterKillOrphan: (() => void) | undefined;
    const careRuntime = createCareRuntime(
      {
        storageRoot: join(rootDir, 'care'),
        homeDir: fakeHome,
        sense,
        drives: rootDrives,
        listWorkspacePaths: () => [repoDir],
        listSessions: () => [],
        listInternalRoots: () => [],
        jobs: {
          listOrphanJobs: () =>
            orphanJobsCount > 0 ? [{ id: 'j-1', owner: 'dead', startedAt: T0 - 4 * 3_600_000 }] : [],
          listProtectedJobPids: () => [],
          killOrphanJob: () => {
            orphanJobsCount = Math.max(0, orphanJobsCount - 1);
            onAfterKillOrphan?.();
            return 'requested';
          },
        },
        exec: controlledExec,
        clock: { wall: () => T0, mono: () => 5_000 },
      },
      { fastIntervalMs: 5_000, slowIntervalMs: 15_000 },
    );

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await careRuntime.start();
    try {
      const tools = new Map((registeredSource?.sandboxTools ?? []).map((t) => [t.name, t]));
      expect(tools.size).toBe(5);

      // 1) 验证全部 5 个沙盒工具对已中止 DriveAbortSignal 立即拒绝（零子进程、零求助卡、零后续探针）
      const execBeforeAbortedCalls = execCount;
      const cardsBeforeAbortedCalls = proposedCards.length;
      for (const [name, spec] of tools) {
        await expect(
          spec.execute(
            name === 'care_request_help'
              ? { driveKey: 'repo_hygiene', title: 'should-not-post', summary: 'aborted' }
              : { refreshSlowBloat: true },
            { signal: { aborted: true } },
          ),
        ).rejects.toThrow(/aborted/i);
      }
      expect(execCount).toBe(execBeforeAbortedCalls);
      expect(proposedCards.length).toBe(cardsBeforeAbortedCalls);

      // 2) care_sniff_workspaces 在途执行时，higherOrderTurnAbort.abort() 触发 -> 立即中断在途 git 子进程且绝不继续跑慢探针！
      const sniffSpec = tools.get('care_sniff_workspaces');
      if (!sniffSpec) throw new Error('missing care_sniff_workspaces');
      blockNextGit = true;
      const sniffAbort = new AbortController();
      const startedP = new Promise<void>((r) => {
        notifyBlockedStarted = r;
      });
      const sniffInFlight = sniffSpec.execute({ refreshSlowBloat: true }, { signal: sniffAbort.signal });
      await startedP;
      expect(blockedSignals.at(-1)?.aborted).toBe(false);
      sniffAbort.abort();
      await expect(sniffInFlight).rejects.toThrow(/aborted/i);
      expect(blockedSignals.at(-1)?.aborted).toBe(true);
      expect((await careRuntime.statusSnapshot()).workspaceBloat).toBeUndefined();

      // 3) 清理类工具（如 care_stop_orphan_jobs）在 killOrphanJob 刚完成瞬间信号中止 -> 不再追加执行收尾 runFastProbe()
      const stopOrphanSpec = tools.get('care_stop_orphan_jobs');
      if (!stopOrphanSpec) throw new Error('missing care_stop_orphan_jobs');
      blockNextGit = false;
      const stopToolAbort = new AbortController();
      onAfterKillOrphan = () => {
        stopToolAbort.abort();
      };
      const execBeforeStopTool = execCount;
      orphanJobsCount = 1;
      await expect(stopOrphanSpec.execute({}, { signal: stopToolAbort.signal })).rejects.toThrow(/aborted/i);
      onAfterKillOrphan = undefined;
      expect(orphanJobsCount).toBe(0);
      expect(execCount).toBe(execBeforeStopTool);

      // 4) 后台探针在途运行期间，higherOrderSuppressed 从 false -> true：立即调用 probeAbort.abort() 中断子进程！
      blockNextGit = true;
      const bgStarted = new Promise<void>((r) => {
        notifyBlockedStarted = r;
      });
      const bgProbe = careRuntime.runFastProbe();
      await bgStarted;
      expect(blockedSignals.at(-1)?.aborted).toBe(false);
      emitSuppression(true, 'eco');
      await bgProbe;
      expect(blockedSignals.at(-1)?.aborted).toBe(true);

      // 5) 压制生效期间（eco / L1 不适），fastTimer 到期轮询绝不拉起任何 git/lsof/ps 子进程！
      blockNextGit = false;
      const execDuringSuppressed = execCount;
      await vi.advanceTimersByTimeAsync(16_000); // 跨越 3 个 fastIntervalMs 周期 + 1 个 slowIntervalMs 周期
      expect(execCount).toBe(execDuringSuppressed);

      // 6) 当 higherOrderSuppressed 从 true -> false 恢复时，主动补跑一次 runFastProbe()（及首次慢探针）刷新基线！
      emitSuppression(false, 'normal');
      await vi.waitFor(
        async () => {
          expect(execCount).toBeGreaterThan(execDuringSuppressed);
          expect((await careRuntime.statusSnapshot()).workspaceBloat).toBeDefined();
        },
        { timeout: 5_000 },
      );

      // 7) 非 AbortSignal 实例的纯对象 DriveAbortSignal 在途翻转为 aborted=true 时，同样实时中止子进程！
      blockNextGit = true;
      let customFlagAborted = false;
      const customDriveSignal = {
        get aborted() {
          return customFlagAborted;
        },
      };
      const customStarted = new Promise<void>((r) => {
        notifyBlockedStarted = r;
      });
      const customCall = sniffSpec.execute({ refreshSlowBloat: false }, { signal: customDriveSignal });
      await customStarted;
      customFlagAborted = true;
      await expect(customCall).rejects.toThrow(/aborted/i);
      expect(blockedSignals.at(-1)?.aborted).toBe(true);

      // 7b) 合并探针隔离：单个沙盒调用者信号中止时，绝不连坐中断同一时刻并行的非中止调用者！
      const sharedStarted = new Promise<void>((r) => {
        notifyBlockedStarted = r;
      });
      blockNextGit = true;
      const callerAbort = new AbortController();
      const sniffShared = sniffSpec.execute({ refreshSlowBloat: false }, { signal: callerAbort.signal });
      await sharedStarted;
      const statusShared = careRuntime.runFastProbe();
      callerAbort.abort();
      await expect(sniffShared).rejects.toThrow(/aborted/i);
      // 仍有未中止调用者 statusShared 在等待，底层共享子进程信号不得被误杀！
      expect(blockedSignals.at(-1)?.aborted).toBe(false);
      emitSuppression(true, 'eco'); // 通过全局抢占收尾该阻塞探针
      await statusShared;

      // 8) 处于 eco/压制状态启动新实例时：start() 绝不强跑后台 git/lsof/ps 子进程，且跨重启首次点击批准求助卡可按需水合清理！
      blockNextGit = false;
      emitSuppression(true, 'eco');
      const execBeforeEcoBoot = execCount;
      const ecoBootRuntime = createCareRuntime(
        {
          storageRoot: join(rootDir, 'care-eco-boot'),
          homeDir: fakeHome,
          sense,
          drives: {
            ...rootDrives,
            registerSource: (reg) => {
              registeredSource = reg;
              return () => {};
            },
          },
          listWorkspacePaths: () => [repoDir],
          listSessions: () => [],
          listInternalRoots: () => [],
          jobs: { listOrphanJobs: () => [], listProtectedJobPids: () => [], killOrphanJob: () => 'already-finished' },
          exec: controlledExec,
          clock: { wall: () => T0, mono: () => 5_000 },
        },
        { fastIntervalMs: 5_000, slowIntervalMs: 15_000 },
      );
      await ecoBootRuntime.start();
      try {
        expect(execCount).toBe(execBeforeEcoBoot);
        const realArtifactPath = await realpath(join(repoDir, 'node_modules'));
        const { makeTargetToken } = await import('../src/host/safety.js');
        const persistedArtToken = makeTargetToken('art', realArtifactPath);
        const crossRestartApprove = await registeredSource?.executeHelpAction?.({
          cardId: 'persisted-art-card',
          driveKey: 'asi-care:workspace_bloat',
          actionTarget: persistedArtToken,
          now: T0,
          signal: new AbortController().signal,
        });
        expect(crossRestartApprove?.freedBytes).toBeGreaterThanOrEqual(4096);
        await expect(stat(realArtifactPath)).rejects.toThrow();
      } finally {
        await ecoBootRuntime.stop();
      }
    } finally {
      vi.useRealTimers();
      await careRuntime.stop();
    }
  });
});
