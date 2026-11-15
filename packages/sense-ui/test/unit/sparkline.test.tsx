import { describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach } from 'vitest'
import { Sparkline } from '../../src/sparkline'
import { formatCount, formatPercent } from '../../src/format'
import { T0 } from '../../src/mock/fixtures'

afterEach(cleanup)

describe('Sparkline 时间窗口与基线带', () => {
  const points = [
    { at: T0 - 300_001, value: 999 }, // 早于窗口，丢弃
    { at: T0 + 1, value: 888 }, // 未来，丢弃
    { at: T0, value: 7 },
    { at: T0 - 300_000, value: 3 }, // 窗口边界内，保留但排序在前
  ]

  it('x 域固定为 [now-5min, now]：窗口首点 x=0、最新点 x=100', () => {
    const { container } = render(
      <Sparkline points={points} now={T0} label="测试" format={formatCount} />,
    )
    const path = container.querySelector('path')!
    // 无基线时绘图域 = 数据域 [3,7]（pad 0.32）
    expect(path.getAttribute('d')).toBe('M0.00,93.10 L100.00,6.90')
  })

  it('稀疏点按真实时间摆位而不是首尾拉满', () => {
    const { container } = render(
      <Sparkline
        points={[
          { at: T0 - 60_000, value: 5 },
          { at: T0, value: 5 },
        ]}
        now={T0}
        label="测试"
        format={formatCount}
      />,
    )
    const d = container.querySelector('path')!.getAttribute('d')!
    // T0-60s → x=80，不依赖首尾点位置
    expect(d).toMatch(/^M80\.00,[\d.]+ L100\.00,[\d.]+$/)
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
    // 基线带纳入绘图域 [0,10]（pad 0.8）
    expect(container.querySelector('path')!.getAttribute('d')).toBe(
      'M0.00,67.24 L100.00,32.76',
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

  it('非有限时间点被过滤', () => {
    const { container } = render(
      <Sparkline
        points={[
          { at: Number.NaN, value: 1 },
          { at: T0, value: Number.POSITIVE_INFINITY },
          { at: T0 - 10_000, value: 3 },
          { at: T0, value: 5 },
        ]}
        now={T0}
        label="测试"
        format={formatCount}
      />,
    )
    const path = container.querySelector('path')!
    expect(path.getAttribute('d')).not.toContain('NaN')
    const summary = screen.getByText(/最近 5 分钟趋势/).textContent!
    expect(summary).toContain('当前 5')
    expect(summary).toContain('最低 3')
  })

  it('水平直线不产生非法几何', () => {
    const { container } = render(
      <Sparkline
        points={[
          { at: T0 - 10_000, value: 0 },
          { at: T0, value: 0 },
        ]}
        now={T0}
        label="测试"
        format={formatCount}
      />,
    )
    const d = container.querySelector('path')!.getAttribute('d')!
    expect(d).not.toContain('NaN')
    expect(d).not.toContain('Infinity')
  })
})

describe('Sparkline 阈值与越界分段', () => {
  const pts = (vals: Array<[number, number]>) =>
    vals.map(([dt, v]) => ({ at: T0 - dt, value: v }))

  it('画给定阈值虚线并按 sev 分 class', () => {
    const { container } = render(
      <Sparkline
        points={pts([[10_000, 1], [0, 2]])}
        now={T0}
        label="测试"
        format={formatCount}
        thresholds={[
          { value: 5, sev: 'warn', direction: 'above' },
          { value: 9, sev: 'critical', direction: 'above' },
        ]}
      />,
    )
    const lines = container.querySelectorAll('line[data-threshold]')
    expect(lines).toHaveLength(2)
    expect(lines[0]!.getAttribute('data-threshold')).toBe('warn')
    expect(lines[1]!.getAttribute('data-threshold')).toBe('critical')
  })

  it('above 阈值：只有越界线段着色，正常段保持中性', () => {
    const { container } = render(
      <Sparkline
        points={pts([[120_000, 2], [60_000, 8], [0, 6]])}
        now={T0}
        label="测试"
        format={formatCount}
        thresholds={[{ value: 5, sev: 'warn', direction: 'above' }]}
      />,
    )
    expect(container.querySelector('path[data-out-of-range="warn"]')).toBeTruthy()
    expect(container.querySelector('path[data-out-of-range="critical"]')).toBeNull()
    // 正常段（v2→交点）仍在 segNormal 里
    const normal = [...container.querySelectorAll('path')].find(
      (p) => !p.getAttribute('data-out-of-range'),
    )!
    expect(normal.getAttribute('d')!.length).toBeGreaterThan(0)
  })

  it('below 方向阈值（电池类）：低于线才告警', () => {
    const { container } = render(
      <Sparkline
        points={pts([[120_000, 20], [0, 3]])}
        now={T0}
        label="测试"
        format={formatCount}
        thresholds={[{ value: 15, sev: 'critical', direction: 'below' }]}
      />,
    )
    expect(container.querySelector('path[data-out-of-range="critical"]')).toBeTruthy()
  })

  it('未提供阈值时全部段保持中性', () => {
    const { container } = render(
      <Sparkline
        points={pts([[120_000, 95], [0, 99]])}
        now={T0}
        label="测试"
        format={formatPercent}
      />,
    )
    expect(container.querySelector('path[data-out-of-range]')).toBeNull()
    expect(container.querySelectorAll('line[data-threshold]')).toHaveLength(0)
  })
})

describe('Sparkline 展开大图', () => {
  const fmt1 = (v: number) => v.toFixed(1)

  it('展开图有 -5分钟/现在 坐标', () => {
    render(
      <Sparkline
        expanded
        points={[
          { at: T0 - 60_000, value: 3 },
          { at: T0, value: 9 },
        ]}
        now={T0}
        label="测试"
        format={fmt1}
      />,
    )
    expect(screen.getByText('-5 分钟')).toBeTruthy()
    expect(screen.getByText('现在')).toBeTruthy()
  })

  it('y 轴标注真实绘图域（数据+基线+padding），非裸数据极值', () => {
    const { container } = render(
      <Sparkline
        expanded
        points={[
          { at: T0 - 60_000, value: 3 },
          { at: T0, value: 7 },
        ]}
        now={T0}
        label="测试"
        format={fmt1}
        baseline={{ low: 0, high: 10 }}
      />,
    )
    // 数据 [3,7] + 基线 [0,10] → 域 [0,10]，pad 0.8 → [-0.8, 10.8]
    const yMax = container.querySelector('[class*="axisYMax"]')!
    const yMin = container.querySelector('[class*="axisYMin"]')!
    expect(yMax.textContent).toBe('10.8')
    expect(yMin.textContent).toBe('-0.8')
    // 无障碍极值仍只报数据值
    const summary = screen.getByText(/最近 5 分钟趋势/).textContent!
    expect(summary).toContain('最高 7.0')
    expect(summary).toContain('最低 3.0')
  })

  it('阈值标注在绘图容器内按真实域定位，x 轴在容器外', () => {
    const { container } = render(
      <Sparkline
        expanded
        points={[
          { at: T0 - 60_000, value: 3 },
          { at: T0, value: 7 },
        ]}
        now={T0}
        label="测试"
        format={fmt1}
        baseline={{ low: 0, high: 10 }}
        thresholds={[{ value: 8, sev: 'warn', direction: 'above' }]}
      />,
    )
    const label = container.querySelector('[class*="thrLabel"]') as HTMLElement
    expect(label).toBeTruthy()
    // 域 [-0.8,10.8]：yOf(8) = (1 - 8.8/11.6) * 100 ≈ 24.14%
    expect(Number.parseFloat(label.style.top)).toBeCloseTo(24.14, 1)
    expect(label.closest('[class*="chartPlot"]')).toBeTruthy()
    const axisX = container.querySelector('[class*="axisX"]')!
    expect(axisX.closest('[class*="chartPlot"]')).toBeNull()
  })
})
