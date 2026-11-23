import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AsiDrivesServiceApi,
  AsiDrivesSnapshot,
  AsiSenseServiceApi,
  DriveSourceRegistration,
  Fact,
  PowerMode,
  SenseSnapshot,
} from '@asi/sense-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationTurnInput } from '../src/host/consolidator.js';
import { createSleepRuntime } from '../src/host/runtime.js';

const T0 = 1_764_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function okFact<T>(value: T, now = T0): Fact<T> {
  return {
    value,
    status: 'ok',
    source: { id: 'test', api: 'mock', host: 'local' },
    observedAt: now,
    ttlMs: 60_000,
  };
}

function makeSenseHarness(getNow: () => number) {
  let locked = false;
  let paused = false;
  let powerMode: PowerMode = 'normal';
  const subs = new Set<(s: SenseSnapshot) => void>();

  const buildSnap = (): SenseSnapshot => {
    const now = getNow();
    return {
      now,
      mono: now - T0 + 1_000,
      state: {
        self: {
          activity: okFact('idle' as const, now),
          pending: okFact({ inbox: 0, jobs: 0 }, now),
          tools: okFact([], now),
          permissions: okFact({}, now),
          body: {
            cpu: okFact({ usage: 0.1, perCore: [0.1], load1: 0.8, load5: 0.7, load15: 0.6 }, now),
            memory: okFact({ pressure: 'normal' as const, used: 4e9, total: 16e9, swapUsed: 0 }, now),
            disks: { kind: 'disks' as const, ...okFact([{ mount: '/', total: 200e9, free: 120e9 }], now) },
            battery: okFact({ percent: 90, charging: true, powerState: 'charging' as const }, now),
            thermal: okFact('nominal' as const, now),
            network: okFact({ online: true, rxBps: 0, txBps: 0 }, now),
            harnessProcess: okFact({ rss: 120e6, cpu: 0.02, uptimeSec: 600 }, now),
            tokens: okFact(
              {
                contextWindow: 128_000,
                contextWindowSource: 'catalog' as const,
                contextUsed: 1_200,
                sessionUsage: { input: 1_000, output: 200, cacheRead: 0, cacheWrite: 0 },
              },
              now,
            ),
          },
        },
        env: {
          where: {
            model: okFact({ provider: 'mock', endpoint: 'http://127.0.0.1:3425/v1', local: true }, now),
            harness: okFact({ host: 'local', os: 'darwin', pid: 100 }, now),
            observed: okFact({ host: 'local', userSession: 'gui' }, now),
            toolExec: okFact({ host: 'local', cwd: '/tmp' }, now),
          },
          frontApp: okFact({ name: 'Code', bundleId: 'dev.code' }, now),
          focusedWindow: okFact({ title: 'editor' }, now),
          activeJobs: okFact([], now),
          system: okFact({ locked }, now),
        },
        observation: { sources: {} },
      },
      history: {
        cpu: [],
        memory: [],
        battery: [],
        thermal: [],
        networkRx: [],
        networkTx: [],
        processCpu: [],
        processRss: [],
        tokens: [],
        disks: {},
        diskFree: {},
      },
      settings: { paused, sendTitles: true, powerMode },
      sampleIntervalsMs: {},
    };
  };

  const api: AsiSenseServiceApi = {
    snapshot: () => buildSnap(),
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    getSettings: () => ({ paused, sendTitles: true, powerMode }),
    setPaused: async (p) => {
      paused = p;
      for (const fn of subs) fn(buildSnap());
    },
    setSendTitles: async () => {},
    setPowerMode: async (m) => {
      powerMode = m;
      for (const fn of subs) fn(buildSnap());
    },
    openPermissionSettings: async () => {},
    registerInternalSession: () => () => {},
    recentSignals: () => [],
  };

  return {
    api,
    setLocked(next: boolean) {
      locked = next;
      for (const fn of subs) fn(buildSnap());
    },
    emit() {
      for (const fn of subs) fn(buildSnap());
    },
  };
}

