import { describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach } from 'vitest'
import { Sparkline } from '../../src/sparkline'
import { formatCount } from '../../src/format'
import { T0 } from '../../src/mock/fixtures'

afterEach(cleanup)

describe('Sparkline 时间窗口与基线带', () => {
  const points = [
    { at: T0 - 300_001, value: 999 }, // 早于窗口，丢弃
    { at: T0 + 1, value: 888 }, // 未来，丢弃
    { at: T0, value: 7 },
    { at: T0 - 300_000, value: 3 }, // 窗口边界内，保留但排序在前
  ]

  it('过滤窗口外/未来点并按时间排序，路径按排序后顺序', () => {
    const { container } = render(
      <Sparkline points={points} now={T0} label="测试" format={formatCount} />,
    )
    const path = container.querySelector('path')!
    // 无基线时绘图域 = 数据域 [3,7]
    expect(path.getAttribute('d')).toBe('M0.0,18.0 L72.0,2.0')
  })

  it('绘图域包含基线带但无障碍极值只报数据值', () => {
    const { container } = render(
      <Sparkline
        points={points}
        now={T0}
        label="测试"
        format={formatCount}
        baseline={{ low: 0, high: 10 }}
      />,
    )
    expect(container.querySelector('rect[data-baseline="true"]')).toBeTruthy()
    // 基线带纳入绘图域 [0,10]
    expect(container.querySelector('path')!.getAttribute('d')).toBe(
      'M0.0,13.2 L72.0,6.8',
    )
    const summary = screen.getByText(/最近 5 分钟趋势/).textContent!
    expect(summary).toContain('当前 7')
    expect(summary).toContain('最高 7')
    expect(summary).toContain('最低 3')
    expect(summary).toContain('基线区间 0 至 10')
    expect(summary).not.toContain('888')
    expect(summary).not.toContain('999')
  })

  it('少于两个有效点显示占位文案，无基线不画带', () => {
    const { container } = render(
      <Sparkline
        points={[{ at: T0, value: 5 }]}
        now={T0}
        label="测试"
        format={formatCount}
        baseline={{ low: 0, high: 10 }}
      />,
    )
    expect(screen.getByText('暂无趋势数据')).toBeTruthy()
    expect(container.querySelector('rect[data-baseline]')).toBeNull()
  })
})
