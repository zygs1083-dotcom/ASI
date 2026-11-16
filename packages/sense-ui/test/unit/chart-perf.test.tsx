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
import { ClockProvider, SamplingProvider } from '../../src/clock'

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
    onResumeTuning: vi.fn(async () => {}),
    onResetTuning: vi.fn(async () => {}),
    onAcceptRebaseline: vi.fn(async (_id: string) => {}),
  }
}

const histCalls = () => vi.mocked(sampleHistory).mock.calls.length
const geoCalls = () => vi.mocked(buildSpark).mock.calls.length

describe('图表渲染预算', () => {
  it('温控按 30 秒心跳判断滞后，2 秒指标仍按原周期判断', () => {
    const now = 1_700_000_000_000
    const points = [{ at: now - 1_000, value: 0 }, { at: now, value: 0 }]
    const draw = (age: number) => (
      <SamplingProvider value={{ paused: false, intervals: { thermal: 30_000 } }}>
        <Sparkline metric="thermal" points={points} now={now + age} label="温控" format={String} />
        <Sparkline metric="cpu" points={points} now={now + age} label="CPU" format={String} />
      </SamplingProvider>
    )
    const view = render(draw(0))
    for (const age of [13_000, 59_000, 90_000]) {
      view.rerender(draw(age))
      expect(view.container.textContent).toContain('温控最近 5 分钟趋势：当前')
      expect(view.container.textContent).toContain('CPU历史 5 分钟趋势，数据滞后')
    }
    view.rerender(draw(90_001))
    expect(view.container.textContent).toContain('温控历史 5 分钟趋势，数据滞后')
    view.rerender(draw(6_000))
    expect(view.container.textContent).toContain('CPU最近 5 分钟趋势：当前')
    view.rerender(draw(6_001))
    expect(view.container.textContent).toContain('CPU历史 5 分钟趋势，数据滞后')
  })

  it('按各序列周期标记滞后，显式暂停立即生效且不重建图形', async () => {
    const m = makeScenario('healthy')
    const points = [{ at: m.now - 60_000, value: 0.2 }, { at: m.now, value: 0.3 }]
    const props = makeProps({
      ...m,
      sampleIntervalsMs: { 'disk:/': 10_000, battery: 30_000 },
      history: { ...m.history, disks: { '/': points }, battery: points },
    })
    const view = render(<SensePanel {...props} />)
    const disk = await waitFor(() => view.container.querySelector('details[data-tile="disks"] summary')!)
    const battery = view.container.querySelector('details[data-tile="battery"] summary')!
    vi.mocked(buildSpark).mockClear()
    view.rerender(<SensePanel {...props} model={{ ...props.model, paused: true }} />)
    expect(disk.textContent).toContain('采集暂停 · 最后')
    expect(battery.textContent).toContain('采集暂停 · 最后')
    expect(disk.textContent).not.toContain('当前')
    expect(geoCalls()).toBe(0)
    view.rerender(<SensePanel {...props} model={props.model} />)
    view.rerender(<SensePanel {...props} model={{ ...props.model, now: m.now + 29_000 }} />)
    expect(disk.textContent).not.toContain('数据滞后')
    expect(battery.textContent).not.toContain('数据滞后')
    view.rerender(<SensePanel {...props} model={{ ...props.model, now: m.now + 30_001 }} />)
    expect(disk.textContent).toContain('数据滞后 · 最后 30 秒前')
    expect(disk.textContent).not.toContain('采集暂停')
    expect(battery.textContent).not.toContain('数据滞后')
    const intervals = { 'disk:/': 20_000, battery: 30_000 } as const
    view.rerender(<SensePanel {...props} model={{ ...props.model, sampleIntervalsMs: intervals, now: m.now + 30_001 }} />)
    expect(disk.textContent).not.toContain('数据滞后')
    view.rerender(<SensePanel {...props} model={{ ...props.model, sampleIntervalsMs: intervals, now: m.now + 60_001 }} />)
    expect(disk.textContent).toContain('数据滞后 · 最后 60 秒前')
    expect(battery.textContent).not.toContain('数据滞后')
    view.rerender(<SensePanel {...props} model={{ ...props.model, sampleIntervalsMs: intervals, now: m.now + 90_000 }} />)
    expect(battery.textContent).not.toContain('数据滞后')
    view.rerender(<SensePanel {...props} model={{ ...props.model, sampleIntervalsMs: intervals, now: m.now + 90_001 }} />)
    expect(battery.textContent).toContain('数据滞后 · 最后 90 秒前')
  })

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

  it('长时间数据滞后与事实更新而历史不变时，图表标明历史锚点且不重做预处理', () => {
    const m = makeScenario('healthy')
    const points = m.history.cpu
    const chart = (now: number, severity: 'good' | 'warn') => (
      <ClockProvider value={now}>
        <Sparkline expanded points={points} now={m.now} label="CPU" format={formatPercent}
          severity={severity} sampleIntervalMs={5_000} />
      </ClockProvider>
    )
    const view = render(chart(m.now, 'good'))
    expect(view.container.textContent).toContain('现在')
    vi.mocked(sampleHistory).mockClear()
    vi.mocked(buildSpark).mockClear()
    view.rerender(chart(m.now + 15_000, 'good'))
    expect(view.container.textContent).toContain('现在')
    view.rerender(chart(m.now + 15_001, 'good'))
    expect(view.container.textContent).toContain('数据滞后 · 最后 15 秒前')
    expect(view.container.textContent).not.toContain('现在')
    expect(view.container.textContent).not.toContain('当前')
    expect(geoCalls()).toBe(0)
    expect(histCalls()).toBe(0)
    view.rerender(chart(m.now + 600_000, 'warn'))
    expect(view.container.textContent).toContain('数据滞后 · 最后 600 秒前')
    expect(view.container.textContent).not.toContain('当前')
    expect(view.container.textContent).not.toContain('最近 5 分钟')
  })

  it('展开图显式暂停时立即停止称现在和当前', () => {
    const m = makeScenario('healthy')
    const chart = (paused: boolean) => (
      <Sparkline expanded paused={paused} points={m.history.cpu} now={m.now}
        label="CPU" format={formatPercent} severity="warn" sampleIntervalMs={5000} />
    )
    const view = render(chart(false))
    expect(view.container.textContent).toContain('现在')
    vi.mocked(buildSpark).mockClear()
    view.rerender(chart(true))
    expect(view.container.textContent).toContain('采集暂停 · 最后')
    expect(view.container.textContent).not.toContain('现在')
    expect(view.container.textContent).not.toContain('当前')
    expect(view.container.querySelector('circle[data-current]')).toBeNull()
    expect(geoCalls()).toBe(0)
  })

  it('事实更新但历史引用未变时不把旧图当成当前', () => {
    const m = makeScenario('healthy')
    const props = makeProps({ ...m, sampleIntervalsMs: { cpu: 5000 } })
    const view = render(<SensePanel {...props} />)
    const now = m.now + 600_000
    const body = m.state.self.body
    const cpu = { ...body.cpu, observedAt: now, ttlMs: 60_000, value: { ...body.cpu.value!, usage: 0.9 } }
    view.rerender(<SensePanel {...props} model={{
      ...props.model, now, state: { ...m.state, self: { ...m.state.self, body: { ...body, cpu } } },
    }} />)
    const tile = view.container.querySelector('details[data-tile="cpu"] summary')!
    expect(tile.textContent).toContain('数据滞后 · 最后 600 秒前')
    expect(tile.textContent).not.toContain('最近 5 分钟趋势')
    expect(tile.textContent).not.toContain('当前')
    expect(tile.querySelector('circle[data-current]')).toBeNull()
  })
})
