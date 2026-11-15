import { describe, expect, it } from 'vitest'
import { effectiveSeverity, effectiveStatus, evaluateBody } from '../../src/health'
import { T0, emptyFact, fact, makeBody } from '../../src/mock/fixtures'
import type { Body } from '../../src/view-model'

function bodyWith(patch: Partial<Body>): Body {
  return { ...makeBody(), ...patch }
}

describe('effectiveStatus', () => {
  it('ok 且未超 TTL 保持 ok', () => {
    expect(effectiveStatus(fact(1, { ageMs: 4_000, ttlMs: 5_000 }), T0)).toBe('ok')
  })
  it('ok 但超过 TTL 记为 stale', () => {
    expect(effectiveStatus(fact(1, { ageMs: 6_000, ttlMs: 5_000 }), T0)).toBe('stale')
  })
  it('恰好等于 TTL 不算过期', () => {
    expect(effectiveStatus(fact(1, { ageMs: 5_000, ttlMs: 5_000 }), T0)).toBe('ok')
  })
  it('denied 不受 TTL 影响', () => {
    const f = fact<number>(null, { status: 'denied', ageMs: 99_000, ttlMs: 1_000 })
    expect(effectiveStatus(f, T0)).toBe('denied')
  })
})

describe('单项阈值', () => {
  const sev = (b: Body) => evaluateBody(b, T0)

  it('CPU 边界：0.74 good / 0.75 warn / 0.9 critical', () => {
    const cpu = (usage: number) =>
      bodyWith({ cpu: fact({ usage, perCore: [], load1: 0, load5: 0, load15: 0 }) })
    expect(sev(cpu(0.74)).rows.cpu.severity).toBe('good')
    expect(sev(cpu(0.75)).rows.cpu.severity).toBe('warn')
    expect(sev(cpu(0.89)).rows.cpu.severity).toBe('warn')
    expect(sev(cpu(0.9)).rows.cpu.severity).toBe('critical')
  })

  it('内存：pressure 优先于用量比例', () => {
    const mem = (pressure: 'normal' | 'warn' | 'critical', used: number, total = 32e9) =>
      bodyWith({ memory: fact({ total, used, pressure, swapUsed: 0 }) })
    expect(sev(mem('warn', 1e9)).rows.memory.severity).toBe('warn')
    expect(sev(mem('critical', 1e9)).rows.memory.severity).toBe('critical')
    expect(sev(mem('normal', 0.86 * 32e9)).rows.memory.severity).toBe('warn')
    expect(sev(mem('normal', 0.96 * 32e9)).rows.memory.severity).toBe('critical')
    expect(sev(mem('normal', 0.84 * 32e9)).rows.memory.severity).toBe('good')
  })

  it('磁盘：free/total <=10% warn，<=5% critical', () => {
    const disk = (freeRatio: number) =>
      bodyWith({
        disks: fact([{ mount: '/', total: 100e9, free: freeRatio * 100e9 }]),
      })
    expect(sev(disk(0.11)).rows.disks.severity).toBe('good')
    expect(sev(disk(0.1)).rows.disks.severity).toBe('warn')
    expect(sev(disk(0.05)).rows.disks.severity).toBe('critical')
    expect(sev(disk(0.01)).rows.disks.severity).toBe('critical')
  })

  it('电池：未充电 <=15 warn <=5 critical；充电豁免', () => {
    const bat = (percent: number, charging: boolean) =>
      bodyWith({ battery: fact({ percent, charging }) })
    expect(sev(bat(16, false)).rows.battery.severity).toBe('good')
    expect(sev(bat(15, false)).rows.battery.severity).toBe('warn')
    expect(sev(bat(5, false)).rows.battery.severity).toBe('critical')
    expect(sev(bat(3, true)).rows.battery.severity).toBe('good')
  })

  it('电池为 null 且 ok：行隐藏且不算缺失', () => {
    const r = sev(bodyWith({ battery: fact(null) }))
    expect(r.rows.battery.hidden).toBe(true)
    expect(r.severity).toBe('good')
  })

  it('电池 denied：不隐藏且计入缺失', () => {
    const r = sev(
      bodyWith({ battery: emptyFact('denied', '未授权') }),
    )
    expect(r.rows.battery.hidden).toBe(false)
    expect(r.severity).toBe('unknown')
    expect(r.sentence).toBe('数据待补全')
  })

  it('温控与网络', () => {
    expect(sev(bodyWith({ thermal: fact('nominal') })).rows.thermal.severity).toBe('good')
    expect(sev(bodyWith({ thermal: fact('fair') })).rows.thermal.severity).toBe('warn')
    expect(sev(bodyWith({ thermal: fact('serious') })).rows.thermal.severity).toBe('warn')
    expect(sev(bodyWith({ thermal: fact('critical') })).rows.thermal.severity).toBe('critical')
    expect(
      sev(bodyWith({ network: fact({ online: false, rxBps: 0, txBps: 0 }) })).rows
        .network.severity,
    ).toBe('warn')
  })

  it('DSH 进程与 token 上下文', () => {
    const proc = (cpu: number) =>
      bodyWith({ harnessProcess: fact({ rss: 1e9, cpu, uptimeSec: 10 }) })
    expect(sev(proc(0.75)).rows.process.severity).toBe('warn')
    expect(sev(proc(0.9)).rows.process.severity).toBe('critical')

    const tok = (used: number, window = 100_000) =>
      bodyWith({
        tokens: fact({
          contextWindow: window,
          contextUsed: used,
          sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }),
      })
    expect(sev(tok(84_999)).rows.tokens.severity).toBe('good')
    expect(sev(tok(85_000)).rows.tokens.severity).toBe('warn')
    expect(sev(tok(95_000)).rows.tokens.severity).toBe('critical')
  })

  it('token 缺 contextWindow/contextUsed 记为 unknown', () => {
    const b = bodyWith({
      tokens: fact({
        sessionUsage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      }),
    })
    const r = sev(b)
    expect(r.rows.tokens.severity).toBe('unknown')
    expect(r.severity).toBe('unknown')
  })
})

