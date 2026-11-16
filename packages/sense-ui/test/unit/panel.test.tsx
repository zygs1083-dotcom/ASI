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
import type { SensePanelProps, SensePanelModel } from '../../src/view-model'
import { makeScenario } from '../../src/mock/scenarios'
import { fact, makeEvent, makeState, T0 } from '../../src/mock/fixtures'

afterEach(cleanup)

function makeProps(model: SensePanelModel, over: Partial<SensePanelProps> = {}) {
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
  return props
}

function renderPanel(model: SensePanelModel, over: Partial<SensePanelProps> = {}) {
  const props = makeProps(model, over)
  const view = render(<SensePanel {...props} />)
  return { props, view }
}

function openSection(name: string): HTMLDetailsElement {
  const summary = screen.getByText(name, { selector: 'summary' })
  const details = summary.closest('details')!
  if (!details.open) fireEvent.click(summary)
  return details
}

async function openTile(key: string): Promise<HTMLDetailsElement> {
  const details = document.querySelector<HTMLDetailsElement>(
    `details[data-tile="${key}"]`,
  )!
  if (!details.open) fireEvent.click(details.querySelector('summary')!)
  // toggle 事件由浏览器按任务派发，detail 懒挂载需等下一轮渲染
  await waitFor(() =>
    expect(details.querySelector('[class*="tileDetail"]')).toBeTruthy(),
  )
  return details
}

describe('结构与分区', () => {
  it('身体/现在/事件流默认展开，规则默认收起', async () => {
    renderPanel(makeScenario('healthy'))
    expect(screen.getByText('环境感知')).toBeTruthy()
    for (const name of ['身体', '现在', '事件流']) {
      expect(
        screen.getByText(name, { selector: 'summary' }).closest('details')!.open,
      ).toBe(true)
    }
    const rules = screen.getByText('规则', { selector: 'summary' }).closest('details')!
    expect(rules.open).toBe(false)
  })

  it('summary 点击可折叠/展开（含规则分区）', async () => {
    renderPanel(makeScenario('healthy'))
    const summary = screen.getByText('事件流', { selector: 'summary' })
    const details = summary.closest('details')!
    fireEvent.click(summary)
    expect(details.open).toBe(false)
    fireEvent.click(summary)
    expect(details.open).toBe(true)

    const rulesDetails = openSection('规则')
    expect(rulesDetails.open).toBe(true)
    fireEvent.click(screen.getByText('规则', { selector: 'summary' }))
    expect(rulesDetails.open).toBe(false)
  })

  it('监护概览给出严重度词与整句评估', async () => {
    const { view } = renderPanel(makeScenario('healthy'))
    expect(screen.getByText('状态良好')).toBeTruthy()
    expect(document.querySelector('[class*="monitor"]')!.getAttribute('data-sev')).toBe('good')
    view.unmount()
    const { view: v2 } = renderPanel(makeScenario('memory-pressure'))
    expect(screen.getByText('内存紧张')).toBeTruthy()
    expect(document.querySelector('[class*="monitor"]')!.getAttribute('data-sev')).toBe('warn')
    v2.unmount()
    renderPanel(makeScenario('permission-denied'))
    expect(screen.getByText('数据待补全')).toBeTruthy()
  })

  it('rapid-change 有磁盘投影时优先警示行显示见底时间', async () => {
    renderPanel(makeScenario('rapid-change'))
    expect(screen.getByText('磁盘 9 分钟后见底')).toBeTruthy()
  })
})

