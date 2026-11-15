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
import { formatPercent, formatRate } from '../../src/format'
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

const ins = (o: Partial<MetricInsight>): MetricInsight => ({
  sources: [],
  triggered: [],
  ...o,
})

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

  it('insight 无 currentEta 时不从事件 detail 推导见底时间', () => {
    const m = makeScenario('rapid-change')
    for (const key of Object.keys(m.insights ?? {})) {
      delete m.insights![key as keyof typeof m.insights]!.currentEta
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
  it('单位表与既有底线方向；tokens 底线按窗口计算', () => {
    expect(metricUnit('memory')).toBe('ratio')
    expect(metricUnit('tokens')).toBe('tokens')
    expect(metricUnit('networkRx')).toBe('bytes/s')
    expect(defaultFloors('battery')!.every((t) => t.direction === 'below')).toBe(true)
    expect(defaultFloors('cpu')!.map((t) => t.value)).toEqual([0.75, 0.9])
    // 网络/processRss 无既有底线；tokens 无窗口无底线
    expect(defaultFloors('networkRx')).toBeNull()
    expect(defaultFloors('processRss')).toBeNull()
    expect(defaultFloors('tokens')).toBeNull()
    expect(defaultFloors('tokens', 100_000)!.map((x) => x.value)).toEqual([85_000, 95_000])
  })

  it('宿主 floor 优先；floor 单位不符阻断默认回退且不画线', () => {
    const c = chartThresholds('cpu', ins({
      thresholds: { floor: { value: 0.7, source: 'host-floor' } },
    }))
    expect(c.source).toBe('supplied')
    expect(c.lines[0]!.value).toBe(0.7)
    // 单位不符：不画 floor 线、不回退默认底线，其余层仍画线
    expect(
      chartThresholds('cpu', ins({ thresholds: { floor: { value: 7, source: 'x', unit: 'count' } } })).lines,
    ).toHaveLength(0)
    expect(
      chartThresholds('cpu', ins({
        thresholds: {
          floor: { value: 7, source: 'x', unit: 'count' },
          rate: { value: 0.6, source: 'h' },
        },
      })).lines.map((l) => l.label),
    ).toEqual(['变化率'])
  })

  it('宿主 floor：电池方向 below；supplied 线严重度取 effectiveSeverity', () => {
    const supplied = ins({
      severity: 'critical',
      sources: ['floor'],
      thresholds: { floor: { value: 15, source: 'host-floor' } },
    })
    expect(chartThresholds('battery', supplied).lines).toEqual([
      { value: 15, sev: 'critical', direction: 'below', label: '底线' },
    ])
    const cpu = chartThresholds('cpu', supplied)
    expect([cpu.lines[0]!.direction, cpu.lines[0]!.sev]).toEqual(['above', 'critical'])
    // 无 severity 的 supplied 线缺省 warn
    expect(
      chartThresholds('cpu', ins({ thresholds: { floor: { value: 0.7, source: 'x' } } })).lines[0]!.sev,
    ).toBe('warn')
  })

  it('收集全部可比较的 floor/rate/baseline 线并标注层名', () => {
    const i = ins({
      triggered: ['rate'],
      thresholds: {
        floor: { value: 0.7, source: 'h1' },
        rate: { value: 0.6, source: 'h2' },
        baseline: { value: 0.5, source: 'h3' },
      },
    })
    const c = chartThresholds('cpu', i)
    expect(c.lines.map((l) => [l.value, l.label, l.sev])).toEqual([
      [0.7, '底线', 'warn'],
      [0.6, '变化率', 'warn'],
      [0.5, '基线', 'warn'],
    ])
  })

  it('无 supplied floor 时保留默认显示底线，rate/baseline 线共存', () => {
    const i = ins({ thresholds: { rate: { value: 0.6, source: 'h' } } })
    const c = chartThresholds('cpu', i)
    expect(c.lines).toHaveLength(3)
    expect(c.lines.filter((l) => l.label === '显示底线')).toHaveLength(2)
    expect(c.lines[0]!.label).toBe('变化率')
  })

  it('rate 层显式导数单位与绘制单位不符 → 只进明细文本', () => {
    const i = ins({ thresholds: { rate: { value: 5, source: 'h', unit: 'bytes/min' } } })
    expect(chartThresholds('memory', i).lines.every((l) => l.label !== '变化率')).toBe(true)
    expect(thresholdRowText('memory', 'rate', i, undefined, formatPercent)).toContain('/分')
  })

  it('网络单位升级为 bytes/s：supplied bytes/s 可画线，旧 bytes 标注兼容为 B/s', () => {
    expect(metricUnit('networkRx')).toBe('bytes/s')
    const bps = ins({ thresholds: { rate: { value: 1e6, source: 'h', unit: 'bytes/s' } } })
    expect(chartThresholds('networkRx', bps).lines).toHaveLength(1)
    const legacy = ins({ thresholds: { rate: { value: 1e6, source: 'h', unit: 'bytes' } } })
    expect(chartThresholds('networkRx', legacy).lines).toHaveLength(1)
    // 兼容文本仍按 B/s 呈现
    expect(
      thresholdRowText('networkRx', 'rate', legacy, undefined, formatRate),
    ).toContain('/s')
    // 真正不符的单位（如 count）不可画线
    const bad = ins({ thresholds: { rate: { value: 1e6, source: 'h', unit: 'count' } } })
    expect(chartThresholds('networkRx', bad).lines).toHaveLength(0)
  })

  it('明细行：默认底线命名「显示底线」，未提供层明示未提供', () => {
    expect(thresholdRowText('cpu', 'floor', undefined, undefined, formatPercent)).toContain('显示底线')
    expect(thresholdRowText('cpu', 'rate', undefined, undefined, formatPercent)).toBe('未提供')
    expect(thresholdRowText('cpu', 'baseline', undefined, undefined, formatPercent)).toBe('未提供')
    expect(thresholdRowText('networkRx', 'floor', undefined, undefined, formatPercent)).toBe('未提供')
  })
})

describe('attentionLine 宿主 currentEta 投影', () => {
  type M = ReturnType<typeof makeScenario>
  const setEta = (m: M, over: Partial<NonNullable<MetricInsight['currentEta']>>) => {
    m.insights = {
      ...m.insights,
      'disk:/': { ...m.insights!['disk:/']!, currentEta: { ...m.insights!['disk:/']!.currentEta!, ...over } },
    }
  }
  const line = (m: M) => attentionLine(m, evaluateBody(m.state.self.body, m.now, m.insights))
  // 去掉场景自带的 disk:/ rate 事件（否则它比新 asOf 更新而失效投影）
  const noRateEvents = (m: M) => (
    (m.events = m.events.filter((e) => e.detail?.kind !== 'body.rate')), m
  )

  it('新鲜有效投影 → N 分钟后见底', () => {
    expect(line(makeScenario('rapid-change'))).toBe('磁盘 9 分钟后见底')
  })

  it.each([
    { ratePerMinute: 0 },
    { ratePerMinute: 2.1 * 1024 ** 3 }, // 磁盘方向反转
    { asOf: T0 + 1 },
    { sampleIntervalMs: 0 },
    { sampleIntervalMs: Number.NaN },
    { timeToThresholdMs: undefined },
    { timeToThresholdMs: -1 },
    { timeToThresholdMs: Number.NaN },
    { timeToThresholdMs: 8 * 24 * 3600_000 }, // >7 天抑制
  ] as const)('无效投影字段 → 无倒计时 %j', (over) => {
    const m = noRateEvents(makeScenario('rapid-change'))
    setEta(m, over as Partial<NonNullable<MetricInsight['currentEta']>>)
    expect(line(m)).toBeNull()
  })

  it('asOf 恰在 2× 间隔边界仍有效；超过即失效', () => {
    const m = noRateEvents(makeScenario('rapid-change'))
    setEta(m, { asOf: T0 - 10_000, sampleIntervalMs: 5_000 })
    expect(line(m)).toBe('磁盘 9 分钟后见底')
    setEta(m, { asOf: T0 - 10_001 })
    expect(line(m)).toBeNull()
  })

  it.each([
    { desc: '无 ETA（timeToFloorMs 缺省）', over: { timeToFloorMs: undefined } },
    { desc: '零速率', over: { delta: 0 } },
    { desc: '反向速率', over: { delta: 2.1 * 1024 ** 3 } },
  ] as const)('更新的匹配 body.rate 信号（$desc）使旧投影失效', ({ over }) => {
    const m = makeScenario('rapid-change')
    // 事件晚于 asOf 一个间隔以上但仍在 2× 间隔新鲜度内
    setEta(m, { asOf: T0 - 10_000, sampleIntervalMs: 5_000 })
    m.events = [...m.events, rateEvent(over as Partial<NonNullable<SenseEvent['detail']>>, T0 - 1_000)]
    expect(line(m)).toBeNull()
  })

  it('耗尽类说见底/其余说触及阈值；上行反向速率 → 无投影', () => {
    const cpuEta = (ratePerMinute: number) => {
      const m = makeScenario('rapid-change')
      m.state.self.body.cpu = fact({ usage: 0.95, perCore: [], load1: 0, load5: 0, load15: 0 })
      m.insights = {
        ...m.insights,
        cpu: ins({
          triggered: ['rate'],
          severity: 'critical',
          currentEta: { asOf: T0, sampleIntervalMs: 5_000, timeToThresholdMs: 3 * 60_000, ratePerMinute },
        }),
      }
      return m
    }
    expect(line(cpuEta(0.1))).toBe('CPU 3 分钟后触及阈值')
    expect(line(cpuEta(-0.1))).toBeNull()
  })
})
