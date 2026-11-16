import { describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach } from 'vitest'
import { SensePanel } from '../../src/SensePanel'
import type {
  MetricInsight,
  MetricPoint,
  SensePanelProps,
  SensePanelModel,
} from '../../src/view-model'
import { makeScenario } from '../../src/mock/scenarios'
import { disksFixture, emptyFact, fact, makeBody, makeEvent, makeState, T0 } from '../../src/mock/fixtures'
import { formatClock } from '../../src/format'
import { evaluateBody } from '../../src/health'

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
    onResumeTuning: vi.fn(async () => {}),
    onResetTuning: vi.fn(async () => {}),
    onAcceptRebaseline: vi.fn(async (_id: string) => {}),
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

async function openTile(key: string): Promise<HTMLElement> {
  const el = document.querySelector(`details[data-tile="${key}"]`)!
  if (!(el as HTMLDetailsElement).open) {
    fireEvent.click(el.querySelector('summary')!)
  }
  // toggle 事件由浏览器按任务派发，detail 懒挂载需等下一轮渲染
  await waitFor(() =>
    expect(el.querySelector('[class*="tileDetail"]')).toBeTruthy(),
  )
  return el as HTMLElement
}

describe('过期保留值', () => {
  it('空磁盘在摘要及明细均按磁盘契约显示未知', async () => {
    for (const disks of [
      disksFixture(null, { status: 'unavailable' }),
      disksFixture([], { status: 'ok' }),
    ]) {
      const state = makeState()
      state.self.body.disks = disks
      const { view } = renderPanel({ ...makeScenario('healthy'), state })
      const tile = await openTile('disks')
      expect(tile.querySelector('summary')!.textContent).toContain('未知')
      expect(tile.querySelector('summary')!.textContent).not.toContain('不可用')
      expect(tile.querySelector('[class*="detailFact"]')!.textContent).toContain('未知')
      view.unmount()
    }
  })

  it('CPU 过期但保留值：摘要仍显示值 + 已过期年龄 + 未知标签', async () => {
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

  it('磁盘过期但保留值：挂载列表可见、标签未知、无速率徽标', async () => {
    const state = makeState()
    state.self.body.disks = disksFixture(
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

  it('磁盘剩余比例条按 free/total 填充并带 data-ratio', async () => {
    const state = makeState()
    state.self.body.disks = disksFixture([
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

  it('最近触发忽略未来/非法时间戳，历史更早事件仍算数', async () => {
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
    const details = await openTile('memory')
    expect(details.textContent).toContain(formatClock(T0 - 120_000))
    expect(details.textContent).not.toContain(formatClock(T0 + 120_000))
  })
})

describe('Token 速率估算与布局', () => {
  it('增速缺失/零/负/非有限都不估算填满', async () => {
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

  it('无上下文时仍显示本会话行且无压缩措辞', async () => {
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

  it('每张卡片头都有折叠箭头标识', async () => {
    renderPanel(makeScenario('healthy'))
    const tiles = document.querySelectorAll('details[data-tile]')
    expect(tiles.length).toBeGreaterThan(5)
    for (const t of tiles) {
      expect(t.querySelector('summary [class*="chev"]')).toBeTruthy()
    }
  })

  it('卡片顺序：CPU、内存、Token(满宽)、磁盘、网络、温控、电池、进程', async () => {
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
  it('多主机时「位置详情」保留全部原始字段与来源', async () => {
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

  it('应用不可用时窗口 denied 仍显示原因与授权回调', async () => {
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

  it('应用不可用但窗口可用时标题仍显示', async () => {
    const state = makeState()
    state.env.frontApp = emptyFact('unavailable')
    renderPanel({ ...makeScenario('healthy'), state })
    expect(document.body.textContent).toContain('demo.ts — project')
  })

  it('sendTitles=false 时窗口 denied reason / 不可用保留标题都不进 DOM', async () => {
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

  it('焦点卡 app/窗口超过「刚刚」的新鲜度显示秒级年龄', async () => {
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

  it('关注路径 lastChange 为刚刚时省略年龄后缀', async () => {
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
  it('已在调整视图时再次点「调整」仍重新聚焦', async () => {
    renderPanel(makeScenario('rapid-change'))
    fireEvent.click(within(await openTile('memory')).getByText('调整'))
    expect(
      (document.activeElement as HTMLElement).textContent,
    ).toContain('采样间隔')
    // 焦点先移到别处，再从另一卡片触发
    ;(
      document.querySelector(
        'details[data-tile="cpu"] summary',
      ) as HTMLElement
    ).focus()
    fireEvent.click(within(await openTile('cpu')).getByText('调整'))
    expect(
      (document.activeElement as HTMLElement).textContent,
    ).toContain('采样间隔')
    const rules = screen
      .getByText('规则', { selector: 'summary' })
      .closest('details')!
    expect(rules.open).toBe(true)
  })

  it('调整记录 prev/next 节点带原值/新值 aria-label', async () => {
    renderPanel(makeScenario('rapid-change'))
    openSection('规则')
    fireEvent.click(screen.getByRole('button', { name: '调整日志' }))
    expect(screen.getAllByLabelText(/^原值/).length).toBeGreaterThan(0)
    expect(screen.getAllByLabelText(/^新值/).length).toBeGreaterThan(0)
  })

  it('只有可反馈事件带 data-feedback 标记', async () => {
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
    async (layer) => {
      const state = makeState()
      state.self.body.cpu = fact({ usage: 0.5, perCore: [0.5], load1: 1, load5: 1, load15: 1 })
      renderPanel({ ...makeScenario('healthy'), state, insights: { cpu: { sources: [layer], triggered: [layer] } } })
      const tile = document.querySelector('details[data-tile="cpu"]')!
      expect(within(tile as HTMLElement).getByText('注意')).toBeTruthy()
      expect(screen.getByText('CPU 负载较高')).toBeTruthy()
      // 摘要图末点标记取 effectiveSeverity（无可比阈值也可见 warn）
      expect(tile.querySelector('summary circle[data-current="warn"]')).not.toBeNull()
      expect((await openTile('cpu')).textContent).toContain('宿主未给严重度')
    },
  )
})

describe('曲线告警服从触发状态', () => {
  const cpuPanel = (usage: number, insight: MetricInsight, history?: MetricPoint[]) => {
    const m = makeScenario('healthy')
    m.state.self.body.cpu = fact({ usage, perCore: [usage], load1: 1, load5: 1, load15: 1 })
    if (history) m.history = { ...m.history, cpu: history }
    renderPanel({ ...m, insights: { cpu: insight } })
    return document.querySelector('details[data-tile="cpu"] summary')!
  }

  it('未触发宿主层不把曲线染成告警：cpu 0.5、baseline 线 0.4、triggered 空 → good 且中性', async () => {
    const summary = cpuPanel(0.5, {
      sources: ['baseline'],
      triggered: [],
      thresholds: { baseline: { value: 0.4, source: 'host-baseline' } },
    })
    expect(document.querySelector('details[data-tile="cpu"]')!.getAttribute('data-sev')).toBe('good')
    expect(screen.getByText('状态良好')).toBeTruthy()
    // history 部分点 >0.4 越过该线：inactive 线只画不染
    expect(summary.querySelectorAll('path[data-out-of-range]')).toHaveLength(0)
    // 宿主 baseline 线 + 两条既有显示底线仍画出
    const labels = [...summary.querySelectorAll('line[data-threshold]')].map((l) =>
      l.getAttribute('data-threshold'),
    )
    expect(labels).toHaveLength(3)
    expect(labels.filter((s) => s === 'warn')).toHaveLength(2)
    expect(labels.filter((s) => s === 'critical')).toHaveLength(1)
  })
})

describe('contextWindow 回退估值', () => {
  const tokenState = (source: 'configured' | 'catalog' | 'fallback') => {
    const s = makeState()
    s.self.body.tokens = fact({ ...s.self.body.tokens.value!, contextWindowSource: source })
    return s
  }

  it('容量未确认：环降饱和、无剩余/填满/压缩派生，磁贴未知但总览不计缺失', async () => {
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
      (await openTile('tokens')).querySelectorAll(
        '[class*="metricBlock"] line[data-threshold]',
      ),
    ).toHaveLength(0)
  })

  it.each([
    ['configured', '配置值'],
    ['catalog', '模型目录'],
    ['fallback', '回退估值'],
  ] as const)('%s 容量来源在明细标注为「%s」', async (source, text) => {
    renderPanel({ ...makeScenario('healthy'), state: tokenState(source) })
    expect((await openTile('tokens')).textContent).toContain(text)
  })
})

describe('过期事实禁用当前推算', () => {
  const staleOf = <T,>(value: T) => fact(value, { status: 'stale', ageMs: 120_000, ttlMs: 5_000 })

  it('stale 保留值标「上次读数」+ 已过期，禁用全部当前推算与明细 insight', async () => {
    const state = makeState()
    state.self.body.tokens = staleOf(state.self.body.tokens.value!)
    state.self.body.battery = staleOf(state.self.body.battery.value!)
    state.self.body.cpu = fact(
      { usage: 0.3, perCore: [0.3], load1: 1, load5: 1, load15: 1 },
      { status: 'stale', ageMs: 120_000, ttlMs: 5_000 },
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
    const details = await openTile('cpu')
    expect(details.textContent).toContain('上次读数 30%')
    expect(details.textContent).not.toContain('当前 30%')
    expect(details.textContent).toContain('未触发')
  })

  it('stale token/battery 清除全部当前投影：预计下次/压缩/ETA/基线带/阈值线', async () => {
    const state = makeState()
    state.self.body.tokens = fact(
      {
        ...makeBody().tokens.value!,
        contextWindowSource: 'configured',
        contextUsed: 100_000,
        // contextProjected 超过压缩阈值：fresh 时会显示「下次请求预计触发压缩」
        contextProjected: 130_000,
        compressionThreshold: 115_200,
        contextGrowthPerMinute: 720,
      },
      { status: 'stale', ageMs: 120_000, ttlMs: 5_000 },
    )
    state.self.body.battery = fact(
      { percent: 12, charging: false, minutesLeft: 45 },
      { status: 'stale', ageMs: 120_000, ttlMs: 5_000 },
    )
    renderPanel({
      ...makeScenario('healthy'),
      state,
      insights: {
        tokens: {
          baseline: { low: 30_000, high: 60_000 },
          sources: ['floor', 'baseline'],
          triggered: [],
          thresholds: { floor: { value: 110_000, source: 'h' } },
          currentEta: {
            asOf: T0 - 1_000,
            sampleIntervalMs: 5_000,
            timeToThresholdMs: 8 * 60_000,
            ratePerMinute: 700,
          },
        },
        battery: {
          baseline: { low: 60, high: 95 },
          sources: ['floor'],
          triggered: [],
        },
      },
    })
    const tokens = document.querySelector('details[data-tile="tokens"]')!
    for (const w of ['预计下次', '下次请求', '按当前速度', '压缩']) {
      expect(tokens.textContent, `摘要不应出现「${w}」`).not.toContain(w)
    }
    // TokenRing 阈值刻度不画
    expect(tokens.querySelector('[class*="ringTick"]')).toBeNull()
    // 保留值与历史仍在
    expect(tokens.textContent).toContain('上次读数')
    expect(tokens.textContent).toContain('已过期')
    expect(tokens.textContent).toContain('本会话')

    // 明细展开后同样无投影/insight，且不再生成默认底线/基线带
    const detail = await openTile('tokens')
    for (const w of ['预计下次', '下次请求', '按当前速度', '压缩', '显示底线']) {
      expect(detail.textContent, `明细不应出现「${w}」`).not.toContain(w)
    }
    expect(detail.querySelectorAll('line[data-threshold]')).toHaveLength(0)
    expect(detail.querySelector('rect[data-baseline]')).toBeNull()
    expect(detail.textContent).toContain('上次读数')

    // stale 电池摘要图不画宿主 baseline 带，也不显示剩余分钟投影
    const battery = document.querySelector('details[data-tile="battery"]')!
    expect(battery.querySelector('summary rect[data-baseline]')).toBeNull()
    expect(battery.textContent).not.toContain('约剩')
    // 监护句不得引用 stale token 的 currentEta
    expect(document.body.textContent).not.toContain('分钟后')
  })

  it.each(['denied', 'unavailable'] as const)(
    '%s 保留值不泄露：摘要/明细都不出现（CPU 与 Token）',
    async (status) => {
      const state = makeState()
      state.self.body.cpu = fact(state.self.body.cpu.value!, { status, reason: '受限' })
      state.self.body.tokens = fact(state.self.body.tokens.value!, { status, reason: '受限' })
      renderPanel({ ...makeScenario('healthy'), state })
      for (const key of ['cpu', 'tokens']) {
        const tile = await openTile(key)
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
  ])('空/全无效列表 → 明示无有效读数、行未知、不伪造 0', async ({ disks }) => {
    const state = makeState()
    state.self.body.disks = disksFixture(disks)
    renderPanel({ ...makeScenario('healthy'), state })
    const tile = await openTile('disks')
    expect(tile.textContent).toContain(disks.length ? '无有效磁盘读数' : '未知')
    expect(tile.textContent).not.toContain('0 B')
    expect(within(tile as HTMLElement).getAllByText('未知').length).toBeGreaterThan(0)
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
  it('无关更新不重渲 CPU 卡片；CPU 事实变化才重渲', async () => {
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

  it('时钟/事件拷贝/无关事件不重渲；相关事件与 TTL 过期重渲；年龄独立前进', async () => {
    const m = makeScenario('healthy')
    const spy = vi.spyOn(m.state.self.body.cpu.value!.perCore, 'map')
    // 内存渲染计数器：breakdown 只有 MemoryTile 渲染路径读取
    const memValue = m.state.self.body.memory.value!
    const bd = memValue.breakdown
    let memReads = 0
    Object.defineProperty(memValue, 'breakdown', {
      configurable: true,
      get: () => (memReads++, bd),
    })
    const { view, props } = renderPanel(m)
    const rr = (patch: Partial<SensePanelModel>) =>
      view.rerender(<SensePanel {...props} model={{ ...m, ...patch }} />)
    const base = spy.mock.calls.length
    const memBase = memReads
    expect(base).toBeGreaterThan(0)

    // now +1s：无状态翻转 → 两张卡都不重渲
    rr({ now: m.now + 1_000 })
    expect(spy.mock.calls.length).toBe(base)
    expect(memReads).toBe(memBase)
    // 事件数组拷贝 + 无关事件（file.burst）→ 仍不重渲
    const burst = makeEvent(8, {
      signal: { kind: 'file.burst', subject: '/demo/tmp' },
      detail: {
        kind: 'file.burst',
        directory: '/demo/tmp',
        windowMs: 60_000,
        created: 1,
        modified: 0,
        deleted: 9,
        excessiveDeletion: false,
      },
    })
    rr({ now: m.now + 2_000, events: [...m.events, burst] })
    expect(spy.mock.calls.length).toBe(base)
    expect(memReads).toBe(memBase)
    // 相关 cpu body.rate 事件 → CPU 重渲，内存仍不重渲
    const rateCpu = makeEvent(9, {
      signal: { kind: 'body.rate', subject: 'CPU' },
      detail: {
        kind: 'body.rate',
        metric: 'cpu',
        windowMs: 60_000,
        delta: 0.18,
        unit: 'ratio',
      },
    })
    rr({ now: m.now + 3_000, events: [...m.events, burst, rateCpu] })
    expect(spy.mock.calls.length).toBeGreaterThan(base)
    expect(memReads).toBe(memBase)
  })

  it('宿主将 CPU 标过期时重渲；过期年龄随时钟独立前进', async () => {
    const m = makeScenario('healthy')
    // age 4s / ttl 5s：T0 时 ok，新帧由宿主标记过期
    m.state.self.body.cpu = fact(
      { usage: 0.3, perCore: [0.3, 0.4], load1: 1, load5: 1, load15: 1 },
      { ageMs: 4_000, ttlMs: 5_000 },
    )
    const spy = vi.spyOn(m.state.self.body.cpu.value!.perCore, 'map')
    const { view, props } = renderPanel(m)
    const rr = (patch: Partial<SensePanelModel>) =>
      view.rerender(<SensePanel {...props} model={{ ...m, ...patch }} />)
    const base = spy.mock.calls.length
    const state = { ...m.state, self: { ...m.state.self, body: {
      ...m.state.self.body, cpu: { ...m.state.self.body.cpu, status: 'stale' as const },
    } } }
    rr({ now: m.now + 2_000, state })
    expect(spy.mock.calls.length).toBeGreaterThan(base)
    const tile = document.querySelector('details[data-tile="cpu"]')!
    expect(tile.querySelector('summary')!.textContent).toContain('已过期')
    // 过期保留值：年龄随时钟前进，但不重渲整张卡（map 不再增长）
    const staleBase = spy.mock.calls.length
    expect(tile.querySelector('summary')!.textContent).toContain('6 秒前')
    rr({ now: m.now + 3_000, state })
    expect(tile.querySelector('summary')!.textContent).toContain('7 秒前')
    expect(spy.mock.calls.length).toBe(staleBase)
  })

  it('>5min 历史匹配事件与未来事件到点：相关集合仍更新明细「最近触发」', async () => {
    const m = makeScenario('healthy')
    m.state.self.body.cpu = fact(
      { usage: 0.3, perCore: [0.3], load1: 1, load5: 1, load15: 1 },
      { ttlMs: 600_000 },
    )
    const spy = vi.spyOn(m.state.self.body.cpu.value!.perCore, 'map')
    const { view, props } = renderPanel(m)
    const rr = (patch: Partial<SensePanelModel>) =>
      view.rerender(<SensePanel {...props} model={{ ...m, ...patch }} />)
    const cpuEvent = (id: number, at: number) =>
      makeEvent(id, {
        signal: { kind: 'body.anomaly', subject: 'CPU', at },
        detail: {
          kind: 'body.anomaly',
          metric: 'cpu',
          current: 0.95,
          baseline: 0.4,
          deviation: 2.5,
          unit: 'ratio',
        },
      })
    const detail = await openTile('cpu')
    const block = () => detail.querySelector('[data-metric="cpu"]')!
    expect(block().textContent).toContain('最近触发：无')

    // 拷贝 + 无关事件仍不重渲
    const base = spy.mock.calls.length
    const burst = makeEvent(8, {
      signal: { kind: 'file.burst', subject: '/demo/tmp' },
      detail: {
        kind: 'file.burst',
        directory: '/demo/tmp',
        windowMs: 60_000,
        created: 1,
        modified: 0,
        deleted: 9,
        excessiveDeletion: false,
      },
    })
    rr({ events: [...m.events, burst] })
    expect(spy.mock.calls.length).toBe(base)
    // >5min 历史匹配事件：明细「最近触发」要显示它 → 重渲
    const evs = [...m.events, cpuEvent(20, T0 - 6 * 60_000), cpuEvent(21, T0 + 60_000)]
    rr({ events: evs })
    expect(spy.mock.calls.length).toBeGreaterThan(base)
    expect(block().textContent).toContain(formatClock(T0 - 6 * 60_000))
    // 未来事件到点（同一事件数组，仅 now 越过 at）→ 入选并重渲
    const base2 = spy.mock.calls.length
    rr({ now: T0 + 61_000, events: evs })
    expect(spy.mock.calls.length).toBeGreaterThan(base2)
    expect(block().textContent).toContain(formatClock(T0 + 60_000))
  })

  it('磁盘 rate 徽标跨 5 分钟窗消失；陈旧卷历史事件仍更新明细；CPU 不动', async () => {
    const m = makeScenario('healthy')
    m.state.self.body.cpu = fact(
      { usage: 0.3, perCore: [0.3], load1: 1, load5: 1, load15: 1 },
      { ttlMs: 600_000 },
    )
    m.state.self.body.disks = disksFixture(
      [
        { mount: '/', total: 460e9, free: 175e9 },
        { mount: '/data', total: 200e9, free: 160e9, status: 'stale' as const },
      ],
      { ttlMs: 600_000 },
    )
    const cpuSpy = vi.spyOn(m.state.self.body.cpu.value!.perCore, 'map')
    const rate = makeEvent(30, {
      signal: { kind: 'body.rate', subject: '磁盘 /', at: T0 - 4 * 60_000 },
      detail: {
        kind: 'body.rate',
        metric: 'disk:/',
        windowMs: 60_000,
        delta: -2.1 * 1024 ** 3,
        unit: 'bytes',
      },
    })
    const anom = makeEvent(31, {
      signal: { kind: 'body.anomaly', subject: '磁盘 /data', at: T0 - 6 * 60_000 },
      detail: {
        kind: 'body.anomaly',
        metric: 'disk:/data',
        current: 0.99,
        baseline: 0.4,
        deviation: 3,
        unit: 'ratio',
      },
    })
    const m1 = { ...m, events: [rate] }
    const { view, props } = renderPanel(m1)
    const cpuBase = cpuSpy.mock.calls.length
    const rr = (patch: Partial<SensePanelModel>) =>
      view.rerender(<SensePanel {...props} model={{ ...m1, ...patch }} />)
    const tile = document.querySelector('details[data-tile="disks"]')!
    const summary = tile.querySelector('summary')!
    expect(summary.textContent).toContain('/分') // rate 4min 前 → 徽标在
    const diskDetail = await openTile('disks')
    const dataBlock = () => diskDetail.querySelector('[data-metric="disk:/data"]')!
    expect(dataBlock().textContent).toContain('最近触发：无')

    // 陈旧卷的历史 anom（>5min）仍属相关 key → 重渲并更新「最近触发」
    rr({ events: [rate, anom] })
    expect(dataBlock().textContent).toContain(formatClock(T0 - 6 * 60_000))
    expect(cpuSpy.mock.calls.length).toBe(cpuBase)
    // now 越过 5 分钟窗：同一事件集但徽标过期 → 重渲消失，CPU 仍不动
    rr({ now: T0 + 121_000, events: [rate, anom] })
    expect(summary.textContent).not.toContain('/分')
    expect(cpuSpy.mock.calls.length).toBe(cpuBase)
  })
})

describe('磁盘卷级新鲜度', () => {
  const partialDisks = () => ({
    ...disksFixture(
      [
        { mount: '/', total: 460e9, free: 175e9, status: 'stale' as const, observedAt: T0 - 90_000, ttlMs: 5_000 },
        { mount: '/data', total: 200e9, free: 160e9 },
      ],
    ),
    unavailableMounts: ['/Volumes/network'],
  })

  it('根卷 stale 灰显 + 已过期年龄 + 保留值；/data 新鲜；unavailable 挂载「无法读取」无数字无图', async () => {
    const state = makeState()
    state.self.body.disks = partialDisks()
    renderPanel({ ...makeScenario('healthy'), state })
    // 行按新鲜 /data 仍 good；根卷失鲜只加「部分」标记不降级
    const tile = document.querySelector('details[data-tile="disks"]')!
    expect(tile.getAttribute('data-sev')).toBe('good')
    expect(tile.querySelector('summary [data-partial]')?.textContent).toContain(
      '部分 · 数据待补全',
    )
    // 总览：严重度词旁「部分」徽标 + 部分补全句
    expect(screen.getByText('部分')).toBeTruthy()
    expect(screen.getAllByText(/数据待补全/).length).toBeGreaterThanOrEqual(2)
    // 主摘要选根卷：stale 标记 + 保留值 163.0 GB
    const summary = tile.querySelector('summary')!
    expect(summary.textContent).toContain('已过期 · 90 秒前')
    expect(summary.textContent).toContain('163.0 GB')
    expect(summary.querySelector('[data-status="stale"]')).toBeTruthy()

    const detail = await openTile('disks')
    // 根卷行 stale 表头（保留值），/data 行当前读数
    const rootBlock = detail.querySelector('[data-metric="disk:/"]')!
    expect(rootBlock.textContent).toContain('上次读数')
    expect(rootBlock.textContent).toContain('163.0 GB')
    const dataBlock = detail.querySelector('[data-metric="disk:/data"]')!
    expect(dataBlock.textContent).toContain('当前')
    expect(dataBlock.textContent).toContain('149.0 GB')
    // 挂载点列表：根卷行 stale 标注 + /Volumes/network「无法读取」无比例条
    const rows = [...detail.querySelectorAll('[class*="detailLine"]')]
    const netRow = rows.find((r) => r.textContent!.includes('/Volumes/network'))!
    expect(netRow.textContent).toContain('无法读取')
    expect(netRow.querySelector('[data-strip]')).toBeNull()
    // unavailable 挂载不产生图表块
    expect(detail.querySelector('[data-metric="disk:/Volumes/network"]')).toBeNull()
  })

  it('父整体 stale：主摘要只标一次「已过期」，保留值仍在', async () => {
    const state = makeState()
    state.self.body.disks = disksFixture(
      [{ mount: '/', total: 460e9, free: 175e9 }],
      { status: 'stale', ageMs: 90_000, ttlMs: 5_000 },
    )
    renderPanel({ ...makeScenario('healthy'), state })
    const summary = document.querySelector('details[data-tile="disks"] summary')!
    expect(summary.textContent).toContain('163.0 GB')
    expect(summary.querySelectorAll('[data-status="stale"]')).toHaveLength(1)
    expect(summary.textContent!.match(/已过期/g)).toHaveLength(1)
  })

  it.each(['ok', 'stale'] as const)(
    '根卷 stale、/data 剩余 2%%：父级 %s 时磁盘及总览均为 critical',
    (parentStatus) => {
    const vols = [
      {
        mount: '/',
        total: 100e9,
        free: 40e9,
        status: 'stale' as const,
        observedAt: T0 - 90_000,
        ttlMs: 30_000,
      },
      {
        mount: '/data',
        total: 100e9,
        free: 2e9,
        status: 'ok' as const,
        observedAt: T0 - 1_000,
        ttlMs: 30_000,
      },
    ]
    const state = makeState()
    state.self.body.disks = disksFixture(vols, {
      status: parentStatus,
      ageMs: 1_000,
      ttlMs: 30_000,
    })
    const result = evaluateBody(state.self.body, T0)
    expect(result.rows.disks).toMatchObject({ severity: 'critical', partial: true })
    expect(result).toMatchObject({
      severity: 'critical', sentence: '磁盘空间不足', partial: true,
    })
    console.info(`disk-regression ${parentStatus}: ${JSON.stringify({
      disk: result.rows.disks.severity,
      overview: result.severity,
      partial: result.partial,
      sentence: result.sentence,
    })}`)
    renderPanel({ ...makeScenario('healthy'), state })
    const tile = document.querySelector('details[data-tile="disks"]')!
    expect(tile.getAttribute('data-sev')).toBe('critical')
    const summary = tile.querySelector('summary')!
    expect(summary.textContent).toContain('/data')
    expect(summary.textContent).toContain('部分')
    expect(summary.querySelector('[data-status="stale"]')).toBeNull()
    // 总览紧急 + 「部分」徽标
    expect(
      document
        .querySelector('[class*="monitor"][data-sev]')!
        .getAttribute('data-sev'),
    ).toBe('critical')
    expect(screen.getByText('部分')).toBeTruthy()
    },
  )

  it('根卷新鲜且 /net 无法读取：磁盘和总览标部分而非状态良好', async () => {
    const state = makeState()
    state.self.body.disks = {
      ...disksFixture([{
        mount: '/', total: 100e9, free: 90e9, status: 'ok' as const,
        observedAt: T0 - 1_000, ttlMs: 30_000,
      }], { ageMs: 1_000, ttlMs: 30_000 }),
      unavailableMounts: ['/net'],
    }
    const result = evaluateBody(state.self.body, T0)
    expect(result.rows.disks).toEqual({ severity: 'good', hidden: false, partial: true })
    expect(result).toMatchObject({
      severity: 'good', sentence: '部分 · 数据待补全', partial: true,
    })
    console.info(`disk-regression /net: ${JSON.stringify({
      disk: result.rows.disks.severity,
      overview: result.severity,
      partial: result.partial,
      sentence: result.sentence,
    })}`)
    renderPanel({ ...makeScenario('healthy'), state })
    const tile = document.querySelector('details[data-tile="disks"]')!
    expect(tile.getAttribute('data-sev')).toBe('good')
    expect(tile.querySelector('summary [data-partial]')?.textContent).toContain('部分 · 数据待补全')
    expect(screen.queryByText('状态良好')).toBeNull()
    expect(screen.getByText('部分')).toBeTruthy()
    const detail = await openTile('disks')
    const net = [...detail.querySelectorAll('[class*="detailLine"]')]
      .find((row) => row.textContent?.includes('/net'))!
    expect(net.textContent).toContain('/net 无法读取')
    expect(net.textContent).not.toMatch(/\d|GB/)
    expect(net.querySelector('[data-strip]')).toBeNull()
    expect(detail.querySelector('[data-metric="disk:/net"]')).toBeNull()
  })
})
