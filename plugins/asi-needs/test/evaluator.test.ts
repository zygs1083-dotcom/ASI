import { describe, expect, it } from 'vitest';
import { applyHysteresis, evaluateNeeds } from '../src/host/evaluator.js';
import { emptyHistory, fact, makeSnapshot, T0 } from './fixtures.js';

describe('applyHysteresis 连续稳态张力与回滞锁', () => {
  it('未进入不适时：>=60 为 comfortable，<60 为 uncomfortable，<25 为 critical', () => {
    expect(applyHysteresis(100)).toEqual({ satisfaction: 100, urgency: 0, zone: 'comfortable', driveActive: false });
    expect(applyHysteresis(60)).toEqual({ satisfaction: 60, urgency: 40, zone: 'comfortable', driveActive: false });
    expect(applyHysteresis(59)).toEqual({ satisfaction: 59, urgency: 41, zone: 'uncomfortable', driveActive: true });
    expect(applyHysteresis(25)).toEqual({ satisfaction: 25, urgency: 75, zone: 'uncomfortable', driveActive: true });
    expect(applyHysteresis(24)).toEqual({ satisfaction: 24, urgency: 76, zone: 'critical', driveActive: true });
    expect(applyHysteresis(0)).toEqual({ satisfaction: 0, urgency: 100, zone: 'critical', driveActive: true });
  });

  it('进入不适或危急后，恢复到 60..69 仍保持驱动，直到 >=70 才解除', () => {
    const step1 = applyHysteresis(55);
    expect(step1).toMatchObject({ zone: 'uncomfortable', driveActive: true });

    const step2 = applyHysteresis(65, step1);
    expect(step2).toMatchObject({ satisfaction: 65, zone: 'uncomfortable', driveActive: true });

    const step3 = applyHysteresis(69, step2);
    expect(step3).toMatchObject({ satisfaction: 69, zone: 'uncomfortable', driveActive: true });

    const step4 = applyHysteresis(70, step3);
    expect(step4).toMatchObject({ satisfaction: 70, zone: 'comfortable', driveActive: false });
  });
});

