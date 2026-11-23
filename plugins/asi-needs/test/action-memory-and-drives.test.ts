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
import * as AsiSensePlugin from 'asi-sense';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionOutcomeLedger, buildActionMeasurement } from '../src/host/action-memory.js';
import { EXTERNAL_CACHE_ACTIVE_PROTECTION_MS } from '../src/host/cache-catalog.js';
import * as AsiNeedsPlugin from '../src/host/dsh/index.js';
import { createNeedsRuntime } from '../src/host/runtime.js';
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
      await vi.waitFor(() => expect(sniffSnapshot).toBeDefined());
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

      // 阶段 2：恢复 normal 采样且 L1 生理需求全部舒适 -> 自动解除高阶压制，唤醒后台会话运行 sleep_consolidate_notes！
      await root.asiSense.setPowerMode('normal');
      await vi.waitFor(() => {
        expect(sleepToolRuns).toBe(1);
        expect(root.asiDrives.snapshot().drives.find((d) => d.key === 'asi-sleep:consolidation')?.zone).toBe(
          'comfortable',
        );
      });
      expect(promptsSeen[0]).toContain('L2 · 记忆离线巩固 (asi-sleep:consolidation)');

      // 若此时再次切回 eco，即使在自维护会话中也立即由 guard 拦截高阶沙盒工具！
      const maintAgent = agentsList.find((a) => a.id !== 'ordinary-user-chat');
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
      needsFork.dispose();
      senseFork.dispose();
      await new Promise((r) => setTimeout(r, 25));
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
      await vi.waitFor(() => expect(higherRuns).toBe(1));
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

      await vi.waitFor(() => {
        expect(seenSignals[0]?.aborted).toBe(true);
        expect(l1PreemptRuns).toBe(1);
        expect(rt.snapshot().maintenanceSession.status).toBe('idle');
      });
      expect(rt.snapshot().maintenanceSession.circuitBrokenNeeds ?? []).not.toContain('asi-care:digest');

      // 2. L1 磁盘恢复舒适（80 GB），跨过冷却后高阶第 2 轮运行但未调工具（零收益）-> 进入高阶静默熔断
      nowWall += 150_000;
      nowMono += 150_000;
      diskFree = 80 * 1024 ** 3;
      sense.emit(() => makeSnap());
      await vi.waitFor(() => {
        expect(higherRuns).toBe(2);
        expect(rt.snapshot().maintenanceSession.status).toBe('idle');
      });
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
});
