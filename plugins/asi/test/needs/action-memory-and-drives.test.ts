import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { type Agent, emitAgentEvent } from '@deepseek-ai/dsh-agent';
import { createScope } from '@deepseek-ai/dsh-scope';
import { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native';
import ToolsService, { defineTool } from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionOutcomeLedger, buildActionMeasurement } from '../../src/needs/host/action-memory.js';
import { EXTERNAL_CACHE_ACTIVE_PROTECTION_MS } from '../../src/needs/host/cache-catalog.js';
import * as AsiNeedsPlugin from '../../src/needs/host/dsh/index.js';
import { createNeedsRuntime, ORPHAN_HIGHER_CARD_GRACE_MS } from '../../src/needs/host/runtime.js';
import * as AsiSensePlugin from '../../src/sense/host/dsh/index.js';
import { createMockSenseService, fact, makeSnapshot, T0 } from './fixtures.js';

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

function makeScopedAgent(root: Context, id: string, cwd?: string): Agent {
  const agent = {
    id: SessionId(id),
    status: 'idle' as const,
    ...(cwd ? { session: { header: { cwd } } } : {}),
  } as { id: SessionId; status: 'idle'; session?: { header: { cwd: string } }; ctx?: Context };
  agent.ctx = createScope(root, agent).ctx;
  return agent as unknown as Agent;
}