describe('evaluateNeeds 五大生存需求评估', () => {
  it('健康环境全部处于 comfortable 且无激活驱动力', () => {
    const res = evaluateNeeds({
      snapshot: makeSnapshot(),
      modelConnectivity: 'online',
      stuckJobCount: 0,
    });
    expect(res.overallZone).toBe('comfortable');
    expect(res.activeDrives).toEqual([]);
    for (const key of ['energy', 'space', 'memory', 'mind', 'thermals'] as const) {
      expect(res.needs[key].zone).toBe('comfortable');
      expect(res.needs[key].driveActive).toBe(false);
    }
  });

  it('能量（energy）：台式机无电池豁免、插电低电量豁免、未插电低电量与网关失联判危急', () => {
    // 台式机 battery: null
    const desktop = makeSnapshot();
    desktop.state.self.body.battery = fact(null);
    expect(evaluateNeeds({ snapshot: desktop, modelConnectivity: 'online', stuckJobCount: 0 }).needs.energy.zone).toBe(
      'comfortable',
    );

    // 插电 5% → comfortable
    const charging = makeSnapshot();
    charging.state.self.body.battery = fact({ percent: 5, charging: true, powerState: 'charging' });
    expect(evaluateNeeds({ snapshot: charging, modelConnectivity: 'online', stuckJobCount: 0 }).needs.energy.zone).toBe(
      'comfortable',
    );

    // 未插电 25% → uncomfortable
    const lowBat = makeSnapshot();
    lowBat.state.self.body.battery = fact({ percent: 25, charging: false, powerState: 'battery' });
    expect(evaluateNeeds({ snapshot: lowBat, modelConnectivity: 'online', stuckJobCount: 0 }).needs.energy.zone).toBe(
      'uncomfortable',
    );

    // 未插电 8% → critical
    const critBat = makeSnapshot();
    critBat.state.self.body.battery = fact({ percent: 8, charging: false, powerState: 'battery' });
    expect(evaluateNeeds({ snapshot: critBat, modelConnectivity: 'online', stuckJobCount: 0 }).needs.energy.zone).toBe(
      'critical',
    );

    // 模型网关失联 → critical
    expect(
      evaluateNeeds({ snapshot: makeSnapshot(), modelConnectivity: 'offline', stuckJobCount: 0 }).needs.energy.zone,
    ).toBe('critical');
  });

  it('空间（space）：卷余量、5 分钟骤降速率与过期卷隔离', () => {
    const GiB = 1024 ** 3;
    const MiB = 1024 ** 2;

    // 过期卷不误报危急
    const staleRoot = makeSnapshot();
    staleRoot.state.self.body.disks = {
      kind: 'disks',
      ...fact([
        { mount: '/', total: 500 * GiB, free: 1 * GiB, status: 'stale', observedAt: T0 - 90_000, ttlMs: 5_000 },
        { mount: '/data', total: 500 * GiB, free: 200 * GiB, status: 'ok', observedAt: T0 - 1_000, ttlMs: 30_000 },
      ]),
    };
    const rStale = evaluateNeeds({ snapshot: staleRoot, modelConnectivity: 'online', stuckJobCount: 0 });
    expect(rStale.needs.space.zone).toBe('comfortable');

    // 剩余空间充足但按 1 GB/分 急速耗尽（10 分钟内见底）→ critical
    const dropping = makeSnapshot({
      history: emptyHistory({
        diskFree: {
          '/': [
            { at: T0 - 120_000, value: 14 * GiB },
            { at: T0, value: 12 * GiB },
          ],
        },
      }),
    });
    dropping.state.self.body.disks = {
      kind: 'disks',
      ...fact([{ mount: '/', total: 100 * GiB, free: 12 * GiB }]),
    };
    const rDrop = evaluateNeeds({ snapshot: dropping, modelConnectivity: 'online', stuckJobCount: 0 });
    expect(rDrop.needs.space.zone).toBe('critical');
    expect(Number(rDrop.needs.space.evidence.dropBytesPerMin)).toBeLessThanOrEqual(-900 * MiB);
  });

  it('内存与进程（memory）：系统内存压力、DSH RSS 膨胀与残留卡死任务', () => {
    const GiB = 1024 ** 3;
    const bloated = makeSnapshot();
    bloated.state.self.body.harnessProcess = fact({ rss: 2 * GiB, cpu: 0.1, uptimeSec: 1000 });
    expect(evaluateNeeds({ snapshot: bloated, modelConnectivity: 'online', stuckJobCount: 0 }).needs.memory.zone).toBe(
      'uncomfortable',
    );

    const stuckJobs = evaluateNeeds({ snapshot: makeSnapshot(), modelConnectivity: 'online', stuckJobCount: 3 });
    expect(stuckJobs.needs.memory.zone).toBe('critical');
  });

  it('心智容量（mind）：fallback 回退估值在偏紧时仅入 uncomfortable，逼近 98%+ 才入 critical', () => {
    const fallbackTight = makeSnapshot();
    fallbackTight.state.self.body.tokens = fact({
      contextWindow: 100_000,
      contextWindowSource: 'fallback',
      contextUsed: 90_000,
      sessionUsage: { input: 90_000, output: 5_000, cacheRead: 0, cacheWrite: 0 },
    });
    const rFallback = evaluateNeeds({ snapshot: fallbackTight, modelConnectivity: 'online', stuckJobCount: 0 });
    expect(rFallback.needs.mind.zone).toBe('uncomfortable');

    const verifiedTight = makeSnapshot();
    verifiedTight.state.self.body.tokens = fact({
      contextWindow: 100_000,
      contextWindowSource: 'configured',
      contextUsed: 95_000,
      sessionUsage: { input: 95_000, output: 5_000, cacheRead: 0, cacheWrite: 0 },
    });
    const rVerified = evaluateNeeds({ snapshot: verifiedTight, modelConnectivity: 'online', stuckJobCount: 0 });
    expect(rVerified.needs.mind.zone).toBe('critical');
  });

  it('体温负荷（thermals）：温控档位与 2 分钟持续满载判定（单点尖峰不误报）', () => {
    // 单点 CPU 95% 但历史均值 30% → 保持 comfortable
    const briefSpike = makeSnapshot({
      history: emptyHistory({
        cpu: [
          { at: T0 - 90_000, value: 0.2 },
          { at: T0 - 60_000, value: 0.25 },
          { at: T0 - 30_000, value: 0.2 },
          { at: T0, value: 0.95 },
        ],
      }),
    });
    briefSpike.state.self.body.cpu = fact({ usage: 0.95, perCore: [0.95], load1: 2, load5: 1, load15: 1 });
    expect(
      evaluateNeeds({ snapshot: briefSpike, modelConnectivity: 'online', stuckJobCount: 0 }).needs.thermals.zone,
    ).toBe('comfortable');

    // 持续 2 分钟 >92% → critical
    const sustained = makeSnapshot({
      history: emptyHistory({
        cpu: [
          { at: T0 - 90_000, value: 0.94 },
          { at: T0 - 60_000, value: 0.96 },
          { at: T0 - 30_000, value: 0.95 },
          { at: T0, value: 0.95 },
        ],
      }),
    });
    sustained.state.self.body.cpu = fact({ usage: 0.95, perCore: [0.95], load1: 8, load5: 7, load15: 6 });
    expect(
      evaluateNeeds({ snapshot: sustained, modelConnectivity: 'online', stuckJobCount: 0 }).needs.thermals.zone,
    ).toBe('critical');
  });

  it('读数短暂 stale / unknown 或单卷过期时保持已激活的回滞驱动，不误清零；墙钟跳变不误判卷过期', () => {
    const GiB = 1024 ** 3;

    // 1. 磁盘：`/` 进入 critical 后，即使 `/` 短暂 stale 而 `/data` 仍 ok，space 仍保持 critical 驱动
    const critRoot = makeSnapshot();
    critRoot.state.self.body.disks = {
      kind: 'disks',
      ...fact([
        { mount: '/', total: 500 * GiB, free: 1 * GiB, status: 'ok' },
        { mount: '/data', total: 500 * GiB, free: 300 * GiB, status: 'ok' },
      ]),
    };
    const step1 = evaluateNeeds({ snapshot: critRoot, modelConnectivity: 'online', stuckJobCount: 0 });
    expect(step1.needs.space).toMatchObject({ zone: 'critical', driveActive: true });

    const rootStale = makeSnapshot();
    rootStale.state.self.body.disks = {
      kind: 'disks',
      ...fact([
        { mount: '/', total: 500 * GiB, free: 1 * GiB, status: 'stale' },
        { mount: '/data', total: 500 * GiB, free: 300 * GiB, status: 'ok' },
      ]),
    };
    const step2 = evaluateNeeds({
      snapshot: rootStale,
      modelConnectivity: 'online',
      stuckJobCount: 0,
      previous: {
        space: {
          zone: step1.needs.space.zone,
          driveActive: step1.needs.space.driveActive,
          satisfaction: step1.needs.space.satisfaction,
          mount: String(step1.needs.space.evidence.mount),
        },
      },
    });
    expect(step2.needs.space).toMatchObject({ zone: 'critical', driveActive: true });

    // 墙钟大幅跳变（now + 1h）但单调时钟仍标记 status: 'ok' 时，不应因 observedAt + ttlMs < now 误判忽略危急卷
    const jumpedWall = makeSnapshot({ now: T0 + 3_600_000 });
    jumpedWall.state.self.body.disks = {
      kind: 'disks',
      ...fact([{ mount: '/', total: 500 * GiB, free: 1 * GiB, status: 'ok', observedAt: T0 - 1_000, ttlMs: 30_000 }]),
    };
    expect(
      evaluateNeeds({ snapshot: jumpedWall, modelConnectivity: 'online', stuckJobCount: 0 }).needs.space.zone,
    ).toBe('critical');

    // 2. 能量 / 内存 / 心智 / 温控：驱动激活后传感器短暂 stale 时保持回滞驱动；新会话 unknown 则正常释放
    const distressed = makeSnapshot({ activeSessionId: 'sess-a' });
    distressed.state.self.body.battery = fact({ percent: 8, charging: false, powerState: 'battery' });
    distressed.state.self.body.memory = fact({
      total: 32 * GiB,
      used: 31 * GiB,
      pressure: 'critical',
      swapUsed: 8 * GiB,
    });
    distressed.state.self.body.thermal = fact('critical');
    distressed.state.self.body.tokens = fact({
      contextWindow: 100_000,
      contextWindowSource: 'configured',
      contextUsed: 96_000,
      sessionUsage: { input: 96_000, output: 1_000, cacheRead: 0, cacheWrite: 0 },
    });
    const d1 = evaluateNeeds({ snapshot: distressed, modelConnectivity: 'online', stuckJobCount: 0 });
    const prev = {
      energy: {
        zone: d1.needs.energy.zone,
        driveActive: d1.needs.energy.driveActive,
        satisfaction: d1.needs.energy.satisfaction,
        batteryDriven: true,
      },
      memory: {
        zone: d1.needs.memory.zone,
        driveActive: d1.needs.memory.driveActive,
        satisfaction: d1.needs.memory.satisfaction,
      },
      thermals: {
        zone: d1.needs.thermals.zone,
        driveActive: d1.needs.thermals.driveActive,
        satisfaction: d1.needs.thermals.satisfaction,
      },
      mind: {
        zone: d1.needs.mind.zone,
        driveActive: d1.needs.mind.driveActive,
        satisfaction: d1.needs.mind.satisfaction,
        sessionId: 'sess-a',
      },
    };

    const staleSnap = makeSnapshot({ activeSessionId: 'sess-a' });
    staleSnap.state.self.body.battery = fact(null, { status: 'stale' });
    staleSnap.state.self.body.memory = fact(null, { status: 'stale' });
    staleSnap.state.self.body.thermal = fact(null, { status: 'stale' });
    staleSnap.state.self.body.cpu = fact(null, { status: 'stale' });
    staleSnap.state.self.body.harnessProcess = fact(null, { status: 'stale' });
    staleSnap.state.self.body.tokens = fact(null, { status: 'stale' });

    const dStale = evaluateNeeds({
      snapshot: staleSnap,
      modelConnectivity: 'online',
      stuckJobCount: 0,
      previous: prev,
    });
    expect(dStale.needs.energy).toMatchObject({ zone: 'critical', driveActive: true });
    expect(dStale.needs.memory).toMatchObject({ zone: 'critical', driveActive: true });
    expect(dStale.needs.thermals).toMatchObject({ zone: 'critical', driveActive: true });
    expect(dStale.needs.mind).toMatchObject({ zone: 'critical', driveActive: true });

    // 用户切换到全新空白会话 sess-b（tokens 尚未采样为 unknown）时，不应把旧会话心智危急扣在新会话头上
    const switchedSnap = makeSnapshot({ activeSessionId: 'sess-b' });
    switchedSnap.state.self.body.tokens = fact(null, { status: 'unknown' });
    const dSwitched = evaluateNeeds({
      snapshot: switchedSnap,
      modelConnectivity: 'online',
      stuckJobCount: 0,
      previous: prev,
    });
    expect(dSwitched.needs.mind).toMatchObject({ zone: 'comfortable', driveActive: false });
  });
});
