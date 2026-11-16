import { describe, expect, it } from 'vitest'
import { tick } from '../../src/preview/tick'
import { T0, emptyFact, fact, makeBody, makeState } from '../../src/mock/fixtures'
import { makeScenario } from '../../src/mock/scenarios'
import { effectiveDisks } from '@asi/sense-types'
import { evaluateBody } from '../../src/health'

describe('预览 tick（实时模式）', () => {
  it('仅给本次续期的磁盘卷追加历史点，物化其他卷不算采样', () => {
    const state = makeState()
    state.self.body.disks = {
      ...state.self.body.disks,
      status: 'ok', observedAt: T0 - 1_000, ttlMs: 30_000,
      value: [
        { mount: '/', total: 100, free: 60, status: 'ok', observedAt: T0 - 19_000, ttlMs: 30_000 },
        { mount: '/legacy', total: 100, free: 80 },
        { mount: '/later', total: 100, free: 70, status: 'ok', observedAt: T0 - 1_000, ttlMs: 30_000 },
      ],
    }
    const m = makeScenario('healthy')
    const legacy = [{ at: T0 - 1_000, value: 0.2 }]
    const later = [{ at: T0 - 1_000, value: 0.3 }]
    const next = tick({ ...m, state, history: { ...m.history, disks: { '/': [], '/legacy': legacy, '/later': later } } })
    expect(next.history.disks['/']).toEqual([{ at: next.now, value: 0.4 }])
    expect(next.history.disks['/legacy']).toBe(legacy)
    expect(next.history.disks['/later']).toBe(later)
  })

  it('不复活父期限已到的旧卷，同时续期新鲜卷', () => {
    const state = makeState()
    state.self.body.disks = {
      ...state.self.body.disks,
      status: 'ok', observedAt: T0 - 5000, ttlMs: 6000,
      value: [
        { mount: '/', total: 100, free: 2 },
        { mount: '/data', total: 100, free: 90, status: 'ok', observedAt: T0 - 19000, ttlMs: 30000 },
      ],
    }
    const next = tick({ ...makeScenario('healthy'), state })
    expect(effectiveDisks(next.state.self.body.disks, next.now).value?.map((v) => v.status))
      .toEqual(['stale', 'ok'])
    expect(evaluateBody(next.state.self.body, next.now).rows.disks)
      .toMatchObject({ severity: 'good', partial: true })
    expect(next.state.self.body.disks.value?.[1]?.observedAt).toBe(next.now)
  })

  it('父级 stale 时仍续期显式新鲜卷，且不可读卷不续期', () => {
    const state = makeState()
    state.self.body.disks = {
      ...state.self.body.disks,
      status: 'stale', observedAt: T0 - 30000, ttlMs: 6000, unavailableMounts: ['/net'],
      value: [
        { mount: '/', total: 100, free: 2 },
        { mount: '/data', total: 100, free: 90, status: 'ok', observedAt: T0 - 19000, ttlMs: 30000 },
        { mount: '/net', total: 100, free: 2, status: 'ok', observedAt: T0 - 19000, ttlMs: 30000 },
      ],
    }
    const m = makeScenario('healthy')
    const next = tick({ ...m, state, history: { ...m.history, disks: { '/data': [], '/net': [] } } })
    expect(effectiveDisks(next.state.self.body.disks, next.now).value?.map((v) => v.status))
      .toEqual(['stale', 'ok', 'unavailable'])
    expect(next.state.self.body.disks.value?.[1]?.observedAt).toBe(next.now)
    expect(next.state.self.body.disks.value?.[2]?.observedAt).toBe(T0 - 19000)
    expect(next.history.disks['/data']).toHaveLength(1)
    expect(next.history.disks['/net']).toHaveLength(0)
    let later = next
    for (let i = 0; i < 40; i++) later = tick(later)
    expect(effectiveDisks(later.state.self.body.disks, later.now).value?.map((v) => v.status))
      .toEqual(['stale', 'ok', 'unavailable'])
    expect(later.history.disks['/data']!.length).toBeGreaterThan(1)
    expect(later.history.disks['/net']).toHaveLength(0)
  })
  it('cpu/network/tokens 每 tick 采样；其余 ok 事实未到期保持原引用', () => {
    const state = makeState()
    state.self.body.thermal = emptyFact('unavailable', 'helper 未上报')
    const m = { ...makeScenario('healthy'), state }
    const next = tick(m)
    expect(next.now).toBe(T0 + 1_000)
    // 变化事实落新 observedAt 且对象更新
    for (const key of ['cpu', 'network', 'tokens'] as const) {
      expect(next.state.self.body[key].observedAt).toBe(T0 + 1_000)
      expect(next.state.self.body[key]).not.toBe(m.state.self.body[key])
    }
    // 静止事实第一 tick（远未到 2/3·TTL）不重建，引用原样
    for (const key of ['memory', 'disks', 'battery', 'harnessProcess'] as const) {
      expect(next.state.self.body[key]).toBe(m.state.self.body[key])
    }
    expect(next.state.self).not.toBe(m.state.self)
    // env 全未到期 → 整个 env 引用保留
    expect(next.state.env).toBe(m.state.env)
    // 非 ok 事实不续期，状态不变
    expect(next.state.self.body.thermal).toBe(m.state.self.body.thermal)
    expect(next.state.self.body.thermal.status).toBe('unavailable')
  })

  it('ok 事实到 2/3·TTL 才续期，续期只更新 observedAt', () => {
    const state = makeState()
    // 40s TTL + 夹具默认 1s 年龄：首次续期在 age≥26.7s，即第 26 tick
    state.self.body.memory = fact(
      { total: 16e9, used: 8e9, pressure: 'normal', swapUsed: 0 },
      { ttlMs: 40_000 },
    )
    let m = { ...makeScenario('healthy'), state }
    for (let i = 0; i < 25; i++) m = tick(m)
    expect(m.state.self.body.memory).toBe(state.self.body.memory)
    m = tick(m)
    const renewed = m.state.self.body.memory
    expect(renewed).not.toBe(state.self.body.memory)
    expect(renewed.observedAt).toBe(m.now)
    expect(renewed.value).toBe(state.self.body.memory.value)
  })

  it('磁盘续期只刷显式 ok 卷，stale 卷保留；父级元数据聚合 fresh 卷', () => {
    const state = makeState()
    state.self.body.disks = {
      kind: 'disks',
      ...fact(
        [
          {
            mount: '/',
            total: 100e9,
            free: 90e9,
            status: 'ok' as const,
            observedAt: T0 - 19_000,
            ttlMs: 30_000,
          },
          {
            mount: '/stale',
            total: 100e9,
            free: 90e9,
            status: 'stale' as const,
            observedAt: T0 - 80_000,
            ttlMs: 30_000,
          },
          { mount: '/legacy', total: 100e9, free: 90e9 },
        ],
        { ttlMs: 30_000 },
      ),
    }
    let m = { ...makeScenario('healthy'), state }
    // 根卷已达自己的 2/3·TTL，第一 tick 独立续期
    m = tick(m)
    const d = m.state.self.body.disks
    expect(d).not.toBe(state.self.body.disks)
    const vols = Object.fromEntries(d.value!.map((v) => [v.mount, v]))
    // '/' 显式 ok 且 age=20s ≥ 2/3·30s → 刷到 now；stale 卷不动；legacy 物化旧期限
    expect(vols['/']!.observedAt).toBe(m.now)
    expect(vols['/stale']).toBe(state.self.body.disks.value![1])
    expect(vols['/legacy']!.observedAt).toBe(T0 - 1000)
    // 父级聚合 fresh 卷（/ + legacy）：observedAt=最旧 fresh 观察，ttl=最早绝对过期-最旧观察
    expect(d.status).toBe('ok')
    expect(d.observedAt).toBe(T0 - 1000)
    expect(d.ttlMs).toBeGreaterThan(0)
  })

  it('历史只随变化事实追加；未变化序列保留原数组引用', () => {
    const m = makeScenario('healthy')
    const next = tick(m)
    // cpu/network/tokens 采样 → 追加
    expect(next.history.cpu.at(-1)!.at).toBe(T0 + 1_000)
    expect(next.history.networkRx.at(-1)!.at).toBe(T0 + 1_000)
    expect(next.history.tokens.at(-1)!.at).toBe(T0 + 1_000)
    // memory/disks 未续期 → 序列引用原样
    expect(next.history.memory).toBe(m.history.memory)
    expect(next.history.disks).toBe(m.history.disks)
    expect(next.history.processCpu).toBe(m.history.processCpu)
  })

  it('paused 时只推进 now，不假装采集', () => {
    const m = { ...makeScenario('healthy'), paused: true }
    const next = tick(m)
    expect(next.now).toBe(T0 + 1_000)
    expect(next.state).toBe(m.state)
    expect(next.history).toBe(m.history)
  })

  it('series 只追加非 null 值，不用 0 占位', () => {
    const m = makeScenario('desktop-no-battery')
    const state = makeState()
    state.self.body.battery = fact(null, { ttlMs: 1_000 })
    const next = tick({ ...m, state })
    // 无电池值：续期触发采样但无新点（也不补 0）
    expect(next.history.battery.every((p) => p.value !== 0)).toBe(true)
  })

  it('contextUsed 增长到 contextWindow 即封顶', () => {
    let m = makeScenario('context-almost-full')
    for (let i = 0; i < 200; i++) m = tick(m)
    const v = m.state.self.body.tokens.value!
    expect(v.contextUsed).toBeLessThanOrEqual(v.contextWindow!)
    expect(v.contextProjected).toBeLessThanOrEqual(v.contextWindow!)
  })

  it('历史只保留最近 5 分钟内的点', () => {
    let m = makeScenario('healthy')
    const body = makeBody()
    m = {
      ...m,
      state: { ...m.state, self: { ...m.state.self, body } },
      history: { ...m.history, cpu: [{ at: T0 - 400_000, value: 0.5 }] },
    }
    const next = tick(m)
    expect(next.history.cpu.every((p) => p.at > next.now - 300_000)).toBe(true)
    // 旧点被裁剪 + 新点被追加
    expect(next.history.cpu.at(-1)!.at).toBe(T0 + 1_000)
  })

  it('stale 事实不刷新 observedAt（保留有意过期状态）', () => {
    const state = makeState()
    state.self.body.cpu = fact(
      { usage: 0.3, perCore: [], load1: 0, load5: 0, load15: 0 },
      { status: 'stale', ageMs: 120_000 },
    )
    const next = tick({ ...makeScenario('healthy'), state })
    expect(next.state.self.body.cpu.observedAt).toBe(T0 - 120_000)
    expect(next.state.self.body.cpu.value!.usage).toBe(0.3)
  })
})

