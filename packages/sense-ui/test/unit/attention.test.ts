import { describe, expect, it } from 'vitest'
import { attentionLine } from '../../src/attention'
import { evaluateBody } from '../../src/health'
import { rateBadge } from '../../src/sections/disk-rows'
import {
  chartThresholds,
  defaultFloors,
  metricUnit,
  thresholdRowText,
} from '../../src/thresholds'
import { formatPercent } from '../../src/format'
import { makeScenario } from '../../src/mock/scenarios'
import { fact, makeBody, makeEvent, makeState, T0 } from '../../src/mock/fixtures'
import type { MetricInsight, SenseEvent } from '../../src/view-model'

function rateEvent(over: Partial<NonNullable<SenseEvent['detail']>> = {}, at = T0 - 4_000) {
  const e = makeEvent(1, {
    level: 'wake',
    detail: {
      kind: 'body.rate',
      metric: 'disk:/',
      windowMs: 60_000,
      delta: -2.1 * 1024 ** 3,
      unit: 'bytes',
      timeToFloorMs: 9 * 60_000,
      ...(over as object),
    } as SenseEvent['detail'],
  })
  e.signal.at = at
  return e
}

describe('attentionLine 严重度优先', () => {
  it('rapid-change：磁盘投影给出见底分钟', () => {
    const m = makeScenario('rapid-change')
    const ev = evaluateBody(m.state.self.body, m.now, m.insights)
    expect(attentionLine(m, ev)).toBe('磁盘 9 分钟后见底')
  })

  it('critical 内存不会被 warn 磁盘事件掩盖', () => {
    const m = makeScenario('rapid-change')
    const body = makeBody()
    body.memory = fact({ total: 32e9, used: 31e9, pressure: 'normal', swapUsed: 0 })
    m.state = makeState({ self: { ...m.state.self, body } })
    const ev = evaluateBody(m.state.self.body, m.now, m.insights)
    expect(ev.severity).toBe('critical')
    // 最差行是 memory，磁盘事件不匹配 → 回退 evaluateBody 句子
    expect(attentionLine(m, ev)).toBeNull()
    expect(ev.sentence).toBe('内存紧张')
  })

  it('事件超出 5 分钟窗口不参与', () => {
    const m = makeScenario('rapid-change')
    for (const e of m.events) {
      if (e.detail?.kind === 'body.rate') e.signal.at = T0 - 400_000
    }
    const ev = evaluateBody(m.state.self.body, m.now, m.insights)
    expect(attentionLine(m, ev)).toBeNull()
  })

  it('无 timeToFloorMs 的事件不编造见底时间', () => {
    const m = makeScenario('rapid-change')
    for (const e of m.events) {
      if (e.detail?.kind === 'body.rate') delete e.detail.timeToFloorMs
    }
    const ev = evaluateBody(m.state.self.body, m.now, m.insights)
    expect(attentionLine(m, ev)).toBeNull()
  })

  it('全部良好时不产生警示行', () => {
    const m = makeScenario('healthy')
    const ev = evaluateBody(m.state.self.body, m.now, m.insights)
    expect(attentionLine(m, ev)).toBeNull()
  })
})

describe('rateBadge 过滤', () => {
  const base = [rateEvent()]

  it('有效速率事件给出每分变化徽标', () => {
    const text = rateBadge('disk:/', base, T0)!
    expect(text).toContain('/分')
    expect(text).toContain('GB')
  })

  it('未来/过旧/零窗口/非有限 delta 一律忽略', () => {
    expect(rateBadge('disk:/', [rateEvent({}, T0 + 1)], T0)).toBeUndefined()
    expect(rateBadge('disk:/', [rateEvent({}, T0 - 300_001)], T0)).toBeUndefined()
    expect(rateBadge('disk:/', [rateEvent({ windowMs: 0 })], T0)).toBeUndefined()
    expect(
      rateBadge('disk:/', [rateEvent({ delta: Number.NaN })], T0),
    ).toBeUndefined()
  })

  it('指标不匹配不产出徽标', () => {
    expect(rateBadge('cpu', base, T0)).toBeUndefined()
  })
})

describe('阈值解析', () => {
  it('单位表与既有底线方向', () => {
    expect(metricUnit('memory')).toBe('ratio')
    expect(metricUnit('tokens')).toBe('tokens')
    expect(metricUnit('networkRx')).toBe('bytes')
    const batt = defaultFloors('battery')!
    expect(batt.every((t) => t.direction === 'below')).toBe(true)
    expect(defaultFloors('cpu')!.map((t) => t.value)).toEqual([0.75, 0.9])
    // 网络/processRss 无既有底线
    expect(defaultFloors('networkRx')).toBeNull()
    expect(defaultFloors('processRss')).toBeNull()
  })

  it('tokens 底线按窗口计算，窗口缺失则无底线', () => {
    const t = defaultFloors('tokens', 100_000)!
    expect(t.map((x) => x.value)).toEqual([85_000, 95_000])
    expect(defaultFloors('tokens')).toBeNull()
  })

  it('宿主 floor 优先；显式单位不符时不画线', () => {
    const supplied: MetricInsight = {
      sources: ['floor'],
      triggered: [],
      thresholds: { floor: { value: 0.7, source: 'host-floor' } },
    }
    const c = chartThresholds('cpu', supplied)
    expect(c.source).toBe('supplied')
    expect(c.lines[0]!.value).toBe(0.7)

    const mismatched: MetricInsight = {
      sources: ['floor'],
      triggered: [],
      thresholds: { floor: { value: 7, source: 'x', unit: 'count' } },
    }
    expect(chartThresholds('cpu', mismatched).lines).toHaveLength(0)
  })

  it('宿主 floor：电池方向 below、单条阈值恒为 warn（不随当前 insight 严重度变 critical）', () => {
    const supplied: MetricInsight = {
      severity: 'critical',
      sources: ['floor'],
      triggered: [],
      thresholds: { floor: { value: 15, source: 'host-floor' } },
    }
    const c = chartThresholds('battery', supplied)
    expect(c.source).toBe('supplied')
    expect(c.lines).toEqual([
      { value: 15, sev: 'warn', direction: 'below' },
    ])
    // 其余指标仍是 above
    const cpu = chartThresholds('cpu', supplied)
    expect(cpu.lines[0]!.direction).toBe('above')
    expect(cpu.lines[0]!.sev).toBe('warn')
  })

  it('明细行：默认底线命名「显示底线」，未提供层明示未提供', () => {
    expect(thresholdRowText('cpu', 'floor', undefined, undefined, formatPercent)).toContain('显示底线')
    expect(thresholdRowText('cpu', 'rate', undefined, undefined, formatPercent)).toBe('未提供')
    expect(thresholdRowText('cpu', 'baseline', undefined, undefined, formatPercent)).toBe('未提供')
    expect(thresholdRowText('networkRx', 'floor', undefined, undefined, formatPercent)).toBe('未提供')
  })
})
