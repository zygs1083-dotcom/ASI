/** 场景补充：上下文接近满、回退估值与卷级新鲜度混杂的磁盘场景。 */

import type { NeedsPanelModel } from '../view-model';
import {
  fact,
  makeBody,
  makeHistory,
  makeMaintenanceSession,
  makeNeed,
  makeNeeds,
  makeState,
  panelModel,
  series,
  T0,
} from './fixtures';

export function contextAlmostFull(): NeedsPanelModel {
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
    needs: makeNeeds({
      mind: makeNeed('mind', 32, '上下文仅剩 7%（9.5k），后台准备压缩空闲会话'),
    }),
    maintenanceSession: makeMaintenanceSession({
      status: 'running',
      lastRunAt: T0 - 8_000,
      turnCount: 1,
    }),
  });
}

export function tokenFallback(): NeedsPanelModel {
  const m = contextAlmostFull();
  m.state.self.body.tokens = fact({
    ...m.state.self.body.tokens.value!,
    contextWindowSource: 'fallback',
  });
  m.needs = makeNeeds({
    mind: makeNeed('mind', 42, '上下文回退估值较紧（93%），空闲时可尝试整理'),
  });
  m.overallZone = 'uncomfortable';
  return m;
}

export function diskPartial(): NeedsPanelModel {
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
      diskFree: {
        '/': series(60, 5_000, () => 175e9),
        '/data': series(60, 5_000, () => 160e9),
      },
    }),
  });
}