describe('tick 全事实新鲜度', () => {
  it('周期续期下 ok 事实长期保持新鲜', () => {
    let m = makeScenario('healthy')
    for (let i = 0; i < 60; i++) m = tick(m)
    const { self, env } = m.state
    for (const f of [
      self.body.memory,
      self.body.disks,
      self.body.thermal,
      self.activity,
      env.where.model,
      env.frontApp,
      env.watchedPaths,
    ]) {
      // 最后一次续期距 now 不超过 2/3·TTL（即仍新鲜且引用未每 tick 重建）
      expect(m.now - f.observedAt).toBeLessThanOrEqual((f.ttlMs * 2) / 3)
      expect(m.now - f.observedAt).toBeLessThan(f.ttlMs)
    }
  })

  it('301 次 tick 后磁盘历史仍追加且窗口有界', () => {
    let m = makeScenario('healthy')
    for (let i = 0; i < 301; i++) m = tick(m)
    const root = m.history.disks['/']!
    expect(root.length).toBeGreaterThan(0)
    // 最新点在续期采样点附近（非每 tick）；点只在采样时裁剪，
    // 最旧点可落后窗口边沿一个续期间隔
    expect(m.now - root.at(-1)!.at).toBeLessThan(30_000)
    expect(root.every((p) => p.at > m.now - 330_000)).toBe(true)
    expect(root.at(-1)!.value).toBeGreaterThan(0)
    expect(root.at(-1)!.value).toBeLessThan(1)
  })

  it('暂停时 observedAt 不刷新', () => {
    const m = { ...makeScenario('healthy'), paused: true }
    const next = tick(m)
    expect(next.state.self.body.memory.observedAt).toBe(
      m.state.self.body.memory.observedAt,
    )
    expect(next.now).toBe(m.now + 1_000)
  })
})
