import { describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach } from 'vitest'
import { SensePanel } from '../../src/SensePanel'
import type { SensePanelProps, SensePanelModel } from '../../src/view-model'
import { makeScenario } from '../../src/mock/scenarios'
import { fact, makeEvent, makeState } from '../../src/mock/fixtures'

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
    ...over,
  }
  return props
}

function renderPanel(model: SensePanelModel, over: Partial<SensePanelProps> = {}) {
  const props = makeProps(model, over)
  const view = render(<SensePanel {...props} />)
  return { props, view }
}

describe('结构与分区', () => {
  it('渲染标题与四个默认展开的分区', () => {
    renderPanel(makeScenario('healthy'))
    expect(screen.getByText('环境感知')).toBeTruthy()
    for (const name of ['身体', '现在', '事件流', '规则']) {
      const summary = screen.getByText(name)
      expect(summary.closest('details')!.open).toBe(true)
    }
  })

  it('summary 点击可折叠/展开', () => {
    renderPanel(makeScenario('healthy'))
    const summary = screen.getByText('事件流')
    const details = summary.closest('details')!
    fireEvent.click(summary)
    expect(details.open).toBe(false)
    fireEvent.click(summary)
    expect(details.open).toBe(true)
  })

  it('健康条给出整句评估', () => {
    const { view } = renderPanel(makeScenario('healthy'))
    expect(screen.getByText('状态良好')).toBeTruthy()
    view.unmount()
    const { view: v2 } = renderPanel(makeScenario('memory-pressure'))
    expect(screen.getByText('内存紧张')).toBeTruthy()
    v2.unmount()
    renderPanel(makeScenario('permission-denied'))
    expect(screen.getByText('数据待补全')).toBeTruthy()
  })
})

describe('事实状态呈现', () => {
  it('denied 显示原因与授权按钮', () => {
    const { props } = renderPanel(makeScenario('permission-denied'))
    const buttons = screen.getAllByText('授权')
    fireEvent.click(buttons[0]!)
    expect(props.onOpenPermissionSettings).toHaveBeenCalledOnce()
  })

  it('stale 显示保留值与过期标记', () => {
    renderPanel(makeScenario('permission-denied'))
    expect(screen.getAllByText(/已过期/).length).toBeGreaterThan(0)
  })

  it('余额缺失显示说明而不是 0', () => {
    const model = makeScenario('context-almost-full')
    renderPanel(model)
    expect(screen.getByText(/提供方未提供余额接口/)).toBeTruthy()
    expect(screen.queryByText(/^0$/)).toBeNull()
  })

  it('上下文缺数据时不按 0 渲染', () => {
    const state = makeState()
    state.self.body.tokens = fact({
      sessionUsage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    })
    renderPanel({ ...makeScenario('healthy'), state })
    expect(screen.getByText('上下文数据不可用')).toBeTruthy()
    expect(screen.queryByText('压缩阈值未提供')).toBeNull()
  })

  it('台式机电池 null 时隐藏电池行', () => {
    renderPanel(makeScenario('desktop-no-battery'))
    expect(screen.queryByText('电池')).toBeNull()
  })

  it('电池 denied 时渲染状态而非隐藏', () => {
    const state = makeState()
    state.self.body.battery = fact(null, { status: 'denied', reason: '未授权电池信息' })
    renderPanel({ ...makeScenario('healthy'), state })
    expect(screen.getByText('电池')).toBeTruthy()
    expect(screen.getByText(/未授权电池信息/)).toBeTruthy()
  })
})

describe('窗口标题隐私', () => {
  it('sendTitles=false 时标题不进入 DOM，事件主体也被遮盖', () => {
    const model = { ...makeScenario('healthy'), sendTitles: false }
    renderPanel(model)
    expect(screen.getByText('已隐藏')).toBeTruthy()
    expect(document.body.textContent).not.toContain('demo.ts — project')
    expect(screen.getAllByText('窗口标题已隐藏').length).toBeGreaterThan(0)
  })

  it('sendTitles=true 时正常显示标题', () => {
    renderPanel(makeScenario('healthy'))
    expect(document.body.textContent).toContain('demo.ts — project')
  })
})

