import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { SensePanel } from '../../src/SensePanel'
import { makeScenario } from '../../src/mock/scenarios'
import type { SensePanelModel, SensePanelProps } from '../../src/view-model'

afterEach(cleanup)

function setup(model: SensePanelModel) {
  const props = {
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
    onResumeTuning: vi.fn(),
    onResetTuning: vi.fn(),
    onAcceptRebaseline: vi.fn(),
  } satisfies SensePanelProps
  const view = render(<SensePanel {...props} />)
  fireEvent.click(screen.getByText('规则', { selector: 'summary' }))
  return { props, view }
}

describe('调参恢复与重置', () => {
  it('保存失败显示恢复入口，直接调用恢复回调', () => {
    const model = makeScenario('healthy')
    model.tuning = { parameters: [], log: [], disabled: { reason: 'storage-failed' } }
    const { props } = setup(model)
    expect(screen.getByText(/保存调参数据失败/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '恢复 AI 调参' }))
    expect(props.onResumeTuning).toHaveBeenCalledOnce()
    expect(props.onResetTuning).not.toHaveBeenCalled()
  })

  it('恢复失败的重置必须确认，可取消，取消后焦点返回入口', () => {
    const model = makeScenario('healthy')
    model.tuning = { parameters: [], log: [], disabled: { reason: 'restore-failed' } }
    const { props } = setup(model)
    expect(screen.getByText('保存的调参数据损坏，AI 调参已停用')).toBeTruthy()
    const trigger = screen.getByRole('button', { name: '重置调参' })
    fireEvent.click(trigger)
    expect(props.onResetTuning).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '确认重置' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(document.activeElement).toBe(trigger)
    expect(props.onResetTuning).not.toHaveBeenCalled()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: '确认重置' }))
    expect(props.onResetTuning).toHaveBeenCalledOnce()
    expect(props.onResumeTuning).not.toHaveBeenCalled()
  })
})

