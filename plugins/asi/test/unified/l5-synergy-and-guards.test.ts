import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DriveSandboxToolSpec, DriveSourceRegistration, SleepMemorySummary } from '@asi/sense-types';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it } from 'vitest';
import { detectDreamLowerTierBlock } from '../../src/dream/host/evaluator.ts';
import { createDreamRuntime } from '../../src/dream/host/runtime.ts';
import { detectLowerTierBlock } from '../../src/growth/host/evaluator.ts';
import { createGrowthRuntime } from '../../src/growth/host/runtime.ts';
import { createIntuitionRuntime } from '../../src/intuition/host/runtime.ts';
import { AsiDrivesService } from '../../src/needs/host/dsh/drives-service.ts';
import { createNeedsRuntime } from '../../src/needs/host/runtime.ts';
import type { OrdinaryTurnSignal } from '../../src/tom/host/ports.ts';
import { createTomRuntime } from '../../src/tom/host/runtime.ts';
import { createMockSenseService, fact, T0 } from '../needs/fixtures.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
});

function makeMem(
  overrides: Partial<SleepMemorySummary> & Pick<SleepMemorySummary, 'id' | 'kind' | 'title' | 'content'>,
): SleepMemorySummary {
  return {
    tags: ['sqlite', 'concurrency'],
    topicKey: 'sqlite:wal-lock',
    pinned: true,
    confidence: 0.92,
    retention: 0.91,
    evidenceCount: 3,
    recallCount: 2,
    sourceSessionIds: ['sess-a'],
    createdAt: T0 - 60_000,
    updatedAt: T0 - 10_000,
    ...overrides,
  };
}