describe('事件流', () => {
  it('超过 200 截断、每页 10 条、可翻页', () => {
    renderPanel(makeScenario('busy-events'))
    expect(screen.getByText(/最新 200 条/)).toBeTruthy()
    expect(screen.getByText(/第 1\/20 页/)).toBeTruthy()
    const items = document.querySelectorAll('li')
    expect(items.length).toBe(10 + 3) // 10 事件 + 3 规则
    fireEvent.click(screen.getByText('下一页'))
    expect(screen.getByText(/第 2\/20 页/)).toBeTruthy()
    fireEvent.click(screen.getByText('上一页'))
    expect(screen.getByText(/第 1\/20 页/)).toBeTruthy()
  })

  it('输入骤减时分页被钳位', () => {
    const { props, view } = renderPanel(makeScenario('busy-events'))
    fireEvent.click(screen.getByText('下一页'))
    expect(screen.getByText(/第 2\/20 页/)).toBeTruthy()
    const shrunk = { ...props.model, events: [makeEvent(1), makeEvent(2)] }
    view.rerender(<SensePanel {...props} model={shrunk} />)
    expect(screen.queryByText('下一页')).toBeNull()
    expect(screen.getByText(/第 1\/1 页/)).toBeTruthy()
  })

  it('等级、合并计数与自因标注', () => {
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
  it('待确认唤醒规则只有 确认/拒绝', () => {
    const { props } = renderPanel(makeScenario('healthy'))
    expect(screen.getByText('待确认')).toBeTruthy()
    fireEvent.click(screen.getByText('确认'))
    expect(props.onConfirmRule).toHaveBeenCalledWith('rule-pending')
    fireEvent.click(screen.getByText('拒绝'))
    expect(props.onDeleteRule).toHaveBeenCalledWith('rule-pending')
  })

  it('普通规则启停与删除', () => {
    const { props } = renderPanel(makeScenario('healthy'))
    const enableBox = screen.getAllByRole('checkbox').find(
      (el) => el.closest('label')!.textContent === '启用' && !(el as HTMLInputElement).checked,
    )!
    fireEvent.click(enableBox)
    expect(props.onToggleRule).toHaveBeenCalledWith('rule-app', true)
    const del = screen.getAllByText('删除')[0]!
    fireEvent.click(del)
    expect(props.onDeleteRule).toHaveBeenCalled()
  })

  it('暂停感知与标题开关回调', () => {
    const { props } = renderPanel(makeScenario('healthy'))
    fireEvent.click(screen.getByText('暂停感知').closest('label')!.querySelector('input')!)
    expect(props.onPause).toHaveBeenCalledWith(true)
    fireEvent.click(
      screen.getByText('窗口标题发给模型').closest('label')!.querySelector('input')!,
    )
    expect(props.onToggleTitles).toHaveBeenCalledWith(false)
  })
})

describe('基线学习与阈值来源', () => {
  it('learning 场景显示 37% 学习进度（progress 元素）', () => {
    renderPanel(makeScenario('learning'))
    expect(screen.getByText(/基线学习 37% · 学习中/)).toBeTruthy()
    expect(document.querySelector('progress')).toBeTruthy()
  })

  it('学习期无基线带（不虚构 band），无 insight 的行显示未提供', () => {
    renderPanel(makeScenario('learning'))
    expect(document.querySelectorAll('[data-baseline]')).toHaveLength(0)
    expect(screen.getAllByText(/来源：底线 \/ 变化率/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('阈值来源未提供').length).toBeGreaterThan(0)
  })

  it('healthy 场景提供基线带并有无障碍文案', () => {
    renderPanel(makeScenario('healthy'))
    expect(document.querySelectorAll('[data-baseline]').length).toBeGreaterThan(0)
    expect(document.body.textContent).toContain('基线区间')
    expect(screen.getAllByText(/触发：未触发/).length).toBeGreaterThan(0)
  })

  it('rapid-change 触发的层被标注出来', () => {
    renderPanel(makeScenario('rapid-change'))
    expect(screen.getAllByText(/触发：变化率|触发：基线/).length).toBeGreaterThan(0)
  })

  it('行级非 good 状态有文字标签而非仅颜色', () => {
    renderPanel(makeScenario('memory-pressure'))
    expect(screen.getAllByText('注意').length).toBeGreaterThan(0)
  })
})

describe('Token 展示', () => {
  it('剩余上下文与缓存命中率', () => {
    renderPanel(makeScenario('healthy'))
    // 128_000 - 46_200 = 81_800
    expect(screen.getByText(/剩余 81.8k/)).toBeTruthy()
    // 61_000 / 96_400 ≈ 63%
    expect(screen.getByText(/缓存命中率 63%/)).toBeTruthy()
  })

  it('balanceStatus=unavailable 时不泄露金额', () => {
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

  it('balanceStatus=denied 显示授权按钮', () => {
    const state = makeState()
    state.self.body.tokens = fact({
      sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      balance: { amount: 5, currency: 'CNY', source: 'demo-provider' },
      balanceStatus: 'denied',
    })
    const { props } = renderPanel({ ...makeScenario('healthy'), state })
    expect(screen.getByText(/余额无权限/)).toBeTruthy()
    const btn = screen.getAllByText('授权').at(-1)!
    fireEvent.click(btn)
    expect(props.onOpenPermissionSettings).toHaveBeenCalled()
  })

  it('压缩阈值措辞：已达 / 预计触发 / 按下次请求距离', () => {
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
  it('调整日志视图：参数锁、记录、撤销', () => {
    const { props } = renderPanel(makeScenario('rapid-change'))
    fireEvent.click(screen.getByRole('button', { name: '调整日志' }))
    expect(screen.getByText('采样间隔')).toBeTruthy()
    expect(
      screen.getByText('CPU 异常灵敏度 · 3 σ → 4 σ · Agent'),
    ).toBeTruthy()
    // 时间带日历日期：昨天与一小时的条目可区分
    expect(screen.getAllByText(/\d{4}.\d{1,2}.\d{1,2}.+\d{2}:\d{2}:\d{2}/).length).toBeGreaterThan(0)
    expect(screen.getByText('已撤销')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('CPU 异常灵敏度锁定'))
    expect(props.onLockParam).toHaveBeenCalledWith('cpu.anomalySigma', true)

    fireEvent.click(screen.getAllByText('撤销')[0]!)
    expect(props.onRevertTuning).toHaveBeenCalled()
  })

  it('告警事件提供 有用/噪音 反馈按钮并回报 signal.id', () => {
    const { props } = renderPanel(makeScenario('rapid-change'))
    fireEvent.click(screen.getAllByText('有用')[0]!)
    expect(props.onFeedback).toHaveBeenCalledWith('sig-1', 'useful')
    fireEvent.click(screen.getAllByText('噪音')[0]!)
    expect(props.onFeedback).toHaveBeenCalledWith('sig-1', 'noise')
  })

  it('普通 record 事件不显示反馈按钮', () => {
    const model = { ...makeScenario('healthy'), events: [makeEvent(9)] }
    renderPanel(model)
    expect(screen.queryByText('有用')).toBeNull()
    expect(screen.queryByText('噪音')).toBeNull()
  })
})

describe('窗口类事件隐私', () => {
  it('sendTitles=false 时 reason/ruleName/detail 中的标题不进入 DOM', () => {
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
  it('stale 显示 N 秒前而非分钟', () => {
    const state = makeState()
    state.self.body.cpu = fact(
      { usage: 0.3, perCore: [], load1: 0, load5: 0, load15: 0 },
      { status: 'stale', ageMs: 120_000 },
    )
    renderPanel({ ...makeScenario('healthy'), state })
    expect(screen.getAllByText(/120 秒前/).length).toBeGreaterThan(0)
  })
})

describe('告警明细与磁盘严重度', () => {
  it('sendTitles=false 时 body/file 类告警明细仍完整显示', () => {
    renderPanel({ ...makeScenario('rapid-change'), sendTitles: false })
    expect(screen.getByText('磁盘 /')).toBeTruthy()
    expect(screen.getByText('网络下行')).toBeTruthy()
    expect(screen.getByText('/demo/project/tmp')).toBeTruthy()
    expect(screen.getByText(/指标 disk:\//)).toBeTruthy()
    expect(screen.getByText(/删除 70 · 过量删除/)).toBeTruthy()
  })

  it('磁盘行按自身 insight 严重度着色，其他盘不受连坐', () => {
    renderPanel(makeScenario('rapid-change'))
    const root = screen
      .getByText('/', { selector: 'span' })
      .closest<HTMLElement>('div[class*="diskRow"]')!
    const vol = screen
      .getByText('/demo/vol', { selector: 'span' })
      .closest<HTMLElement>('div[class*="diskRow"]')!
    expect(root.getAttribute('data-sev')).toBe('warn')
    expect(vol.getAttribute('data-sev')).toBe('good')
    // 根盘有可见 注意 徽标，第二盘无
    expect(within(root).getByText('注意')).toBeTruthy()
    expect(within(vol).queryByText('注意')).toBeNull()
    // good 盘进度条保持业务蓝而非行级 warn 色
    const volBar = vol.querySelector('div[class*="bar"] > i')!
    expect(getComputedStyle(volBar).backgroundColor).toBe('rgb(65, 118, 230)')
  })
})

describe('余额状态权威', () => {
  it('denied 且金额缺失时仍显示原因与授权按钮', () => {
    const state = makeState()
    state.self.body.tokens = fact({
      sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      balanceStatus: 'denied',
      balanceReason: '未授权账单接口',
    })
    const { props } = renderPanel({ ...makeScenario('healthy'), state })
    expect(screen.getByText(/余额无权限（未授权账单接口）/)).toBeTruthy()
    fireEvent.click(screen.getAllByText('授权').at(-1)!)
    expect(props.onOpenPermissionSettings).toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('余额 0')
  })

  it('unavailable 且金额缺失时显示原因不显示占位零', () => {
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
