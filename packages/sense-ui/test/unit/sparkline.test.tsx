import { describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach } from 'vitest'
import { Sparkline, sampleHistory } from '../../src/sparkline'
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

describe('sampleHistory 降采样', () => {
  const big = () =>
    Array.from({ length: 200_000 }, (_, i) => ({
      at: T0 - 300_000 + Math.floor((i * 299_999) / 199_999),
      value: i === 12_345 ? -50 : i === 150_000 ? 999 : 10 + Math.sin(i / 400),
    }))

  it('200,000 点 → ≤240，保留首末端点与全局极值，不抛错', () => {
    const pts = big()
    const t0 = performance.now()
    const out = sampleHistory(pts, T0)
    expect(performance.now() - t0).toBeLessThan(50)
    expect(out.length).toBeLessThanOrEqual(240)
    expect(out[0]!.at).toBe(pts[0]!.at)
    expect(out[out.length - 1]!.at).toBe(pts[199_999]!.at)
    let mn = Infinity
    let mx = -Infinity
    for (const p of out) { if (p.value < mn) mn = p.value; if (p.value > mx) mx = p.value }
    expect([mn, mx]).toEqual([-50, 999])
  })

  it('≤240 点：完整保留并按时间排序，窗外观测点被过滤', () => {
    const pts = [
      { at: T0 - 10_000, value: 3 },
      { at: T0, value: 5 },
      { at: T0 - 20_000, value: 1 },
      { at: T0 + 1, value: 99 },
    ]
    expect(sampleHistory(pts, T0).map((p) => p.value)).toEqual([1, 3, 5])
  })

  it('200,000 点整图渲染 <50ms（夹具分配不计时）', () => {
    const pts = big()
    const t0 = performance.now()
    const { container } = render(
      <Sparkline points={pts} now={T0} label="压力" format={formatCount} />,
    )
    console.log(`[sparkline-200k] render ${(performance.now() - t0).toFixed(1)}ms`)
    expect(performance.now() - t0).toBeLessThan(50)
    const d = container.querySelector('path')!.getAttribute('d')!
    expect(d.split('L').length).toBeLessThanOrEqual(240)
  })
})

describe('当前状态与阈值边界', () => {
  const twoPts = [{ at: T0 - 10_000, value: 1 }, { at: T0, value: 2 }]

  it.each([
    ['warn', '注意'],
    ['critical', '紧急'],
  ] as const)('%s：末点状态标记 + 无障碍摘要含当前状态', (sev, word) => {
    const { container } = render(
      <Sparkline points={twoPts} now={T0} label="测试" format={formatCount} severity={sev} />,
    )
    expect(container.querySelector(`circle[data-current="${sev}"]`)).toBeTruthy()
    expect(screen.getByText(/最近 5 分钟趋势/).textContent).toContain(word)
  })

  it('值恰等于阈值判为越界（与状态比较 ≥/≤ 一致）', () => {
    const { container } = render(
      <Sparkline
        points={[{ at: T0 - 10_000, value: 5 }, { at: T0, value: 5 }]}
        now={T0}
        label="测试"
        format={formatCount}
        thresholds={[{ value: 5, sev: 'warn', direction: 'above' }]}
      />,
    )
    expect(container.querySelector('path[data-out-of-range="warn"]')).toBeTruthy()
  })
})

describe('展开图多阈值标注间距', () => {
  it('贴近的多条标注按 ≥13px/110px 间隔排开、夹在图内且含层名', () => {
    const { container } = render(
      <Sparkline
        expanded
        points={[{ at: T0 - 60_000, value: 3 }, { at: T0, value: 7 }]}
        now={T0}
        label="测试"
        format={(v) => v.toFixed(1)}
        thresholds={[
          { value: 8.0, sev: 'warn', direction: 'above', label: '底线' },
          { value: 8.2, sev: 'warn', direction: 'above', label: '变化率' },
          { value: 8.4, sev: 'critical', direction: 'above', label: '基线' },
        ]}
      />,
    )
    const labels = [...container.querySelectorAll<HTMLElement>('[class*="thrLabel"]')]
    expect(labels).toHaveLength(3)
    const tops = labels.map((l) => Number.parseFloat(l.style.top)).sort((a, b) => a - b)
    for (let i = 1; i < tops.length; i++) {
      expect(tops[i]! - tops[i - 1]!).toBeGreaterThanOrEqual(11.5)
    }
    for (const t of tops) { expect(t).toBeGreaterThanOrEqual(0); expect(t).toBeLessThanOrEqual(100) }
    const joined = labels.map((l) => l.textContent).join(' ')
    for (const w of ['底线', '变化率', '基线']) expect(joined).toContain(w)
  })
})
