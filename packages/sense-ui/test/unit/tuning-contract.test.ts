import { describe, expect, it } from 'vitest'
import type { SensePanelProps } from '../../src/view-model'

describe('危险调参回调类型', () => {
  it('必须返回 Promise<void>', () => {
    const valid: Pick<SensePanelProps, 'onResumeTuning' | 'onResetTuning' | 'onAcceptRebaseline'> = {
      onResumeTuning: async () => {},
      onResetTuning: async () => {},
      onAcceptRebaseline: async () => {},
    }
    // @ts-expect-error 返回 void 不满足危险操作契约
    valid.onResumeTuning = () => {}
    // @ts-expect-error 返回 void 不满足危险操作契约
    valid.onResetTuning = () => {}
    // @ts-expect-error 返回 void 不满足危险操作契约
    valid.onAcceptRebaseline = () => {}
    expect(valid).toBeTruthy()
  })
})
