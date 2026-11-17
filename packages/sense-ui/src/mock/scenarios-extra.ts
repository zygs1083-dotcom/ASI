/** 场景补充：上下文接近满/回退估值与卷级新鲜度混杂的磁盘场景。 */

import type { SensePanelModel } from '../view-model';
import { fact, makeBody, makeHistory, makeInsights, makeState, panelModel, series, T0 } from './fixtures';

export function contextAlmostFull(): SensePanelModel {
  const body = makeBody();
  body.tokens = fact({
    contextWindow: 128_000,
    contextWindowSource: 'catalog',
    contextUsed: 118_500,
    contextProjected: 124_000,
    sessionUsage: { input: 410_000, output: 38_000, cacheRead: 290_000, cacheWrite: 21_000 },
    compressionThreshold: 120_000,
  });
  return panelModel(makeState({ self: { ...makeState().self, body } }), {
    history: makeHistory({ tokens: series(60, 5_000, (i) => 90_000 + i * 470) }),
    // 宿主在该读数下 floor 层确会触发 warn（剩余 7.4% < 12%），
    // 否则 sources 含 floor 而 triggered 为空会把行压回 good。
    insights: makeInsights({
      tokens: {
        baseline: { low: 30_000, high: 60_000 },
        sources: ['floor', 'baseline'],
        triggered: ['floor'],
        severity: 'warn',
      },
    }),
  });
}

/** 上下文窗口容量来自回退估值：环/余量降饱和为「容量未确认」，无告警。 */
export function tokenFallback(): SensePanelModel {
  const m = contextAlmostFull();
  m.state.self.body.tokens = fact({
    ...m.state.self.body.tokens.value!,
    contextWindowSource: 'fallback',
  });
  return m;
}

/**
 * 卷级新鲜度混杂（与 DiskSampler.sample 实际产物同形）：
 * 根卷显式 stale（保留值灰显）、/data 显式 ok；父事实 ok，元数据只来自
 * 唯一的 fresh 卷（observedAt/ttlMs 沿用 /data）；网络盘挂起列入
 * unavailableMounts（不产数字、历史、图）。
 */
export function diskPartial(): SensePanelModel {
  const state = makeState();
  state.self.body.disks = {
    kind: 'disks',
    ...fact(
      [
        {
          mount: '/',
          total: 460e9,
          free: 175e9,
          status: 'stale',
          observedAt: T0 - 90_000,
          ttlMs: 5_000,
        },
        {
          mount: '/data',
          total: 200e9,
          free: 160e9,
          status: 'ok',
          observedAt: T0 - 1_000,
          ttlMs: 30_000,
        },
      ],
      { api: 'diskstat', ageMs: 1_000, ttlMs: 30_000 },
    ),
    unavailableMounts: ['/Volumes/network'],
  };
  return panelModel(state, {
    history: makeHistory({
      disks: {
        '/': series(60, 5_000, (i) => 0.62 + 0.005 * Math.sin(i / 20)),
        '/data': series(60, 5_000, (i) => 0.2 + 0.004 * Math.sin(i / 20)),
      },
    }),
  });
}