describe('聚合健康度', () => {
  it('全部 ok → good / 状态良好', () => {
    const r = evaluateBody(makeBody(), T0)
    expect(r.severity).toBe('good')
    expect(r.sentence).toBe('状态良好')
  })

  it('最差项胜出并按稳定优先级取句子（memory 先于 cpu）', () => {
    const b = bodyWith({
      memory: fact({ total: 32e9, used: 30e9, pressure: 'warn', swapUsed: 0 }),
      cpu: fact({ usage: 0.8, perCore: [], load1: 0, load5: 0, load15: 0 }),
    })
    const r = evaluateBody(b, T0)
    expect(r.severity).toBe('warn')
    expect(r.sentence).toBe('内存紧张')
  })

  it('critical 优先于 warn，句子取对应行', () => {
    const b = bodyWith({
      cpu: fact({ usage: 0.95, perCore: [], load1: 0, load5: 0, load15: 0 }),
      memory: fact({ total: 32e9, used: 29e9, pressure: 'warn', swapUsed: 0 }),
    })
    const r = evaluateBody(b, T0)
    expect(r.severity).toBe('critical')
    expect(r.sentence).toBe('CPU 负载较高')
  })

  it('有缺失且无 warn/critical → unknown / 数据待补全', () => {
    const b = bodyWith({ thermal: emptyFact('unavailable') })
    const r = evaluateBody(b, T0)
    expect(r.severity).toBe('unknown')
    expect(r.sentence).toBe('数据待补全')
  })

  it('有缺失但有 warn → 仍报 warn', () => {
    const b = bodyWith({
      thermal: emptyFact('unavailable'),
      network: fact({ online: false, rxBps: 0, txBps: 0 }),
    })
    const r = evaluateBody(b, T0)
    expect(r.severity).toBe('warn')
    expect(r.sentence).toBe('网络已断开')
  })

  it('ok 但过期的 CPU 参与聚合时按缺失处理', () => {
    const b = bodyWith({
      cpu: fact(
        { usage: 0.99, perCore: [], load1: 0, load5: 0, load15: 0 },
        { ageMs: 60_000, ttlMs: 5_000 },
      ),
    })
    const r = evaluateBody(b, T0)
    expect(r.rows.cpu.severity).toBe('unknown')
    expect(r.severity).toBe('unknown')
  })
})

describe('内存 max(pressure, ratio) 与 insight 合并', () => {
  it('pressure warn + 占用 96% → critical', () => {
    const b = bodyWith({
      memory: fact({ total: 32e9, used: 30.8e9, pressure: 'warn', swapUsed: 0 }),
    })
    const r = evaluateBody(b, T0)
    expect(r.rows.memory.severity).toBe('critical')
    expect(r.severity).toBe('critical')
  })

  it('pressure normal + 占用 86% → warn', () => {
    const b = bodyWith({
      memory: fact({ total: 32e9, used: 27.6e9, pressure: 'normal', swapUsed: 0 }),
    })
    expect(evaluateBody(b, T0).rows.memory.severity).toBe('warn')
  })

  it('新鲜事实并入 insight 严重度（cpu good + insight critical → critical）', () => {
    const b = makeBody()
    const r = evaluateBody(b, T0, {
      cpu: { sources: ['rate'], triggered: ['rate'], severity: 'critical' },
    })
    expect(r.rows.cpu.severity).toBe('critical')
    expect(r.severity).toBe('critical')
    expect(r.sentence).toBe('CPU 负载较高')
  })

  it('denied/stale 事实不并入 insight（不假装当前）', () => {
    const b = bodyWith({ cpu: emptyFact('denied', '未授权') })
    const r = evaluateBody(b, T0, {
      cpu: { sources: ['rate'], triggered: ['rate'], severity: 'critical' },
    })
    expect(r.rows.cpu.severity).toBe('unknown')
    expect(r.severity).toBe('unknown')
  })

  it('networkTx insight 映射到网络行，disk:${mount} 映射到对应盘', () => {
    const b = makeBody()
    const r = evaluateBody(b, T0, {
      networkTx: { sources: ['rate'], triggered: ['rate'], severity: 'warn' },
      'disk:/demo/vol': { sources: ['floor'], triggered: ['floor'], severity: 'critical' },
    })
    expect(r.rows.network.severity).toBe('warn')
    expect(r.rows.disks.severity).toBe('critical')
    expect(r.severity).toBe('critical')
    expect(r.sentence).toBe('磁盘空间不足')
  })

  it('无 insight 参数时行为与原来一致', () => {
    expect(evaluateBody(makeBody(), T0).severity).toBe('good')
    expect(evaluateBody(makeBody(), T0, {}).severity).toBe('good')
  })

  it('在线状态下网络 insight 告警报"网络流量异常"而非"已断开"', () => {
    const r = evaluateBody(makeBody(), T0, {
      networkRx: { sources: ['baseline'], triggered: ['baseline'], severity: 'warn' },
    })
    expect(r.severity).toBe('warn')
    expect(r.sentence).toBe('网络流量异常')
  })
})

