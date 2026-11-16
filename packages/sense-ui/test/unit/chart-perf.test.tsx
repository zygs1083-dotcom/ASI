import { describe, expect, it, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { SensePanel } from '../../src/SensePanel'
import type { SensePanelProps, SensePanelModel } from '../../src/view-model'
import { makeScenario } from '../../src/mock/scenarios'
import { fact } from '../../src/mock/fixtures'
import { sampleHistory } from '../../src/history'
import { buildSpark } from '../../src/geometry'
import { tick } from '../../src/preview/tick'
import { Sparkline } from '../../src/sparkline'
import { formatPercent } from '../../src/format'

vi.mock('../../src/history', async (orig) => {
  const mod = await orig<typeof import('../../src/history')>()
  return { ...mod, sampleHistory: vi.fn(mod.sampleHistory) }
})
vi.mock('../../src/geometry', async (orig) => {
  const mod = await orig<typeof import('../../src/geometry')>()
  return { ...mod, buildSpark: vi.fn(mod.buildSpark) }
})

afterEach(cleanup)

function makeProps(model: SensePanelModel): SensePanelProps {
  return {
    model,
    onToggleRule: vi.fn(),
    onConfirmRule: vi.fn(),
    onDeleteRule: vi.fn(),
    onPause: vi.fn(),
    onToggleTitles: vi.fn(),
    onOpenPermissionSettings: vi.fn(),
    onRevertTuning: vi.fn(),
    onLockParam: vi.fn(),
    onFeedback: vi.fn(),
  }
}

const histCalls = () => vi.mocked(sampleHistory).mock.calls.length
const geoCalls = () => vi.mocked(buildSpark).mock.calls.length

describe('图表渲染预算', () => {
  it('折叠卡片不挂明细图；纯时钟推进零重采样/零几何重建', () => {
    const m = makeScenario('healthy')
    const props = makeProps(m)
    const view = render(<SensePanel {...props} />)
    // 折叠态：无展开图 DOM，无明细容器
    expect(document.querySelector('[class*="chartExpanded"]')).toBeNull()
    expect(document.querySelector('[class*="tileDetail"]')).toBeNull()
    expect(geoCalls()).toBeGreaterThan(0) // 摘要图初始化有采样
    const cpuSparkBefore = document.querySelector(
      'details[data-tile="cpu"] summary svg[data-sev]',
    )!.innerHTML

    // model.now +1s：事实/历史引用全部不变 → 时钟文案之外零图工作
    const h0 = histCalls()
    const g0 = geoCalls()
    view.rerender(<SensePanel {...props} model={{ ...m, now: m.now + 1_000 }} />)
    expect(histCalls()).toBe(h0)
    expect(geoCalls()).toBe(g0)
    expect(
      document.querySelector('details[data-tile="cpu"] summary svg[data-sev]')!.innerHTML,
    ).toBe(cpuSparkBefore)
  })

  it('仅 CPU 事实+历史变化：只有 CPU 摘要图重采样一次；开明细只加 CPU 详图', async () => {
    const m = makeScenario('healthy')
    const props = makeProps(m)
    const view = render(<SensePanel {...props} />)
    vi.mocked(sampleHistory).mockClear()
    vi.mocked(buildSpark).mockClear()

    const now = m.now + 1_000
    const cpu2 = fact(
      { ...m.state.self.body.cpu.value!, usage: 0.9 },
      { ttlMs: 30_000 },
    )
    const m2: SensePanelModel = {
      ...m,
      now,
      state: {
        ...m.state,
        self: {
          ...m.state.self,
          body: { ...m.state.self.body, cpu: cpu2 },
        },
      },
      history: {
        ...m.history,
        cpu: [...m.history.cpu, { at: now, value: 0.9 }],
      },
    }
    view.rerender(<SensePanel {...props} model={m2} />)
    // 折叠态只有一张 CPU 摘要图重建；其余卡引用未变不重渲
    expect(geoCalls()).toBe(1)
    expect(histCalls()).toBe(1)

    // 打开 CPU 明细：仅其展开图补建（摘要图同 points 引用走缓存不再算）
    const details = document.querySelector<HTMLDetailsElement>(
      'details[data-tile="cpu"]',
    )!
    fireEvent.click(details.querySelector('summary')!)
    await waitFor(() =>
      expect(details.querySelector('[class*="tileDetail"]')).toBeTruthy(),
    )
    expect(geoCalls()).toBe(2)
    expect(
      details.querySelector('[class*="tileDetail"] [class*="chartExpanded"]'),
    ).toBeTruthy()
    // 其他卡的明细仍未挂载
    expect(
      document.querySelector('details[data-tile="memory"] [class*="tileDetail"]'),
    ).toBeNull()
    vi.mocked(sampleHistory).mockClear()
    vi.mocked(buildSpark).mockClear()
    view.rerender(<SensePanel {...props} model={{ ...m2, now: now + 1_000 }} />)
    expect(histCalls()).toBe(0)
    expect(geoCalls()).toBe(0)
    fireEvent.click(details.querySelector('summary')!)
    await waitFor(() => expect(details.querySelector('[class*="tileDetail"]')).toBeNull())
  })

  it('实际预览 tick 只重采样变化的 CPU、网络下行与 Token 图', () => {
    const m = makeScenario('healthy')
    const props = makeProps(m)
    const view = render(<SensePanel {...props} />)
    vi.mocked(sampleHistory).mockClear()
    vi.mocked(buildSpark).mockClear()
    const next = tick(m)
    view.rerender(<SensePanel {...props} model={next} />)
    const actual = vi.mocked(sampleHistory).mock.calls.map(([points]) => points)
    expect(actual).toHaveLength(3)
    for (const series of [next.history.cpu, next.history.networkRx, next.history.tokens]) {
      expect(actual.filter((points) => points === series)).toHaveLength(1)
    }
    expect(geoCalls()).toBe(3)
    expect(next.history.memory).toBe(m.history.memory)
    expect(next.history.disks).toBe(m.history.disks)
  })

  it('图表文案和时钟变化但数据相同，不重建采样或路径', () => {
    const m = makeScenario('healthy')
    const view = render(
      <Sparkline points={m.history.cpu} now={m.now} label="CPU" format={formatPercent} />,
    )
    vi.mocked(sampleHistory).mockClear()
    vi.mocked(buildSpark).mockClear()
    view.rerender(
      <Sparkline points={m.history.cpu} now={m.now + 1_000} label="处理器" format={(n) => `${n}`} />,
    )
    expect(histCalls()).toBe(0)
    expect(geoCalls()).toBe(0)
  })
})