describe('事实状态呈现', () => {
  it('denied 显示原因与授权按钮', async () => {
    const { props } = renderPanel(makeScenario('permission-denied'))
    const buttons = screen.getAllByText('授权')
    fireEvent.click(buttons[0]!)
    expect(props.onOpenPermissionSettings).toHaveBeenCalledOnce()
  })

  it('stale 显示保留值与过期标记', async () => {
    renderPanel(makeScenario('permission-denied'))
    expect(screen.getAllByText(/已过期/).length).toBeGreaterThan(0)
  })

  it('余额缺失显示说明而不是 0', async () => {
    const model = makeScenario('context-almost-full')
    renderPanel(model)
    expect(screen.getByText(/提供方未提供余额接口/)).toBeTruthy()
    expect(screen.queryByText(/^0$/)).toBeNull()
  })

  it('上下文缺数据时明示不可用与未提供项，不按 0 渲染', async () => {
    const state = makeState()
    state.self.body.tokens = fact({
      sessionUsage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    })
    renderPanel({ ...makeScenario('healthy'), state })
    expect(screen.getByText('上下文数据不可用')).toBeTruthy()
    // 无上下文不出压缩措辞；会话用量行仍保留
    expect(screen.queryByText(/压缩阈值/)).toBeNull()
    expect(screen.getAllByText(/本会话 输入/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/^0$/)).toBeNull()
  })

  it('台式机电池 null 时隐藏电池卡片', async () => {
    renderPanel(makeScenario('desktop-no-battery'))
    expect(document.querySelector('details[data-tile="battery"]')).toBeNull()
  })

  it('电池 denied 时渲染状态而非隐藏', async () => {
    const state = makeState()
    state.self.body.battery = fact(null, { status: 'denied', reason: '未授权电池信息' })
    renderPanel({ ...makeScenario('healthy'), state })
    expect(screen.getByText('电池')).toBeTruthy()
    expect(screen.getAllByText(/未授权电池信息/).length).toBeGreaterThan(0)
  })
})

