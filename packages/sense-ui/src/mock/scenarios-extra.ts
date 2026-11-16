/** 场景补充：上下文接近满/回退估值与卷级新鲜度混杂的磁盘场景。 */

import type { SensePanelModel } from '../view-model'
import {
  fact,
  makeBody,
  makeHistory,
  makeState,
  panelModel,
  series,
  T0,
} from './fixtures'

export function contextAlmostFull(): SensePanelModel {
  const body = makeBody()
  body.tokens = fact({
    contextWindow: 128_000,
    contextWindowSource: 'catalog',
    contextUsed: 118_500,
    contextProjected: 124_000,
    sessionUsage: { input: 410_000, output: 38_000, cacheRead: 290_000, cacheWrite: 21_000 },
    compressionThreshold: 120_000,
  })
  return panelModel(makeState({ self: { ...makeState().self, body } }), {
    history: makeHistory({ tokens: series(60, 5_000, (i) => 90_000 + i * 470) }),
  })
}

/** 上下文窗口容量来自回退估值：环/余量降饱和为「容量未确认」，无告警。 */
export function tokenFallback(): SensePanelModel {
  const m = contextAlmostFull()
  m.state.self.body.tokens = fact({
    ...m.state.self.body.tokens.value!,
    contextWindowSource: 'fallback',
  })
  return m
}

/** 卷级新鲜度混杂：根卷读数过期（保留值灰显）、/data 新鲜、网络盘挂起无法读取。 */
export function diskPartial(): SensePanelModel {
  const state = makeState()
  state.self.body.disks = {
    ...fact(
      [
        {
          mount: '/',
          total: 460e9,
          free: 175e9,
          observedAt: T0 - 90_000,
          ttlMs: 5_000,
        },
        { mount: '/data', total: 200e9, free: 160e9 },
      ],
      { api: 'diskstat' },
    ),
    unavailableMounts: ['/Volumes/network'],
  }
  return panelModel(state, {
    history: makeHistory({
      disks: {
        '/': series(60, 5_000, (i) => 0.62 + 0.005 * Math.sin(i / 20)),
        '/data': series(60, 5_000, (i) => 0.2 + 0.004 * Math.sin(i / 20)),
      },
    }),
  })
}
