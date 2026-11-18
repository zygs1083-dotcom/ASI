/** 八个演示场景，供预览与 e2e 截图使用。 */

import type { SenseEvent, SensePanelModel } from '../view-model';
import {
  denied,
  emptyFact,
  fact,
  makeBody,
  makeEvent,
  makeHistory,
  makeInsights,
  makeState,
  panelModel,
  series,
  T0,
} from './fixtures';
import { contextAlmostFull, diskPartial, tokenFallback } from './scenarios-extra';
import { historyAwayAnomaly, historyEmpty, historyReady } from './scenarios-history';

export const SCENARIOS = [
  'healthy',
  'memory-pressure',
  'context-almost-full',
  'permission-denied',
  'busy-events',
  'desktop-no-battery',
  'learning',
  'rapid-change',
  'token-fallback',
  'disk-partial',
  'tuning-disabled',
  'rebaseline-suggested',
  'history-ready',
  'history-empty',
  'history-away-anomaly',
  'history-monthly-error',
] as const;

export type ScenarioName = (typeof SCENARIOS)[number];

function healthy(): SensePanelModel {
  const events = [
    makeEvent(1, { level: 'context', reason: '命中保存合并', ruleName: 'src 下文件保存' }),
    makeEvent(2),
    makeEvent(3, { cause: 'agent', reason: 'Agent 工具写入', level: 'record' }),
    makeEvent(4, { level: 'wake', reason: '任务非 0 退出', ruleName: '测试失败时唤醒' }),
  ];
  return panelModel(makeState(), { events });
}

function memoryPressure(): SensePanelModel {
  const body = makeBody();
  body.memory = fact({ total: 32e9, used: 29.1e9, pressure: 'warn', swapUsed: 3.2e9 }, { api: 'vm_stat' });
  return panelModel(makeState({ self: { ...makeState().self, body } }), {
    history: makeHistory({ memory: series(60, 5_000, (i) => 0.82 + 0.09 * Math.sin(i / 8)) }),
  });
}