describe('指标卡片布局与折叠', () => {
  it('Token 卡片跨两列，其余卡片单列；全部初始收起', async () => {
    renderPanel(makeScenario('healthy'))
    const token = document.querySelector('details[data-tile="tokens"]')!
    expect(token.getAttribute('data-span2')).toBe('true')
    for (const el of document.querySelectorAll('details[data-tile]')) {
      expect((el as HTMLDetailsElement).open).toBe(false)
      if (el !== token) expect(el.getAttribute('data-span2')).toBeNull()
    }
  })

  it('展开的卡片跨整行，明细里才有来源与阈值行', async () => {
    renderPanel(makeScenario('healthy'))
    const details = await openTile('cpu')
    expect(details.open).toBe(true)
    const scoped = within(details)
    expect(scoped.getByText(/来源/)).toBeTruthy()
    expect(scoped.getByText('底线')).toBeTruthy()
    expect(scoped.getByText('变化率')).toBeTruthy()
    expect(scoped.getByText('基线')).toBeTruthy()
  })

  it('卡片「调整」入口打开规则分区并聚焦调整日志', async () => {
    renderPanel(makeScenario('rapid-change'))
    const details = await openTile('memory')
    fireEvent.click(within(details).getByText('调整'))
    const rules = screen.getByText('规则', { selector: 'summary' }).closest('details')!
    expect(rules.open).toBe(true)
    expect(screen.getByRole('button', { name: '调整日志' }).getAttribute('aria-pressed')).toBe('true')
    expect((document.activeElement as HTMLElement).textContent).toContain('采样间隔')
  })

  it('告警卡片有文字严重度标签，不只靠颜色', async () => {
    renderPanel(makeScenario('memory-pressure'))
    const mem = document.querySelector('details[data-tile="memory"]')!
    expect(within(mem as HTMLElement).getByText('注意')).toBeTruthy()
  })

  it('无内存细分时只画 used/free 单段并在明细明示未提供', async () => {
    const state = makeState()
    const mem = { ...state.self.body.memory.value! }
    delete mem.breakdown
    state.self.body.memory = fact(mem)
    renderPanel({ ...makeScenario('healthy'), state })
    const strip = document.querySelector('details[data-tile="memory"] [class*="memStrip"]')!
    expect(strip.children).toHaveLength(1)
    const details = await openTile('memory')
    expect(within(details).getByText('内存细分未提供')).toBeTruthy()
  })

  it('有内存细分时按 App/联动/压缩/缓存 四段渲染', async () => {
    renderPanel(makeScenario('healthy'))
    const strip = document.querySelector('details[data-tile="memory"] [class*="memStrip"]')!
    expect(strip.children).toHaveLength(4)
    const details = await openTile('memory')
    expect(within(details).getByText(/App .*联动.*压缩.*缓存/)).toBeTruthy()
  })

  it('contextProjected 缺失显示未提供，增速缺失不估算填满', async () => {
    const state = makeState()
    const t = { ...state.self.body.tokens.value! }
    delete t.contextProjected
    delete t.contextGrowthPerMinute
    state.self.body.tokens = fact(t)
    renderPanel({ ...makeScenario('healthy'), state })
    expect(screen.getByText(/预计下次 未提供/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('按当前速度')
  })

  it('contextGrowthPerMinute 提供时在摘要估算填满分钟数', async () => {
    renderPanel(makeScenario('healthy'))
    // (128000-46200)/720 ≈ 113.6 → 约 114 分钟，摘要直接可见、明细不重复
    expect(screen.getByText(/按当前速度约 114 分钟填满/)).toBeTruthy()
    expect(
      screen.getAllByText(/按当前速度约 114 分钟填满/),
    ).toHaveLength(1)
  })
})

describe('窗口标题隐私', () => {
  it('sendTitles=false 时标题不进入 DOM，事件主体也被遮盖', async () => {
    const model = { ...makeScenario('healthy'), sendTitles: false }
    renderPanel(model)
    expect(screen.getByText('标题已隐藏')).toBeTruthy()
    expect(document.body.textContent).not.toContain('demo.ts — project')
    expect(screen.getAllByText('窗口标题已隐藏').length).toBeGreaterThan(0)
  })

  it('sendTitles=true 时正常显示标题', async () => {
    renderPanel(makeScenario('healthy'))
    expect(document.body.textContent).toContain('demo.ts — project')
  })
})

describe('位置链', () => {
  it('全部同主机时合并显示并可展开原始明细', async () => {
    renderPanel(makeScenario('healthy'))
    const summary = screen.getByText('全部在 demo-host')
    const details = summary.closest('details')!
    fireEvent.click(summary)
    expect(details.open).toBe(true)
    expect(details.textContent).toContain('demo-provider')
    expect(details.textContent).toContain('macOS 15.2')
    expect(details.textContent).toContain('/demo/project')
  })

  it('远端模型（local=false）不合并并标注异地', async () => {
    const state = makeState()
    state.env.where.model = fact({
      provider: 'remote-provider',
      endpoint: 'https://api.remote.example/v1',
      local: false,
    })
    renderPanel({ ...makeScenario('healthy'), state })
    expect(screen.queryByText(/全部在/)).toBeNull()
    expect(screen.getByText('api.remote.example')).toBeTruthy()
    expect(screen.getAllByText('异地').length).toBeGreaterThan(0)
  })

  it('工具执行处主机不同也不合并', async () => {
    const state = makeState()
    state.env.where.toolExec = fact({ host: 'build-node', cwd: '/demo/project' })
    renderPanel({ ...makeScenario('healthy'), state })
    expect(screen.queryByText(/全部在/)).toBeNull()
    expect(screen.getByText('build-node')).toBeTruthy()
    expect(screen.getByText('异地')).toBeTruthy()
  })
})

describe('事件流', () => {
  it('超过 200 截断、每页 10 条、可翻页', async () => {
    renderPanel(makeScenario('busy-events'))
    expect(screen.getByText(/最新 200 条/)).toBeTruthy()
    expect(screen.getByText(/第 1\/20 页/)).toBeTruthy()
    expect(document.querySelectorAll('li[class*="event"]')).toHaveLength(10)
    fireEvent.click(screen.getByText('下一页'))
    expect(screen.getByText(/第 2\/20 页/)).toBeTruthy()
    fireEvent.click(screen.getByText('上一页'))
    expect(screen.getByText(/第 1\/20 页/)).toBeTruthy()
  })

  it('输入骤减时分页被钳位', async () => {
    const { props, view } = renderPanel(makeScenario('busy-events'))
    fireEvent.click(screen.getByText('下一页'))
    expect(screen.getByText(/第 2\/20 页/)).toBeTruthy()
    const shrunk = { ...props.model, events: [makeEvent(1), makeEvent(2)] }
    view.rerender(<SensePanel {...props} model={shrunk} />)
    expect(screen.queryByText('下一页')).toBeNull()
    expect(screen.getByText(/第 1\/1 页/)).toBeTruthy()
  })

  it('按分钟分组：组标题有分钟时刻/条数/唤醒数', async () => {
    renderPanel(makeScenario('rapid-change'))
    // 4 条事件同分钟 → 一个组，含 2 次唤醒
    const summary = screen.getByText('4 条事件')
    expect(summary).toBeTruthy()
    expect(screen.getByText('2 次唤醒')).toBeTruthy()
  })

  it('含唤醒的组默认展开，普通多事件组默认收起', async () => {
    const m = makeScenario('healthy')
    const boundary = Math.floor(T0 / 60_000) * 60_000
    // 三条同分钟普通事件（minute -2）→ 收起组
    m.events = [
      makeEvent(11, { level: 'record' }),
      makeEvent(12, { level: 'record' }),
      makeEvent(13, { level: 'record' }),
    ]
    m.events.forEach((e, i) => {
      e.signal.at = boundary - 61_000 - i * 3_000
    })
    // 一组含 wake（minute -1）→ 展开
    m.events.push(
      makeEvent(20, { level: 'wake' }),
      makeEvent(21, { level: 'record' }),
    )
    m.events[3]!.signal.at = boundary - 10_000
    m.events[4]!.signal.at = boundary - 13_000
    renderPanel(m)
    const groups = [...document.querySelectorAll('[class*="minuteGroup"] details')]
    expect(groups.length).toBe(2)
    const openCount = groups.filter((d) => (d as HTMLDetailsElement).open).length
    expect(openCount).toBe(1)
    const wakeGroup = groups.find((d) => d.textContent!.includes('1 次唤醒'))!
    expect((wakeGroup as HTMLDetailsElement).open).toBe(true)
    // 新分钟组在前
    const first = groups[0] as HTMLDetailsElement
    expect(first).toBe(wakeGroup)
  })

  it('单条事件直接渲染不进分组', async () => {
    const m = makeScenario('healthy')
    m.events = [makeEvent(31)]
    renderPanel(m)
    expect(document.querySelectorAll('[class*="minuteGroup"]')).toHaveLength(0)
    expect(document.querySelectorAll('li[class*="event"]')).toHaveLength(1)
  })

  it('等级、合并计数与自因标注', async () => {
    renderPanel(makeScenario('busy-events'))
    expect(screen.getAllByText('注入').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/×3/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Agent 自己引起/).length).toBeGreaterThan(0)
    // 已抑制(n%11)与唤醒(n%13)的首条在第 2 页
    fireEvent.click(screen.getByText('下一页'))
    expect(screen.getAllByText('已抑制').length).toBeGreaterThan(0)
    expect(screen.getAllByText('唤醒').length).toBeGreaterThan(0)
  })
})

describe('规则与开关', () => {
  it('待确认唤醒规则只有 确认/拒绝', async () => {
    const { props } = renderPanel(makeScenario('healthy'))
    openSection('规则')
    expect(screen.getByText('待确认')).toBeTruthy()
    fireEvent.click(screen.getByText('确认'))
    expect(props.onConfirmRule).toHaveBeenCalledWith('rule-pending')
    fireEvent.click(screen.getByText('拒绝'))
    expect(props.onDeleteRule).toHaveBeenCalledWith('rule-pending')
  })

  it('普通规则启停与删除', async () => {
    const { props } = renderPanel(makeScenario('healthy'))
    openSection('规则')
    const enableBox = screen.getAllByRole('checkbox').find(
      (el) => el.closest('label')!.textContent === '启用' && !(el as HTMLInputElement).checked,
    )!
    fireEvent.click(enableBox)
    expect(props.onToggleRule).toHaveBeenCalledWith('rule-app', true)
    const del = screen.getAllByText('删除')[0]!
    fireEvent.click(del)
    expect(props.onDeleteRule).toHaveBeenCalled()
  })

  it('暂停感知与标题开关回调', async () => {
    const { props } = renderPanel(makeScenario('healthy'))
    openSection('规则')
    fireEvent.click(screen.getByText('暂停感知').closest('label')!.querySelector('input')!)
    expect(props.onPause).toHaveBeenCalledWith(true)
    fireEvent.click(
      screen.getByText('窗口标题发给模型').closest('label')!.querySelector('input')!,
    )
    expect(props.onToggleTitles).toHaveBeenCalledWith(false)
  })
})

describe('基线学习与阈值来源', () => {
  it('learning 场景显示 37% 学习进度（progress 元素）', async () => {
    renderPanel(makeScenario('learning'))
    expect(screen.getByText(/基线学习 37% · 学习中/)).toBeTruthy()
    expect(document.querySelector('progress')).toBeTruthy()
  })

  it('learning strip 仅在学习状态出现', async () => {
    renderPanel(makeScenario('healthy'))
    expect(screen.queryByText(/基线学习/)).toBeNull()
  })

  it('learning.status=ready 时同样不显示学习条', async () => {
    const m = {
      ...makeScenario('healthy'),
      learning: {
        status: 'ready' as const,
        collectedMs: 86_400_000,
        targetMs: 86_400_000,
      },
    }
    renderPanel(m)
    expect(screen.queryByText(/基线学习/)).toBeNull()
    expect(document.querySelector('progress')).toBeNull()
  })

  it('学习期无基线带（不虚构 band），未提供层明示未提供', async () => {
    renderPanel(makeScenario('learning'))
    expect(document.querySelectorAll('[data-baseline]')).toHaveLength(0)
    await openTile('cpu')
    expect(screen.getAllByText(/显示底线/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('未提供').length).toBeGreaterThan(0)
  })

  it('healthy 场景提供基线带并有无障碍文案', async () => {
    renderPanel(makeScenario('healthy'))
    expect(document.querySelectorAll('[data-baseline]').length).toBeGreaterThan(0)
    expect(document.body.textContent).toContain('基线区间')
    await openTile('cpu')
    expect(screen.getAllByText(/未触发/).length).toBeGreaterThan(0)
  })

  it('rapid-change 触发的层在明细里标注出来', async () => {
    renderPanel(makeScenario('rapid-change'))
    await openTile('disks')
    expect(screen.getAllByText(/变化率 · 最近触发/).length).toBeGreaterThan(0)
  })
})

describe('Token 展示', () => {
  it('剩余上下文与缓存命中率', async () => {
    renderPanel(makeScenario('healthy'))
    // 128_000 - 46_200 = 81_800
    expect(screen.getByText(/剩余 81.8k/)).toBeTruthy()
    // 61_000 / 96_400 ≈ 63%
    expect(screen.getByText(/缓存命中率 63%/)).toBeTruthy()
  })

  it('balanceStatus=unavailable 时不泄露金额', async () => {
    const state = makeState()
    state.self.body.tokens = fact({
      contextWindow: 128_000,
      contextUsed: 46_000,
      sessionUsage: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 },
      balance: { amount: 99.9, currency: 'CNY', source: 'demo-provider' },
      balanceStatus: 'unavailable',
      balanceReason: '接口超时',
    })
    renderPanel({ ...makeScenario('healthy'), state })
    expect(screen.getByText(/余额不可用（接口超时）/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('99.9')
  })

  it('balanceStatus=denied 时授权按钮在展开明细里', async () => {
    const state = makeState()
    state.self.body.tokens = fact({
      sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      balance: { amount: 5, currency: 'CNY', source: 'demo-provider' },
      balanceStatus: 'denied',
    })
    const { props } = renderPanel({ ...makeScenario('healthy'), state })
    expect(screen.getByText(/余额无权限/)).toBeTruthy()
    const details = await openTile('tokens')
    const btn = within(details).getByText('授权')
    fireEvent.click(btn)
    expect(props.onOpenPermissionSettings).toHaveBeenCalled()
  })

  it('压缩阈值措辞：已达 / 预计触发 / 按下次请求距离', async () => {
    const base = {
      contextWindow: 128_000,
      sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compressionThreshold: 100_000,
    }
    const s1 = makeState()
    s1.self.body.tokens = fact({ ...base, contextUsed: 101_000 })
    renderPanel({ ...makeScenario('healthy'), state: s1 })
    expect(screen.getByText('已达自动压缩阈值')).toBeTruthy()
    cleanup()

    const s2 = makeState()
    s2.self.body.tokens = fact({ ...base, contextUsed: 90_000, contextProjected: 102_000 })
    renderPanel({ ...makeScenario('healthy'), state: s2 })
    expect(screen.getByText('下次请求预计触发压缩')).toBeTruthy()
    cleanup()

    const s3 = makeState()
    s3.self.body.tokens = fact({ ...base, contextUsed: 80_000, contextProjected: 90_000 })
    renderPanel({ ...makeScenario('healthy'), state: s3 })
    expect(screen.getByText(/距自动压缩（按下次请求）10\.0k/)).toBeTruthy()
  })
})

describe('调整日志与反馈', () => {
  it('调整日志视图：参数锁、记录、撤销', async () => {
    const { props } = renderPanel(makeScenario('rapid-change'))
    openSection('规则')
    fireEvent.click(screen.getByRole('button', { name: '调整日志' }))
    expect(screen.getByText('采样间隔')).toBeTruthy()
    // 旧→新是语义化 prev/next 节点 + 箭头，完整短语仍可读
    const entry = screen
      .getByText(/连续噪音反馈/)
      .closest('li')!
    expect(entry.textContent).toContain('CPU 异常灵敏度 · 3 σ → 4 σ · Agent')
    // 时间带日历日期：昨天与一小时的条目可区分
    expect(screen.getAllByText(/\d{4}.\d{1,2}.\d{1,2}.+\d{2}:\d{2}:\d{2}/).length).toBeGreaterThan(0)
    expect(screen.getByText('已撤销')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('CPU 异常灵敏度锁定'))
    expect(props.onLockParam).toHaveBeenCalledWith('cpu.anomalySigma', true)

    fireEvent.click(screen.getAllByText('撤销')[0]!)
    expect(props.onRevertTuning).toHaveBeenCalled()
  })

  it('告警事件提供 有用/噪音 图标反馈并回报 signal.id', async () => {
    const { props } = renderPanel(makeScenario('rapid-change'))
    fireEvent.click(screen.getAllByRole('button', { name: '有用' })[0]!)
    expect(props.onFeedback).toHaveBeenCalledWith('sig-1', 'useful')
    fireEvent.click(screen.getAllByRole('button', { name: '噪音' })[0]!)
    expect(props.onFeedback).toHaveBeenCalledWith('sig-1', 'noise')
  })

  it('普通 record 事件不显示反馈按钮', async () => {
    const model = { ...makeScenario('healthy'), events: [makeEvent(9)] }
    renderPanel(model)
    expect(screen.queryByRole('button', { name: '有用' })).toBeNull()
    expect(screen.queryByRole('button', { name: '噪音' })).toBeNull()
  })
})

describe('窗口类事件隐私', () => {
  it('sendTitles=false 时 reason/ruleName/detail 中的标题不进入 DOM', async () => {
    const model = { ...makeScenario('healthy'), sendTitles: false }
    model.events = [
      makeEvent(1, {
        reason: '聚焦切换到 SecretTitle',
        ruleName: 'SecretTitle 规则',
        detail: {
          kind: 'file.burst',
          directory: '/SecretTitle-dir',
          windowMs: 60_000,
          created: 1,
          modified: 0,
          deleted: 9,
          excessiveDeletion: true,
        },
      }),
    ]
    model.events[0]!.signal.kind = 'window.focused'
    model.events[0]!.signal.subject = 'SecretTitle'
    renderPanel(model)
    expect(document.body.innerHTML).not.toContain('SecretTitle')
    expect(screen.getByText('已按隐私设置隐藏原因')).toBeTruthy()
  })
})

describe('过期事实秒级年龄', () => {
  it('stale 显示 N 秒前而非分钟', async () => {
    const state = makeState()
    state.self.body.cpu = fact(
      { usage: 0.3, perCore: [], load1: 0, load5: 0, load15: 0 },
      { status: 'stale', ageMs: 120_000 },
    )
    renderPanel({ ...makeScenario('healthy'), state })
    expect(screen.getAllByText(/120 秒前/).length).toBeGreaterThan(0)
  })

  it('新鲜事实不显示「刚刚」占位文字', async () => {
    renderPanel(makeScenario('healthy'))
    expect(screen.queryByText('刚刚')).toBeNull()
  })
})

describe('告警明细与磁盘严重度', () => {
  it('sendTitles=false 时 body/file 类告警明细仍完整显示', async () => {
    renderPanel({ ...makeScenario('rapid-change'), sendTitles: false })
    expect(screen.getAllByText('磁盘 /').length).toBeGreaterThan(0)
    expect(screen.getAllByText('网络下行').length).toBeGreaterThan(0)
    expect(screen.getByText('/demo/project/tmp')).toBeTruthy()
    expect(screen.getByText(/指标 disk:\//)).toBeTruthy()
    expect(screen.getByText(/删除 70 · 过量删除/)).toBeTruthy()
  })

  it('每个盘按自身 insight 严重度着色，行级标签不重复', async () => {
    renderPanel(makeScenario('rapid-change'))
    const tile = await openTile('disks')
    // 行级最多一个严重度标签
    expect(tile.querySelectorAll('summary [class*="sevTag"]')).toHaveLength(1)
    // 每挂载点各自严重度
    const root = tile.querySelector('[data-metric="disk:/"]')!
    const vol = tile.querySelector('[data-metric="disk:/demo/vol"]')!
    expect(root.getAttribute('data-sev')).toBe('warn')
    expect(vol.getAttribute('data-sev')).toBe('good')
  })
})

describe('余额状态权威', () => {
  it('denied 且金额缺失时仍显示原因与授权按钮', async () => {
    const state = makeState()
    state.self.body.tokens = fact({
      sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      balanceStatus: 'denied',
      balanceReason: '未授权账单接口',
    })
    const { props } = renderPanel({ ...makeScenario('healthy'), state })
    expect(screen.getByText(/余额无权限（未授权账单接口）/)).toBeTruthy()
    const details = await openTile('tokens')
    fireEvent.click(within(details).getByText('授权'))
    expect(props.onOpenPermissionSettings).toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('余额 0')
  })

  it('unavailable 且金额缺失时显示原因不显示占位零', async () => {
    const state = makeState()
    state.self.body.tokens = fact({
      sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      balanceStatus: 'unavailable',
      balanceReason: '接口超时',
    })
    renderPanel({ ...makeScenario('healthy'), state })
    expect(screen.getByText(/余额不可用（接口超时）/)).toBeTruthy()
  })
})