function makeDrivesHarness(sense: AsiSenseServiceApi, getNow: () => number) {
  let l1Distressed = false;
  let source: DriveSourceRegistration | undefined;
  const subs = new Set<(snap: AsiDrivesSnapshot) => void>();

  const buildSnap = (): AsiDrivesSnapshot => {
    const senseSnap = sense.snapshot();
    const suppressed = l1Distressed || senseSnap.settings.powerMode === 'eco';
    const readings = source ? source.evaluate(senseSnap) : [];
    const drives = readings.map((r) => ({
      key: `${source?.id}:${r.key}`,
      sourceId: source?.id ?? 'asi-sleep',
      tier: source?.tier ?? 2,
      label: r.label,
      satisfaction: r.satisfaction,
      urgency: 100 - r.satisfaction,
      zone: (r.satisfaction < 25 ? 'critical' : r.satisfaction < 60 ? 'uncomfortable' : 'comfortable') as
        | 'comfortable'
        | 'uncomfortable'
        | 'critical',
      driveActive: r.satisfaction < 60,
      ...(r.autoMaintain !== undefined ? { autoMaintain: r.autoMaintain } : {}),
      suppressed,
      ...(suppressed ? { suppressionReason: 'L1 生理需求不适，高阶需求已挂起' } : {}),
      summary: r.summary,
      evidence: r.evidence ?? {},
      updatedAt: getNow(),
    }));
    return {
      now: getNow(),
      powerMode: senseSnap.settings.powerMode,
      higherOrderSuppressed: suppressed,
      ...(suppressed ? { suppressionReason: 'L1 生理需求不适，高阶需求已挂起' } : {}),
      activeTier: !suppressed && drives.some((d) => d.driveActive) ? 2 : null,
      drives,
    };
  };

  const api: AsiDrivesServiceApi = {
    snapshot: () => buildSnap(),
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    registerSource: (reg) => {
      source = reg;
      return () => {
        if (source === reg) source = undefined;
      };
    },
    notifySourceChanged: () => {
      const snap = buildSnap();
      for (const fn of subs) fn(snap);
    },
  };

  return {
    api,
    setL1Distressed(distressed: boolean) {
      l1Distressed = distressed;
      const snap = buildSnap();
      for (const fn of subs) fn(snap);
    },
  };
}

