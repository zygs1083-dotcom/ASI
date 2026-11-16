import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { SensePanel } from '../../src/SensePanel'
import { effectiveStatus } from '../../src/health'
import { disksFixture, fact, T0 } from '../../src/mock/fixtures'
import { makeScenario } from '../../src/mock/scenarios'
import type { SensePanelModel, SensePanelProps } from '../../src/view-model'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function renderPanel(model: SensePanelModel) {
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
    onAcceptRebaseline: vi.fn(async () => {}),
  }
  return { props, view: render(<SensePanel {...props} />) }
}

function openDiskTile() {
  const tile = document.querySelector('details[data-tile="disks"]')! as HTMLDetailsElement
  act(() => {
    tile.open = true
    fireEvent(tile, new Event('toggle'))
  })
  return tile
}

describe('事实状态契约', () => {
  it('无剩余期限时信任 status，不根据墙钟或 TTL 判过期', () => {
    const f = fact(1, { ageMs: 6_000, ttlMs: 5_000 })
    expect(effectiveStatus(f, T0 + 61_000)).toBe('ok')
    expect(effectiveStatus({ ...f, status: 'stale' }, T0 - 61_000)).toBe('stale')
  })

  it('墙钟前跳 61 秒后普通事实、磁盘和告警仍新鲜', () => {
    const model = makeScenario('healthy')
    model.state.self.body.disks = disksFixture([
      { mount: '/', total: 100, free: 80, status: 'ok', observedAt: T0 - 1_000, ttlMs: 5_000 },
    ])
    model.insights = {
      cpu: { sources: ['baseline'], triggered: ['baseline'], severity: 'critical' },
      'disk:/': { sources: ['baseline'], triggered: ['baseline'], severity: 'critical' },
    }
    const { props, view } = renderPanel(model)
    view.rerender(<SensePanel {...props} model={{ ...model, now: T0 + 61_000 }} />)
    for (const key of ['cpu', 'disks']) {
      const tile = document.querySelector(`details[data-tile="${key}"]`)!
      expect(tile.getAttribute('data-sev')).toBe('critical')
      expect(tile.querySelector('[data-status="stale"]')).toBeNull()
    }
    expect(document.querySelector('[class*="monitor"][data-sev]')?.getAttribute('data-sev')).toBe('critical')
    expect(screen.getByText('Terminal')).toBeTruthy()
  })

  it.each(['explicit', 'inherited'] as const)('展开的 %s 磁盘卷与卡片在墙钟前跳和回拨时保持新鲜', (mode) => {
    const model = makeScenario('healthy')
    model.state.self.body.disks = disksFixture([
      { mount: '/', total: 100, free: 2, ...(mode === 'explicit' ? { status: 'ok' as const } : {}) },
    ], { ageMs: 1_000, ttlMs: 5_000 })
    const { props, view } = renderPanel(model)
    const tile = openDiskTile()
    const detail = () => tile.querySelector('[class*="detailFact"]')!
    const metric = () => tile.querySelector('[data-metric="disk:/"]')!
    for (const now of [T0, T0 + 61_000, T0 - 61_000, T0]) {
      view.rerender(<SensePanel {...props} model={{ ...model, now }} />)
      expect(tile.getAttribute('data-sev')).toBe('critical')
      expect(tile.querySelector('summary [data-status="stale"]')).toBeNull()
      expect(detail().textContent).not.toContain('已过期')
      expect(metric().textContent).toContain('当前')
      expect(metric().getAttribute('data-status')).toBeNull()
    }
  })

  it('展开明细中显式卷独立于过期父级，缺省卷继承父级', () => {
    const model = makeScenario('healthy')
    model.state.self.body.disks = disksFixture([
      { mount: '/', total: 100, free: 80 },
      { mount: '/data', total: 100, free: 2, status: 'ok' },
    ], { status: 'stale', ageMs: 1_000, ttlMs: 5_000 })
    const { props, view } = renderPanel(model)
    const tile = openDiskTile()
    for (const now of [T0, T0 + 61_000, T0 - 61_000]) {
      view.rerender(<SensePanel {...props} model={{ ...model, now }} />)
      expect(tile.getAttribute('data-sev')).toBe('critical')
      expect(tile.querySelector('[class*="detailFact"]')!.textContent).not.toContain('已过期')
      expect(tile.querySelector('[data-metric="disk:/"]')!.textContent).toContain('上次读数')
      expect(tile.querySelector('[data-metric="disk:/data"]')!.textContent).toContain('当前')
    }
  })

  it.each(['explicit', 'inherited'] as const)('展开的 %s 卷在单调期限到达后与卡片一起过期', (mode) => {
    vi.useFakeTimers()
    const model = makeScenario('healthy')
    model.state.self.body.disks = disksFixture([
      { mount: '/', total: 100, free: 2, ...(mode === 'explicit' ? { status: 'ok' as const, staleInMs: 5_000 } : {}) },
    ])
    if (mode === 'inherited') model.state.self.body.disks.staleInMs = 5_000
    renderPanel(model)
    const tile = openDiskTile()
    expect(tile.querySelector('[class*="detailFact"]')!.textContent).not.toContain('已过期')
    act(() => vi.advanceTimersByTime(5_000))
    expect(tile.querySelector('summary [data-status="stale"]')).toBeTruthy()
    expect(tile.querySelector('[class*="detailFact"]')!.textContent).toContain('已过期')
    expect(tile.querySelector('[data-metric="disk:/"]')!.textContent).toContain('上次读数')
  })

  it('父级单调期限到期不影响显式新鲜卷', () => {
    vi.useFakeTimers()
    const model = makeScenario('healthy')
    model.state.self.body.disks = {
      ...disksFixture([
        { mount: '/', total: 100, free: 80 },
        { mount: '/data', total: 100, free: 2, status: 'ok' },
      ]),
      staleInMs: 5_000,
    }
    renderPanel(model)
    const tile = openDiskTile()
    act(() => vi.advanceTimersByTime(5_000))
    expect(tile.getAttribute('data-sev')).toBe('critical')
    expect(tile.querySelector('[class*="detailFact"]')!.textContent).not.toContain('已过期')
    expect(tile.querySelector('[data-metric="disk:/"]')!.textContent).toContain('上次读数')
    expect(tile.querySelector('[data-metric="disk:/data"]')!.textContent).toContain('当前')
  })

  it('剩余单调期限到期后自动更新普通事实、磁盘卷和总览', () => {
    vi.useFakeTimers()
    const model = makeScenario('healthy')
    model.state.self.body.cpu = { ...model.state.self.body.cpu, staleInMs: 5_000 }
    model.state.self.body.disks = disksFixture([
      { mount: '/', total: 100, free: 2, status: 'ok', staleInMs: 5_000 },
    ])
    model.state.env.frontApp = { ...model.state.env.frontApp, staleInMs: 5_000 }
    model.insights = { cpu: { sources: ['baseline'], triggered: ['baseline'], severity: 'critical' } }
    renderPanel(model)
    expect(document.querySelector('details[data-tile="cpu"]')?.getAttribute('data-sev')).toBe('critical')
    expect(document.querySelector('details[data-tile="disks"]')?.getAttribute('data-sev')).toBe('critical')
    act(() => vi.advanceTimersByTime(4_999))
    expect(document.querySelector('details[data-tile="cpu"] [data-status="stale"]')).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(document.querySelector('details[data-tile="cpu"] [data-status="stale"]')?.textContent).toContain('6 秒前')
    expect(document.querySelector('details[data-tile="disks"] [data-status="stale"]')).toBeTruthy()
    expect(document.querySelector('[class*="monitor"][data-sev]')?.getAttribute('data-sev')).toBe('unknown')
    expect(screen.getByText('Terminal').closest('[class*="factStale"]')).toBeTruthy()
    expect(model.state.self.body.cpu.status).toBe('ok')
    expect(model.state.self.body.disks.value?.[0]?.status).toBe('ok')
  })

  it('新帧的剩余期限取代旧帧，墙钟跳变不会加速倒计时', () => {
    vi.useFakeTimers()
    const model = makeScenario('healthy')
    model.state.self.body.cpu = { ...model.state.self.body.cpu, staleInMs: 1_000 }
    const { props, view } = renderPanel(model)
    act(() => vi.advanceTimersByTime(400))
    const cpu = { ...model.state.self.body.cpu, staleInMs: 1_800 }
    const next = { ...model, now: T0 + 61_000, state: { ...model.state, self: { ...model.state.self, body: { ...model.state.self.body, cpu } } } }
    view.rerender(<SensePanel {...props} model={next} />)
    act(() => vi.advanceTimersByTime(600))
    expect(document.querySelector('details[data-tile="cpu"] [data-status="stale"]')).toBeNull()
    act(() => vi.advanceTimersByTime(1_200))
    expect(document.querySelector('details[data-tile="cpu"] [data-status="stale"]')).toBeTruthy()
  })

  it('零期限立即过期，缺省卷继承父状态而自声明卷独立', () => {
    const model = makeScenario('healthy')
    model.state.self.body.cpu = { ...model.state.self.body.cpu, staleInMs: 0 }
    model.state.self.body.disks = {
      ...disksFixture([
        { mount: '/', total: 100, free: 80 },
        { mount: '/data', total: 100, free: 2, status: 'ok' },
      ]),
      staleInMs: 0,
    }
    renderPanel(model)
    expect(document.querySelector('details[data-tile="cpu"] [data-status="stale"]')).toBeTruthy()
    const disk = document.querySelector('details[data-tile="disks"]')!
    expect(disk.getAttribute('data-sev')).toBe('critical')
    expect(disk.textContent).toContain('/data')
    expect(disk.textContent).toContain('部分')
  })

  it('不同期限依次到期，非 ok 状态和非法期限不被改变', () => {
    vi.useFakeTimers()
    const model = makeScenario('healthy')
    model.state.self.body.cpu = { ...model.state.self.body.cpu, staleInMs: 1_000 }
    model.state.self.body.memory = { ...model.state.self.body.memory, staleInMs: NaN }
    model.state.self.body.thermal = { ...model.state.self.body.thermal, status: 'denied', staleInMs: 0 }
    model.state.self.body.disks = disksFixture([
      { mount: '/', total: 100, free: 2, status: 'ok', staleInMs: 2_000 },
    ])
    const { view } = renderPanel(model)
    act(() => vi.advanceTimersByTime(1_000))
    expect(document.querySelector('details[data-tile="cpu"] [data-status="stale"]')).toBeTruthy()
    expect(document.querySelector('details[data-tile="disks"]')?.getAttribute('data-sev')).toBe('critical')
    expect(document.querySelector('details[data-tile="memory"] [data-status="stale"]')).toBeNull()
    expect(document.querySelector('details[data-tile="thermal"]')?.textContent).toContain('无权限')
    act(() => vi.advanceTimersByTime(1_000))
    expect(document.querySelector('details[data-tile="disks"] [data-status="stale"]')).toBeTruthy()
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('卸载时清理尚未到期的倒计时', () => {
    vi.useFakeTimers()
    const model = makeScenario('healthy')
    model.state.self.body.cpu = { ...model.state.self.body.cpu, staleInMs: 10_000 }
    const { view } = renderPanel(model)
    expect(vi.getTimerCount()).toBe(1)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('调整日志撤销契约', () => {
  it('superseded/rejected 不可撤销，已撤销与缺省保持各自语义', () => {
    const model = makeScenario('rapid-change')
    const entry = model.tuning!.log[0]!
    model.tuning = { ...model.tuning!, log: [
      { ...entry, id: 'superseded', reason: '已被覆盖', reverted: false, undoable: false },
      { ...entry, id: 'rejected', reason: '提议被拒绝', reverted: false, undoable: false },
      { ...entry, id: 'reverted', reason: '真正撤销', reverted: true, undoable: false },
      { ...entry, id: 'legacy', reason: '旧版记录', reverted: false },
      { ...entry, id: 'undoable', reason: '可撤销记录', reverted: false, undoable: true },
    ] }
    const { props } = renderPanel(model)
    fireEvent.click(screen.getByText('规则', { selector: 'summary' }))
    fireEvent.click(screen.getByRole('button', { name: '调整日志' }))
    for (const reason of ['已被覆盖', '提议被拒绝']) {
      const row = screen.getByText(new RegExp(reason)).closest('li')!
      expect(within(row).queryByRole('button', { name: '撤销' })).toBeNull()
      expect(row.textContent).toContain('不可撤销')
      expect(row.textContent).not.toContain('已撤销')
    }
    expect(screen.getByText(/真正撤销/).closest('li')?.textContent).toContain('已撤销')
    for (const reason of ['旧版记录', '可撤销记录']) {
      fireEvent.click(within(screen.getByText(new RegExp(reason)).closest('li')!).getByRole('button', { name: '撤销' }))
    }
    expect(props.onRevertTuning).toHaveBeenCalledWith('legacy')
    expect(props.onRevertTuning).toHaveBeenCalledWith('undoable')
  })

  it.each([
    { undoable: false, text: '不可撤销' },
    { reverted: true, text: '已撤销' },
  ])('新帧移除聚焦的撤销按钮时，焦点移到对应记录：$text', ({ text, ...update }) => {
    const model = makeScenario('rapid-change')
    const entry = model.tuning!.log[0]!
    model.tuning = { ...model.tuning!, log: [{ ...entry, reverted: false, undoable: true }] }
    const { props, view } = renderPanel(model)
    fireEvent.click(screen.getByText('规则', { selector: 'summary' }))
    fireEvent.click(screen.getByRole('button', { name: '调整日志' }))
    const button = screen.getByRole('button', { name: '撤销' })
    const row = button.closest('li')!
    button.focus()
    expect(document.activeElement).toBe(button)
    view.rerender(<SensePanel {...props} model={{
      ...model, tuning: { ...model.tuning!, log: [{ ...model.tuning!.log[0]!, ...update }] },
    }} />)
    expect(row.textContent).toContain(text)
    expect(document.activeElement).toBe(row)
    expect(row.getAttribute('tabindex')).toBe('-1')
  })

  it('其他记录失效或新帧保留按钮时，不抢焦点', () => {
    const model = makeScenario('rapid-change')
    const entry = model.tuning!.log[0]!
    model.tuning = { ...model.tuning!, log: [
      { ...entry, id: 'first', reason: '第一条', reverted: false },
      { ...entry, id: 'second', reason: '第二条', reverted: false },
    ] }
    const { props, view } = renderPanel(model)
    fireEvent.click(screen.getByText('规则', { selector: 'summary' }))
    fireEvent.click(screen.getByRole('button', { name: '调整日志' }))
    const second = within(screen.getByText(/第二条/).closest('li')!).getByRole('button', { name: '撤销' })
    second.focus()
    view.rerender(<SensePanel {...props} model={{
      ...model, now: T0 + 1_000, tuning: { ...model.tuning!, log: [
        { ...model.tuning!.log[0]!, undoable: false }, model.tuning!.log[1]!,
      ] },
    }} />)
    expect(document.activeElement).toBe(second)
    const pause = screen.getByRole('checkbox', { name: /暂停感知/ })
    pause.focus()
    view.rerender(<SensePanel {...props} model={{
      ...model, tuning: { ...model.tuning!, log: model.tuning!.log.map((e) => ({ ...e, undoable: false })) },
    }} />)
    expect(document.activeElement).toBe(pause)
  })
})
