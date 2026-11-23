/** 演示场景，供预览与测试使用。 */

import type { NeedsPanelModel } from '../view-model';
import {
  denied,
  disksFixture,
  emptyFact,
  fact,
  makeBody,
  makeHistory,
  makeInstinct,
  makeMaintenanceSession,
  makeNeed,
  makeNeeds,
  makeState,
  panelModel,
  series,
  T0,
} from './fixtures';
import { contextAlmostFull, diskPartial, tokenFallback } from './scenarios-extra';

export const SCENARIOS = [
  'healthy',
  'memory-pressure',
  'context-almost-full',
  'permission-denied',
  'desktop-no-battery',
  'rapid-change',
  'low-energy',
  'token-fallback',
  'disk-partial',
  'external-cache-arbitration',
] as const;

export type ScenarioName = (typeof SCENARIOS)[number];

function healthy(): NeedsPanelModel {
  return panelModel(makeState());
}

function memoryPressure(): NeedsPanelModel {
  const body = makeBody();
  body.memory = fact({ total: 32e9, used: 29.1e9, pressure: 'warn', swapUsed: 3.2e9 }, { api: 'vm_stat' });
  return panelModel(makeState({ self: { ...makeState().self, body } }), {
    history: makeHistory({ memory: series(60, 5_000, (i) => 0.82 + 0.09 * Math.sin(i / 8)) }),
    needs: makeNeeds({
      memory: makeNeed('memory', 40, '系统内存压力偏高（已用 27.1 GB），正在排查残留任务'),
    }),
    maintenanceSession: makeMaintenanceSession({
      status: 'running',
      lastRunAt: T0 - 15_000,
      turnCount: 2,
    }),
    recentMaintenance: [
      {
        id: 'rec-mem-1',
        at: T0 - 25_000,
        actor: 'maintainer',
        need: 'memory',
        action: 'needs_stop_job',
        summary: '结束超时无主任务 job-orphan-3，释放 420 MB',
        outcome: 'partial',
      },
    ],
  });
}

function permissionDenied(): NeedsPanelModel {
  const state = makeState();
  state.env.focusedWindow = denied('未授予辅助功能权限');
  state.env.frontApp = fact({ name: 'Finder', bundleId: 'com.demo.finder' }, { status: 'stale', ageMs: 120_000 });
  state.self.permissions = fact({ 辅助功能: 'denied' });
  const body = makeBody();
  body.thermal = emptyFact('unavailable', 'helper 未上报温控');
  body.battery = emptyFact('unknown');
  body.network = emptyFact('unsupported', '非 macOS 无此信号源');
  body.disks = { ...emptyFact('stale'), kind: 'disks' };
  state.self.body = body;
  state.observation.sources['macos-helper'] = {
    status: 'denied',
    lastSignalAt: T0 - 180_000,
    error: 'AX 订阅失败',
  };
  return panelModel(state);
}

function desktopNoBattery(): NeedsPanelModel {
  const body = makeBody();
  body.battery = fact(null);
  return panelModel(makeState({ self: { ...makeState().self, body } }), {
    needs: makeNeeds({
      energy: makeNeed('energy', 95, '台式机外接电源 · 模型网关连通正常'),
    }),
  });
}

function rapidChange(): NeedsPanelModel {
  const body = makeBody();
  body.disks = disksFixture([
    { mount: '/', total: 460e9, free: 18e9 },
    { mount: '/demo/vol', total: 120e9, free: 72e9 },
  ]);
  return panelModel(makeState({ self: { ...makeState().self, body } }), {
    history: makeHistory({
      disks: {
        '/': series(60, 5_000, (i) => 0.88 + (i / 60) * 0.08),
        '/demo/vol': series(60, 5_000, () => 0.4),
      },
      diskFree: {
        '/': series(60, 5_000, (i) => 28.5e9 - i * 175e6),
        '/demo/vol': series(60, 5_000, () => 72e9),
      },
    }),
    needs: makeNeeds({
      space: makeNeed('space', 18, '主卷仅剩 16.8 GB（3.9%），且每分钟骤降约 2.1 GB'),
    }),
    helpCards: [
      {
        id: 'help-space-1',
        need: 'space',
        severity: 'critical',
        title: '磁盘空间即将耗尽，需人工释放大文件',
        summary:
          '主卷 / 剩余不足 4%，后台已清理插件临时区 380 MB，但剩余大文件位于用户目录，插件不会删除任何用户文件。',
        proposedAction: '请检查构建产物或下载目录中的大文件并手动清理。',
        actionKind: 'acknowledge',
        status: 'open',
        createdAt: T0 - 45_000,
        updatedAt: T0 - 12_000,
      },
    ],
    recentMaintenance: [
      {
        id: 'rec-space-1',
        at: T0 - 50_000,
        actor: 'maintainer',
        need: 'space',
        action: 'needs_clean_cache',
        summary: '清理沙盒临时缓存 14 项，释放 380 MB，但仍未恢复至安全线',
        outcome: 'escalated',
      },
    ],
  });
}

