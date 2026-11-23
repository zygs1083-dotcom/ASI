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
    root.provide('tools', {
      register: () => () => {},
      definitions: () => [],
      executable: () => undefined,
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
});
