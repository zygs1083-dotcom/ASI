import { describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach } from 'vitest'
import { SensePanel } from '../../src/SensePanel'
import type { SensePanelProps, SensePanelModel } from '../../src/view-model'
import { makeScenario } from '../../src/mock/scenarios'
import { emptyFact, fact, makeEvent, makeState, T0 } from '../../src/mock/fixtures'
import { formatClock } from '../../src/format'

afterEach(cleanup)

function renderPanel(model: SensePanelModel, over: Partial<SensePanelProps> = {}) {
  const props: SensePanelProps = {
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
    ...over,
  }
  const view = render(<SensePanel {...props} />)
  return { props, view }
}

function openSection(name: string) {
  const summary = screen.getByText(name, { selector: 'summary' })
  const details = summary.closest('details')!
  if (!details.open) fireEvent.click(summary)
  return details
}

function openTile(key: string): HTMLElement {
  const el = document.querySelector(`details[data-tile="${key}"]`)!
  if (!(el as HTMLDetailsElement).open) {
    fireEvent.click(el.querySelector('summary')!)
  }
  return el as HTMLElement
}

describe('过期保留值', () => {
  it('CPU 过期但保留值：摘要仍显示值 + 已过期年龄 + 未知标签', () => {
    const state = makeState()
    state.self.body.cpu = fact(
      { usage: 0.3, perCore: [0.1, 0.2], load1: 0, load5: 0, load15: 0 },
      { status: 'stale', ageMs: 120_000 },
    )
    renderPanel({ ...makeScenario('healthy'), state })
    const tile = document.querySelector('details[data-tile="cpu"]')!
    const summary = tile.querySelector('summary')!
    expect(summary.textContent).toContain('30%')
    expect(summary.textContent).toContain('已过期')
    expect(summary.textContent).toContain('120 秒前')
    expect(within(tile as HTMLElement).getByText('未知')).toBeTruthy()
    const staleEl = summary.querySelector('[data-status="stale"]')!
    expect(staleEl).toBeTruthy()
    expect(staleEl.className).toContain('factStale')
  })

  it('磁盘过期但保留值：挂载列表可见、标签未知、无速率徽标', () => {
    const state = makeState()
    state.self.body.disks = fact(
      [
        { mount: '/', total: 200e9, free: 40e9 },
        { mount: '/data', total: 100e9, free: 90e9 },
      ],
      { status: 'stale', ageMs: 90_000 },
    )
    renderPanel({ ...makeScenario('rapid-change'), state })
    const tile = document.querySelector('details[data-tile="disks"]')!
    const summary = tile.querySelector('summary')!
    expect(summary.textContent).toContain('37.3 GB')
    expect(summary.textContent).toContain('已过期')
    expect(within(tile as HTMLElement).getByText('未知')).toBeTruthy()
    expect(tile.querySelectorAll('summary [class*="sevTag"]')).toHaveLength(1)
    // 过期不引用 insight 速率徽标
    expect(summary.textContent).not.toContain('/分')
    expect(summary.querySelector('[data-strip="remaining"]')).toBeTruthy()
  })

  it('磁盘剩余比例条按 free/total 填充并带 data-ratio', () => {
    const state = makeState()
    state.self.body.disks = fact([
      { mount: '/', total: 200e9, free: 40e9 },
      { mount: '/data', total: 100e9, free: 90e9 },
    ])
    renderPanel({ ...makeScenario('healthy'), state })
    // 注意力盘 = 剩余比例最低（'/' 20%）
    const strip = document.querySelector(
      'details[data-tile="disks"] summary [data-strip="remaining"]',
    )! as HTMLElement
    expect(strip.getAttribute('data-ratio')).toBe('0.2')
    expect(strip.style.width).toBe('20%')
  })

  it('最近触发忽略未来/非法时间戳，历史更早事件仍算数', () => {
    const anomaly = (id: number) =>
      makeEvent(id, {
        detail: {
          kind: 'body.anomaly',
          metric: 'memory',
          current: 0.9,
          baseline: 0.5,
          deviation: 0.4,
          unit: 'ratio',
        },
      })
    const older = anomaly(41)
    older.signal.at = T0 - 120_000
    const future = anomaly(42)
    future.signal.at = T0 + 120_000
    const m = { ...makeScenario('healthy'), events: [older, future] }
    renderPanel(m)
    const details = openTile('memory')
    expect(details.textContent).toContain(formatClock(T0 - 120_000))
    expect(details.textContent).not.toContain(formatClock(T0 + 120_000))
  })
})