describe('重新基线建议', () => {
  it('按指标单位显示建议，并仅在确认后传入对应 id', () => {
    const model = makeScenario('healthy')
    model.tuning = {
      parameters: [],
      log: [],
      suggestions: [
        { id: 'cpu-1', metric: 'cpu', unit: 'ratio', slotLabel: '周二 14 时', from: 0.2, to: 0.7, samples: 12, dates: 3 },
        { id: 'net-1', metric: 'networkRx', unit: 'bytes-per-second', slotLabel: '周三 15 时', from: 1024, to: 2048, samples: 8, dates: 4 },
        { id: 'disk-1', metric: 'disk:/demo', unit: 'bytes', slotLabel: '周四 16 时', from: 1024 ** 3, to: 2 * 1024 ** 3, samples: 9, dates: 3 },
        { id: 'rss-1', metric: 'processRss', unit: 'bytes', slotLabel: '周五 17 时', from: 1024 ** 3, to: 2 * 1024 ** 3, samples: 10, dates: 3 },
        { id: 'bat-1', metric: 'battery', unit: 'percent', slotLabel: '周六 18 时', from: 30, to: 60, samples: 10, dates: 3 },
        { id: 'temp-1', metric: 'thermal', unit: 'ordinal', slotLabel: '周日 19 时', from: 0.5, to: 1.5, samples: 10, dates: 3 },
        { id: 'token-1', metric: 'tokens', unit: 'tokens', slotLabel: '周一 20 时', from: 1000, to: 2000, samples: 10, dates: 3 },
      ],
    }
    const { props } = setup(model)
    fireEvent.click(screen.getByRole('button', { name: '调整日志' }))
    const list = screen.getByRole('list', { name: '重新基线建议' })
    expect(list.textContent).toContain('CPU')
    expect(list.textContent).toContain('周二 14 时')
    expect(list.textContent).toContain('20%')
    expect(list.textContent).toContain('70%')
    expect(list.textContent).toContain('12 个样本')
    expect(list.textContent).toContain('3 个日期')
    expect(list.textContent).toContain('1 KB/s')
    expect(list.textContent).toContain('2 KB/s')
    expect(list.textContent).toContain('磁盘 /demo 剩余')
    expect(list.textContent).toContain('1.0 GB')
    expect(list.textContent).toContain('2.0 GB')
    expect(list.textContent).toContain('30%')
    expect(list.textContent).toContain('0.5 档')
    expect(list.textContent).toContain('Token 上下文剩余')
    expect(list.textContent).toContain('1,000')
    const items = within(list).getAllByRole('listitem')
    const button = within(items[1]!).getByRole('button', { name: '确认重新基线' })
    fireEvent.click(button)
    expect(props.onAcceptRebaseline).not.toHaveBeenCalled()
    expect(within(items[1]!).getByText('持续故障和新负载无法自动区分，请确认这是正常的新状态')).toBeTruthy()
    expect(document.activeElement).toBe(within(items[1]!).getByRole('button', { name: '确认应用' }))
    fireEvent.click(within(items[1]!).getByRole('button', { name: '取消' }))
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    fireEvent.click(within(items[1]!).getByRole('button', { name: '确认应用' }))
    expect(props.onAcceptRebaseline).toHaveBeenCalledExactlyOnceWith('net-1')
  })

  it('建议内容变化时取消已打开的确认，避免确认过期数据', () => {
    const model = makeScenario('healthy')
    model.tuning = {
      parameters: [], log: [],
      suggestions: [{ id: 'cpu-1', metric: 'cpu', unit: 'ratio', slotLabel: '周二 14 时', from: 0.2, to: 0.7, samples: 12, dates: 3 }],
    }
    const { props, view } = setup(model)
    fireEvent.click(screen.getByRole('button', { name: '调整日志' }))
    fireEvent.click(screen.getByRole('button', { name: '确认重新基线' }))
    view.rerender(<SensePanel {...props} model={{
      ...model,
      tuning: { ...model.tuning, suggestions: [{ ...model.tuning.suggestions![0]!, to: 0.8 }] },
    }} />)
    expect(screen.queryByRole('button', { name: '确认应用' })).toBeNull()
    expect(props.onAcceptRebaseline).not.toHaveBeenCalled()
  })

  it('格式化后数值相同的不同均值仍显示精确差异', () => {
    const model = makeScenario('healthy')
    model.tuning = {
      parameters: [], log: [],
      suggestions: [
        { id: 'cpu', metric: 'cpu', unit: 'ratio', slotLabel: '周一 1 时', from: 0.201, to: 0.202, samples: 8, dates: 3 },
        { id: 'net', metric: 'networkRx', unit: 'bytes-per-second', slotLabel: '周一 2 时', from: 10, to: 20, samples: 8, dates: 3 },
        { id: 'disk', metric: 'disk:/', unit: 'bytes', slotLabel: '周一 3 时', from: 10, to: 20, samples: 8, dates: 3 },
        { id: 'token', metric: 'tokens', unit: 'tokens', slotLabel: '周一 4 时', from: 10001, to: 10002, samples: 8, dates: 3 },
        { id: 'battery', metric: 'battery', unit: 'percent', slotLabel: '周一 5 时', from: 30.1, to: 30.2, samples: 8, dates: 3 },
      ],
    }
    setup(model)
    fireEvent.click(screen.getByRole('button', { name: '调整日志' }))
    const items = within(screen.getByRole('list', { name: '重新基线建议' })).getAllByRole('listitem')
    expect(items[0]!.textContent).toContain('20.1% → 20.2%')
    expect(items[1]!.textContent).toContain('10 B/s → 20 B/s')
    expect(items[2]!.textContent).toContain('10 B → 20 B')
    expect(items[3]!.textContent).toContain('10,001 token → 10,002 token')
    expect(items[4]!.textContent).toContain('30.1% → 30.2%')
  })
})