function lowEnergy(): NeedsPanelModel {
  const body = makeBody();
  body.battery = fact({ percent: 7, charging: false, powerState: 'battery', minutesLeft: 18 });
  return panelModel(makeState({ self: { ...makeState().self, body } }), {
    needs: makeNeeds({
      energy: makeNeed('energy', 12, '电池仅剩 7%（未插电）且模型网关失联'),
    }),
    instinct: makeInstinct({
      powerMode: 'eco',
      powerReason: '电量低于 15% 且未接电源',
      modelConnectivity: 'offline',
      probeCount: 3,
      lastProbeAt: T0 - 4_000,
    }),
    helpCards: [
      {
        id: 'help-energy-1',
        need: 'energy',
        severity: 'critical',
        title: '电量危急且模型网关失联',
        summary: '当前电量仅剩 7%（约 18 分钟），已自动进入本能节能降频并静默重连网关。',
        proposedAction: '请尽快接通电源适配器，并检查本地网关服务状态。',
        actionKind: 'acknowledge',
        status: 'open',
        createdAt: T0 - 30_000,
        updatedAt: T0 - 4_000,
      },
    ],
    recentMaintenance: [
      {
        id: 'rec-instinct-1',
        at: T0 - 30_000,
        actor: 'instinct',
        need: 'energy',
        action: 'eco-mode',
        summary: '触发零 Token 本能反射：切换采样至节能模式并退避探活网关',
        outcome: 'partial',
      },
    ],
  });
}

function externalCacheArbitration(): NeedsPanelModel {
  const body = makeBody();
  body.disks = disksFixture([
    { mount: '/', total: 460e9, free: 38e9 },
    { mount: '/demo/vol', total: 120e9, free: 72e9 },
  ]);
  return panelModel(makeState({ self: { ...makeState().self, body } }), {
    needs: makeNeeds({
      space: makeNeed('space', 44, '主卷剩余 35.4 GB（8.3%），检测到外部开发者缓存占用较高'),
    }),
    maintenanceSession: makeMaintenanceSession({
      status: 'idle',
      turnCount: 2,
      lastRunAt: T0 - 30_000,
      circuitBrokenNeeds: ['space'],
    }),
    helpCards: [
      {
        id: 'help-ext-cache-1',
        need: 'space',
        severity: 'uncomfortable',
        title: '发现可清理外部缓存：Xcode DerivedData（可释放 14.20 GB）',
        summary:
          '扫描到 Xcode DerivedData 总计 15.80 GB，其中超过 1 小时的可清理项为 14.20 GB（风险分级：safe）；另只读统计到废纸篓占用 2.10 GB（仅提示不代清）。',
        proposedAction: '点击「批准清理外部缓存」将直接清除超过 1 小时的陈旧项，自动跳过 1 小时内活跃子项。',
        actionKind: 'clean-external-cache',
        actionTarget: 'xcode-derived-data',
        status: 'open',
        createdAt: T0 - 30_000,
        updatedAt: T0 - 20_000,
      },
    ],
    actionLedger: [
      {
        need: 'space',
        action: 'clean-external-cache:homebrew',
        attempts: 2,
        effectiveCount: 2,
        successRate: 1,
        totalFreedBytes: 5_200_000_000,
        totalStoppedJobs: 0,
        totalTokensSaved: 0,
        totalSatisfactionDelta: 19,
        lastAttemptAt: T0 - 120_000,
        lastEffective: true,
      },
      {
        need: 'space',
        action: 'needs_clean_cache',
        attempts: 1,
        effectiveCount: 0,
        successRate: 0,
        totalFreedBytes: 0,
        totalStoppedJobs: 0,
        totalTokensSaved: 0,
        totalSatisfactionDelta: 0,
        lastAttemptAt: T0 - 30_000,
        lastEffective: false,
      },
    ],
    higherOrderSuppressed: true,
    higherOrderSuppressionReason: 'L1 生理需求处于不适或恢复期，高阶需求已挂起',
    higherOrderDrives: [
      {
        key: 'asi-sleep:consolidation',
        sourceId: 'asi-sleep',
        tier: 2,
        label: '记忆离线巩固',
        satisfaction: 48,
        urgency: 52,
        zone: 'uncomfortable',
        driveActive: true,
        suppressed: true,
        suppressionReason: 'L1 生理需求处于不适或恢复期，高阶需求已挂起',
        summary: '累计 9 条碎片记忆待空闲期离线整合',
        evidence: { pendingFragments: 9 },
        updatedAt: T0,
      },
      {
        key: 'asi-care:digest',
        sourceId: 'asi-care',
        tier: 3,
        label: '环境健康周报',
        satisfaction: 85,
        urgency: 15,
        zone: 'comfortable',
        driveActive: false,
        suppressed: true,
        summary: '本周摘要已是最新',
        evidence: {},
        updatedAt: T0,
      },
    ],
    recentMaintenance: [
      {
        id: 'rec-ext-0',
        at: T0 - 30_000,
        actor: 'maintainer',
        need: 'space',
        action: 'needs_clean_cache',
        summary: 'ASI 自有临时缓存目录已干净，无可清理项',
        outcome: 'info',
        gain: {
          satisfactionBefore: 44,
          satisfactionAfter: 44,
          satisfactionDelta: 0,
          effective: false,
        },
      },
    ],
  });
}

const BUILDERS: Record<ScenarioName, () => NeedsPanelModel> = {
  healthy,
  'memory-pressure': memoryPressure,
  'context-almost-full': contextAlmostFull,
  'permission-denied': permissionDenied,
  'desktop-no-battery': desktopNoBattery,
  'rapid-change': rapidChange,
  'low-energy': lowEnergy,
  'token-fallback': tokenFallback,
  'disk-partial': diskPartial,
  'external-cache-arbitration': externalCacheArbitration,
};

export function makeScenario(name: ScenarioName): NeedsPanelModel {
  return BUILDERS[name]();
}
