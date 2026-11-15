import { describe, expect, it } from 'vitest'
import { tick } from '../../src/preview/tick'
import { T0, emptyFact, fact, makeBody, makeState } from '../../src/mock/fixtures'
import { makeScenario } from '../../src/mock/scenarios'

describe('预览 tick（实时模式）', () => {
  it('所有 ok 事实刷新 observedAt（含静止值），非 ok 状态保留', () => {
    const state = makeState()
    state.self.body.thermal = emptyFact('unavailable', 'helper 未上报')
    const m = { ...makeScenario('healthy'), state }
    const next = tick(m)
    expect(next.now).toBe(T0 + 1_000)
    for (const key of ['memory', 'disks', 'battery', 'network', 'harnessProcess', 'tokens'] as const) {
      expect(next.state.self.body[key].observedAt).toBe(T0 + 1_000)
    }
    // 非 ok 事实不刷新，状态不变
    expect(next.state.self.body.thermal.status).toBe('unavailable')
    expect(next.state.self.body.thermal.observedAt).toBe(T0 - 1_000)
  })

  it('paused 时只推进 now，不假装采集', () => {
    const m = { ...makeScenario('healthy'), paused: true }
    const next = tick(m)
    expect(next.now).toBe(T0 + 1_000)
    expect(next.state.self.body.cpu.observedAt).toBe(m.state.self.body.cpu.observedAt)
    expect(next.history.cpu.length).toBe(m.history.cpu.length)
  })

  it('series 只追加非 null 值，不用 0 占位', () => {
    const m = makeScenario('desktop-no-battery')
    const before = m.history.battery.length
    const next = tick(m)
    // 无电池：点被裁剪但不追加新点
    expect(next.history.battery.length).toBe(before)
    expect(next.history.battery.every((p) => p.value !== 0 || p.at < next.now)).toBe(true)
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
    // stale 值不进入新历史点之外的更新：值仍是原样
    expect(next.state.self.body.cpu.value!.usage).toBe(0.3)
  })
})

describe('tick 全事实新鲜度', () => {
  it('6 次 tick 后身体与现在分区的事实仍新鲜', () => {
    let m = makeScenario('healthy')
    for (let i = 0; i < 6; i++) m = tick(m)
    const { self, env } = m.state
    expect(self.body.memory.observedAt).toBe(m.now)
    expect(self.body.disks.observedAt).toBe(m.now)
    expect(self.body.thermal.observedAt).toBe(m.now)
    expect(self.activity.observedAt).toBe(m.now)
    expect(env.where.model.observedAt).toBe(m.now)
    expect(env.frontApp.observedAt).toBe(m.now)
    expect(env.watchedPaths.observedAt).toBe(m.now)
  })

  it('301 次 tick 后磁盘历史最新点仍在 now', () => {
    let m = makeScenario('healthy')
    for (let i = 0; i < 301; i++) m = tick(m)
    const root = m.history.disks['/']!
    expect(root.length).toBeGreaterThan(0)
    expect(root.at(-1)!.at).toBe(m.now)
    // 值是使用率比例 0..1
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