describe('Token 速率估算与布局', () => {
  it('增速缺失/零/负/非有限都不估算填满', () => {
    for (const rate of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const state = makeState()
      state.self.body.tokens = fact({
        ...state.self.body.tokens.value!,
        contextGrowthPerMinute: rate,
      })
      const { view } = renderPanel({ ...makeScenario('healthy'), state })
      expect(document.body.textContent).not.toContain('按当前速度')
      view.unmount()
    }
    // 窗口非有限同样不估算
    const s2 = makeState()
    s2.self.body.tokens = fact({
      ...s2.self.body.tokens.value!,
      contextWindow: Number.POSITIVE_INFINITY,
    })
    renderPanel({ ...makeScenario('healthy'), state: s2 })
    expect(document.body.textContent).not.toContain('按当前速度')
  })

  it('无上下文时仍显示本会话行且无压缩措辞', () => {
    const state = makeState()
    state.self.body.tokens = fact({
      sessionUsage: { input: 2_000, output: 100, cacheRead: 500, cacheWrite: 0 },
      balanceStatus: 'unavailable',
    })
    renderPanel({ ...makeScenario('healthy'), state })
    expect(screen.getAllByText(/本会话 输入/).length).toBeGreaterThan(0)
    const token = document.querySelector('details[data-tile="tokens"]')!
    expect(
      within(token as HTMLElement).queryByText(/压缩/),
    ).toBeNull()
  })

  it('每张卡片头都有折叠箭头标识', () => {
    renderPanel(makeScenario('healthy'))
    const tiles = document.querySelectorAll('details[data-tile]')
    expect(tiles.length).toBeGreaterThan(5)
    for (const t of tiles) {
      expect(t.querySelector('summary [class*="chev"]')).toBeTruthy()
    }
  })

  it('卡片顺序：CPU、内存、Token(满宽)、磁盘、网络、温控、电池、进程', () => {
    renderPanel(makeScenario('healthy'))
    const keys = [...document.querySelectorAll('details[data-tile]')].map((t) =>
      t.getAttribute('data-tile'),
    )
    expect(keys).toEqual([
      'cpu',
      'memory',
      'tokens',
      'disks',
      'network',
      'thermal',
      'battery',
      'process',
    ])
  })
})

