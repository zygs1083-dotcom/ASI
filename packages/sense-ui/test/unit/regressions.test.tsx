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

describe('宿主触发缺省严重度（缺 severity 不显示为良好）', () => {
  it.each(['floor', 'rate', 'baseline'] as const)(
    '%s 层 triggered 无 severity：磁贴/总览/图标记 warn，明细标注未给严重度',
    (layer) => {
      const state = makeState()
      state.self.body.cpu = fact({ usage: 0.5, perCore: [0.5], load1: 1, load5: 1, load15: 1 })
      renderPanel({ ...makeScenario('healthy'), state, insights: { cpu: { sources: [layer], triggered: [layer] } } })
      const tile = document.querySelector('details[data-tile="cpu"]')!
      expect(within(tile as HTMLElement).getByText('注意')).toBeTruthy()
      expect(screen.getByText('CPU 负载较高')).toBeTruthy()
      // 摘要图末点标记取 effectiveSeverity（无可比阈值也可见 warn）
      expect(tile.querySelector('summary circle[data-current="warn"]')).not.toBeNull()
      expect(openTile('cpu').textContent).toContain('宿主未给严重度')
    },
  )
})

describe('contextWindow 回退估值', () => {
  const tokenState = (source: 'configured' | 'catalog' | 'fallback') => {
    const s = makeState()
    s.self.body.tokens = fact({ ...s.self.body.tokens.value!, contextWindowSource: source })
    return s
  }

  it('容量未确认：环降饱和、无剩余/填满/压缩派生，磁贴未知但总览不计缺失', () => {
    renderPanel({ ...makeScenario('healthy'), state: tokenState('fallback') })
    const tile = document.querySelector('details[data-tile="tokens"]')!
    expect(tile.getAttribute('data-sev')).toBe('unknown')
    expect(tile.textContent).toContain('容量未确认')
    expect(tile.textContent).not.toContain('剩余')
    expect(tile.textContent).not.toContain('按当前速度')
    expect(tile.textContent).not.toContain('压缩')
    expect(tile.querySelector('[data-unconfirmed]')).toBeTruthy()
    // 会话用量不受影响；总览仍良好；展开图无容量派生底线
    expect(tile.textContent).toContain('本会话')
    expect(screen.getByText('状态良好')).toBeTruthy()
    expect(
      openTile('tokens').querySelectorAll('[class*="metricBlock"] line[data-threshold]'),
    ).toHaveLength(0)
  })

  it.each([
    ['configured', '配置值'],
    ['catalog', '模型目录'],
    ['fallback', '回退估值'],
  ] as const)('%s 容量来源在明细标注为「%s」', (source, text) => {
    renderPanel({ ...makeScenario('healthy'), state: tokenState(source) })
    expect(openTile('tokens').textContent).toContain(text)
  })
})

describe('过期事实禁用当前推算', () => {
  const staleOf = <T,>(value: T) => fact(value, { status: 'ok', ageMs: 120_000, ttlMs: 5_000 })

  it('stale 保留值标「上次读数」+ 已过期，禁用全部当前推算与明细 insight', () => {
    const state = makeState()
    state.self.body.tokens = staleOf(state.self.body.tokens.value!)
    state.self.body.battery = staleOf(state.self.body.battery.value!)
    state.self.body.cpu = fact(
      { usage: 0.3, perCore: [0.3], load1: 1, load5: 1, load15: 1 },
      { status: 'ok', ageMs: 120_000, ttlMs: 5_000 },
    )
    renderPanel({
      ...makeScenario('healthy'),
      state,
      insights: { cpu: { baseline: { low: 0.1, high: 0.4 }, sources: ['floor', 'baseline'], triggered: ['baseline'] } },
    })
    const tokens = document.querySelector('details[data-tile="tokens"]')!
    expect(tokens.textContent).not.toContain('按当前速度')
    expect(tokens.textContent).toContain('上次读数')
    expect(tokens.textContent).toContain('已过期')
    const battery = document.querySelector('details[data-tile="battery"]')!
    expect(battery.textContent).toContain('76%')
    expect(battery.textContent).not.toContain('约剩')
    // CPU 摘要图不引用 insight；明细表头为上次读数且触发层清空
    const summary = document.querySelector('details[data-tile="cpu"] summary')!
    expect(summary.querySelector('rect[data-baseline]')).toBeNull()
    const details = openTile('cpu')
    expect(details.textContent).toContain('上次读数 30%')
    expect(details.textContent).not.toContain('当前 30%')
    expect(details.textContent).toContain('未触发')
  })

  it.each(['denied', 'unavailable'] as const)(
    '%s 保留值不泄露：摘要/明细都不出现（CPU 与 Token）',
    (status) => {
      const state = makeState()
      state.self.body.cpu = fact(state.self.body.cpu.value!, { status, reason: '受限' })
      state.self.body.tokens = fact(state.self.body.tokens.value!, { status, reason: '受限' })
      renderPanel({ ...makeScenario('healthy'), state })
      for (const key of ['cpu', 'tokens']) {
        const tile = openTile(key)
        for (const v of ['34%', '46.2', '12.34', '上次读数']) {
          expect(tile.textContent).not.toContain(v)
        }
      }
    },
  )
})