describe('L5 跨模块马斯洛防饥饿仲裁、ToM 心流避让与 DMN 沙盒抢占回归验证', () => {
  it('当 asi-intuition 存在 >=2 条高优未决前瞻提醒且 asi-tom 高摩擦后进入锁屏时：shouldDeferProactiveWork()=false，dream(15m) 与 growth(20m) 均零饥饿正常触发；未锁屏心流时温和避让，真实 L3 care 告警仍严格阻断 L4', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'asi-l5-synergy-'));
    tempDirs.push(rootDir);

    const repoA = join(rootDir, 'work', 'repo-alpha');
    const repoB = join(rootDir, 'work', 'repo-beta');
    await mkdir(join(repoA, '.git'), { recursive: true });
    await mkdir(join(repoB, '.git'), { recursive: true });
    await writeFile(
      join(repoA, 'package.json'),
      JSON.stringify({ name: 'repo-alpha', dependencies: { 'better-sqlite3': '^11.0.0' } }),
    );
    await writeFile(
      join(repoB, 'package.json'),
      JSON.stringify({ name: 'repo-beta', dependencies: { 'better-sqlite3': '^11.0.0' } }),
    );

    let wallNow = T0;
    let monoNow = 10_000;
    const sense = createMockSenseService({ now: wallNow, mono: monoNow }, join(rootDir, 'data', 'asi', 'sense'));

    const ctx = new Context();
    const needsRuntime = createNeedsRuntime({
      storageRoot: join(rootDir, 'data', 'asi', 'needs'),
      sense,
      clock: { wall: () => wallNow, mono: () => monoNow },
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => id,
        hasSession: () => false,
        runMaintenanceTurn: async () => {},
        deliverCryToUserSession: async () => false,
      },
      probeEndpoint: async () => true,
    });
    await needsRuntime.start();
    const drives = new AsiDrivesService(ctx, needsRuntime);

    const memories: SleepMemorySummary[] = [
      makeMem({
        id: 'm_pit_a',
        kind: 'pitfall',
        title: 'SQLite WAL 锁表死锁踩坑',
        content: '多线程写入必须开启 busy_timeout 并保持单事务原子提交，防止 SQLITE_BUSY 死锁。',
        sourceSessionIds: ['sess-a'],
      }),
      makeMem({
        id: 'm_dec_a',
        kind: 'decision',
        title: 'SQLite 迁移脚本串行化约定',
        content: '启动期迁移统一串行加锁并设置 WAL journal_mode。',
        sourceSessionIds: ['sess-a'],
      }),
      makeMem({
        id: 'm_pref_a',
        kind: 'preference',
        title: '本地存储优先幂等原子写',
        content: '写盘前先写临时文件再 rename 替换目标路径。',
        sourceSessionIds: ['sess-a'],
      }),
      makeMem({
        id: 'm_ep_b',
        kind: 'episode',
        title: '排查 repo-beta SQLite 并发写锁竞争',
        content: 'repo-beta 批量导入遇到 SQLITE_BUSY race condition 需要锁超时治理。',
        sourceSessionIds: ['sess-b'],
      }),
    ];

    const sleepStub = {
      listMemories: () => memories,
      subscribe: () => () => {},
    };

    let turnSignalListener: ((sig: OrdinaryTurnSignal) => void) | undefined;
    const tomRuntime = createTomRuntime({
      storageRoot: join(rootDir, 'data', 'asi', 'tom'),
      now: () => wallNow,
      sense,
      drives,
      sleep: sleepStub,
      sessions: {
        hasActiveOrdinarySession: () => true,
        onUserPrompt: () => () => {},
        onTurnSettled: (cb) => {
          turnSignalListener = cb;
          return () => {
            turnSignalListener = undefined;
          };
        },
        onApprovalResolved: () => () => {},
      },
    });
    await tomRuntime.start();

    const parkedBySession = new Map<string, string>();
    let sessionCreatedCb: ((ev: { sessionId: string; cwd?: string }) => void) | undefined;
    const intuitionRuntime = createIntuitionRuntime({
      storageRoot: join(rootDir, 'data', 'asi', 'intuition'),
      now: () => wallNow,
      sense,
      drives,
      sleep: sleepStub,
      tom: {
        shouldDeferProactiveWork: () => tomRuntime.shouldDeferProactiveWork(),
        subscribe: (fn) => tomRuntime.subscribe(() => fn(tomRuntime.snapshot())),
      },
      sessions: {
        listOrdinarySessionIds: () => ['sess-a'],
        getSessionCwd: () => repoA,
        syncParkedMessage: (sid, content) => {
          if (content === null) {
            parkedBySession.delete(sid);
            return true;
          }
          parkedBySession.set(sid, content);
          return true;
        },
        injectNextStep: () => true,
      },
      events: {
        onSessionCreated: (cb) => {
          sessionCreatedCb = cb;
          return () => {
            sessionCreatedCb = undefined;
          };
        },
        onSessionTurnClaimed: () => () => {},
        onUserPreStep: () => () => {},
        onToolPreExecute: () => () => {},
        onToolResult: () => () => {},
        onJobFinished: () => () => {},
      },
    });
    await intuitionRuntime.start();

    const dreamRuntime = createDreamRuntime({
      storageRoot: join(rootDir, 'data', 'asi', 'dream'),
      homeDir: rootDir,
      clock: { wall: () => wallNow, mono: () => monoNow },
      sense,
      drives,
      getSleep: () => sleepStub,
      tom: {
        shouldDeferProactiveWork: () => tomRuntime.shouldDeferProactiveWork(),
        subscribe: (fn) => tomRuntime.subscribe(() => fn(tomRuntime.snapshot())),
      },
      conversations: {
        listCompletedOrdinaryTurns: () => [],
        anyOrdinarySessionRunning: () => false,
        listKnownWorkspaces: () => [repoA, repoB],
        listSessionWorkspaces: () =>
          new Map([
            ['sess-a', repoA],
            ['sess-b', repoB],
          ]),
        onOrdinaryActivity: () => () => {},
      },
    });
    await dreamRuntime.start();

    const growthRuntime = createGrowthRuntime({
      storageRoot: join(rootDir, 'data', 'asi', 'growth'),
      homeDir: rootDir,
      clock: { wall: () => wallNow, mono: () => monoNow },
      sense,
      drives,
      getSleep: () => sleepStub,
      conversations: {
        listCompletedOrdinaryTurns: () => [
          {
            turnId: 'turn-1',
            sessionId: 'sess-a',
            at: wallNow - 30_000,
            cwd: repoA,
            stepCount: 3,
            toolNames: ['bash', 'edit_file', 'bash'],
            hadToolError: true,
            userText: '排查 SQLite WAL 锁表死锁 SQLITE_BUSY',
            assistantText: '已启用 busy_timeout 与单事务原子写解决死锁。',
          },
          {
            turnId: 'turn-2',
            sessionId: 'sess-b',
            at: wallNow - 20_000,
            cwd: repoB,
            stepCount: 3,
            toolNames: ['bash', 'edit_file', 'bash'],
            hadToolError: true,
            userText: '修复 SQLite 并发写锁竞争 SQLITE_BUSY',
            assistantText: '配置 busy_timeout 5000ms 与 WAL 串行迁移锁后恢复正常。',
          },
        ],
        anyOrdinarySessionRunning: () => false,
        listKnownWorkspaces: () => [repoA, repoB],
        listSessionWorkspaces: () =>
          new Map([
            ['sess-a', repoA],
            ['sess-b', repoB],
          ]),
        onOrdinaryActivity: () => () => {},
      },
    });
    await growthRuntime.start();

    try {
      // 1. 制造 >=2 条高优已到期前瞻意图 + ToM 高摩擦（连续打断）
      await intuitionRuntime.actions.createIntention({
        title: '发布前核对 SQLite 迁移回滚脚本',
        instruction: '检查 schema 升级回滚安全性',
        triggerKind: 'time',
        dueAt: wallNow + 1_000,
        priority: 'high',
      });
      await intuitionRuntime.actions.createIntention({
        title: '检查 WAL 锁超时参数',
        instruction: '确认 busy_timeout >= 5000',
        triggerKind: 'time',
        dueAt: wallNow + 1_000,
        priority: 'high',
      });

      turnSignalListener?.({ sessionId: 'sess-a', at: wallNow - 5_000, outcome: 'interrupted' });
      turnSignalListener?.({ sessionId: 'sess-a', at: wallNow - 1_000, outcome: 'interrupted' });

      wallNow += 2_000;
      monoNow += 2_000;
      sessionCreatedCb?.({ sessionId: 'sess-a', cwd: repoA });
      sense.emit((prev) => ({
        ...prev,
        now: wallNow,
        mono: monoNow,
        state: {
          ...prev.state,
          env: {
            ...prev.state.env,
            frontApp: fact({ name: 'Cursor', bundleId: 'com.todesktop.cursor' }, { observedAt: wallNow }),
          },
        },
      }));
      await new Promise((r) => setTimeout(r, 50));

      const snapActiveL3 = drives.snapshot();
      const intDrive = snapActiveL3.drives.find((d) => d.key === 'asi-intuition:prospective_sentinel');
      const tomDrive = snapActiveL3.drives.find((d) => d.key === 'asi-tom:social_tact');
      expect(intDrive?.driveActive).toBe(true);
      expect(tomDrive?.driveActive).toBe(true);

      // 观察型 L3 驱动（asi-intuition / asi-tom）绝不阻塞 L4 dream 与 growth
      expect(detectDreamLowerTierBlock(sense.snapshot(), snapActiveL3).lowerTierBlocked).toBe(false);
      expect(detectLowerTierBlock(sense.snapshot(), snapActiveL3).lowerTierBlocked).toBe(false);

      // 对照验证：若真实行动型 L3 care 驱动激活，仍必须严格阻断 L4！
      const offFakeCare = drives.registerSource({
        id: 'asi-care',
        tier: 3,
        label: '工作区看护',
        evaluate: () => [{ key: 'repo_hygiene', label: '仓库卫生', satisfaction: 40, summary: '存在陈旧锁' }],
      });
      sense.emit((prev) => ({ ...prev, now: wallNow, mono: monoNow }));
      await new Promise((r) => setTimeout(r, 40));
      expect(detectDreamLowerTierBlock(sense.snapshot(), drives.snapshot()).lowerTierBlocked).toBe(true);
      expect(detectLowerTierBlock(sense.snapshot(), drives.snapshot()).lowerTierBlocked).toBe(true);
      offFakeCare();
      sense.emit((prev) => ({ ...prev, now: wallNow, mono: monoNow }));
      await new Promise((r) => setTimeout(r, 40));

      // 2. 未锁屏状态下搭档进入 deep_focus：shouldDeferProactiveWork() === true
      //    - normal 优先级前瞻提醒静默延后；
      //    - 即使空闲 16 分钟，未锁屏自动做梦也礼貌避让不打扰心流！
      await tomRuntime.actions.setManualOverride({ state: 'deep_focus', durationMinutes: 30 });
      expect(tomRuntime.shouldDeferProactiveWork()).toBe(true);

      const normalInt = await intuitionRuntime.actions.createIntention({
        title: '顺手整理变更日志草稿',
        instruction: '不紧急，等心流结束后再提醒',
        triggerKind: 'time',
        dueAt: wallNow + 500,
        priority: 'normal',
      });
      wallNow += 16 * 60_000;
      monoNow += 16 * 60_000;
      sense.emit((prev) => ({
        ...prev,
        now: wallNow,
        mono: monoNow,
        state: {
          ...prev.state,
          env: {
            ...prev.state.env,
            frontApp: fact({ name: 'Terminal', bundleId: 'com.apple.Terminal' }, { observedAt: wallNow }),
          },
        },
      }));
      await new Promise((r) => setTimeout(r, 50));

      expect(intuitionRuntime.serviceSnapshot().intentions.find((item) => item.id === normalInt.id)?.status).toBe(
        'pending',
      );
      expect(dreamRuntime.panelModel().drive.autoDreamsToday).toBe(0);
      expect(dreamRuntime.panelModel().drive.summary).toContain('搭档心流专注中');

      // 3. 清除手动锁定并锁屏进入 away_resting（高摩擦刚退去）：
      //    shouldDeferProactiveWork() 必须立即返回 false，且 dream 与 growth 均零饥饿自动完成！
      await tomRuntime.actions.setManualOverride({ state: null });
      wallNow += 5 * 60_000;
      monoNow += 5 * 60_000;
      sense.emit((prev) => ({
        ...prev,
        now: wallNow,
        mono: monoNow,
        state: {
          ...prev.state,
          env: {
            ...prev.state.env,
            system: fact({ locked: true, sleeping: false }, { observedAt: wallNow }),
          },
        },
      }));

      expect(tomRuntime.snapshot().state).toBe('away_resting');
      expect(tomRuntime.shouldDeferProactiveWork()).toBe(false);

      // 等待异步自动做梦与自动技能起草落盘完成
      for (let i = 0; i < 40; i += 1) {
        if (dreamRuntime.panelModel().totalInsights >= 1 && growthRuntime.panelModel().draftCount >= 1) {
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }

      expect(dreamRuntime.panelModel().totalInsights).toBeGreaterThanOrEqual(1);
      expect(dreamRuntime.panelModel().drive.autoDreamsToday).toBe(1);
      expect(growthRuntime.panelModel().draftCount).toBeGreaterThanOrEqual(1);
    } finally {
      await Promise.allSettled([dreamRuntime.stop(), growthRuntime.stop(), intuitionRuntime.stop(), tomRuntime.stop()]);
      await needsRuntime.stop();
    }
  });

  it('沙盒工具 dream_synthesize_cross_repo 严格执行深静默/暂停/L1 门控，且在途 sandbox 周期遇 L1 告警立即抢占中断', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'asi-dream-sandbox-gate-'));
    tempDirs.push(rootDir);

    const repo1 = join(rootDir, 'r1');
    const repo2 = join(rootDir, 'r2');
    await mkdir(join(repo1, '.git'), { recursive: true });
    await mkdir(join(repo2, '.git'), { recursive: true });
    await writeFile(join(repo1, 'package.json'), '{"dependencies":{"better-sqlite3":"1.0.0"}}');
    await writeFile(join(repo2, 'package.json'), '{"dependencies":{"better-sqlite3":"1.0.0"}}');

    const wallNow = T0;
    const monoNow = 10_000;
    const sense = createMockSenseService({ now: wallNow, mono: monoNow }, join(rootDir, 'data', 'asi', 'sense'));

    const ctx = new Context();
    const needsRuntime = createNeedsRuntime({
      storageRoot: join(rootDir, 'data', 'asi', 'needs'),
      sense,
      clock: { wall: () => wallNow, mono: () => monoNow },
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => id,
        hasSession: () => false,
        runMaintenanceTurn: async () => {},
        deliverCryToUserSession: async () => false,
      },
      probeEndpoint: async () => true,
    });
    await needsRuntime.start();
    const rawDrives = new AsiDrivesService(ctx, needsRuntime);
    let capturedSandboxTool: DriveSandboxToolSpec | undefined;
    const drives = {
      snapshot: () => rawDrives.snapshot(),
      subscribe: (fn: Parameters<typeof rawDrives.subscribe>[0]) => rawDrives.subscribe(fn),
      notifySourceChanged: (sourceId?: string) => rawDrives.notifySourceChanged(sourceId),
      registerSource: (reg: DriveSourceRegistration) => {
        if (reg.id === 'asi-dream') {
          capturedSandboxTool = reg.sandboxTools?.find((t) => t.name === 'dream_synthesize_cross_repo');
        }
        return rawDrives.registerSource(reg);
      },
    };

    let llmEntered: (() => void) | undefined;
    const llmStarted = new Promise<void>((res) => {
      llmEntered = res;
    });
    let sandboxAborted = false;

    const dreamRuntime = createDreamRuntime({
      storageRoot: join(rootDir, 'data', 'asi', 'dream'),
      homeDir: rootDir,
      clock: { wall: () => wallNow, mono: () => monoNow },
      sense,
      drives,
      getSleep: () => ({
        listMemories: () => [
          makeMem({
            id: 'm1',
            kind: 'pitfall',
            title: 'SQLite 锁表死锁需设 busy_timeout',
            content: '并发写必须开启 busy_timeout 并使用原子写。',
            tags: ['sqlite'],
            sourceSessionIds: ['s1'],
          }),
        ],
        subscribe: () => () => {},
      }),
      conversations: {
        listCompletedOrdinaryTurns: () => [
          {
            turnId: 's2:t1',
            sessionId: 's2',
            cwd: repo2,
            at: wallNow - 30_000,
            userText: '排查 SQLite 锁表超时死锁',
            assistantText: '检查连接配置',
            toolNames: [],
            failedToolCount: 1,
          },
        ],
        anyOrdinarySessionRunning: () => false,
        listKnownWorkspaces: () => [repo1, repo2],
        listSessionWorkspaces: () =>
          new Map([
            ['s1', repo1],
            ['s2', repo2],
          ]),
        onOrdinaryActivity: () => () => {},
      },
      llmDream: async (_prompt, signal) => {
        llmEntered?.();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              sandboxAborted = true;
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            },
            { once: true },
          );
        });
        return undefined;
      },
    });
    await dreamRuntime.start();

    try {
      expect(capturedSandboxTool).toBeDefined();

      // 1. 未满 15m 深静默且未传 force -> 返回等待摘要，不执行做梦周期
      const notQuietRes = await capturedSandboxTool?.execute({}, { signal: new AbortController().signal });
      expect(notQuietRes?.summary).toContain('等待 15 分钟深静默窗口');

      // 2. 暂停态调用直接抛错拒绝
      await sense.setPaused(true);
      await new Promise((r) => setTimeout(r, 40));
      await expect(
        capturedSandboxTool?.execute({ force: true }, { signal: new AbortController().signal }),
      ).rejects.toThrow(/paused/i);
      await sense.setPaused(false);
      await new Promise((r) => setTimeout(r, 40));

      // 3. force: true 启动在途 sandbox 做梦周期，随后触发 eco / L1 压制 -> 立即抢占中断在途 sandbox 周期！
      const inFlight = capturedSandboxTool?.execute({ force: true }, { signal: new AbortController().signal });
      inFlight?.catch(() => undefined);
      await llmStarted;
      await sense.setPowerMode('eco', '电量告警');
      sense.emit((prev) => ({ ...prev, now: wallNow + 1_000 }));

      await expect(inFlight).rejects.toThrow(/aborted/i);
      expect(sandboxAborted).toBe(true);
    } finally {
      await dreamRuntime.stop();
      await needsRuntime.stop();
    }
  });
});