describe('0.3.0 全景嗅探、一键外部缓存批准清理、行动效果记忆熔断与 ctx.asiDrives 跨插件仲裁', () => {
  it('无人值守仅清理自有临时区并生成带受控 targetId 的求助卡；用户点击批准清理后释放 >1h 陈旧缓存、保留 1h 内活跃项与废纸篓，并记入收益账本', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'asi-030-ext-approve-'));
    tempDirs.push(rootDir);
    const storageRoot = join(rootDir, 'needs-data');
    const fakeHome = join(rootDir, 'home');

    const derived = join(fakeHome, 'Library', 'Developer', 'Xcode', 'DerivedData');
    const brew = join(fakeHome, 'Library', 'Caches', 'Homebrew');
    const trash = join(fakeHome, '.Trash');
    await mkdir(join(storageRoot, 'tmp'), { recursive: true });
    await mkdir(derived, { recursive: true });
    await mkdir(brew, { recursive: true });
    await mkdir(trash, { recursive: true });

    const ownTmpFile = join(storageRoot, 'tmp', 'asi-temp.bin');
    const staleBrewFile = join(brew, 'bottle-1.0.tar.gz');
    const staleCacheFile = join(derived, 'stale-build.bin');
    const activeCacheFile = join(derived, 'active-build.bin');
    const trashFile = join(trash, 'user-trash.zip');

    await writeFile(ownTmpFile, Buffer.alloc(4096));
    await writeFile(staleBrewFile, Buffer.alloc(49_152));
    await writeFile(staleCacheFile, Buffer.alloc(32_768));
    await writeFile(activeCacheFile, Buffer.alloc(8192));
    await writeFile(trashFile, Buffer.alloc(65_536));

    await setMtime(staleBrewFile, T0 - 3 * EXTERNAL_CACHE_ACTIVE_PROTECTION_MS);
    await setMtime(staleCacheFile, T0 - 2 * EXTERNAL_CACHE_ACTIVE_PROTECTION_MS);
    await setMtime(activeCacheFile, T0 - 10 * 60_000); // 10 分钟前活跃编译文件

    let diskFreeBytes = 10 * 1024 ** 3; // 10 GB / 200 GB (5% -> uncomfortable)
    const lowDiskSnap = makeSnapshot({ now: T0, mono: 1_000 });
    lowDiskSnap.state.self.body.disks = {
      kind: 'disks',
      ...fact([{ mount: '/', total: 200 * 1024 ** 3, free: diskFreeBytes }]),
    };

    const sense = createMockSenseService(lowDiskSnap, storageRoot, (cur) => {
      const next = structuredClone(cur);
      next.state.self.body.disks = {
        kind: 'disks',
        ...fact([{ mount: '/', total: 200 * 1024 ** 3, free: diskFreeBytes }]),
      };
      return next;
    });

    let sniffSnapshot: Awaited<ReturnType<typeof runtime.tools.sniffCauses>> | undefined;
    const runtime = createNeedsRuntime({
      storageRoot,
      homeDir: fakeHome,
      sense,
      clock: { wall: () => T0, mono: () => 1_000 },
      probeEndpoint: async () => true,
      execProcessPs: async () => ' 901 1 1048576 62.5 6.4 /Applications/Xcode.app/Contents/MacOS/Xcode\n',
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => id,
        hasSession: () => true,
        runMaintenanceTurn: async () => {
          sniffSnapshot = await runtime.tools.sniffCauses();
          await runtime.tools.cleanCache();
        },
        deliverCryToUserSession: async () => true,
      },
    });

    await runtime.start();
    try {
      await vi.waitFor(() => {
        expect(sniffSnapshot).toBeDefined();
        expect(runtime.snapshot().maintenanceSession.turnCount).toBe(1);
        expect(runtime.snapshot().maintenanceSession.status).toBe('idle');
      });
      expect(sniffSnapshot?.externalCaches.map((c) => c.targetId)).toEqual(['homebrew', 'xcode-derived-data']);
      expect(sniffSnapshot?.externalCaches[1]?.totalBytes).toBe(32_768 + 8192);
      expect(sniffSnapshot?.externalCaches[1]?.reclaimableBytes).toBe(32_768);
      expect(sniffSnapshot?.trash.totalBytes).toBe(65_536);
      expect(sniffSnapshot?.topProcesses.byCpu[0]?.name).toBe('Xcode');

      // 无人值守自维护只删掉了 ASI 自有临时文件，外部缓存与废纸篓均未触碰！
      await expect(stat(ownTmpFile)).rejects.toThrow();
      expect((await stat(staleBrewFile)).isFile()).toBe(true);
      expect((await stat(staleCacheFile)).isFile()).toBe(true);
      expect((await stat(activeCacheFile)).isFile()).toBe(true);
      expect((await stat(trashFile)).isFile()).toBe(true);

      // 自动生成带受控白名单 targetId 的头号外部缓存大户（homebrew）求助卡
      await vi.waitFor(() => {
        const firstCard = runtime
          .snapshot()
          .helpCards.find((c) => c.status === 'open' && c.actionKind === 'clean-external-cache');
        expect(firstCard?.actionTarget).toBe('homebrew');
      });
      const brewCard = runtime
        .snapshot()
        .helpCards.find((c) => c.status === 'open' && c.actionKind === 'clean-external-cache');
      if (!brewCard) throw new Error('missing brewCard');

      // 拒绝任意路径、废纸篓以及本机 0 字节不可清理的目标（防止幻觉挂出空批准卡）
      await expect(
        runtime.tools.requestHelp({
          need: 'space',
          title: '非法路径测试',
          summary: '测试拒绝任意路径',
          actionKind: 'clean-external-cache',
          actionTarget: '/tmp/evil-path',
        }),
      ).rejects.toThrow(/whitelisted targetId/);
      await expect(
        runtime.tools.requestHelp({
          need: 'space',
          title: '非法废纸篓测试',
          summary: '测试拒绝废纸篓清理',
          actionKind: 'clean-external-cache',
          actionTarget: 'macos-trash',
        }),
      ).rejects.toThrow(/whitelisted targetId/);
      await expect(
        runtime.tools.requestHelp({
          need: 'space',
          title: '空外部缓存目标测试',
          summary: '本机不存在 playwright 缓存',
          actionKind: 'clean-external-cache',
          actionTarget: 'playwright-browsers',
        }),
      ).rejects.toThrow(/0 reclaimable bytes/);

      // 第一步批准清理 homebrew 后磁盘仍偏紧（12 GB / 200 GB）-> 自动跟进挂出第二大户 xcode-derived-data 求助卡！
      diskFreeBytes = 12 * 1024 ** 3;
      await runtime.actions.approveHelp(brewCard.id);
      await expect(stat(staleBrewFile)).rejects.toThrow();

      const extCard = runtime
        .snapshot()
        .helpCards.find((c) => c.status === 'open' && c.actionKind === 'clean-external-cache');
      expect(extCard).toBeDefined();
      if (!extCard) throw new Error('missing second extCard');
      expect(extCard.actionTarget).toBe('xcode-derived-data');
      expect(extCard.summary).toContain('废纸篓');

      // 第二步点击「批准清理外部缓存」清理 xcode-derived-data：模拟释放空间后磁盘余量回升舒适区
      diskFreeBytes = 45 * 1024 ** 3;
      await runtime.actions.approveHelp(extCard.id);

      // 陈旧缓存（>1h）被直接清除，10 分钟内活跃子项与废纸篓完好保留！
      await expect(stat(staleCacheFile)).rejects.toThrow();
      expect((await stat(activeCacheFile)).isFile()).toBe(true);
      expect((await stat(trashFile)).isFile()).toBe(true);

      // 收益账本实测记录释放字节数与满足度提升 Δ
      const snap = runtime.snapshot();
      const extLedger = snap.actionLedger?.find((e) => e.action === 'clean-external-cache:xcode-derived-data');
      expect(extLedger).toBeDefined();
      expect(extLedger?.effectiveCount).toBe(1);
      expect(extLedger?.totalFreedBytes).toBe(32_768);
      expect(extLedger?.totalSatisfactionDelta).toBeGreaterThan(0);
    } finally {
      await runtime.stop();
    }
  });

  it('零收益静默熔断：安全自救无收益且已挂出求助卡时熔断省 Token，跨重启保持，并在环境实质变化、升级 critical 或用户批准时精确解除；唤醒提示词注入历史有效率推荐', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'asi-030-breaker-'));
    tempDirs.push(storageRoot);

    let nowWall = T0;
    let nowMono = 1_000;
    let diskFree = 14 * 1024 ** 3; // 7% -> uncomfortable

    const makeDiskSnap = () => {
      const s = makeSnapshot({ now: nowWall, mono: nowMono });
      s.state.self.body.disks = {
        kind: 'disks',
        ...fact([{ mount: '/', total: 200 * 1024 ** 3, free: diskFree }]),
      };
      return s;
    };

    const sense1 = createMockSenseService(makeDiskSnap(), storageRoot);
    let maintTurns1 = 0;
    const prompts1: string[] = [];

    const rt1 = createNeedsRuntime({
      storageRoot,
      sense: sense1,
      clock: { wall: () => nowWall, mono: () => nowMono },
      probeEndpoint: async () => true,
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => id,
        hasSession: () => true,
        runMaintenanceTurn: async (_sid, prompt) => {
          maintTurns1 += 1;
          prompts1.push(prompt);
          // 尝试自有缓存清理（0 字节收益）并挂出求助卡
          await rt1.tools.cleanCache();
          await rt1.tools.requestHelp({
            need: 'space',
            severity: 'uncomfortable',
            title: '用户目录视频占满磁盘',
            summary: '安全清理无可释放项，请人工清理大文件',
            actionKind: 'acknowledge',
          });
        },
        deliverCryToUserSession: async () => true,
      },
    });

    await rt1.start();
    try {
      await vi.waitFor(() => {
        expect(maintTurns1).toBe(1);
        expect(rt1.snapshot().maintenanceSession.status).toBe('idle');
      });
      expect(rt1.snapshot().maintenanceSession.circuitBrokenNeeds).toContain('space');

      // 跨过 120s 冷却（+180s、+360s）且仅有微小抖动（< 50MB）：零收益静默熔断生效，绝不重复拉起大模型！
      nowWall += 180_000;
      nowMono += 180_000;
      diskFree -= 20 * 1024 ** 2;
      sense1.emit(() => makeDiskSnap());
      await new Promise((r) => setTimeout(r, 25));
      expect(maintTurns1).toBe(1);

      nowWall += 180_000;
      nowMono += 180_000;
      sense1.emit(() => makeDiskSnap());
      await new Promise((r) => setTimeout(r, 25));
      expect(maintTurns1).toBe(1);
    } finally {
      await rt1.stop();
    }

    // 重启为 rt2：从持久化 state.json 恢复熔断器与动作收益账本，无环境变化时仍保持静默不拉起模型
    const sense2 = createMockSenseService(makeDiskSnap(), storageRoot);
    let maintTurns2 = 0;
    const prompts2: string[] = [];

    const rt2 = createNeedsRuntime({
      storageRoot,
      sense: sense2,
      clock: { wall: () => nowWall, mono: () => nowMono },
      probeEndpoint: async () => true,
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => id,
        hasSession: () => true,
        runMaintenanceTurn: async (_sid, prompt) => {
          maintTurns2 += 1;
          prompts2.push(prompt);
        },
        deliverCryToUserSession: async () => true,
      },
    });

    await rt2.start();
    try {
      await new Promise((r) => setTimeout(r, 25));
      expect(maintTurns2).toBe(0);
      expect(rt2.snapshot().maintenanceSession.circuitBrokenNeeds).toContain('space');
      expect(rt2.snapshot().actionLedger?.some((e) => e.action === 'needs_clean_cache' && e.attempts === 1)).toBe(true);

      // 解除条件 1：环境出现实质变化（磁盘减少 3 GB 至 11 GB / 5.5%，仍处于 uncomfortable 但超过 512MB 变化阈值）-> 自动解除熔断拉起一次，且提示词携带历史零收益记忆！
      nowWall += 150_000;
      nowMono += 150_000;
      diskFree = 11 * 1024 ** 3;
      sense2.emit(() => makeDiskSnap());
      await vi.waitFor(() => {
        expect(maintTurns2).toBe(1);
        expect(rt2.snapshot().maintenanceSession.status).toBe('idle');
      });
      expect(prompts2[0]).toContain('Action-Outcome Memory');
      expect(prompts2[0]).toContain('needs_clean_cache');

      // 本轮依然无收益且求助卡仍 open -> 再次进入熔断
      expect(rt2.snapshot().maintenanceSession.circuitBrokenNeeds).toContain('space');

      // 解除条件 2：恶化升级到 critical（磁盘仅剩 1.5 GB）-> 立即突破熔断与冷却！
      nowWall += 20_000;
      nowMono += 20_000;
      diskFree = 1.5 * 1024 ** 3;
      sense2.emit(() => makeDiskSnap());
      await vi.waitFor(() => {
        expect(maintTurns2).toBe(2);
        expect(rt2.snapshot().maintenanceSession.status).toBe('idle');
      });

      // 解除条件 3：用户点击求助卡「我已处理」(approveHelp) -> 解除熔断跑一次复核，若仍零收益则自动重新闭合熔断，绝不后续无限空转！
      expect(rt2.snapshot().maintenanceSession.circuitBrokenNeeds).toContain('space');
      const openCard = rt2.snapshot().helpCards.find((c) => c.need === 'space' && c.status === 'open');
      if (!openCard) throw new Error('missing openCard');
      nowWall += 150_000;
      nowMono += 150_000;
      await rt2.actions.approveHelp(openCard.id);
      await vi.waitFor(() => {
        expect(maintTurns2).toBe(3);
        expect(rt2.snapshot().maintenanceSession.status).toBe('idle');
      });
      expect(rt2.snapshot().maintenanceSession.circuitBrokenNeeds).toContain('space');

      // 再推进 180s：即使卡片已变成 approved（无 open 卡），熔断依然稳固生效，不再每 120s 泄漏 Token！
      nowWall += 180_000;
      nowMono += 180_000;
      sense2.emit(() => makeDiskSnap());
      await new Promise((r) => setTimeout(r, 25));
      expect(maintTurns2).toBe(3);

      // 新剧集测试「忽略」(dismissHelp)：恢复舒适后再次跌入 uncomfortable 并直接忽略求助卡，立即进入静默熔断不空转
      diskFree = 80 * 1024 ** 3;
      sense2.emit(() => makeDiskSnap());
      await vi.waitFor(() => expect(rt2.snapshot().needs.space.zone).toBe('comfortable'));

      nowWall += 180_000;
      nowMono += 180_000;
      diskFree = 14 * 1024 ** 3;
      sense2.emit(() => makeDiskSnap());
      await vi.waitFor(() => {
        expect(maintTurns2).toBe(4);
        expect(rt2.snapshot().maintenanceSession.status).toBe('idle');
      });
      const { card: dismissTargetCard } = await rt2.tools.requestHelp({
        need: 'space',
        severity: 'uncomfortable',
        title: '忽略后静默测试',
        summary: '用户暂不清理',
      });
      await rt2.actions.dismissHelp(dismissTargetCard.id);
      expect(rt2.snapshot().maintenanceSession.circuitBrokenNeeds).toContain('space');

      nowWall += 180_000;
      nowMono += 180_000;
      sense2.emit(() => makeDiskSnap());
      await new Promise((r) => setTimeout(r, 25));
      expect(maintTurns2).toBe(4);

      // 校验账本推荐逻辑：早期成功 1 次但随后连续失败 4 次（1/5，lastEffective=false）的动作标为近期零收益，不再盲目优先推荐
      const ledger = new ActionOutcomeLedger();
      ledger.record({
        need: 'space',
        action: 'needs_clean_cache',
        at: 1,
        gain: buildActionMeasurement({ freedBytes: 1024 }),
      });
      for (let i = 0; i < 4; i += 1) {
        ledger.record({ need: 'space', action: 'needs_clean_cache', at: 2 + i, gain: buildActionMeasurement({}) });
      }
      const recText = ledger.formatPromptRecommendations(['space']).join('\n');
      expect(recText).toContain('近期零收益，1/5 有效');
      expect(recText).not.toContain('优先推荐历史有效动作');
    } finally {
      await rt2.stop();
    }
  });

  it('ctx.asiDrives 跨插件马斯洛多层仲裁：L1 不适或 eco 模式时自动压制 L2/L3 需求与沙盒工具；恢复正常后共享预算唤醒并计量高阶工具收益', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-030-drives-cordis-'));
    tempDirs.push(dir);

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
    let runTurnHook: ((agent: Agent, prompt: string) => Promise<void>) | undefined;

    root.provide('agents', {
      list: () => agentsList,
      get: (id: string) => agentsList.find((a) => a.id === id),
    });
    root.provide('jobs', {
      list: () => [],
      kill: () => 'already-finished',
      events: { subscribe: () => () => {} },
    });
    root.provide('llm', {
      listConfigurableProviders: () => [],
      resolveModelInfo: async () => undefined,
    });
    root.provide('sessionProjections', { snapshot: () => ({ values: {} }) });
    root.provide('sessions', { list: () => [] });
    root.provide('tokenMeter', { contextPressure: () => ({}) });
    root.provide('profileContext', {
      name: 'fixture',
      dir,
      patchPath: '',
      installAnchor: '',
      cwd: '',
      home: '',
      startedBundles: [],
      overlays: [],
      telemetryDisabledEnv: undefined,
    });
    root.provide('sessionController', {
      create: async (req: { cwd?: string; sessionId?: string }) => {
        await new Promise((r) => setTimeout(r, 15));
        const sid = req.sessionId ?? 'maint-1';
        const maintAgent = {
          id: SessionId(sid),
          status: 'idle' as const,
          session: { header: { cwd: req.cwd ?? '' } },
          followup: (msg: { content: { text: string }[] }) => {
            const prompt = msg.content[0]?.text ?? '';
            void runTurnHook?.(maintAgent as unknown as Agent, prompt);
          },
          send: () => {},
          cancel: () => {},
          whenIdle: async () => {},
        } as unknown as Agent & { ctx: Context };
        maintAgent.ctx = createScope(root, maintAgent).ctx;
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

    const senseFork = await root.plugin(AsiSensePlugin, {
      storageRoot: join(dir, 'sense'),
      helperPath: join(dir, 'nonexistent-helper'),
      intervalMs: 10_000,
    });
    const needsFork = await root.plugin(AsiNeedsPlugin, {
      storageRoot: join(dir, 'needs'),
    });

    try {
      expect(root.asiDrives).toBeDefined();

      // 校验非法注册拦截：禁止占用 L1 或覆盖危险工具名 shell
      expect(() =>
        root.asiDrives.registerSource({
          id: 'bad-tier',
          tier: 1 as never,
          label: 'bad',
          evaluate: () => [],
        }),
      ).toThrow(/tier must be 2, 3, or 4/);
      expect(() =>
        root.asiDrives.registerSource({
          id: 'bad-tool',
          tier: 2,
          label: 'bad',
          evaluate: () => [],
          sandboxTools: [{ name: 'shell', description: 'evil', execute: async () => ({ summary: 'x' }) }],
        }),
      ).toThrow(/Forbidden or reserved sandbox tool name/);

      // 先切换至 eco 模式验证高阶压制
      await root.asiSense.setPowerMode('eco', '模拟节能模式');

      let sleepSatisfaction = 40; // L2 不适
      let sleepToolRuns = 0;
      let maintWakeups = 0;
      const promptsSeen: string[] = [];

      runTurnHook = async (maintAgent, prompt) => {
        maintWakeups += 1;
        promptsSeen.push(prompt);
        const execTool = root.tools.executable('sleep_consolidate_notes', maintAgent);
        if (execTool) {
          await execTool.execute({ batchSize: 3 }, {
            agent: maintAgent,
            signal: new AbortController().signal,
            callId: 'call-sleep-1' as never,
          } as never);
        }
      };

      const disposeSleep = root.asiDrives.registerSource({
        id: 'asi-sleep',
        tier: 2,
        label: '离线睡眠整理',
        evaluate: () => [
          {
            key: 'consolidation',
            label: '记忆离线巩固',
            satisfaction: sleepSatisfaction,
            summary: sleepSatisfaction < 70 ? '待巩固碎片记忆 12 条' : '记忆碎片已全部巩固',
            evidence: { fragments: sleepSatisfaction < 70 ? 12 : 0 },
          },
        ],
        sandboxTools: [
          {
            name: 'sleep_consolidate_notes',
            description: 'Consolidate episodic fragments during idle sleep cycle',
            driveKey: 'consolidation',
            parameters: {
              batchSize: { type: 'number', description: 'Max fragments to merge', required: true },
            },
            execute: async () => {
              sleepToolRuns += 1;
              sleepSatisfaction = 92;
              return {
                summary: '成功离线合并 12 条碎片记忆',
                tokensSaved: 6_400,
              };
            },
          },
        ],
      });

      const disposeCare = root.asiDrives.registerSource({
        id: 'asi-care',
        tier: 3,
        label: '主动关怀',
        evaluate: () => [
          {
            key: 'digest',
            label: '每日摘要预热',
            satisfaction: 50,
            summary: '待生成本地摘要',
          },
        ],
      });

      // 普通用户对话绝不可见 needs_sniff_causes 或 sleep_consolidate_notes
      const ordinaryUser = makeScopedAgent(root, 'ordinary-user-chat');
      agentsList.push(ordinaryUser);
      emitAgentEvent(root, ordinaryUser, 'agent/created', { source: 'startup' });
      const userTools = root.tools.definitions(ordinaryUser).map((d) => d.name);
      expect(userTools).toContain('needs_status');
      expect(userTools).not.toContain('needs_sniff_causes');
      expect(userTools).not.toContain('sleep_consolidate_notes');

      // 阶段 1：处于 eco 模式时，L2/L3 全部被自动压制挂起，后台自维护不会为高阶需求唤醒！
      await new Promise((r) => setTimeout(r, 40));
      const suppressedSnap = root.asiDrives.snapshot();
      expect(suppressedSnap.higherOrderSuppressed).toBe(true);
      expect(suppressedSnap.activeTier).toBeNull();
      expect(suppressedSnap.drives.find((d) => d.key === 'asi-sleep:consolidation')?.suppressed).toBe(true);
      expect(maintWakeups).toBe(0);

      // 阶段 2：恢复 normal 采样且连续刷新多个感官快照 -> 自动解除高阶压制，在首次建会话窗口内仅建 1 个会话并仅执行 1 轮维护！
      await Promise.all([root.asiSense.setPowerMode('normal'), root.asiSense.refresh?.(), root.asiSense.refresh?.()]);
      await vi.waitFor(() => {
        expect(sleepToolRuns).toBe(1);
        expect(root.asiDrives.snapshot().drives.find((d) => d.key === 'asi-sleep:consolidation')?.zone).toBe(
          'comfortable',
        );
      });
      expect(maintWakeups).toBe(1);
      expect(promptsSeen[0]).toContain('L2 · 记忆离线巩固 (asi-sleep:consolidation)');

      // 若此时再次切回 eco，即使在自维护会话中也立即由 guard 拦截高阶沙盒工具！
      const maintAgents = agentsList.filter((a) => a.id !== 'ordinary-user-chat');
      expect(maintAgents).toHaveLength(1);
      const maintAgent = maintAgents[0];
      expect(maintAgent).toBeDefined();
      if (!maintAgent) throw new Error('missing maintAgent');
      await root.asiSense.setPowerMode('eco', '高温节能');
      const blockedByEco = root.tools.checkGuards({
        name: 'sleep_consolidate_notes',
        agent: maintAgent,
      } as never);
      expect(blockedByEco?.reason).toContain('高阶需求已挂起');

      // 注销外部插件源后，其驱动与沙盒工具立即从仲裁快照和自维护会话卸载
      disposeSleep();
      disposeCare();
      expect(root.asiDrives.snapshot().drives.every((d) => d.tier === 1)).toBe(true);
      expect(root.tools.executable('sleep_consolidate_notes', maintAgent)).toBeUndefined();
    } finally {
      await needsFork.dispose();
      await senseFork.dispose();
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it('高阶回合运行中途突遇 L1 危机或 eco 时立即抢占中断且不误记熔断；高阶熔断跨短暂 eco 保持并在 evidence 变更时精准唤醒；省略 driveKey 自动关联收益', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'asi-030-drives-preempt-'));
    tempDirs.push(storageRoot);

    let nowWall = T0;
    let nowMono = 1_000;
    let diskFree = 80 * 1024 ** 3; // L1 舒适

    const makeSnap = () => {
      const s = makeSnapshot({ now: nowWall, mono: nowMono });
      s.settings.sendTitles = false;
      s.state.env.focusedWindow = fact({ title: 'Secret Private Title' });
      s.state.self.body.disks = {
        kind: 'disks',
        ...fact([{ mount: '/', total: 200 * 1024 ** 3, free: diskFree }]),
      };
      return s;
    };

    const sense = createMockSenseService(makeSnap(), storageRoot);
    const seenSignals: AbortSignal[] = [];
    let releaseHigherTurn: (() => void) | undefined;
    let l1PreemptRuns = 0;
    let higherRuns = 0;

    const rt = createNeedsRuntime({
      storageRoot,
      sense,
      clock: { wall: () => nowWall, mono: () => nowMono },
      probeEndpoint: async () => true,
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => id,
        hasSession: () => true,
        runMaintenanceTurn: async (_sid, prompt, signal) => {
          seenSignals.push(signal);
          if (prompt.includes('[L1 ·')) {
            l1PreemptRuns += 1;
            return;
          }
          higherRuns += 1;
          if (higherRuns === 1) {
            await new Promise<void>((resolve) => {
              releaseHigherTurn = resolve;
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
          } else if (higherRuns === 3) {
            const tool = rt.drives.registeredSandboxTools()[0];
            if (tool) {
              await rt.drives.executeSandboxTool(tool, {}, signal);
            }
          }
        },
        deliverCryToUserSession: async () => true,
      },
    });

    await rt.start();
    try {
      let careSat = 40;
      let careFragments = 5;
      let windowSeenByPlugin: unknown = 'unset';

      rt.drives.registerSource({
        id: 'asi-care',
        tier: 3,
        label: '主动关怀',
        evaluate: (snap) => {
          windowSeenByPlugin = snap.state.env.focusedWindow.value;
          // 尝试原地篡改传入快照不应污染宿主
          snap.state.self.body.thermal = fact('critical');
          return [
            {
              key: 'digest',
              label: '摘要整理',
              satisfaction: careSat,
              summary: '待整理摘要',
              evidence: { fragments: careFragments },
            },
            // 同源重复 key 自动去重
            {
              key: 'digest',
              label: '重复项',
              satisfaction: 99,
              summary: 'duplicate',
            },
          ];
        },
        sandboxTools: [
          {
            // 故意省略 driveKey，验证自动关联到 asi-care:digest 并计算满足度 Δ
            name: 'care_build_digest',
            description: 'Build local digest',
            execute: async () => {
              careSat = 95;
              return { summary: '摘要生成完毕' };
            },
          },
        ],
      });

      // sendTitles=false 时外部插件看不到窗口标题，且原地篡改快照不影响宿主 thermals
      await vi.waitFor(() => expect(higherRuns).toBe(1), { timeout: 5_000 });
      expect(windowSeenByPlugin).toBeNull();
      expect(rt.snapshot().needs.thermals.zone).toBe('comfortable');
      expect(rt.snapshot().higherOrderDrives).toHaveLength(1);
      expect(releaseHigherTurn).toBeTypeOf('function');

      // 1. 高阶回合运行中途，L1 磁盘空间突跌至 8 GB（uncomfortable）！
      // 验证：在途高阶回合 signal 立即被 abort，不被误记入 circuitBrokenNeeds，且 L1 不受高阶冷却阻塞立即接管运行！
      nowWall += 5_000;
      nowMono += 5_000;
      diskFree = 8 * 1024 ** 3;
      sense.emit(() => makeSnap());

      await vi.waitFor(
        () => {
          expect(seenSignals[0]?.aborted).toBe(true);
          expect(l1PreemptRuns).toBe(1);
          expect(rt.snapshot().maintenanceSession.status).toBe('idle');
        },
        { timeout: 5_000 },
      );
      expect(rt.snapshot().maintenanceSession.circuitBrokenNeeds ?? []).not.toContain('asi-care:digest');

      // 2. L1 磁盘恢复舒适（80 GB），跨过冷却后高阶第 2 轮运行但未调工具（零收益）-> 进入高阶静默熔断
      nowWall += 150_000;
      nowMono += 150_000;
      diskFree = 80 * 1024 ** 3;
      sense.emit(() => makeSnap());
      await vi.waitFor(
        () => {
          expect(higherRuns).toBe(2);
          expect(rt.snapshot().maintenanceSession.status).toBe('idle');
        },
        { timeout: 5_000 },
      );
      expect(rt.snapshot().maintenanceSession.circuitBrokenNeeds).toContain('asi-care:digest');

      // 短暂切换 eco 模式再恢复 normal（无 evidence 变化）：高阶熔断保持不丢失，绝不无故重跑！
      await sense.setPowerMode('eco', '临时节能');
      nowWall += 150_000;
      nowMono += 150_000;
      sense.emit(() => makeSnap());
      await sense.setPowerMode('normal');
      nowWall += 150_000;
      nowMono += 150_000;
      sense.emit(() => makeSnap());
      await new Promise((r) => setTimeout(r, 25));
      expect(higherRuns).toBe(2);
      expect(rt.snapshot().maintenanceSession.circuitBrokenNeeds).toContain('asi-care:digest');

      // 3. 插件内部 evidence 发生实质变化并调用 notifySourceChanged -> 精准解除高阶熔断，执行无 driveKey 工具并记录满足度 Δ！
      careFragments = 18;
      nowWall += 150_000;
      nowMono += 150_000;
      rt.drives.notifySourceChanged('asi-care');
      await vi.waitFor(() => {
        expect(higherRuns).toBe(3);
        expect(rt.snapshot().higherOrderDrives?.[0]?.zone).toBe('comfortable');
      });
      const careLedger = rt
        .snapshot()
        .actionLedger?.find((e) => e.need === 'asi-care:digest' && e.action === 'care_build_digest');
      expect(careLedger?.effectiveCount).toBe(1);
      expect(careLedger?.totalSatisfactionDelta).toBe(55);
    } finally {
      await rt.stop();
    }
  });

  it('并发重入护栏：首次异步建会话及会话轮换期间连续到达多个感官快照或并发调用 openMaintenanceSession/triggerCheck 时，仅建 1 个会话且仅执行 1 轮维护；建会话中途被 L1 抢占或抛错时状态与预算精确收敛', async () => {
    // 1. 首次创建自维护会话阻塞期间：并发涌入 5 帧感官快照 + 2 次 openMaintenanceSession，仅创建 1 个会话且仅执行 1 轮维护
    const dir1 = await mkdtemp(join(tmpdir(), 'asi-030-maint-mutex-1-'));
    tempDirs.push(dir1);

    let nowWall = T0;
    let nowMono = 1_000;
    let sleepSat = 38;
    const sense1 = createMockSenseService(makeSnapshot({ now: nowWall, mono: nowMono }), dir1);
    const createdSessions1: string[] = [];
    const turns1: { sid: string; prompt: string }[] = [];
    let releaseCreate1: (() => void) | undefined;
    let releaseRotate1: (() => void) | undefined;

    const rt1 = createNeedsRuntime({
      storageRoot: dir1,
      sense: sense1,
      clock: { wall: () => nowWall, mono: () => nowMono },
      probeEndpoint: async () => true,
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => {
          createdSessions1.push(id);
          if (createdSessions1.length === 1) {
            await new Promise<void>((resolve) => {
              releaseCreate1 = resolve;
            });
          } else {
            await new Promise<void>((resolve) => {
              releaseRotate1 = resolve;
            });
          }
          return id;
        },
        hasSession: (id) => createdSessions1.includes(id),
        runMaintenanceTurn: async (sid, prompt) => {
          turns1.push({ sid, prompt });
          sleepSat = 95;
        },
        deliverCryToUserSession: async () => true,
      },
    });

    await rt1.start();
    try {
      rt1.drives.registerSource({
        id: 'asi-sleep',
        tier: 2,
        label: '离线睡眠整理',
        evaluate: () => [
          {
            key: 'consolidation',
            label: '记忆离线巩固',
            satisfaction: sleepSat,
            summary: sleepSat < 70 ? '待整理碎片' : '已巩固',
            evidence: { count: sleepSat < 70 ? 8 : 0 },
          },
        ],
      });

      await vi.waitFor(() => expect(releaseCreate1).toBeTypeOf('function'));
      expect(rt1.snapshot().maintenanceSession.status).toBe('running');

      // 在首个 ensureMaintenanceSession 尚未返回时连续发射 5 次快照，并并发调用 2 次 openMaintenanceSession
      for (let i = 0; i < 5; i += 1) {
        nowWall += 200;
        nowMono += 200;
        sense1.emit((prev) => ({ ...prev, now: nowWall, mono: nowMono }));
      }
      const openP1 = rt1.actions.openMaintenanceSession();
      const openP2 = rt1.actions.openMaintenanceSession();
      await new Promise((r) => setTimeout(r, 15));

      expect(createdSessions1).toHaveLength(1);
      expect(turns1).toHaveLength(0);

      releaseCreate1?.();
      const [openedId1, openedId2] = await Promise.all([openP1, openP2]);

      await vi.waitFor(() => {
        expect(turns1).toHaveLength(1);
        expect(rt1.snapshot().maintenanceSession.status).toBe('idle');
      });
      expect(createdSessions1).toHaveLength(1);
      expect(openedId1).toBe(createdSessions1[0]);
      expect(openedId2).toBe(createdSessions1[0]);
      expect(turns1[0]?.sid).toBe(createdSessions1[0]);
      expect(rt1.snapshot().maintenanceSession.turnCount).toBe(1);

      // 手动 triggerCheck 在需求重新进入不适且未熔断时：不会因内部 scheduleProcess 先抢跑 auto-maintain 而漏跑或双跑
      sleepSat = 42;
      nowWall += 150_000;
      nowMono += 150_000;
      await rt1.actions.triggerCheck();
      expect(turns1).toHaveLength(2);
      expect(rt1.snapshot().records[0]?.action).toBe('manual-check');

      // 跑满 12 轮触发会话轮换时，轮换异步窗口内并发到达多帧快照 + openMaintenanceSession 同样复用新会话且仅跑 1 轮
      for (let i = 0; i < 10; i += 1) {
        await rt1.actions.triggerCheck();
      }
      expect(rt1.snapshot().maintenanceSession.turnCount).toBe(12);

      sleepSat = 35;
      nowWall += 150_000;
      nowMono += 150_000;
      sense1.emit((prev) => ({ ...prev, now: nowWall, mono: nowMono }));
      await vi.waitFor(() => expect(releaseRotate1).toBeTypeOf('function'));

      for (let i = 0; i < 3; i += 1) {
        nowWall += 100;
        nowMono += 100;
        sense1.emit((prev) => ({ ...prev, now: nowWall, mono: nowMono }));
      }
      const rotatedOpenPromise = rt1.actions.openMaintenanceSession();
      await new Promise((r) => setTimeout(r, 10));
      expect(createdSessions1).toHaveLength(2);

      releaseRotate1?.();
      const rotatedId = await rotatedOpenPromise;
      await vi.waitFor(() => {
        expect(turns1).toHaveLength(13);
        expect(rt1.snapshot().maintenanceSession.status).toBe('idle');
      });
      expect(createdSessions1).toHaveLength(2);
      expect(rotatedId).toBe(createdSessions1[1]);
      expect(turns1[12]?.sid).toBe(createdSessions1[1]);
    } finally {
      await rt1.stop();
    }

    // 2. 高阶需求在首次建会话尚未返回时突遇 L1 不适抢占：跳过已中止的高阶回合（不浪费配额），复用刚建好的会话立即执行 1 轮 L1 自维护
    const dir2 = await mkdtemp(join(tmpdir(), 'asi-030-maint-mutex-2-'));
    tempDirs.push(dir2);

    let wall2 = T0;
    let mono2 = 1_000;
    let diskFree2 = 80 * 1024 ** 3;
    const makeSnap2 = () => {
      const s = makeSnapshot({ now: wall2, mono: mono2 });
      s.state.self.body.disks = {
        kind: 'disks',
        ...fact([{ mount: '/', total: 200 * 1024 ** 3, free: diskFree2 }]),
      };
      return s;
    };
    const sense2 = createMockSenseService(makeSnap2(), dir2);
    const createdSessions2: string[] = [];
    const prompts2: string[] = [];
    let releaseCreate2: (() => void) | undefined;

    const rt2 = createNeedsRuntime({
      storageRoot: dir2,
      sense: sense2,
      clock: { wall: () => wall2, mono: () => mono2 },
      probeEndpoint: async () => true,
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => {
          createdSessions2.push(id);
          await new Promise<void>((resolve) => {
            releaseCreate2 = resolve;
          });
          return id;
        },
        hasSession: (id) => createdSessions2.includes(id),
        runMaintenanceTurn: async (_sid, prompt) => {
          prompts2.push(prompt);
        },
        deliverCryToUserSession: async () => true,
      },
    });

    await rt2.start();
    try {
      rt2.drives.registerSource({
        id: 'asi-care',
        tier: 3,
        label: '主动关怀',
        evaluate: () => [{ key: 'digest', label: '摘要预热', satisfaction: 40, summary: '待预热' }],
      });
      await vi.waitFor(() => expect(releaseCreate2).toBeTypeOf('function'));

      // 建会话尚未完成时 L1 磁盘跌入 uncomfortable -> 高阶回合在启动前即被抢占，放行建会话后直接跑 1 轮 L1
      wall2 += 500;
      mono2 += 500;
      diskFree2 = 10 * 1024 ** 3;
      sense2.emit(() => makeSnap2());
      await new Promise((r) => setTimeout(r, 10));

      releaseCreate2?.();
      await vi.waitFor(() => {
        expect(prompts2).toHaveLength(1);
        expect(rt2.snapshot().maintenanceSession.status).toBe('idle');
      });
      expect(createdSessions2).toHaveLength(1);
      expect(prompts2[0]).toContain('[L1 ·');
      expect(prompts2[0]).not.toContain('asi-care:digest');
    } finally {
      await rt2.stop();
    }

    // 3. 首次建会话抛错且期间涌入多帧危急快照：仅尝试建会话 1 次（按冷却退避不紧接着重撞），状态收敛为 unavailable 且仅啼哭 1 次
    const dir3 = await mkdtemp(join(tmpdir(), 'asi-030-maint-mutex-3-'));
    tempDirs.push(dir3);

    let wall3 = T0;
    let mono3 = 1_000;
    const critSnap3 = makeSnapshot({ now: wall3, mono: mono3 });
    critSnap3.state.self.body.disks = {
      kind: 'disks',
      ...fact([{ mount: '/', total: 200 * 1024 ** 3, free: 512 * 1024 ** 2 }]),
    };
    const sense3 = createMockSenseService(critSnap3, dir3);
    let createAttempts3 = 0;
    const cries3: string[] = [];
    let rejectCreate3: ((err: Error) => void) | undefined;

    const rt3 = createNeedsRuntime({
      storageRoot: dir3,
      sense: sense3,
      clock: { wall: () => wall3, mono: () => mono3 },
      probeEndpoint: async () => true,
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async () => {
          createAttempts3 += 1;
          return await new Promise<string>((_resolve, reject) => {
            rejectCreate3 = reject;
          });
        },
        hasSession: () => false,
        runMaintenanceTurn: async () => {},
        deliverCryToUserSession: async (_t, _e, content) => {
          cries3.push(content);
          return true;
        },
      },
    });

    const startPromise3 = rt3.start();
    try {
      await vi.waitFor(() => expect(rejectCreate3).toBeTypeOf('function'));
      await startPromise3;

      for (let i = 0; i < 3; i += 1) {
        wall3 += 300;
        mono3 += 300;
        sense3.emit((prev) => ({ ...prev, now: wall3, mono: mono3 }));
      }
      await new Promise((r) => setTimeout(r, 10));
      expect(createAttempts3).toBe(1);

      rejectCreate3?.(new Error('ENOSPC: no space left on device'));
      await vi.waitFor(() => {
        expect(rt3.snapshot().maintenanceSession.status).toBe('unavailable');
        expect(cries3).toHaveLength(1);
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(createAttempts3).toBe(1);
      expect(cries3).toHaveLength(1);
      expect(cries3[0]).toContain('need="space"');
      expect(cries3[0]).toContain('severity="critical"');
    } finally {
      await rt3.stop();
    }
  });

  it('深水并发边界：建会话期间新增同层/更高阶需求合并、自动回合中并发 triggerCheck 排队去重、pause/stop 中断回滚与轮换 ENOSPC 保活回退', async () => {
    // 1. 建会话异步窗口内：L3 触发建会话期间更高优先级 L2 注册，放行后在同 1 轮按马斯洛序合并处理 L2+L3（绝不漏掉 L2 并误锁 120s）；
    //    若需求在建会话完成前已自行恢复舒适，则跳过空跑并完整回滚冷却！
    const dirA = await mkdtemp(join(tmpdir(), 'asi-030-deep-merge-'));
    tempDirs.push(dirA);

    let wallA = T0;
    let monoA = 1_000;
    let careSatA = 45;
    let sleepSatA = 90;
    const senseA = createMockSenseService(makeSnapshot({ now: wallA, mono: monoA }), dirA);
    const createdA: string[] = [];
    const promptsA: string[] = [];
    let releaseCreateA: (() => void) | undefined;

    const rtA = createNeedsRuntime({
      storageRoot: dirA,
      sense: senseA,
      clock: { wall: () => wallA, mono: () => monoA },
      probeEndpoint: async () => true,
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => {
          createdA.push(id);
          await new Promise<void>((resolve) => {
            releaseCreateA = resolve;
          });
          return id;
        },
        hasSession: (id) => createdA.includes(id),
        runMaintenanceTurn: async (_sid, prompt) => {
          promptsA.push(prompt);
          careSatA = 92;
          sleepSatA = 94;
        },
        deliverCryToUserSession: async () => true,
      },
    });

    await rtA.start();
    try {
      // 先注册 L3 触发首次异步建会话
      rtA.drives.registerSource({
        id: 'asi-care',
        tier: 3,
        label: '主动关怀',
        evaluate: () => [{ key: 'digest', label: '摘要整理', satisfaction: careSatA, summary: '待生成' }],
      });
      await vi.waitFor(() => expect(releaseCreateA).toBeTypeOf('function'));

      // 建会话尚未返回时，更高优先级的 L2 睡眠巩固注册进入不适
      sleepSatA = 35;
      rtA.drives.registerSource({
        id: 'asi-sleep',
        tier: 2,
        label: '离线睡眠整理',
        evaluate: () => [{ key: 'consolidation', label: '记忆巩固', satisfaction: sleepSatA, summary: '待合并' }],
      });
      await new Promise((r) => setTimeout(r, 10));

      // 先测试“建会话完成前全部恢复舒适 -> 零回合空跑且回滚冷却”
      careSatA = 95;
      sleepSatA = 95;
      wallA += 200;
      monoA += 200;
      senseA.emit((prev) => ({ ...prev, now: wallA, mono: monoA }));
      await new Promise((r) => setTimeout(r, 10));

      releaseCreateA?.();
      await vi.waitFor(() => expect(rtA.snapshot().maintenanceSession.status).toBe('idle'));
      expect(promptsA).toHaveLength(0);
      expect(rtA.snapshot().maintenanceSession.turnCount).toBe(0);
      expect(rtA.snapshot().maintenanceSession.lastRunAt).toBeUndefined();

      // 由于空跑已回滚冷却，仅隔 5s（远小于 120s 冷却）L2 与 L3 再次进入不适即可立即唤醒并在单轮内按 L2 -> L3 序合并！
      careSatA = 45;
      sleepSatA = 35;
      wallA += 5_000;
      monoA += 5_000;
      senseA.emit((prev) => ({ ...prev, now: wallA, mono: monoA }));
      await vi.waitFor(() => {
        expect(promptsA).toHaveLength(1);
        expect(rtA.snapshot().maintenanceSession.status).toBe('idle');
      });
      const idxL2 = promptsA[0]?.indexOf('L2 · 记忆巩固 (asi-sleep:consolidation)') ?? -1;
      const idxL3 = promptsA[0]?.indexOf('L3 · 摘要整理 (asi-care:digest)') ?? -1;
      expect(idxL2).toBeGreaterThanOrEqual(0);
      expect(idxL3).toBeGreaterThan(idxL2);

      // L1 同层合并：当 memory 触发轮换建会话期间 space 也跌入 uncomfortable，单轮提示词同时包含 memory 与 space（绝不漏掉 space）
      while (rtA.snapshot().maintenanceSession.turnCount < 12) {
        await rtA.actions.triggerCheck();
      }
      const prevPromptCountA = promptsA.length;
      releaseCreateA = undefined;
      wallA += 150_000;
      monoA += 150_000;
      senseA.emit((prev) => {
        const next = structuredClone(prev);
        next.now = wallA;
        next.mono = monoA;
        next.state.self.body.memory = fact({
          total: 32 * 1024 ** 3,
          used: 30 * 1024 ** 3,
          pressure: 'warn',
          swapUsed: 2 * 1024 ** 3,
        });
        return next;
      });
      await vi.waitFor(() => expect(releaseCreateA).toBeTypeOf('function'));

      wallA += 200;
      monoA += 200;
      senseA.emit((prev) => {
        const next = structuredClone(prev);
        next.now = wallA;
        next.mono = monoA;
        next.state.self.body.disks = {
          kind: 'disks',
          ...fact([{ mount: '/', total: 200 * 1024 ** 3, free: 10 * 1024 ** 3 }]),
        };
        return next;
      });
      await new Promise((r) => setTimeout(r, 10));

      (releaseCreateA as (() => void) | undefined)?.();
      await vi.waitFor(() => {
        expect(promptsA).toHaveLength(prevPromptCountA + 1);
        expect(rtA.snapshot().maintenanceSession.status).toBe('idle');
      });
      expect(promptsA.at(-1)).toContain('内存与进程');
      expect(promptsA.at(-1)).toContain('空间');
    } finally {
      await rtA.stop();
    }

    // 2. 自动维护回合在途时（space 已静默熔断，memory 正在跑 auto-maintain），并发调用 2 次 triggerCheck()：
    //    绝不丢弃手动自检，而是在在途自动回合结束后合并执行唯一 1 轮强制巡检（覆盖已熔断的 space）！
    //    且跑满 12 轮触发会话轮换遭遇 ENOSPC 时，自动回退复用仍存活的旧会话完成自救，不误锁为 unavailable。
    const dirB = await mkdtemp(join(tmpdir(), 'asi-030-deep-manual-rotate-'));
    tempDirs.push(dirB);

    let wallB = T0;
    let monoB = 1_000;
    let diskFreeB = 10 * 1024 ** 3; // space 不适
    let hasStuckJobB = false;
    let failRotateWithEnospc = false;

    const makeSnapB = () => {
      const s = makeSnapshot({ now: wallB, mono: monoB });
      s.state.self.body.disks = {
        kind: 'disks',
        ...fact([{ mount: '/', total: 200 * 1024 ** 3, free: diskFreeB }]),
      };
      return s;
    };
    const senseB = createMockSenseService(makeSnapB(), dirB);
    const liveSessionsB = new Set<string>();
    const promptsB: string[] = [];
    let releaseAutoMemoryTurn: (() => void) | undefined;
    let releaseRotateAttempt: (() => void) | undefined;

    const rtB = createNeedsRuntime({
      storageRoot: dirB,
      sense: senseB,
      clock: { wall: () => wallB, mono: () => monoB },
      probeEndpoint: async () => true,
      jobs: {
        listActiveJobs: () =>
          hasStuckJobB ? [{ id: 'stuck-b', owner: 'dead', status: 'running', startedAt: T0 - 30 * 60_000 }] : [],
        hasLiveOwner: () => false,
        killJob: () => {
          hasStuckJobB = false;
          return 'requested';
        },
      },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => {
          if (failRotateWithEnospc) {
            await new Promise<void>((resolve) => {
              releaseRotateAttempt = resolve;
            });
            throw new Error('ENOSPC: no space left on device');
          }
          liveSessionsB.add(id);
          return id;
        },
        hasSession: (id) => liveSessionsB.has(id),
        runMaintenanceTurn: async (_sid, prompt) => {
          promptsB.push(prompt);
          if (promptsB.length === 1) {
            await rtB.tools.requestHelp({
              need: 'space',
              severity: 'uncomfortable',
              title: '磁盘偏紧',
              summary: '零收益挂卡进入熔断',
            });
          } else if (releaseAutoMemoryTurn === undefined && hasStuckJobB) {
            await new Promise<void>((resolve) => {
              releaseAutoMemoryTurn = resolve;
            });
            await rtB.tools.stopStuckJob();
          }
        },
        deliverCryToUserSession: async () => true,
      },
    });

    await rtB.start();
    try {
      // 第 1 轮自动维护后 space 进入零收益静默熔断
      await vi.waitFor(() => {
        expect(promptsB).toHaveLength(1);
        expect(rtB.snapshot().maintenanceSession.circuitBrokenNeeds).toContain('space');
      });

      // 跨过冷却后 memory 出现残留卡死任务触发在途 auto-maintain（此时自动回合跳过已熔断的 space）
      wallB += 150_000;
      monoB += 150_000;
      hasStuckJobB = true;
      senseB.emit(() => makeSnapB());
      await vi.waitFor(() => expect(releaseAutoMemoryTurn).toBeTypeOf('function'));
      expect(promptsB[1]).toContain('内存与进程');
      expect(promptsB[1]).not.toContain('空间');

      // 在自动回合尚未结束时并发连点 2 次 triggerCheck()
      const manualP1 = rtB.actions.triggerCheck();
      const manualP2 = rtB.actions.triggerCheck();
      await new Promise((r) => setTimeout(r, 15));
      expect(promptsB).toHaveLength(2);

      // 放行在途自动回合 -> 2 次并发 triggerCheck 合并排队跑且仅跑 1 轮手动自检，覆盖已熔断的 space！
      releaseAutoMemoryTurn?.();
      await Promise.all([manualP1, manualP2]);
      expect(promptsB).toHaveLength(3);
      expect(promptsB[2]).toContain('空间');
      expect(rtB.snapshot().records[0]?.action).toBe('manual-check');

      // 补足到 12 轮后触发会话轮换，模拟轮换建新会话抛 ENOSPC 且并发调用 openMaintenanceSession()
      while (rtB.snapshot().maintenanceSession.turnCount < 12) {
        await rtB.actions.triggerCheck();
      }
      const initialLiveId = rtB.snapshot().maintenanceSession.sessionId;
      expect(initialLiveId).toBeDefined();

      failRotateWithEnospc = true;
      diskFreeB = 8 * 1024 ** 3;
      const rotateCheckPromise = rtB.actions.triggerCheck();
      await vi.waitFor(() => expect(releaseRotateAttempt).toBeTypeOf('function'));
      const concurrentOpenDuringFailedRotate = rtB.actions.openMaintenanceSession();

      releaseRotateAttempt?.();
      const [openedFallbackId] = await Promise.all([concurrentOpenDuringFailedRotate, rotateCheckPromise]);
      expect(openedFallbackId).toBe(initialLiveId);
      expect(rtB.snapshot().maintenanceSession.sessionId).toBe(initialLiveId);
      expect(rtB.snapshot().maintenanceSession.status).toBe('idle');
      expect(rtB.snapshot().maintenanceSession.turnCount).toBe(13);
    } finally {
      await rtB.stop();
    }

    // 3. 在建会话失败/悬停及在途 runMaintenanceTurn 期间调用 pause(true) -> pause(false)，以及 stop() 并发注销清理：
    //    暂停立即 abort 在途回合、零啼哭泄漏、零误熔断且完整回滚冷却，恢复 pause(false) 后无需等 120s 立即唤醒！
    const dirC = await mkdtemp(join(tmpdir(), 'asi-030-deep-pause-stop-'));
    tempDirs.push(dirC);

    let wallC = T0;
    let monoC = 1_000;
    let diskFreeC = 512 * 1024 ** 2; // critical space
    const makeSnapC = () => {
      const s = makeSnapshot({ now: wallC, mono: monoC });
      s.state.self.body.disks = {
        kind: 'disks',
        ...fact([{ mount: '/', total: 200 * 1024 ** 3, free: diskFreeC }]),
      };
      return s;
    };
    const senseC = createMockSenseService(makeSnapC(), dirC, () => makeSnapC());
    const liveC = new Set<string>();
    const criesC: string[] = [];
    const seenSignalsC: AbortSignal[] = [];
    let createCallsC = 0;
    let rejectFirstCreateC: ((err: Error) => void) | undefined;
    let releaseFirstTurnC: (() => void) | undefined;
    let releaseStopCreateC: ((id: string) => void) | undefined;
    let completedTurnsC = 0;

    const rtC = createNeedsRuntime({
      storageRoot: dirC,
      sense: senseC,
      clock: { wall: () => wallC, mono: () => monoC },
      probeEndpoint: async () => true,
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => {
          createCallsC += 1;
          if (createCallsC === 1) {
            return await new Promise<string>((_resolve, reject) => {
              rejectFirstCreateC = reject;
            });
          }
          if (createCallsC === 3) {
            return await new Promise<string>((resolve) => {
              releaseStopCreateC = resolve;
            });
          }
          liveC.add(id);
          return id;
        },
        hasSession: (id) => liveC.has(id),
        runMaintenanceTurn: async (_sid, _prompt, signal) => {
          seenSignalsC.push(signal);
          if (seenSignalsC.length === 1) {
            await new Promise<void>((resolve) => {
              releaseFirstTurnC = resolve;
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
            if (signal.aborted) return;
          }
          completedTurnsC += 1;
          diskFreeC = 120 * 1024 ** 3;
        },
        deliverCryToUserSession: async (_t, _e, content) => {
          criesC.push(content);
          return true;
        },
      },
    });

    const startPromiseC = rtC.start();
    await vi.waitFor(() => expect(rejectFirstCreateC).toBeTypeOf('function'));
    await startPromiseC;

    // (a) 首次建会话悬停期间调用 pause(true)，随后建会话抛错：暂停态下绝不发 <asi-cry> 且冷却回滚
    await rtC.actions.pause(true);
    rejectFirstCreateC?.(new Error('transient session failure while pausing'));
    await new Promise((r) => setTimeout(r, 15));
    expect(criesC).toHaveLength(0);

    // 仅隔 3s 调用 pause(false)：因冷却已回滚，立即重建会话并进入首轮 runMaintenanceTurn
    wallC += 3_000;
    monoC += 3_000;
    await rtC.actions.pause(false);
    await vi.waitFor(() => expect(releaseFirstTurnC).toBeTypeOf('function'));
    expect(createCallsC).toBe(2);

    // (b) 首轮 runMaintenanceTurn 尚在运行中调用 pause(true)：立即 abort 在途回合、不计完成轮次、不发啼哭、不记熔断且回滚冷却
    await rtC.actions.pause(true);
    await vi.waitFor(() => {
      expect(seenSignalsC[0]?.aborted).toBe(true);
      expect(rtC.snapshot().maintenanceSession.status).toBe('idle');
    });
    expect(completedTurnsC).toBe(0);
    expect(criesC).toHaveLength(0);
    expect(rtC.snapshot().maintenanceSession.turnCount).toBe(0);

    // 仅隔 5s（< 120s）调用 pause(false)：立即重新运行自维护并恢复舒适！
    wallC += 5_000;
    monoC += 5_000;
    await rtC.actions.pause(false);
    await vi.waitFor(() => {
      expect(completedTurnsC).toBe(1);
      expect(rtC.snapshot().needs.space.zone).toBe('comfortable');
    });

    // (c) 模拟会话失效后新建会话悬停（且宿主重分配新 sessionId 注册）期间调用 stop()：零内部会话残留泄漏
    liveC.clear();
    const danglingOpen = rtC.actions.openMaintenanceSession();
    await vi.waitFor(() => expect(releaseStopCreateC).toBeTypeOf('function'));
    await rtC.stop();
    rtC.registerMaintenanceSessionId('reassigned-after-stop');
    releaseStopCreateC?.('reassigned-during-stop');
    await expect(danglingOpen).rejects.toThrow(/stopped/);
    expect(senseC.internalSessions().size).toBe(0);
  });

  it('高阶驱动通用求助卡回调（proposeHelpCard / executeHelpAction / onHelpDismissed / resolveHelpCards）：全程零 <asi-cry> 注入、一键批准记入账本、忽略触发熔断、恢复或注销自动归档', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'asi-030-higher-help-'));
    tempDirs.push(storageRoot);

    const sense = createMockSenseService(makeSnapshot({ now: T0, mono: 2_000 }), storageRoot);
    const cryInbox: string[] = [];
    const runtime = createNeedsRuntime({
      storageRoot,
      sense,
      clock: { wall: () => T0, mono: () => 2_000 },
      probeEndpoint: async () => true,
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => id,
        hasSession: () => true,
        runMaintenanceTurn: async () => {},
        deliverCryToUserSession: async (_t, _e, content) => {
          cryInbox.push(content);
          return true;
        },
      },
    });

    await runtime.start();
    try {
      let bloatSat = 45;
      const dismissedTargets: string[] = [];
      let approvedExecCount = 0;

      const unregister = runtime.drives.registerSource({
        id: 'asi-care',
        tier: 3,
        label: '工作区与项目看护',
        evaluate: () => [
          {
            key: 'workspace_bloat',
            label: '闲置工作树产物膨胀',
            satisfaction: bloatSat,
            summary: bloatSat < 70 ? '闲置产物 1.5 GiB' : '无积压产物',
            evidence: { idleBytes: bloatSat < 70 ? 1_500_000_000 : 0 },
          },
        ],
        executeHelpAction: async (input) => {
          approvedExecCount += 1;
          bloatSat = 100;
          return {
            ledgerAction: `clean-workspace-artifact:${input.actionTarget}`,
            summary: '已清理闲置构建产物',
            freedBytes: 1_500_000_000,
          };
        },
        onHelpDismissed: ({ actionTarget }) => {
          if (actionTarget) dismissedTargets.push(actionTarget);
        },
      });

      // 拒绝包含路径字符的非法 actionTarget
      await expect(
        runtime.drives.proposeHelpCard('asi-care', {
          driveKey: 'workspace_bloat',
          title: 'bad target',
          summary: 'bad',
          actionKind: 'run-drive-action',
          actionTarget: '/tmp/node_modules',
        }),
      ).rejects.toThrow(/non-path actionTarget/);

      // 挂出 critical 级高阶求助卡：即使处于 critical，也严禁触发 <asi-cry> 对话打扰！
      const card1 = await runtime.drives.proposeHelpCard('asi-care', {
        driveKey: 'workspace_bloat',
        severity: 'critical',
        title: '闲置产物待清理 1',
        summary: '可释放 1.5 GiB',
        actionKind: 'run-drive-action',
        actionTarget: 'art_first',
        approveLabel: '批准清理构建产物',
      });
      expect(card1.silent).toBe(true);
      expect(card1.driveLabel).toBe('L3 · 闲置工作树产物膨胀');
      expect(cryInbox).toHaveLength(0);

      // 测试忽略卡片：触发 onHelpDismissed 回调且对该 L3 驱动建立静默熔断
      await runtime.actions.dismissHelp(card1.id);
      expect(dismissedTargets).toEqual(['art_first']);
      expect(runtime.snapshot().maintenanceSession.circuitBrokenNeeds).toContain('asi-care:workspace_bloat');

      // 挂出第二张卡片并点击批准：执行 executeHelpAction、解除熔断、记录 ActionOutcomeLedger
      const card2 = await runtime.drives.proposeHelpCard('asi-care', {
        driveKey: 'workspace_bloat',
        severity: 'uncomfortable',
        title: '闲置产物待清理 2',
        summary: '可释放 1.5 GiB',
        actionKind: 'run-drive-action',
        actionTarget: 'art_second',
        approveLabel: '批准清理构建产物',
      });
      await runtime.actions.approveHelp(card2.id);
      expect(approvedExecCount).toBe(1);
      expect(runtime.snapshot().maintenanceSession.circuitBrokenNeeds ?? []).not.toContain('asi-care:workspace_bloat');
      const ledger = runtime
        .snapshot()
        .actionLedger?.find(
          (e) => e.need === 'asi-care:workspace_bloat' && e.action === 'clean-workspace-artifact:art_second',
        );
      expect(ledger?.totalFreedBytes).toBe(1_500_000_000);
      expect(ledger?.totalSatisfactionDelta).toBe(55);

      // 测试 exceptActionTargets 选择性归档与注销源时自动归档残留 open 卡
      const cardKeep = await runtime.drives.proposeHelpCard('asi-care', {
        driveKey: 'workspace_bloat',
        title: '保留项',
        summary: 'keep',
        actionKind: 'acknowledge',
        actionTarget: 'keep_tok',
      });
      await runtime.drives.proposeHelpCard('asi-care', {
        driveKey: 'workspace_bloat',
        title: '过期项',
        summary: 'stale',
        actionKind: 'acknowledge',
        actionTarget: 'stale_tok',
      });
      const resolvedStale = await runtime.drives.resolveHelpCards('asi-care', {
        exceptActionTargets: ['keep_tok'],
      });
      expect(resolvedStale).toBe(1);
      expect(runtime.snapshot().helpCards.find((c) => c.id === cardKeep.id)?.status).toBe('open');

      unregister();
      expect(runtime.snapshot().helpCards.find((c) => c.id === cardKeep.id)?.status).toBe('resolved');
      expect(cryInbox).toHaveLength(0);
    } finally {
      await runtime.stop();
    }
  });

  it('高阶熔断抗 RSS/僵尸数微小抖动不漏 Token，且高阶回合硬性拦截 L1 needs_request_help (<asi-cry>)', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'asi-030-higher-jitter-'));
    tempDirs.push(storageRoot);

    let nowWall = T0;
    let nowMono = 5_000;
    const sense = createMockSenseService(makeSnapshot({ now: nowWall, mono: nowMono }), storageRoot);
    let maintRuns = 0;
    let rejectedL1CryError = '';
    const cryInbox: string[] = [];

    const runtime = createNeedsRuntime({
      storageRoot,
      sense,
      clock: { wall: () => nowWall, mono: () => nowMono },
      probeEndpoint: async () => true,
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => id,
        hasSession: () => true,
        runMaintenanceTurn: async () => {
          maintRuns += 1;
          try {
            await runtime.tools.requestHelp({
              need: 'space',
              title: '误调 L1 啼哭',
              summary: '尝试在高阶回合发 <asi-cry>',
            });
          } catch (err) {
            rejectedL1CryError = err instanceof Error ? err.message : String(err);
          }
        },
        deliverCryToUserSession: async (_t, _e, content) => {
          cryInbox.push(content);
          return true;
        },
      },
    });

    await runtime.start();
    try {
      let rssBytes = 134_217_728; // 128 MiB
      let zombies = 0;
      let orphanPorts = 1;

      runtime.drives.registerSource({
        id: 'asi-care',
        tier: 3,
        label: '工作区与项目看护',
        evaluate: () => [
          {
            key: 'orphan_runtime',
            label: '僵尸进程与孤儿端口',
            satisfaction: 48,
            summary: '1 个孤儿端口',
            evidence: {
              orphanPorts,
              orphanJobs: 0,
              zombies,
              orphanRssBytes: rssBytes,
              topPort: 5173,
            },
          },
        ],
      });

      await vi.waitFor(() => {
        expect(maintRuns).toBe(1);
        expect(runtime.snapshot().maintenanceSession.status).toBe('idle');
      });
      // 高阶维护回合严禁调用 L1 needs_request_help，确保零 <asi-cry> 前台打断
      expect(rejectedL1CryError).toContain('forbidden during higher-order');
      expect(cryInbox).toHaveLength(0);
      expect(runtime.snapshot().maintenanceSession.circuitBrokenNeeds).toContain('asi-care:orphan_runtime');

      // 模拟 3 分钟后进程 RSS 自然抖动 +64 KiB 且出现 1 个瞬态僵尸进程 -> 熔断稳固保持，绝不唤醒大模型！
      nowWall += 180_000;
      nowMono += 180_000;
      rssBytes += 65_536;
      zombies = 1;
      runtime.drives.notifySourceChanged('asi-care');
      sense.emit(() => makeSnapshot({ now: nowWall, mono: nowMono }));
      await new Promise((r) => setTimeout(r, 30));
      expect(maintRuns).toBe(1);
      expect(runtime.snapshot().maintenanceSession.circuitBrokenNeeds).toContain('asi-care:orphan_runtime');

      // 模拟实质变化：新增第 2 个孤儿端口 -> 自动解除熔断执行新一轮自检！
      nowWall += 180_000;
      nowMono += 180_000;
      orphanPorts = 2;
      runtime.drives.notifySourceChanged('asi-care');
      sense.emit(() => makeSnapshot({ now: nowWall, mono: nowMono }));
      await vi.waitFor(() => {
        expect(maintRuns).toBe(2);
      });
      expect(cryInbox).toHaveLength(0);
    } finally {
      await runtime.stop();
    }
  });

  it('卸载高阶插件后跨重启遗留 open 求助卡的优雅回收：点击批准不抛错归档为 resolved，且宽限期后自动归档无宿主孤儿高阶卡片', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'asi-030-orphan-higher-cards-'));
    tempDirs.push(storageRoot);

    let nowWall = T0;
    let nowMono = 1_000;

    // 预置持久化 state.json：模拟卸载 asi-care 与 asi-sleep 前遗留的两张 open 高阶求助卡与一条高阶熔断记录
    await writeFile(
      join(storageRoot, 'state.json'),
      JSON.stringify(
        {
          helpCards: [
            {
              id: 'orphan-care-card-1',
              driveKey: 'asi-care:workspace_bloat',
              driveLabel: 'L3 · 闲置工作树产物膨胀',
              approveLabel: '批准清理构建产物',
              silent: true,
              severity: 'uncomfortable',
              title: '已卸载插件遗留的产物清理卡',
              summary: '历史遗留项',
              actionKind: 'run-drive-action',
              actionTarget: 'art_legacy123456',
              status: 'open',
              createdAt: nowWall - 60_000,
              updatedAt: nowWall - 60_000,
            },
            {
              id: 'orphan-sleep-card-2',
              driveKey: 'asi-sleep:consolidation',
              driveLabel: 'L2 · 记忆整合',
              silent: true,
              severity: 'uncomfortable',
              title: '已卸载插件遗留的只读确认卡',
              summary: '历史遗留项 2',
              actionKind: 'acknowledge',
              actionTarget: 'ack_legacy123456',
              status: 'open',
              createdAt: nowWall - 60_000,
              updatedAt: nowWall - 60_000,
            },
          ],
          circuitBreakers: [
            {
              need: 'asi-care:workspace_bloat',
              trippedAt: nowWall - 60_000,
              zoneAtTrip: 'uncomfortable',
              satisfactionAtTrip: 45,
              envFingerprint: 'fp-old',
              reason: 'legacy breaker',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    const sense = createMockSenseService(makeSnapshot({ now: nowWall, mono: nowMono }), storageRoot);
    const runtime = createNeedsRuntime({
      storageRoot,
      sense,
      clock: { wall: () => nowWall, mono: () => nowMono },
      probeEndpoint: async () => true,
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => id,
        hasSession: () => true,
        runMaintenanceTurn: async () => {},
        deliverCryToUserSession: async () => true,
      },
    });

    await runtime.start();
    try {
      // 1) 启动宽限期内保留卡片（以便晚加载的高阶插件仍可注册），但若对应插件已卸载，用户点击「批准」绝不抛错，立即优雅归档为 resolved！
      expect(runtime.snapshot().helpCards.filter((c) => c.status === 'open')).toHaveLength(2);
      await expect(runtime.actions.approveHelp('orphan-care-card-1')).resolves.toBeUndefined();

      const snapAfterClick = runtime.snapshot();
      expect(snapAfterClick.helpCards.find((c) => c.id === 'orphan-care-card-1')?.status).toBe('resolved');
      expect(snapAfterClick.maintenanceSession.circuitBrokenNeeds ?? []).not.toContain('asi-care:workspace_bloat');
      expect(snapAfterClick.records[0]?.action).toBe('resolve-orphan-help-card');
      expect(snapAfterClick.records[0]?.outcome).toBe('relieved');

      // 2) 若用户对已卸载插件遗留卡点击「忽略」(dismissHelp)，同样清理残留熔断且不重入新熔断；跨过宽限期后剩余孤儿卡自动归档为 resolved！
      await writeFile(join(storageRoot, 'noop'), ''); // keep storage warm
      await expect(runtime.actions.dismissHelp('orphan-sleep-card-2')).resolves.toBeUndefined();
      expect(runtime.snapshot().helpCards.find((c) => c.id === 'orphan-sleep-card-2')?.status).toBe('dismissed');
    } finally {
      await runtime.stop();
    }

    // 重启并验证未点击的跨重启孤儿高阶卡在宽限期满后自动归档为 resolved，且直接调用高阶沙盒工具在途遇 eco 也会即时抢占中止
    await writeFile(
      join(storageRoot, 'state.json'),
      JSON.stringify({
        helpCards: [
          {
            id: 'orphan-auto-sweep-card',
            driveKey: 'asi-sleep:consolidation',
            driveLabel: 'L2 · 记忆整合',
            silent: true,
            severity: 'uncomfortable',
            title: '等待宽限期自动归档的遗留卡',
            summary: '历史遗留项',
            actionKind: 'acknowledge',
            status: 'open',
            createdAt: nowWall,
            updatedAt: nowWall,
          },
        ],
      }),
      'utf8',
    );
    const runtime2 = createNeedsRuntime({
      storageRoot,
      sense,
      clock: { wall: () => nowWall, mono: () => nowMono },
      probeEndpoint: async () => true,
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => id,
        hasSession: () => true,
        runMaintenanceTurn: async () => {},
        deliverCryToUserSession: async () => true,
      },
    });
    await runtime2.start();
    try {
      expect(runtime2.snapshot().helpCards.find((c) => c.id === 'orphan-auto-sweep-card')?.status).toBe('open');
      nowWall += ORPHAN_HIGHER_CARD_GRACE_MS + 5_000;
      nowMono += ORPHAN_HIGHER_CARD_GRACE_MS + 5_000;
      sense.emit(() => makeSnapshot({ now: nowWall, mono: nowMono }));
      await vi.waitFor(() => {
        expect(runtime2.snapshot().helpCards.find((c) => c.id === 'orphan-auto-sweep-card')?.status).toBe('resolved');
      });

      // 注册一个慢速高阶工具并直接通过 executeSandboxTool 调用（非自动回合），中途切入 eco 必须立即 abort 该工具信号！
      let capturedToolSig: { aborted: boolean } | undefined;
      let notifyToolStarted: (() => void) | undefined;
      runtime2.drives.registerSource({
        id: 'asi-mock-l2',
        tier: 2,
        label: 'Mock L2',
        evaluate: () => [{ key: 'focus', label: '专注', satisfaction: 40, summary: 'busy' }],
        sandboxTools: [
          {
            name: 'mock_l2_slow_op',
            description: 'slow op',
            execute: async (_args, ctx) => {
              capturedToolSig = ctx.signal;
              notifyToolStarted?.();
              await new Promise<void>((r) => {
                if (ctx.signal instanceof AbortSignal) {
                  ctx.signal.addEventListener('abort', () => r(), { once: true });
                }
              });
              return { summary: 'done' };
            },
          },
        ],
      });
      const regTool = runtime2.drives.registeredSandboxTools().find((t) => t.spec.name === 'mock_l2_slow_op');
      expect(regTool).toBeDefined();
      if (!regTool) throw new Error('missing regTool');
      const startedToolP = new Promise<void>((r) => {
        notifyToolStarted = r;
      });
      const directExecP = runtime2.drives.executeSandboxTool(regTool, {}, new AbortController().signal);
      await startedToolP;
      expect(capturedToolSig?.aborted).toBe(false);
      await sense.setPowerMode('eco', '测试直接调用抢占');
      sense.emit((s) => s);
      await expect(directExecP).rejects.toThrow(/aborted/i);
      expect(capturedToolSig?.aborted).toBe(true);
    } finally {
      await runtime2.stop();
    }
  });

  it('L2 asi-sleep (autoMaintain=false) 与 L3 asi-care (静默求助卡 + 自动回合) 并存仲裁：L2 等待静默期既不空唤醒会话，也不阻塞 L3 自治与一键批准', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-040-four-plugin-coexist-'));
    tempDirs.push(dir);

    let nowWall = T0;
    let nowMono = 1_000;
    const sense = createMockSenseService(makeSnapshot({ now: nowWall, mono: nowMono }), dir);
    const maintPrompts: string[] = [];
    const cries: string[] = [];
    let careBloatSat = 100;
    let sleepSat = 42;
    let sleepConsolidateRuns = 0;
    let careSniffRuns = 0;
    let autoTurnSleepGuardAllowed: boolean | undefined;
    let autoTurnSleepExecError: string | undefined;

    const rt = createNeedsRuntime({
      storageRoot: dir,
      sense,
      clock: { wall: () => nowWall, mono: () => nowMono },
      probeEndpoint: async () => true,
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => id,
        hasSession: () => true,
        runMaintenanceTurn: async (_sid, prompt, signal) => {
          maintPrompts.push(prompt);
          const sleepTool = rt.drives.registeredSandboxTools().find((t) => t.spec.name === 'sleep_consolidate');
          const careTool = rt.drives.registeredSandboxTools().find((t) => t.spec.name === 'care_sniff_workspaces');
          if (maintPrompts.length === 1) {
            // 自动唤醒回合（!manual）：autoMaintain=false 的 sleep_consolidate 必须被护栏拦截，严禁趁聊天中强跑！
            autoTurnSleepGuardAllowed = rt.drives.checkSandboxToolGuard('sleep_consolidate').allowed;
            if (sleepTool) {
              try {
                await rt.drives.executeSandboxTool(sleepTool, { force: true }, signal);
              } catch (err) {
                autoTurnSleepExecError = err instanceof Error ? err.message : String(err);
              }
            }
            if (careTool) {
              await rt.drives.executeSandboxTool(careTool, {}, signal);
            }
            await rt.drives.proposeHelpCard('asi-care', {
              driveKey: 'workspace_bloat',
              title: '发现闲置工作树构建产物',
              summary: '~/work/wt-old/node_modules 闲置 9 天（1.5 GiB）',
              actionKind: 'run-drive-action',
              actionTarget: 'art_demo01',
              approveLabel: '批准清理构建产物',
            });
          } else if (sleepTool) {
            // 用户手动触发自检（manual=true）：允许显式调用 sleep_consolidate
            await rt.drives.executeSandboxTool(sleepTool, { force: true }, signal);
          }
        },
        deliverCryToUserSession: async (_target, _exclude, text) => {
          cries.push(text);
          return true;
        },
      },
    });

    await rt.start();
    try {
      // 保留工具名（含 memory_recall / memory_profile / care_status）严禁被外部高阶源抢注为沙盒工具
      expect(() =>
        rt.drives.registerSource({
          id: 'bad-collision',
          tier: 4,
          label: '冲突测试',
          evaluate: () => [],
          sandboxTools: [{ name: 'memory_recall', description: 'dup', execute: async () => ({ summary: 'x' }) }],
        }),
      ).toThrow(/Forbidden or reserved sandbox tool name/);

      rt.drives.registerSource({
        id: 'asi-sleep',
        tier: 2,
        label: '离线睡眠与记忆整合',
        evaluate: () => [
          {
            key: 'consolidation',
            label: '睡眠记忆整合',
            satisfaction: sleepSat,
            autoMaintain: false,
            summary: sleepSat < 70 ? '累计 14 轮待睡眠整合（等待 10 分钟静默期）' : '记忆已巩固',
            evidence: { unconsolidatedTurns: sleepSat < 70 ? 14 : 0, quietWindow: false },
          },
        ],
        sandboxTools: [
          {
            name: 'sleep_consolidate',
            driveKey: 'consolidation',
            description: 'Consolidate memories',
            parameters: { force: { type: 'boolean' } },
            execute: async () => {
              sleepConsolidateRuns += 1;
              sleepSat = 100;
              return { summary: '已完成睡眠记忆巩固' };
            },
          },
        ],
      });

      rt.drives.registerSource({
        id: 'asi-care',
        tier: 3,
        label: '工作区与项目看护',
        evaluate: () => [
          {
            key: 'workspace_bloat',
            label: '闲置工作树产物膨胀',
            satisfaction: careBloatSat,
            summary: careBloatSat < 60 ? '闲置产物 1.5 GiB' : '无膨胀',
            evidence: { bloatBytes: careBloatSat < 60 ? 1_600_000_000 : 0 },
          },
        ],
        sandboxTools: [
          {
            name: 'care_sniff_workspaces',
            driveKey: 'workspace_bloat',
            description: 'Sniff workspaces',
            execute: async () => {
              careSniffRuns += 1;
              return { summary: '已嗅探工作区产物膨胀' };
            },
          },
        ],
        executeHelpAction: async (input) => {
          expect(input.actionTarget).toBe('art_demo01');
          careBloatSat = 100;
          return {
            ledgerAction: 'clean-workspace-artifact:node_modules',
            summary: '已清理闲置构建产物 1.5 GiB',
            freedBytes: 1_600_000_000,
          };
        },
      });

      // 阶段 1：仅 L2 asi-sleep 不适（autoMaintain=false），L3 舒适 -> activeTier=2 可见，但绝不唤醒自维护会话！
      await new Promise((r) => setTimeout(r, 25));
      expect(rt.drives.snapshot().activeTier).toBe(2);
      expect(maintPrompts).toHaveLength(0);

      // 阶段 2：L3 asi-care 进入不适 -> L2 的 autoMaintain=false 不阻塞 L3 唤醒，且提示词仅针对 L3、全程零 <asi-cry>！
      careBloatSat = 45;
      nowWall += 5_000;
      nowMono += 5_000;
      rt.drives.notifySourceChanged('asi-care');

      await vi.waitFor(() => {
        expect(maintPrompts).toHaveLength(1);
        expect(rt.snapshot().helpCards.some((c) => c.status === 'open' && c.actionTarget === 'art_demo01')).toBe(true);
      });
      expect(maintPrompts[0]).toContain('asi-care:workspace_bloat');
      expect(maintPrompts[0]).not.toContain('asi-sleep:consolidation');
      expect(autoTurnSleepGuardAllowed).toBe(false);
      expect(autoTurnSleepExecError).toMatch(/autoMaintain=false/);
      expect(sleepConsolidateRuns).toBe(0);
      expect(careSniffRuns).toBe(1);
      expect(cries).toHaveLength(0);

      // 阶段 3：用户在侧栏一键批准静默求助卡 -> 执行回调恢复舒适并记入 ActionOutcomeLedger
      const openCard = rt.snapshot().helpCards.find((c) => c.status === 'open' && c.actionTarget === 'art_demo01');
      expect(openCard?.silent).toBe(true);
      await rt.actions.approveHelp(openCard?.id ?? '');

      expect(rt.snapshot().higherOrderDrives?.find((d) => d.key === 'asi-care:workspace_bloat')?.satisfaction).toBe(
        100,
      );
      const ledgerEntry = rt
        .snapshot()
        .actionLedger?.find(
          (e) => e.need === 'asi-care:workspace_bloat' && e.action === 'clean-workspace-artifact:node_modules',
        );
      expect(ledgerEntry?.effectiveCount).toBe(1);

      // 阶段 4：用户显式点击「立即自检」（manual=true）时，允许在沙盒手动调用 sleep_consolidate
      await rt.actions.triggerCheck();
      expect(sleepConsolidateRuns).toBe(1);
      expect(rt.snapshot().higherOrderDrives?.find((d) => d.key === 'asi-sleep:consolidation')?.satisfaction).toBe(100);
      expect(cries).toHaveLength(0);
    } finally {
      await rt.stop();
    }
  });
});