describe('SleepRuntime 困意曲线、静默窗口、每日 6 次自动配额、L1 抢占中断与 CRUD/Recall', () => {
  it('满 12 轮或间隔 >=6h 产生困意 (<60)；仅在空闲 >=10m 或锁屏且 L1 舒适时自动整合；严格限制 <=6 次/天并支持手动立即整合', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'asi-sleep-rt-'));
    tempDirs.push(storageRoot);

    let now = T0;
    const senseH = makeSenseHarness(() => now);
    const drivesH = makeDrivesHarness(senseH.api, () => now);
    const turns: ConversationTurnInput[] = [];
    let running = false;
    const activityListeners = new Set<() => void>();

    const addTurns = (count: number, sessionPrefix = 's1') => {
      for (let i = 0; i < count; i += 1) {
        const idx = turns.length + 1;
        turns.push({
          turnId: `turn-${idx}`,
          sessionId: sessionPrefix,
          at: now,
          userText: `第 ${idx} 轮讨论：我们偏好统一使用 pnpm 管理依赖（批次 ${idx}）。`,
          assistantText: `好的，第 ${idx} 轮记录完成。`,
        });
      }
      for (const fn of activityListeners) fn();
    };

    const rt = createSleepRuntime({
      storageRoot,
      homeDir: '/Users/mockuser',
      clock: { wall: () => now, mono: () => now - T0 + 1_000 },
      sense: senseH.api,
      drives: drivesH.api,
      conversations: {
        listCompletedOrdinaryTurns: () => [...turns],
        anyOrdinarySessionRunning: () => running,
        onOrdinaryActivity: (fn) => {
          activityListeners.add(fn);
          return () => activityListeners.delete(fn);
        },
      },
    });

    await rt.start();
    try {
      // 初始 0 轮：满足度 100%
      expect(rt.panelModel().drive.satisfaction).toBe(100);

      // 5 轮且未满 6 小时：满足度 >= 70%（舒适），即使空闲 15 分钟也不触发睡眠
      addTurns(5);
      expect(rt.panelModel().drive.satisfaction).toBeGreaterThanOrEqual(70);
      now += 15 * MIN;
      senseH.emit();
      await new Promise((r) => setTimeout(r, 20));
      expect(rt.panelModel().recentConsolidations).toHaveLength(0);

      // 距离首轮经过 >= 6h（仍只有 5 轮未整合）：触发时间因子困意 (<60)，且当前空闲已超过 10m -> 自动执行第 1 次整合！
      now += 6 * HOUR;
      senseH.emit();
      await vi.waitFor(
        () => {
          expect(rt.panelModel().consolidating).toBe(false);
          expect(rt.panelModel().recentConsolidations).toHaveLength(1);
        },
        { timeout: 5_000 },
      );
      expect(rt.panelModel().drive.unconsolidatedTurns).toBe(0);
      expect(rt.panelModel().drive.satisfaction).toBe(100);
      expect(rt.panelModel().drive.autoRunsToday).toBe(1);

      // 再新增 12 轮：立即产生轮次困意 (<60)，但刚活跃 2 分钟且未锁屏 -> 绝不提前自动运行！
      addTurns(12);
      now += 2 * MIN;
      senseH.emit();
      await new Promise((r) => setTimeout(r, 25));
      expect(rt.panelModel().drive.satisfaction).toBeLessThan(60);
      expect(drivesH.api.snapshot().drives[0]?.satisfaction).toBeLessThan(60);
      expect(rt.panelModel().drive.quietWindow).toBe(false);
      expect(rt.panelModel().recentConsolidations).toHaveLength(1);

      // 锁屏 (env.system.locked = true)：立即满足静默窗口 -> 自动执行第 2 次整合！
      senseH.setLocked(true);
      await vi.waitFor(
        () => {
          expect(rt.panelModel().consolidating).toBe(false);
          expect(rt.panelModel().recentConsolidations).toHaveLength(2);
        },
        { timeout: 5_000 },
      );
      expect(rt.panelModel().drive.autoRunsToday).toBe(2);
      senseH.setLocked(false);

      // 继续跑满当日剩余 4 次自动配额（共达 6/6 上限），验证空闲 >=10m 路径
      for (let runIdx = 3; runIdx <= 6; runIdx += 1) {
        addTurns(12, `s-${runIdx}`);
        now += 11 * MIN;
        senseH.emit();
        await vi.waitFor(
          () => {
            expect(rt.panelModel().consolidating).toBe(false);
            expect(rt.panelModel().drive.autoRunsToday).toBe(runIdx);
          },
          { timeout: 5_000 },
        );
      }

      // 第 7 次自动机会（24h 内）：已满 6/6 配额 -> 即使满 12 轮且空闲 20 分钟也不自动运行！
      addTurns(12, 's-quota-blocked');
      now += 20 * MIN;
      senseH.emit();
      await new Promise((r) => setTimeout(r, 30));
      expect(rt.panelModel().drive.unconsolidatedTurns).toBe(12);
      expect(rt.panelModel().drive.autoRunsToday).toBe(6);

      // 但点击手动「立即睡眠整合」不受自动配额或静默窗口限制，立即完成整合！
      running = true;
      const manualRec = await rt.actions.consolidateNow();
      expect(manualRec.trigger).toBe('manual');
      expect(manualRec.turnsProcessed).toBe(12);
      expect(rt.panelModel().drive.unconsolidatedTurns).toBe(0);
      running = false;
    } finally {
      await rt.stop();
    }
  });

  it('在途自动睡眠期间突遇 L1 生理危机或 eco 节能模式时立即抢占中断，不扣自动配额且不丢失待整合轮次；支持完整 CRUD 与 Recall 强化', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'asi-sleep-preempt-'));
    tempDirs.push(storageRoot);

    let now = T0;
    const senseH = makeSenseHarness(() => now);
    const drivesH = makeDrivesHarness(senseH.api, () => now);
    const turns: ConversationTurnInput[] = Array.from({ length: 12 }, (_, i) => ({
      turnId: `tp-${i}`,
      sessionId: 'sess-preempt',
      at: now,
      userText: `架构决策 ${i}：决定采用 MiniSearch 实现本地全文检索。`,
      assistantText: '已记录架构方案。',
    }));

    let llmStartedResolve: (() => void) | undefined;
    const llmStarted = new Promise<void>((resolve) => {
      llmStartedResolve = resolve;
    });

    const rt = createSleepRuntime({
      storageRoot,
      clock: { wall: () => now, mono: () => now - T0 + 1_000 },
      sense: senseH.api,
      drives: drivesH.api,
      conversations: {
        listCompletedOrdinaryTurns: () => turns,
        anyOrdinarySessionRunning: () => false,
        onOrdinaryActivity: () => () => {},
      },
      llmExtract: async (_prompt, signal) => {
        llmStartedResolve?.();
        await new Promise<void>((resolve, reject) => {
          const id = setTimeout(resolve, 5_000);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(id);
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            },
            { once: true },
          );
        });
        return '[]';
      },
    });

    await rt.start();
    try {
      // 推进 11 分钟进入静默窗口 -> 启动自动睡眠整合，等待 llmExtract 进入在途状态
      now += 11 * MIN;
      senseH.emit();
      await llmStarted;
      expect(rt.panelModel().consolidating).toBe(true);

      // 突发 L1 生理不适 -> 立即抢占中断在途睡眠！
      drivesH.setL1Distressed(true);
      await vi.waitFor(
        () => {
          expect(rt.panelModel().consolidating).toBe(false);
        },
        { timeout: 5_000 },
      );
      // 自动配额已回滚为 0，12 轮待整合对话未丢失！
      expect(rt.panelModel().drive.autoRunsToday).toBe(0);
      expect(rt.panelModel().drive.unconsolidatedTurns).toBe(12);

      // 验证记忆 CRUD + Pin 锁定 100% + Recall 强化保留率
      const created = await rt.actions.createMemory({
        kind: 'pitfall',
        title: '排障踩坑：避免裸用状态绿字',
        content: '浅色主题下须用 color-mix 保证对比度。',
        tags: ['css', 'a11y'],
        pinned: false,
      });
      expect(created.id).toMatch(/^mem_/);

      // 推进 10 天：未置顶项保留率自然衰减 < 1
      now += 10 * 86_400_000;
      const beforeRecall = rt.panelModel().memories.find((m) => m.id === created.id);
      expect(beforeRecall?.retention).toBeLessThan(0.95);

      // 调用 recall 命中后：recallCount +1，保留率与稳定度显著回升！
      const recallRes = await rt.recall({ query: '对比度 color-mix' });
      expect(recallRes.hits[0]?.id).toBe(created.id);
      expect(recallRes.hits[0]?.recallCount).toBe(1);
      expect(recallRes.hits[0]?.stabilityDays).toBeGreaterThan(created.fsrs.stability);

      // 置顶后推进 180 天：保留率恒为 1.0 (100%)
      await rt.actions.togglePin(created.id, true);
      now += 180 * 86_400_000;
      const pinnedView = rt.panelModel().memories.find((m) => m.id === created.id);
      expect(pinnedView?.pinned).toBe(true);
      expect(pinnedView?.retention).toBe(1);

      // 编辑与删除
      const updated = await rt.actions.updateMemory(created.id, { title: '更新后的对比度踩坑总结' });
      expect(updated.title).toBe('更新后的对比度踩坑总结');
      expect(rt.profile({ kind: 'pitfall' }).profile.pitfall).toHaveLength(1);

      await rt.actions.deleteMemory(created.id);
      expect(rt.panelModel().memories.find((m) => m.id === created.id)).toBeUndefined();
    } finally {
      await rt.stop();
    }
  });

  it('边界条件：在途整合期间并发手动 CRUD 零丢失、精确阈值边界与空白/控制字符入参拦截', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'asi-sleep-edges-'));
    tempDirs.push(storageRoot);

    let now = T0;
    const senseH = makeSenseHarness(() => now);
    const drivesH = makeDrivesHarness(senseH.api, () => now);
    let unblockLlm: (() => void) | undefined;
    let llmEntered: (() => void) | undefined;
    const llmEnteredPromise = new Promise<void>((r) => {
      llmEntered = r;
    });

    const turns: ConversationTurnInput[] = Array.from({ length: 12 }, (_, i) => ({
      turnId: `edge-${i}`,
      sessionId: 'sess-edge',
      at: now,
      userText: `偏好配置 ${i}：默认使用 vitest 运行测试套件。`,
      assistantText: '已确认使用 vitest。',
    }));

    const rt = createSleepRuntime({
      storageRoot,
      clock: { wall: () => now, mono: () => now - T0 + 1_000 },
      sense: senseH.api,
      drives: drivesH.api,
      conversations: {
        listCompletedOrdinaryTurns: () => turns,
        anyOrdinarySessionRunning: () => false,
        onOrdinaryActivity: () => () => {},
      },
      llmExtract: async () => {
        llmEntered?.();
        await new Promise<void>((r) => {
          unblockLlm = r;
        });
        return JSON.stringify([
          {
            kind: 'preference',
            title: '默认使用 vitest 运行单元测试',
            content: '工作区单测统一执行 vitest run。',
            tags: ['vitest'],
            topicKey: 'preference:test-runner',
            confidence: 0.92,
          },
        ]);
      },
    });

    await rt.start();
    try {
      await expect(
        rt.actions.createMemory({ kind: 'preference', title: '   \u200b\n ', content: 'valid' }),
      ).rejects.toThrow(/required/);
      await expect(rt.actions.deleteMemory('nonexistent_id')).rejects.toThrow(/not found/);

      now += 10 * MIN - 1_000;
      expect(rt.panelModel().drive.quietWindow).toBe(false);

      const preExisting = await rt.actions.createMemory({
        kind: 'decision',
        title: '待删除的旧草稿',
        content: '整合期间将被手动删除',
      });
      const consolidateTask = rt.actions.consolidateNow();
      await llmEnteredPromise;

      const concurrentCreated = await rt.actions.createMemory({
        kind: 'pitfall',
        title: '在途并发新建的避坑记录',
        content: '必须在 REM 提交点读取最新记忆库快照。',
        pinned: true,
      });
      await rt.actions.deleteMemory(preExisting.id);

      unblockLlm?.();
      await consolidateTask;

      const finalIds = rt.panelModel().memories.map((m) => m.id);
      expect(finalIds).toContain(concurrentCreated.id);
      expect(finalIds).not.toContain(preExisting.id);
      expect(rt.panelModel().memories.some((m) => m.title.includes('vitest'))).toBe(true);
    } finally {
      await rt.stop();
    }
  });

  it('回归防护：活跃会话超 2,200 轮对话与进程重启后水位线零驱逐（绝不死循环重复消耗自动配额），且手动整合抢占在途自动整合零竞态', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'asi-sleep-watermark-'));
    tempDirs.push(storageRoot);

    let now = T0;
    const senseH = makeSenseHarness(() => now);
    const drivesH = makeDrivesHarness(senseH.api, () => now);

    // 构造 2,250 轮活跃会话历史（包含带 seq 的 DSH 事件轮次与不带 seq 的普通轮次）
    const turns: ConversationTurnInput[] = [];
    for (let s = 1; s <= 3; s += 1) {
      for (let i = 1; i <= 750; i += 1) {
        turns.push({
          turnId: `t-${s}-${i}`,
          sessionId: `long-sess-${s}`,
          ...(s <= 2 ? { seq: i * 4 } : {}),
          at: T0 + i * 100,
          userText: i === 750 ? `第 ${s} 会话结论：决定采用 MiniSearch 检索 (${s})` : `普通进展讨论 ${i}`,
          assistantText: '已完成步骤。',
        });
      }
    }

    const rt1 = createSleepRuntime({
      storageRoot,
      clock: { wall: () => now, mono: () => now - T0 + 1_000 },
      sense: senseH.api,
      drives: drivesH.api,
      conversations: {
        listCompletedOrdinaryTurns: () => turns,
        anyOrdinarySessionRunning: () => false,
        onOrdinaryActivity: () => () => {},
      },
    });

    await rt1.start();
    try {
      expect(rt1.panelModel().drive.unconsolidatedTurns).toBe(2_250);
      senseH.setLocked(true);
      await vi.waitFor(
        () => {
          expect(rt1.panelModel().consolidating).toBe(false);
          expect(rt1.panelModel().drive.autoRunsToday).toBe(1);
        },
        { timeout: 5_000 },
      );
      expect(rt1.panelModel().drive.unconsolidatedTurns).toBe(0);
      expect(rt1.panelModel().drive.satisfaction).toBe(100);

      // 连续发出多次锁屏感官心跳：绝不因 >2,000 轮驱逐而死循环消耗第 2..6 次自动配额！
      for (let tick = 0; tick < 4; tick += 1) {
        now += 5_000;
        senseH.emit();
        await new Promise((r) => setTimeout(r, 15));
      }
      expect(rt1.panelModel().drive.autoRunsToday).toBe(1);
      expect(rt1.panelModel().drive.unconsolidatedTurns).toBe(0);
    } finally {
      await rt1.stop();
    }

    // 模拟进程重启后重新挂载同一 storageRoot：2,250 轮历史依然保持 0 未整合
    const rt2 = createSleepRuntime({
      storageRoot,
      clock: { wall: () => now, mono: () => now - T0 + 1_000 },
      sense: senseH.api,
      drives: drivesH.api,
      conversations: {
        listCompletedOrdinaryTurns: () => turns,
        anyOrdinarySessionRunning: () => false,
        onOrdinaryActivity: () => () => {},
      },
    });

    let slowAutoStarted: (() => void) | undefined;
    const slowAutoEntered = new Promise<void>((r) => {
      slowAutoStarted = r;
    });
    let llmCallCount = 0;

    const rtPreempt = createSleepRuntime({
      storageRoot: await mkdtemp(join(tmpdir(), 'asi-sleep-manual-race-')).then((d) => {
        tempDirs.push(d);
        return d;
      }),
      clock: { wall: () => now, mono: () => now - T0 + 1_000 },
      sense: senseH.api,
      drives: drivesH.api,
      conversations: {
        listCompletedOrdinaryTurns: () => turns.slice(0, 14),
        anyOrdinarySessionRunning: () => false,
        onOrdinaryActivity: () => () => {},
      },
      llmExtract: async (_prompt, signal) => {
        llmCallCount += 1;
        if (llmCallCount === 1) {
          slowAutoStarted?.();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                // 在 abort 回调期间故意触发感官广播，验证不会抢跑新的 auto 任务压过 manual！
                senseH.emit();
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
              },
              { once: true },
            );
          });
        }
        // manual 执行期间突发 L1 不适，手动整合不应被中断！
        drivesH.setL1Distressed(true);
        return '[]';
      },
    });

    await rt2.start();
    await rtPreempt.start();
    try {
      expect(rt2.panelModel().drive.unconsolidatedTurns).toBe(0);

      await slowAutoEntered;
      const manualRec = await rtPreempt.actions.consolidateNow();
      expect(manualRec.trigger).toBe('manual');
      expect(manualRec.turnsProcessed).toBe(14);
      expect(rtPreempt.panelModel().drive.autoRunsToday).toBe(0);
    } finally {
      await rtPreempt.stop();
      await rt2.stop();
    }
  });
});