function permissionDenied(): SensePanelModel {
  const state = makeState();
  state.env.focusedWindow = denied('未授予辅助功能权限');
  state.env.frontApp = fact({ name: 'Finder', bundleId: 'com.demo.finder' }, { status: 'stale', ageMs: 120_000 });
  state.self.permissions = fact({ 辅助功能: 'denied', 完全磁盘访问: 'granted' });
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

function busyEvents(): SensePanelModel {
  const events: SenseEvent[] = Array.from({ length: 237 }, (_, i) => {
    const n = 237 - i;
    const over: Partial<SenseEvent> = {};
    if (n % 11 === 0) {
      over.level = 'suppressed';
      over.reason = '唤醒预算超限已抑制';
    } else if (n % 7 === 0) {
      over.level = 'context';
      over.reason = '命中保存合并';
      over.ruleName = 'src 下文件保存';
      over.count = 3;
    } else if (n % 13 === 0) {
      over.level = 'wake';
      over.reason = '任务非 0 退出';
      over.ruleName = '测试失败时唤醒';
    }
    if (n % 5 === 0) over.cause = 'agent';
    return makeEvent(n, over);
  });
  return panelModel(makeState(), { events });
}

function desktopNoBattery(): SensePanelModel {
  const body = makeBody();
  body.battery = fact(null);
  return panelModel(makeState({ self: { ...makeState().self, body } }));
}

/**
 * 基线学习进行中（37%）：floor/rate 阈值来源已有，学习基线尚未提供，
 * 因此趋势线不画 band（不虚构），来源标注只列 floor/rate。
 */
function learning(): SensePanelModel {
  return panelModel(makeState(), {
    learning: { status: 'learning', collectedMs: 0.37 * 86_400_000, targetMs: 86_400_000 },
    insights: {
      cpu: { sources: ['floor', 'rate'], triggered: [] },
      memory: { sources: ['floor', 'rate'], triggered: [] },
      'disk:/': { sources: ['floor', 'rate'], triggered: [] },
      tokens: { sources: ['floor'], triggered: [] },
    },
  });
}

/** 快速变化：速率/异常/文件爆发告警 + 调整日志（含各操作者与一条锁定参数）。 */
function rapidChange(): SensePanelModel {
  const events = [
    makeEvent(1, {
      signal: { kind: 'body.rate', subject: '磁盘 /', data: { feedbackAvailable: true } },
      level: 'wake',
      reason: '磁盘可用空间变化率触发',
      detail: {
        kind: 'body.rate',
        metric: 'disk:/',
        windowMs: 60_000,
        delta: -2.1 * 1024 ** 3,
        unit: 'bytes',
        timeToFloorMs: 9 * 60_000,
      },
    }),
    makeEvent(2, {
      signal: { kind: 'body.anomaly', subject: '网络下行', data: { feedbackAvailable: true } },
      level: 'context',
      reason: '网络下行偏离基线',
      detail: {
        kind: 'body.anomaly',
        metric: 'networkRx',
        current: 1_400_000,
        baseline: 420_000,
        deviation: 2.33,
        unit: 'bytes',
      },
    }),
    makeEvent(3, {
      signal: { kind: 'file.burst', subject: '/demo/project/tmp', data: { feedbackAvailable: true } },
      level: 'wake',
      reason: '目录突发大量删除',
      detail: {
        kind: 'file.burst',
        directory: '/demo/project/tmp',
        windowMs: 60_000,
        created: 2,
        modified: 4,
        deleted: 70,
        excessiveDeletion: true,
      },
    }),
    makeEvent(4),
  ];
  return panelModel(makeState(), {
    events,
    insights: makeInsights({
      'disk:/': {
        baseline: { low: 0.55, high: 0.7 },
        sources: ['floor', 'rate', 'baseline'],
        triggered: ['rate'],
        severity: 'warn',
        // 宿主当前投影：采样点 T0，9 分钟后见底；事件里的 timeToFloorMs 只是当时预计
        currentEta: {
          asOf: T0,
          sampleIntervalMs: 30_000,
          timeToThresholdMs: 9 * 60_000,
          ratePerMinute: -2.1 * 1024 ** 3,
        },
      },
      networkRx: {
        baseline: { low: 100_000, high: 700_000 },
        sources: ['rate', 'baseline'],
        triggered: ['baseline'],
        severity: 'warn',
      },
    }),
    tuning: {
      parameters: [
        { key: 'cpu.anomalySigma', label: 'CPU 异常灵敏度', value: 4, unit: 'σ', locked: false },
        { key: 'watch.interval', label: '采样间隔', value: 5, unit: '秒', locked: true },
        { key: 'wake.budget', label: '唤醒预算', value: 3, unit: '次/小时', locked: false },
      ],
      log: [
        {
          id: 't-1',
          paramKey: 'cpu.anomalySigma',
          previous: 3,
          next: 4,
          by: 'agent',
          reason: '连续噪音反馈，将异常判定从 3σ 调整到 4σ',
          at: T0 - 3_600_000,
        },
        {
          id: 't-2',
          paramKey: 'watch.interval',
          previous: 10,
          next: 5,
          by: 'user',
          reason: '希望更快看到变化',
          at: T0 - 7_200_000,
        },
        {
          id: 't-3',
          paramKey: 'wake.budget',
          previous: 5,
          next: 3,
          by: 'auto',
          reason: '夜间自动降频',
          at: T0 - 86_400_000,
          reverted: true,
        },
      ],
    },
  });
}

function tuningDisabled(): SensePanelModel {
  const model = rapidChange();
  return { ...model, tuning: { ...model.tuning!, disabled: { reason: 'restore-failed' } } };
}

function rebaselineSuggested(): SensePanelModel {
  const model = rapidChange();
  return {
    ...model,
    tuning: {
      ...model.tuning!,
      disabled: { reason: 'storage-failed' },
      suggestions: [
        {
          id: 'baseline-cpu',
          metric: 'cpu',
          unit: 'ratio',
          slotLabel: '周二 14 时',
          from: 0.2,
          to: 0.68,
          samples: 12,
          dates: 3,
        },
        {
          id: 'baseline-network',
          metric: 'networkRx',
          unit: 'bytes-per-second',
          slotLabel: '周五 10 时',
          from: 400_000,
          to: 1_400_000,
          samples: 9,
          dates: 3,
        },
        {
          id: 'baseline-disk',
          metric: 'disk:/demo',
          unit: 'bytes',
          slotLabel: '周三 9 时',
          from: 80 * 1024 ** 3,
          to: 60 * 1024 ** 3,
          samples: 10,
          dates: 3,
        },
        {
          id: 'baseline-context',
          metric: 'tokens',
          unit: 'tokens',
          slotLabel: '周四 11 时',
          from: 50_000,
          to: 30_000,
          samples: 11,
          dates: 3,
        },
      ],
    },
  };
}

const BUILDERS: Record<ScenarioName, () => SensePanelModel> = {
  healthy,
  'memory-pressure': memoryPressure,
  'context-almost-full': contextAlmostFull,
  'permission-denied': permissionDenied,
  'busy-events': busyEvents,
  'desktop-no-battery': desktopNoBattery,
  learning,
  'rapid-change': rapidChange,
  'token-fallback': tokenFallback,
  'disk-partial': diskPartial,
  'tuning-disabled': tuningDisabled,
  'rebaseline-suggested': rebaselineSuggested,
  'history-ready': () => historyReady(healthy()),
  'history-empty': () => historyEmpty(healthy()),
  'history-away-anomaly': () => historyAwayAnomaly(healthy()),
  'history-monthly-error': () => historyReady(healthy()),
};

export function makeScenario(name: ScenarioName): SensePanelModel {
  return BUILDERS[name]();
}
