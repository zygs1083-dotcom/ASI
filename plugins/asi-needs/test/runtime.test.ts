import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as AsiSensePlugin from 'asi-sense';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNeedsRuntime } from '../src/host/runtime.js';
import { createMockSenseService, fact, makeSnapshot, T0 } from './fixtures.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('NeedsRuntime 自发维护闭环、冷却预算与啼哭求助生命周期', () => {
  it('稳态舒适时不创建后台会话、不发任何消息；进入不适时在后台会话静默自救且不打扰用户对话', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'asi-needs-rt-'));
    tempDirs.push(storageRoot);

    let nowWall = T0;
    let nowMono = 1_000;
    const sense = createMockSenseService({ now: nowWall, mono: nowMono });
    const cries: { target?: string; content: string; mode: string }[] = [];
    const createdSessions: string[] = [];

    let stuckJobs = [{ id: 'job-stuck-1', owner: 'dead-session', status: 'running', startedAt: T0 - 20 * 60_000 }];
    let jobsListActive = false;

    const runtime = createNeedsRuntime({
      storageRoot,
      sense,
      clock: { wall: () => nowWall, mono: () => nowMono },
      probeEndpoint: async () => true,
      jobs: {
        listActiveJobs: () => (jobsListActive ? stuckJobs : []),
        hasLiveOwner: () => false,
        killJob: (id) => {
          stuckJobs = stuckJobs.filter((j) => j.id !== id);
          return 'requested';
        },
      },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => {
          createdSessions.push(id);
          return id;
        },
        hasSession: (id) => createdSessions.includes(id),
        runMaintenanceTurn: async () => {
          // 模拟后台自维护 Agent 调用 needs_stop_job 成功解除残留任务压力
          await runtime.tools.stopStuckJob();
        },
        deliverCryToUserSession: async (target, _exclude, content, mode) => {
          cries.push({ target, content, mode });
          return true;
        },
      },
    });

    await runtime.start();
    try {
      expect(createdSessions).toHaveLength(0);
      expect(cries).toHaveLength(0);
      expect(runtime.snapshot().overallZone).toBe('comfortable');

      // 产生残留任务 → memory 进入 uncomfortable → 触发后台自维护并恢复舒适区
      jobsListActive = true;
      nowWall += 5_000;
      nowMono += 5_000;
      sense.emit((prev) => ({ ...prev, now: nowWall, mono: nowMono }));

      await vi.waitFor(() => {
        expect(runtime.snapshot().maintenanceSession.turnCount).toBe(1);
      });

      expect(createdSessions).toHaveLength(1);
      expect(sense.internalSessions().has(createdSessions[0] ?? '')).toBe(true);
      expect(stuckJobs).toHaveLength(0);
      expect(runtime.snapshot().needs.memory.zone).toBe('comfortable');
      expect(runtime.snapshot().needs.memory.driveActive).toBe(false);
      // 全程零打扰普通对话
      expect(cries).toHaveLength(0);
      expect(runtime.snapshot().records[0]?.outcome).toBe('relieved');
    } finally {
      await runtime.stop();
    }
  });

  it('物理/连接危急边界（低电量 + 网关失联）触发本能节能降频、生成求助卡且单次剧集仅发送一条离线驻留 <asi-cry>，插电恢复后自动归档求助卡', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'asi-needs-cry-'));
    tempDirs.push(storageRoot);

    let nowWall = T0;
    let nowMono = 1_000;
    let gatewayOnline = false;
    const lowSnap = makeSnapshot({ now: nowWall, mono: nowMono });
    lowSnap.state.self.body.battery = fact({ percent: 6, charging: false, powerState: 'battery', minutesLeft: 12 });
    const sense = createMockSenseService(lowSnap);
    const cries: { content: string; mode: string }[] = [];

    const runtime = createNeedsRuntime({
      storageRoot,
      sense,
      clock: { wall: () => nowWall, mono: () => nowMono },
      probeEndpoint: async () => gatewayOnline,
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => id,
        hasSession: () => true,
        runMaintenanceTurn: async () => {},
        deliverCryToUserSession: async (_target, _exclude, content, mode) => {
          cries.push({ content, mode });
          return true;
        },
      },
    });

    await runtime.start();
    try {
      // 第二次探活确认网关 offline
      nowWall += 12_000;
      nowMono += 12_000;
      sense.emit((prev) => ({ ...prev, now: nowWall, mono: nowMono }));

      await vi.waitFor(() => {
        expect(runtime.snapshot().instinct.modelConnectivity).toBe('offline');
      });

      expect(sense.getSettings().powerMode).toBe('eco');
      const openCards = runtime.snapshot().helpCards.filter((c) => c.status === 'open');
      expect(openCards).toHaveLength(1);
      expect(openCards[0]?.need).toBe('energy');

      // 同一危急剧集多次采样只发唯一一条 <asi-cry>（绝不重复轰炸）
      nowWall += 5_000;
      nowMono += 5_000;
      sense.emit((prev) => ({ ...prev, now: nowWall, mono: nowMono }));
      await new Promise((r) => setTimeout(r, 20));
      expect(cries).toHaveLength(1);
      expect(cries[0]?.content).toContain('<asi-cry need="energy"');

      // 用户插上电源且网关恢复在线 → 求助卡自动变为 resolved，本能切回 normal
      gatewayOnline = true;
      nowWall += 25_000;
      nowMono += 25_000;
      sense.emit((prev) => {
        const next = structuredClone(prev);
        next.now = nowWall;
        next.mono = nowMono;
        next.state.self.body.battery = fact({ percent: 85, charging: true, powerState: 'charging' });
        return next;
      });

      await vi.waitFor(() => {
        expect(runtime.snapshot().needs.energy.zone).toBe('comfortable');
        expect(runtime.snapshot().helpCards.filter((c) => c.status === 'open')).toHaveLength(0);
      });
      expect(sense.getSettings().powerMode).toBe('normal');
    } finally {
      await runtime.stop();
    }
  });

  it('单调 120s 冷却与每小时最多 6 轮护栏生效；自救后仍危急自动升级为求助卡；支持一键批准 clean-cache', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'asi-needs-cap-'));
    tempDirs.push(storageRoot);
    const tmpCacheDir = join(storageRoot, 'tmp');
    await rm(tmpCacheDir, { recursive: true, force: true });

    let nowWall = T0;
    let nowMono = 1_000;
    const sense = createMockSenseService({ now: nowWall, mono: nowMono });
    let maintRuns = 0;
    const cries: string[] = [];

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
        },
        deliverCryToUserSession: async (_t, _e, content) => {
          cries.push(content);
          return true;
        },
      },
    });

    await runtime.start();
    try {
      // 模拟磁盘进入危急（用户大文件占满，自维护无法自行解决）
      sense.emit((prev) => {
        const next = structuredClone(prev);
        next.state.self.body.disks = {
          kind: 'disks',
          ...fact([{ mount: '/', total: 200 * 1024 ** 3, free: 1 * 1024 ** 3 }]),
        };
        return next;
      });

      await vi.waitFor(() => expect(maintRuns).toBe(1));
      // 自救后仍处危急 → 自动生成求助卡并发出一次 <asi-cry>
      await vi.waitFor(() => {
        expect(runtime.snapshot().helpCards.some((c) => c.need === 'space' && c.status === 'open')).toBe(true);
      });
      expect(cries).toHaveLength(1);

      // 30 秒内再次采样受 120 秒单调冷却限制，不重复跑后台会话
      nowWall += 30_000;
      nowMono += 30_000;
      sense.emit((prev) => ({ ...prev, now: nowWall, mono: nowMono }));
      await new Promise((r) => setTimeout(r, 20));
      expect(maintRuns).toBe(1);

      // 测试一键批准 clean-cache 求助卡动作
      await runtime.tools.cleanCache();
      await writeFile(join(storageRoot, 'tmp', 'junk.bin'), Buffer.alloc(2048));
      const { card } = await runtime.tools.requestHelp({
        need: 'space',
        severity: 'uncomfortable',
        title: '批准清理缓存',
        summary: '发现新缓存可清理',
        actionKind: 'clean-cache',
      });
      await runtime.actions.approveHelp(card.id);
      expect(runtime.snapshot().helpCards.find((c) => c.id === card.id)?.status).toBe('approved');
    } finally {
      await runtime.stop();
    }
  });

  it('真实 Cordis 服务联动：AsiSensePlugin 暴露无 UI 感官服务，驱动 NeedsRuntime 实时订阅', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-cordis-pair-'));
    tempDirs.push(dir);

    const root = new Context();
    root.provide('agents', { list: () => [], get: () => undefined });
    root.provide('jobs', {
      list: () => [],
      events: { subscribe: () => () => {} },
    });
    root.provide('llm', {
      listConfigurableProviders: () => [],
      resolveModelInfo: async () => undefined,
    });
    root.provide('sessionProjections', { snapshot: () => ({ values: {} }) });
    root.provide('sessions', { list: () => [] });
    root.provide('systemPrompt', { section: () => () => {} });
    root.provide('tokenMeter', { contextPressure: () => ({}) });
    const registeredToolsAtSenseInit: string[] = [];
    const registeredToolDefs: { name: string }[] = [];
    root.provide('tools', {
      register: (tool: { name: string }) => {
        registeredToolDefs.push({ name: tool.name });
        return () => {};
      },
      definitions: () => [...registeredToolDefs],
      executable: () => undefined,
    });
    root.inject(['asiSense'], (c) => {
      registeredToolsAtSenseInit.push(...c.tools.definitions().map((d) => d.name));
    });
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

    const fork = await root.plugin(AsiSensePlugin, {
      storageRoot: join(dir, 'sense'),
      helperPath: join(dir, 'nonexistent-helper'),
      intervalMs: 5_000,
    });
    expect(registeredToolsAtSenseInit).toEqual(expect.arrayContaining(['env_state', 'env_detail']));

    const runtime = createNeedsRuntime({
      storageRoot: join(dir, 'needs'),
      sense: root.asiSense,
      probeEndpoint: async () => true,
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => id,
        hasSession: () => true,
        runMaintenanceTurn: async () => {},
        deliverCryToUserSession: async () => false,
      },
    });

    await runtime.start();
    try {
      const snap = runtime.snapshot();
      expect(snap.needs.energy).toBeDefined();
      expect(snap.needs.space).toBeDefined();
      expect(snap.needs.memory).toBeDefined();
      expect(snap.needs.mind).toBeDefined();
      expect(snap.needs.thermals).toBeDefined();

      // 验证 asi-needs 通过 Cordis 服务控制 asi-sense 的采样降频与暂停
      await root.asiSense.setPowerMode('eco', '联动测试');
      expect(runtime.snapshot().instinct.powerMode).toBe('eco');
      await runtime.actions.pause(true);
      expect(root.asiSense.getSettings().paused).toBe(true);
    } finally {
      await runtime.stop();
      fork.dispose();
    }
  });

  it('重启恢复持久化：首帧感官为 unknown 时绝不误归档未处理求助卡或重复啼哭，并恢复自维护会话身份', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'asi-needs-restart-'));
    tempDirs.push(storageRoot);

    const nowWall = T0;
    const nowMono = 1_000;
    const critSnap = makeSnapshot({ now: nowWall, mono: nowMono });
    critSnap.state.self.body.battery = fact({ percent: 7, charging: false, powerState: 'battery', minutesLeft: 10 });
    const sense1 = createMockSenseService(critSnap);
    const cries1: string[] = [];
    const knownSessions = new Set<string>();

    const rt1 = createNeedsRuntime({
      storageRoot,
      sense: sense1,
      clock: { wall: () => nowWall, mono: () => nowMono },
      probeEndpoint: async () => true,
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => {
          knownSessions.add(id);
          return id;
        },
        hasSession: (id) => knownSessions.has(id),
        runMaintenanceTurn: async () => {},
        deliverCryToUserSession: async (_t, _e, content) => {
          cries1.push(content);
          return true;
        },
      },
    });

    await rt1.start();
    const maintId = await rt1.actions.openMaintenanceSession();
    expect(rt1.snapshot().helpCards.filter((c) => c.status === 'open')).toHaveLength(1);
    expect(cries1).toHaveLength(1);
    await rt1.stop();

    // 模拟进程重启：刚启动时传感器尚未采集完（battery / disks / tokens 均为 unknown）
    const coldBootSnap = makeSnapshot({ now: nowWall + 5_000, mono: 100 });
    coldBootSnap.state.self.body.battery = fact(null, { status: 'unknown' });
    coldBootSnap.state.self.body.disks = { kind: 'disks', ...fact(null, { status: 'unknown' }) };
    coldBootSnap.state.self.body.tokens = fact(null, { status: 'unknown' });
    const sense2 = createMockSenseService(coldBootSnap);
    const cries2: string[] = [];

    const rt2 = createNeedsRuntime({
      storageRoot,
      sense: sense2,
      clock: { wall: () => nowWall + 5_000, mono: () => 100 },
      probeEndpoint: async () => true,
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => id,
        hasSession: (id) => knownSessions.has(id),
        runMaintenanceTurn: async () => {},
        deliverCryToUserSession: async (_t, _e, content) => {
          cries2.push(content);
          return true;
        },
      },
    });

    await rt2.start();
    try {
      // 未处理求助卡仍在 open 状态，没有被 unknown 读数误归档！且自维护会话 ID 已恢复并注册为内部会话
      expect(rt2.snapshot().helpCards.filter((c) => c.status === 'open')).toHaveLength(1);
      expect(rt2.snapshot().maintenanceSession.sessionId).toBe(maintId);
      expect(rt2.isMaintenanceSession(maintId)).toBe(true);
      expect(sense2.internalSessions().has(maintId)).toBe(true);

      // 随后真实低电量采样到达时，同一危急剧集不重复发送 <asi-cry>
      sense2.emit((prev) => {
        const next = structuredClone(prev);
        next.state.self.body.battery = fact({ percent: 6, charging: false, powerState: 'battery', minutesLeft: 9 });
        return next;
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(cries2).toHaveLength(0);
    } finally {
      await rt2.stop();
    }
  });

  it('求助卡点击「我已处理」或「忽略」后在同一危急剧集内不再死灰复燃，恢复舒适后新剧集重新告警', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'asi-needs-suppress-'));
    tempDirs.push(storageRoot);

    const lowBatSnap = makeSnapshot({ now: T0, mono: 1_000 });
    lowBatSnap.state.self.body.battery = fact({ percent: 8, charging: false, powerState: 'battery', minutesLeft: 10 });
    const sense = createMockSenseService(lowBatSnap);

    const runtime = createNeedsRuntime({
      storageRoot,
      sense,
      clock: { wall: () => T0, mono: () => 1_000 },
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
      const open1 = runtime.snapshot().helpCards.filter((c) => c.status === 'open');
      expect(open1).toHaveLength(1);

      // 用户点击「我已处理」(approveHelp) 时电量仍为 8%，不应在同一次 reconcile 中重新生成 open 求助卡
      await runtime.actions.approveHelp(open1[0]?.id ?? '');
      expect(runtime.snapshot().helpCards.filter((c) => c.status === 'open')).toHaveLength(0);

      // 下一次采样电量降为 7%（同一剧集），仍保持静默不打扰
      sense.emit((prev) => {
        const next = structuredClone(prev);
        next.state.self.body.battery = fact({ percent: 7, charging: false, powerState: 'battery', minutesLeft: 8 });
        return next;
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(runtime.snapshot().helpCards.filter((c) => c.status === 'open')).toHaveLength(0);

      // 插电恢复舒适后拔电再次跌入危急（新剧集）→ 正常弹出新求助卡，且「忽略」同样抑制重复弹出
      sense.emit((prev) => {
        const next = structuredClone(prev);
        next.state.self.body.battery = fact({ percent: 80, charging: true, powerState: 'charging' });
        return next;
      });
      await vi.waitFor(() => expect(runtime.snapshot().needs.energy.zone).toBe('comfortable'));

      sense.emit((prev) => {
        const next = structuredClone(prev);
        next.state.self.body.battery = fact({ percent: 9, charging: false, powerState: 'battery', minutesLeft: 11 });
        return next;
      });
      await vi.waitFor(() => expect(runtime.snapshot().helpCards.filter((c) => c.status === 'open')).toHaveLength(1));

      const open2 = runtime.snapshot().helpCards.find((c) => c.status === 'open');
      await runtime.actions.dismissHelp(open2?.id ?? '');
      sense.emit((prev) => ({ ...prev, now: T0 + 5_000 }));
      await new Promise((r) => setTimeout(r, 20));
      expect(runtime.snapshot().helpCards.filter((c) => c.status === 'open')).toHaveLength(0);
    } finally {
      await runtime.stop();
    }
  });

  it('needs_compact_context 触发 sense.refresh() 刷新 Token 后不误报危急；无活跃会话时延迟投递 <asi-cry>；自维护提示词严格脱敏', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'asi-needs-refresh-'));
    tempDirs.push(storageRoot);

    let compactedDone = false;
    const tightMind = makeSnapshot({ now: T0, mono: 1_000, activeSessionId: undefined });
    tightMind.state.self.body.tokens = fact({
      contextWindow: 100_000,
      contextWindowSource: 'configured',
      contextUsed: 96_000,
      sessionUsage: { input: 96_000, output: 1_000, cacheRead: 0, cacheWrite: 0 },
    });

    const sense = createMockSenseService(tightMind, storageRoot, (cur) => {
      if (!compactedDone) return undefined;
      const next = structuredClone(cur);
      next.state.self.body.tokens = fact({
        contextWindow: 100_000,
        contextWindowSource: 'configured',
        contextUsed: 15_000,
        sessionUsage: { input: 15_000, output: 1_000, cacheRead: 0, cacheWrite: 0 },
      });
      return next;
    });

    const prompts: string[] = [];
    const cries: { target?: string; content: string }[] = [];
    let hasUserSession = false;

    const runtime = createNeedsRuntime({
      storageRoot,
      sense,
      clock: { wall: () => T0, mono: () => 1_000 },
      probeEndpoint: async () => true,
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: {
        listIdleSessionIds: () => ['idle-user-1'],
        compactIdleSession: async () => {
          compactedDone = true;
          return { compacted: true, tokensSaved: 81_000 };
        },
      },
      sessions: {
        createMaintenanceSession: async (id) => id,
        hasSession: () => true,
        runMaintenanceTurn: async (_sid, prompt) => {
          prompts.push(prompt);
          await runtime.tools.compactContext();
        },
        deliverCryToUserSession: async (target, _exclude, content) => {
          if (!hasUserSession) return false;
          cries.push({ target, content });
          return true;
        },
      },
    });

    // 注入含凭据形态的挂载点名以验证 buildMaintenancePrompt 脱敏保护
    sense.emit((prev) => {
      const next = structuredClone(prev);
      next.state.self.body.disks = {
        kind: 'disks',
        ...fact([{ mount: '/Volumes/sk-abcdefghijklmnopqrstuvwxyz1234', total: 100 * 1024 ** 3, free: 4 * 1024 ** 3 }]),
      };
      return next;
    });

    await runtime.start();
    try {
      await vi.waitFor(() => expect(prompts.length).toBeGreaterThanOrEqual(1));
      // 1. 提示词中的敏感 token 已被 sanitizeForModel 脱敏
      expect(prompts[0]).not.toContain('sk-abcdefghijklmnopqrstuvwxyz1234');
      expect(prompts[0]).toContain('[redacted]');

      // 2. needs_compact_context 调用后 sense.refresh() 立即把 mind 更新为 15% 舒适，绝不误生成 mind 危急求助卡
      expect(runtime.snapshot().needs.mind.zone).toBe('comfortable');
      expect(runtime.snapshot().helpCards.some((c) => c.need === 'mind')).toBe(false);

      // 3. 当初始无用户会话（deliverCry 返回 false）而存在未处理求助卡时，一旦用户打开会话立即补发一次 <asi-cry>
      await runtime.tools.requestHelp({
        need: 'space',
        severity: 'critical',
        title: '磁盘待清理',
        summary: '剩余不足',
      });
      expect(cries).toHaveLength(0);

      hasUserSession = true;
      sense.emit((prev) => ({ ...prev, activeSessionId: 'user-opened-1', now: T0 + 2_000 }));
      await vi.waitFor(() => expect(cries).toHaveLength(1));
      expect(cries[0]?.target).toBe('user-opened-1');
    } finally {
      await runtime.stop();
    }
  });

  it('同一剧集从 uncomfortable 升级为 critical 时：无论 uncomfortable 求助卡已忽略、已批准还是仍 open，危急 <asi-cry> 均能正常送达且不重复', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'asi-needs-escalate-cry-'));
    tempDirs.push(storageRoot);

    let nowWall = T0;
    let nowMono = 1_000;
    const sense = createMockSenseService({ now: nowWall, mono: nowMono });
    const cries: string[] = [];
    let shouldRequestUncomfortableCard = true;

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
          if (shouldRequestUncomfortableCard) {
            shouldRequestUncomfortableCard = false;
            await runtime.tools.requestHelp({
              need: 'space',
              severity: 'uncomfortable',
              title: '磁盘空间偏紧',
              summary: '剩余约 6%，建议排查下载目录大文件',
              actionKind: 'acknowledge',
            });
          }
        },
        deliverCryToUserSession: async (_target, _exclude, content) => {
          cries.push(content);
          return true;
        },
      },
    });

    await runtime.start();
    try {
      // 阶段 1（场景 A：忽略 uncomfortable 求助卡后恶化为 critical）：
      // 磁盘剩余 12GB / 200GB（6% -> uncomfortable），产生 uncomfortable 求助卡并发出首条 uncomfortable <asi-cry>
      nowWall += 5_000;
      nowMono += 5_000;
      sense.emit((prev) => {
        const next = structuredClone(prev);
        next.now = nowWall;
        next.mono = nowMono;
        next.state.self.body.disks = {
          kind: 'disks',
          ...fact([{ mount: '/', total: 200 * 1024 ** 3, free: 12 * 1024 ** 3 }]),
        };
        return next;
      });

      await vi.waitFor(() => {
        expect(runtime.snapshot().helpCards.some((c) => c.need === 'space' && c.status === 'open')).toBe(true);
        expect(cries).toHaveLength(1);
      });
      expect(cries[0]).toContain('severity="uncomfortable"');

      // 用户点击「忽略」该 uncomfortable 求助卡；在同一 uncomfortable 阶段不会再次告警或啼哭
      const uncomfCard = runtime.snapshot().helpCards.find((c) => c.need === 'space' && c.status === 'open');
      await runtime.actions.dismissHelp(uncomfCard?.id ?? '');
      nowWall += 10_000;
      nowMono += 10_000;
      sense.emit((prev) => ({ ...prev, now: nowWall, mono: nowMono }));
      await new Promise((r) => setTimeout(r, 20));
      expect(runtime.snapshot().helpCards.filter((c) => c.status === 'open')).toHaveLength(0);
      expect(cries).toHaveLength(1);

      // 同一剧集内磁盘继续恶化至 2GB / 200GB（1% -> critical）：必须升级生成危急求助卡并送达一条 critical <asi-cry>
      nowWall += 10_000;
      nowMono += 10_000;
      sense.emit((prev) => {
        const next = structuredClone(prev);
        next.now = nowWall;
        next.mono = nowMono;
        next.state.self.body.disks = {
          kind: 'disks',
          ...fact([{ mount: '/', total: 200 * 1024 ** 3, free: 2 * 1024 ** 3 }]),
        };
        return next;
      });

      await vi.waitFor(() => {
        const critOpen = runtime
          .snapshot()
          .helpCards.find((c) => c.need === 'space' && c.status === 'open' && c.severity === 'critical');
        expect(critOpen).toBeDefined();
        expect(cries).toHaveLength(2);
      });
      expect(cries[1]).toContain('severity="critical"');

      // 同一危急剧集后续采样绝不重复发送第二条 critical <asi-cry>
      nowWall += 10_000;
      nowMono += 10_000;
      sense.emit((prev) => ({ ...prev, now: nowWall, mono: nowMono }));
      await new Promise((r) => setTimeout(r, 20));
      expect(cries).toHaveLength(2);

      // 阶段 2（场景 B：uncomfortable 求助卡保持 open 未处理时直接恶化为 critical，以及 approveHelp 后升级）：
      // 先恢复至舒适区重置剧集
      nowWall += 130_000;
      nowMono += 130_000;
      sense.emit((prev) => {
        const next = structuredClone(prev);
        next.now = nowWall;
        next.mono = nowMono;
        next.state.self.body.disks = {
          kind: 'disks',
          ...fact([{ mount: '/', total: 200 * 1024 ** 3, free: 120 * 1024 ** 3 }]),
        };
        return next;
      });
      await vi.waitFor(() => expect(runtime.snapshot().needs.space.zone).toBe('comfortable'));

      // 新剧集：产生 open 状态的 uncomfortable 求助卡（clean-cache），用户尚未点击任何按钮
      shouldRequestUncomfortableCard = false;
      nowWall += 5_000;
      nowMono += 5_000;
      sense.emit((prev) => {
        const next = structuredClone(prev);
        next.now = nowWall;
        next.mono = nowMono;
        next.state.self.body.disks = {
          kind: 'disks',
          ...fact([{ mount: '/', total: 200 * 1024 ** 3, free: 12 * 1024 ** 3 }]),
        };
        return next;
      });
      await vi.waitFor(() => expect(runtime.snapshot().needs.space.zone).toBe('uncomfortable'));
      const { card: pendingCard } = await runtime.tools.requestHelp({
        need: 'space',
        severity: 'uncomfortable',
        title: '建议清理临时缓存',
        summary: '空间进入不适区',
        actionKind: 'clean-cache',
      });
      expect(cries).toHaveLength(3);
      expect(cries[2]).toContain('severity="uncomfortable"');

      // 用户未处理该 open 卡，磁盘直接跌入 critical -> 原 open 卡自动升级为 critical 且补发一次 critical <asi-cry>
      nowWall += 15_000;
      nowMono += 15_000;
      sense.emit((prev) => {
        const next = structuredClone(prev);
        next.now = nowWall;
        next.mono = nowMono;
        next.state.self.body.disks = {
          kind: 'disks',
          ...fact([{ mount: '/', total: 200 * 1024 ** 3, free: 2 * 1024 ** 3 }]),
        };
        return next;
      });
      await vi.waitFor(() => {
        const upgraded = runtime.snapshot().helpCards.find((c) => c.id === pendingCard.id);
        expect(upgraded?.severity).toBe('critical');
        expect(cries).toHaveLength(4);
      });
      expect(cries[3]).toContain('severity="critical"');

      // 阶段 3（场景 C：approveHelp 处理 uncomfortable 卡后在同一剧集恶化为 critical）：
      nowWall += 130_000;
      nowMono += 130_000;
      sense.emit((prev) => {
        const next = structuredClone(prev);
        next.now = nowWall;
        next.mono = nowMono;
        next.state.self.body.disks = {
          kind: 'disks',
          ...fact([{ mount: '/', total: 200 * 1024 ** 3, free: 120 * 1024 ** 3 }]),
        };
        return next;
      });
      await vi.waitFor(() => expect(runtime.snapshot().needs.space.zone).toBe('comfortable'));

      nowWall += 5_000;
      nowMono += 5_000;
      sense.emit((prev) => {
        const next = structuredClone(prev);
        next.now = nowWall;
        next.mono = nowMono;
        next.state.self.body.disks = {
          kind: 'disks',
          ...fact([{ mount: '/', total: 200 * 1024 ** 3, free: 12 * 1024 ** 3 }]),
        };
        return next;
      });
      await vi.waitFor(() => expect(runtime.snapshot().needs.space.zone).toBe('uncomfortable'));
      const { card: approveCard } = await runtime.tools.requestHelp({
        need: 'space',
        severity: 'uncomfortable',
        title: '确认磁盘提示',
        summary: '空间偏紧',
        actionKind: 'acknowledge',
      });
      expect(cries).toHaveLength(5);
      await runtime.actions.approveHelp(approveCard.id);

      // approveHelp 处理了 uncomfortable 卡后，同一剧集跌入 critical 仍能正常升级并送达 critical <asi-cry>
      nowWall += 15_000;
      nowMono += 15_000;
      sense.emit((prev) => {
        const next = structuredClone(prev);
        next.now = nowWall;
        next.mono = nowMono;
        next.state.self.body.disks = {
          kind: 'disks',
          ...fact([{ mount: '/', total: 200 * 1024 ** 3, free: 1 * 1024 ** 3 }]),
        };
        return next;
      });
      await vi.waitFor(() => expect(cries).toHaveLength(6));
      expect(cries[5]).toContain('severity="critical"');
    } finally {
      await runtime.stop();
    }
  });

  it('跨重启保留 uncomfortable 啼哭抑制且允许重启后升级 critical；高危已处理状态不被低危卡片操作降级；兼容旧版 criedEpisodes 存档', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'asi-needs-persist-sev-'));
    tempDirs.push(storageRoot);

    let nowWall = T0;
    let nowMono = 1_000;
    const diskUncomfSnap = makeSnapshot({ now: nowWall, mono: nowMono });
    diskUncomfSnap.state.self.body.disks = {
      kind: 'disks',
      ...fact([{ mount: '/', total: 200 * 1024 ** 3, free: 12 * 1024 ** 3 }]),
    };
    const sense1 = createMockSenseService(diskUncomfSnap);
    const cries1: string[] = [];

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
        runMaintenanceTurn: async () => {},
        deliverCryToUserSession: async (_t, _e, content) => {
          cries1.push(content);
          return true;
        },
      },
    });

    await rt1.start();
    // 发起一次 uncomfortable 求助卡并立即停止（验证 deliverCryIfNeeded 自身已持久化 criedEpisodeSeverity）
    await rt1.tools.requestHelp({
      need: 'space',
      severity: 'uncomfortable',
      title: '空间进入不适区',
      summary: '剩余 6%',
    });
    expect(cries1).toHaveLength(1);
    await rt1.stop();

    // 重启为 rt2：处于同一 uncomfortable 剧集时不再重复发 uncomfortable <asi-cry>，但恶化至 critical 时正常升级啼哭
    const sense2 = createMockSenseService(diskUncomfSnap);
    const cries2: string[] = [];
    const rt2 = createNeedsRuntime({
      storageRoot,
      sense: sense2,
      clock: { wall: () => nowWall + 5_000, mono: () => 500 },
      probeEndpoint: async () => true,
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => id,
        hasSession: () => true,
        runMaintenanceTurn: async () => {},
        deliverCryToUserSession: async (_t, _e, content) => {
          cries2.push(content);
          return true;
        },
      },
    });

    await rt2.start();
    try {
      expect(cries2).toHaveLength(0);
      await rt2.tools.requestHelp({
        need: 'space',
        severity: 'uncomfortable',
        title: '重复不适请求',
        summary: '不应重复啼哭',
      });
      expect(cries2).toHaveLength(0);

      // 升级到 critical -> 正常发送 critical <asi-cry>
      sense2.emit((prev) => {
        const next = structuredClone(prev);
        next.now = nowWall + 10_000;
        next.mono = 2_000;
        next.state.self.body.disks = {
          kind: 'disks',
          ...fact([{ mount: '/', total: 200 * 1024 ** 3, free: 1 * 1024 ** 3 }]),
        };
        return next;
      });
      await vi.waitFor(() => expect(cries2).toHaveLength(1));
      expect(cries2[0]).toContain('severity="critical"');

      // 先留下一张旧的 uncomfortable 卡，再忽略 critical 卡，然后忽略旧 uncomfortable 卡：
      // 验证 handledEpisodeSeverity 与 criedEpisodeSeverity 不会被降级回 uncomfortable
      const { card: lowCard } = await rt2.tools.requestHelp({
        need: 'space',
        severity: 'uncomfortable',
        title: '附带清理提示',
        summary: '低级别附加卡',
        actionKind: 'clean-cache',
      });
      const critCard = rt2
        .snapshot()
        .helpCards.find((c) => c.need === 'space' && c.status === 'open' && c.severity === 'critical');
      await rt2.actions.dismissHelp(critCard?.id ?? '');
      await rt2.actions.dismissHelp(lowCard.id);

      // 即使跨过 120s 冷却再次自检，由于 critical 已处理且未被降级，不应重新弹出 critical 卡或啼哭
      nowWall += 200_000;
      nowMono += 200_000;
      await rt2.actions.triggerCheck();
      expect(rt2.snapshot().helpCards.filter((c) => c.need === 'space' && c.status === 'open')).toHaveLength(0);
      expect(cries2).toHaveLength(1);
    } finally {
      await rt2.stop();
    }

    // 兼容旧版 state.json（仅含布尔数组 criedEpisodes: ['energy'] 且 previousStates 为 uncomfortable）
    const legacyDir = await mkdtemp(join(tmpdir(), 'asi-needs-legacy-state-'));
    tempDirs.push(legacyDir);
    await writeFile(
      join(legacyDir, 'state.json'),
      JSON.stringify({
        criedEpisodes: ['energy'],
        previousStates: { energy: { zone: 'uncomfortable', driveActive: true, satisfaction: 45 } },
      }),
      'utf8',
    );
    const batSnap = makeSnapshot({ now: T0, mono: 1_000 });
    batSnap.state.self.body.battery = fact({ percent: 30, charging: false, powerState: 'battery', minutesLeft: 60 });
    const senseLegacy = createMockSenseService(batSnap);
    const criesLegacy: string[] = [];
    const rtLegacy = createNeedsRuntime({
      storageRoot: legacyDir,
      sense: senseLegacy,
      clock: { wall: () => T0, mono: () => 1_000 },
      probeEndpoint: async () => true,
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (id) => id,
        hasSession: () => true,
        runMaintenanceTurn: async () => {},
        deliverCryToUserSession: async (_t, _e, content) => {
          criesLegacy.push(content);
          return true;
        },
      },
    });
    await rtLegacy.start();
    try {
      await rtLegacy.tools.requestHelp({
        need: 'energy',
        severity: 'uncomfortable',
        title: '电量偏低',
        summary: '30%',
      });
      expect(criesLegacy).toHaveLength(0);

      // 电量跌至 8%（critical 物理边界）时成功升级并发送 critical <asi-cry>
      senseLegacy.emit((prev) => {
        const next = structuredClone(prev);
        next.state.self.body.battery = fact({ percent: 8, charging: false, powerState: 'battery', minutesLeft: 10 });
        return next;
      });
      await vi.waitFor(() => expect(criesLegacy).toHaveLength(1));
      expect(criesLegacy[0]).toContain('severity="critical"');
    } finally {
      await rtLegacy.stop();
    }
  });
});