describe('位置与焦点卡', () => {
  it('多主机时「位置详情」保留全部原始字段与来源', () => {
    const state = makeState()
    state.env.where.toolExec = fact({ host: 'build-node', cwd: '/demo/elsewhere' })
    renderPanel({ ...makeScenario('healthy'), state })
    const summary = screen.getByText('位置详情')
    fireEvent.click(summary)
    const details = summary.closest('details')!
    expect(details.open).toBe(true)
    expect(details.textContent).toContain('http://127.0.0.1:3425/v1')
    expect(details.textContent).toContain('macOS 15.2')
    expect(details.textContent).toContain('/demo/elsewhere')
    expect(details.textContent).toContain('来源')
  })

  it('应用不可用时窗口 denied 仍显示原因与授权回调', () => {
    const state = makeState()
    state.env.frontApp = emptyFact('unavailable')
    state.env.focusedWindow = emptyFact('denied', '未授予辅助功能')
    const { props } = renderPanel({ ...makeScenario('healthy'), state })
    const card = document.querySelector('[class*="focusCard"]')! as HTMLElement
    expect(card.textContent).toContain('不可用')
    expect(within(card).getByText(/未授予辅助功能/)).toBeTruthy()
    fireEvent.click(within(card).getByText('授权'))
    expect(props.onOpenPermissionSettings).toHaveBeenCalled()
  })

  it('应用不可用但窗口可用时标题仍显示', () => {
    const state = makeState()
    state.env.frontApp = emptyFact('unavailable')
    renderPanel({ ...makeScenario('healthy'), state })
    expect(document.body.textContent).toContain('demo.ts — project')
  })

  it('sendTitles=false 时窗口 denied reason / 不可用保留标题都不进 DOM', () => {
    const state = makeState()
    state.env.focusedWindow = emptyFact('denied', 'PrivateWindowSecret 未授权')
    const { view } = renderPanel({
      ...makeScenario('healthy'),
      state,
      sendTitles: false,
    })
    expect(document.body.innerHTML).not.toContain('PrivateWindowSecret')
    expect(screen.getByText('标题已隐藏')).toBeTruthy()
    const card = document.querySelector('[class*="focusCard"]') as HTMLElement
    expect(within(card).queryByText('授权')).toBeNull()
    view.unmount()

    // unavailable 但保留了 title 值的事实同样整条不渲染
    const s2 = makeState()
    s2.env.focusedWindow = fact(
      { title: 'thatsecret' },
      { status: 'unavailable' },
    )
    renderPanel({ ...makeScenario('healthy'), state: s2, sendTitles: false })
    expect(document.body.innerHTML).not.toContain('thatsecret')
  })

  it('焦点卡 app/窗口超过「刚刚」的新鲜度显示秒级年龄', () => {
    const state = makeState()
    state.env.frontApp = fact(
      { name: 'Finder', bundleId: 'com.demo.finder' },
      { ageMs: 60_000, ttlMs: 120_000 },
    )
    state.env.focusedWindow = fact(
      { title: 'demo.ts — project' },
      { ageMs: 60_000, ttlMs: 120_000 },
    )
    renderPanel({ ...makeScenario('healthy'), state })
    const card = document.querySelector('[class*="focusCard"]')! as HTMLElement
    expect(card.textContent).toContain('60 秒前')
    expect(within(card).getAllByText(/60 秒前/).length).toBe(2)
  })

  it('关注路径 lastChange 为刚刚时省略年龄后缀', () => {
    const state = makeState()
    state.env.watchedPaths = fact({
      '/demo/src': { changes: 3, lastChange: T0 - 1_000 },
    })
    renderPanel({ ...makeScenario('healthy'), state })
    const row = screen.getByText('关注路径').parentElement!
    expect(row.textContent).toContain('3 次')
    expect(row.textContent).not.toContain('刚刚')
  })
})

describe('调整入口与反馈标记', () => {
  it('已在调整视图时再次点「调整」仍重新聚焦', () => {
    renderPanel(makeScenario('rapid-change'))
    fireEvent.click(within(openTile('memory')).getByText('调整'))
    expect(
      (document.activeElement as HTMLElement).textContent,
    ).toContain('采样间隔')
    // 焦点先移到别处，再从另一卡片触发
    ;(
      document.querySelector(
        'details[data-tile="cpu"] summary',
      ) as HTMLElement
    ).focus()
    fireEvent.click(within(openTile('cpu')).getByText('调整'))
    expect(
      (document.activeElement as HTMLElement).textContent,
    ).toContain('采样间隔')
    const rules = screen
      .getByText('规则', { selector: 'summary' })
      .closest('details')!
    expect(rules.open).toBe(true)
  })

  it('调整记录 prev/next 节点带原值/新值 aria-label', () => {
    renderPanel(makeScenario('rapid-change'))
    openSection('规则')
    fireEvent.click(screen.getByRole('button', { name: '调整日志' }))
    expect(screen.getAllByLabelText(/^原值/).length).toBeGreaterThan(0)
    expect(screen.getAllByLabelText(/^新值/).length).toBeGreaterThan(0)
  })

  it('只有可反馈事件带 data-feedback 标记', () => {
    const m = { ...makeScenario('healthy'), events: [makeEvent(9)] }
    const { view } = renderPanel(m)
    const li = document.querySelector('li[class*="event"]')!
    expect(li.getAttribute('data-feedback')).toBeNull()
    view.unmount()

    renderPanel({
      ...makeScenario('healthy'),
      events: [makeEvent(1, { level: 'wake' })],
    })
    const li2 = document.querySelector('li[class*="event"]')!
    expect(li2.getAttribute('data-feedback')).not.toBeNull()
  })
})