describe('无有效磁盘读数', () => {
  it.each([
    { disks: [] as { mount: string; total: number; free: number }[] },
    { disks: [{ mount: '/', total: 0, free: 0 }, { mount: '/x', total: -1, free: 0 }] },
  ])('空/全无效列表 → 明示无有效读数、行未知、不伪造 0', ({ disks }) => {
    const state = makeState()
    state.self.body.disks = fact(disks)
    renderPanel({ ...makeScenario('healthy'), state })
    const tile = openTile('disks')
    expect(tile.textContent).toContain('无有效磁盘读数')
    expect(tile.textContent).not.toContain('0 B')
    expect(within(tile as HTMLElement).getByText('未知')).toBeTruthy()
    expect(screen.getByText('数据待补全')).toBeTruthy()
  })
})

describe('fillMinutes 结果护栏', () => {
  it.each([
    1e-320, // 极小正增速：除法溢出 Infinity → 无估算
    1,      // (128000-46200)/1 = 81800 分 > 7 天 → 无估算
  ])('异常增速 %j → 不输出估算', (rate) => {
    const s = makeState()
    s.self.body.tokens = fact({ ...s.self.body.tokens.value!, contextGrowthPerMinute: rate })
    renderPanel({ ...makeScenario('healthy'), state: s })
    expect(document.body.textContent).not.toContain('按当前速度')
    expect(document.body.textContent).not.toContain('Infinity')
  })
})

describe('磁贴渲染隔离', () => {
  it('无关更新不重渲 CPU 卡片；CPU 事实变化才重渲', () => {
    const m = makeScenario('healthy')
    const spy = vi.spyOn(m.state.self.body.cpu.value!.perCore, 'map')
    const { view, props } = renderPanel(m)
    const base = spy.mock.calls.length
    expect(base).toBeGreaterThan(0)
    // 无关变化：内存事实与 model 包装更新，CPU 引用与 now/events 不变
    const body2 = { ...m.state.self.body }
    body2.memory = fact({ total: 32e9, used: 20e9, pressure: 'warn', swapUsed: 0 })
    view.rerender(
      <SensePanel {...props} model={{ ...m, state: { ...m.state, self: { ...m.state.self, body: body2 } } }} />,
    )
    expect(spy.mock.calls.length).toBe(base)
    // CPU 事实变化 → 重渲（新事实的 perCore 也会触发 map）
    const body3 = { ...body2 }
    body3.cpu = fact({ usage: 0.91, perCore: [0.9], load1: 1, load5: 1, load15: 1 })
    const spy3 = vi.spyOn(body3.cpu.value!.perCore, 'map')
    view.rerender(
      <SensePanel
        {...props}
        model={{ ...m, state: { ...m.state, self: { ...m.state.self, body: body3 } } }}
      />,
    )
    expect(spy3.mock.calls.length).toBeGreaterThan(0)
  })
})