describe('effectiveSeverity：宿主触发缺省严重度', () => {
  it('triggered 无 severity → warn；空 triggered → good；severity 优先', () => {
    expect(effectiveSeverity({ sources: ['floor'], triggered: ['floor'] })).toBe('warn')
    expect(effectiveSeverity({ sources: ['floor'], triggered: [] })).toBe('good')
    expect(effectiveSeverity({ sources: ['rate'], triggered: ['rate'], severity: 'critical' })).toBe('critical')
    expect(effectiveSeverity(undefined)).toBe('good')
  })

  it.each(['floor', 'rate', 'baseline'] as const)(
    '%s 层 triggered 无 severity 的 insight 并入为 warn（不会显示为良好）',
    (layer) => {
      const r = evaluateBody(makeBody(), T0, {
        cpu: { sources: [layer], triggered: [layer] },
      })
      expect(r.rows.cpu.severity).toBe('warn')
      expect(r.severity).toBe('warn')
      expect(r.sentence).toBe('CPU 负载较高')
    },
  )
})

describe('磁盘有效性', () => {
  const critInsight: import('../../src/view-model').MetricInsight = {
    sources: ['floor'], triggered: ['floor'], severity: 'critical',
  }

  it.each([
    { disks: [] as { mount: string; total: number; free: number }[], sev: 'unknown' },
    { disks: [{ mount: '/', total: 0, free: 5e9 }, { mount: '/x', total: -1, free: 1e9 }], sev: 'unknown' },
  ])('空/全无效列表 → $sev 而非 good', ({ disks, sev }) => {
    const r = evaluateBody(bodyWith({ disks: fact(disks) }), T0)
    expect(r.rows.disks.severity).toBe(sev)
    expect(r.severity).toBe('unknown')
  })

  it('无效条目不参与极值/聚合；有效盘照常告警', () => {
    const r = evaluateBody(
      bodyWith({ disks: fact([
        { mount: '/', total: 0, free: 5e9 },
        { mount: '/d', total: 100e9, free: 2e9 },
      ]) }),
      T0,
    )
    expect(r.rows.disks.severity).toBe('critical')
  })

  it('无效挂载点上的 critical insight 不能复活/升级磁盘行', () => {
    const r = evaluateBody(
      bodyWith({ disks: fact([{ mount: '/', total: 0, free: 0 }]) }), T0, { 'disk:/': critInsight })
    expect(r.rows.disks.severity).toBe('unknown')
    // 混合列表：只聚合有效挂载点的 insight
    const r2 = evaluateBody(
      bodyWith({ disks: fact([
        { mount: '/', total: 100e9, free: 90e9 },
        { mount: '/bad', total: 0, free: 0 },
      ]) }),
      T0,
      { 'disk:/bad': critInsight },
    )
    expect(r2.rows.disks.severity).toBe('good')
  })
})

describe('contextWindow 回退估值', () => {
  const fallbackBody = () =>
    bodyWith({
      tokens: fact({
        contextWindow: 1_000_000,
        contextWindowSource: 'fallback',
        contextUsed: 46_200,
        sessionUsage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      }),
    })

  it('fallback → 行 unknown 但不计入聚合缺失，也不并入 insight 告警', () => {
    const r = evaluateBody(fallbackBody(), T0)
    expect(r.rows.tokens.severity).toBe('unknown')
    expect(r.severity).toBe('good')
    const r2 = evaluateBody(fallbackBody(), T0, {
      tokens: { sources: ['floor'], triggered: ['floor'], severity: 'critical' },
    })
    expect(r2.rows.tokens.severity).toBe('unknown')
    expect(r2.severity).not.toBe('critical')
  })

  it.each(['configured', 'catalog', undefined] as const)(
    '%s 来源保持原有窗口判定',
    (source) => {
      const b = bodyWith({
        tokens: fact({
          contextWindow: 100_000,
          contextWindowSource: source,
          contextUsed: 96_000,
          sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }),
      })
      expect(evaluateBody(b, T0).rows.tokens.severity).toBe('critical')
    },
  )
})
