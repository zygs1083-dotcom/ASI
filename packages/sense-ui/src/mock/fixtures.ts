/** 预览与测试用的确定性夹具；全部为编造数据，不含真实主机名/标题。 */

import type {
  BodyHistory,
  Fact,
  FactStatus,
  MetricInsight,
  MetricKey,
  MetricPoint,
  SenseEvent,
  SenseRule,
  SenseState,
  Signal,
  SourceRef,
} from '../view-model'

export const T0 = 1_763_300_000_000

export const src = (api: string): SourceRef => ({ id: api, api, host: 'demo-host' })

export function fact<T>(
  value: T | null,
  opts: { status?: FactStatus; ageMs?: number; ttlMs?: number; reason?: string; api?: string } = {},
): Fact<T> {
  return {
    value,
    status: opts.status ?? 'ok',
    source: src(opts.api ?? 'demo'),
    observedAt: T0 - (opts.ageMs ?? 1_000),
    ttlMs: opts.ttlMs ?? 5_000,
    reason: opts.reason,
  }
}

/** 无值的事实（denied/unavailable/unsupported/unknown/stale-null），T 由赋值上下文推断。 */
export function emptyFact<T>(status: FactStatus, reason?: string): Fact<T> {
  return fact<T>(null, { status, reason })
}

export const denied = <T>(reason: string): Fact<T> => emptyFact<T>('denied', reason)

export function series(
  points: number,
  stepMs: number,
  fn: (i: number) => number,
): MetricPoint[] {
  return Array.from({ length: points }, (_, i) => ({
    at: T0 - (points - 1 - i) * stepMs,
    value: fn(i),
  }))
}

const sine = (base: number, amp: number, period: number) => (i: number) =>
  Math.max(0, Math.min(1, base + amp * Math.sin(i / period)))

export function makeHistory(over: Partial<BodyHistory> = {}): BodyHistory {
  return {
    cpu: series(60, 5_000, sine(0.35, 0.15, 9)),
    memory: series(60, 5_000, sine(0.6, 0.05, 14)),
    battery: series(60, 5_000, (i) => 78 - i * 0.04),
    thermal: series(60, 5_000, () => 0),
    networkRx: series(60, 5_000, (i) => 400_000 + 250_000 * Math.sin(i / 7)),
    networkTx: series(60, 5_000, (i) => 90_000 + 50_000 * Math.sin(i / 6)),
    processCpu: series(60, 5_000, sine(0.08, 0.04, 8)),
    processRss: series(60, 5_000, (i) => 480e6 + 20e6 * Math.sin(i / 12)),
    tokens: series(60, 5_000, (i) => 42_000 + i * 60),
    disks: {
      '/': series(60, 5_000, sine(0.62, 0.005, 20)),
      '/demo/vol': series(60, 5_000, sine(0.4, 0.004, 20)),
    },
    ...over,
  }
}

/** 已就绪场景的基线区间（与 history 同单位）；learning 场景自行提供无 band 的版本。 */
export function makeInsights(
  over: Partial<Record<MetricKey, MetricInsight>> = {},
): Partial<Record<MetricKey, MetricInsight>> {
  return {
    cpu: { baseline: { low: 0.18, high: 0.5 }, sources: ['floor', 'rate', 'baseline'], triggered: [] },
    memory: { baseline: { low: 0.5, high: 0.7 }, sources: ['floor', 'baseline'], triggered: [] },
    battery: { baseline: { low: 60, high: 95 }, sources: ['floor'], triggered: [] },
    thermal: { sources: ['floor'], triggered: [] },
    networkRx: { baseline: { low: 100_000, high: 700_000 }, sources: ['rate', 'baseline'], triggered: [] },
    networkTx: { baseline: { low: 30_000, high: 160_000 }, sources: ['rate'], triggered: [] },
    processCpu: { baseline: { low: 0.02, high: 0.16 }, sources: ['floor'], triggered: [] },
    processRss: { baseline: { low: 400e6, high: 560e6 }, sources: ['baseline'], triggered: [] },
    tokens: { baseline: { low: 30_000, high: 60_000 }, sources: ['floor', 'baseline'], triggered: [] },
    'disk:/': { baseline: { low: 0.55, high: 0.7 }, sources: ['floor', 'baseline'], triggered: [] },
    'disk:/demo/vol': { baseline: { low: 0.35, high: 0.45 }, sources: ['floor'], triggered: [] },
    ...over,
  }
}

export function makeBody(): SenseState['self']['body'] {
  return {
    cpu: fact({ usage: 0.34, perCore: [0.3, 0.5, 0.28, 0.42, 0.36, 0.31, 0.4, 0.29], load1: 2.1, load5: 1.8, load15: 1.6 }),
    memory: fact({
      total: 32e9,
      used: 19.4e9,
      pressure: 'normal',
      swapUsed: 0.4e9,
      breakdown: { app: 11e9, wired: 5e9, compressed: 3.4e9, cached: 4e9 },
    }),
    disks: fact([
      { mount: '/', total: 460e9, free: 175e9 },
      { mount: '/demo/vol', total: 120e9, free: 72e9 },
    ]),
    battery: fact({ percent: 76, charging: false, minutesLeft: 240 }),
    thermal: fact('nominal'),
    network: fact({ online: true, rxBps: 512_000, txBps: 96_000 }),
    harnessProcess: fact({ rss: 512e6, cpu: 0.07, uptimeSec: 14_200 }),
    tokens: fact({
      contextWindow: 128_000,
      contextWindowSource: 'configured',
      contextUsed: 46_200,
      contextProjected: 52_800,
      sessionUsage: { input: 96_400, output: 12_800, cacheRead: 61_000, cacheWrite: 9_200 },
      balance: { amount: 12.34, currency: 'CNY', source: 'demo-provider' },
      compressionThreshold: 115_200,
      contextGrowthPerMinute: 720,
    }),
  }
}

export function makeState(over: Partial<SenseState> = {}): SenseState {
  const base: SenseState = {
    self: {
      activity: fact('tool'),
      pending: fact({ inbox: 2, jobs: 1 }),
      tools: fact(['env_state', 'env_watch', 'env_detail', 'shell']),
      permissions: fact({ 辅助功能: 'granted', 完全磁盘访问: 'granted' }),
      body: makeBody(),
    },
    env: {
      where: {
        model: fact({ provider: 'demo-provider', endpoint: 'http://127.0.0.1:3425/v1', local: true }),
        harness: fact({ host: 'demo-host', os: 'macOS 15.2', pid: 40210 }),
        observed: fact({ host: 'demo-host', userSession: 'gui/demo' }),
        toolExec: fact({ host: 'demo-host', cwd: '/demo/project' }),
      },
      frontApp: fact({ name: 'Terminal', bundleId: 'com.demo.terminal' }),
      focusedWindow: fact({ title: 'demo.ts — project' }),
      activeJobs: fact([{ id: 'job-1', name: 'pnpm test', status: 'running' }]),
      watchedPaths: fact({ 'src/**': { lastChange: T0 - 32_000, changes: 7 } }),
    },
    observation: {
      sources: {
        'macos-helper': { status: 'ok', lastSignalAt: T0 - 2_000 },
        'file-watch': { status: 'ok', lastSignalAt: T0 - 30_000 },
        'dsh-events': { status: 'ok', lastSignalAt: T0 - 1_000 },
      },
    },
  }
  return {
    self: { ...base.self, ...over.self },
    env: {
      ...base.env,
      ...over.env,
      where: { ...base.env.where, ...over.env?.where },
    },
    observation: { ...base.observation, ...over.observation },
  }
}

export function makeEvent(
  i: number,
  over: Partial<Omit<SenseEvent, 'signal'>> & { signal?: Partial<Signal> } = {},
): SenseEvent {
  const { signal: sigOver, ...rest } = over
  const kinds = ['app.activated', 'window.focused', 'file.changed', 'job.exited']
  const kind = kinds[i % kinds.length]!
  const subjects: Record<string, string> = {
    'app.activated': 'com.demo.browser',
    'window.focused': 'demo.ts — project',
    'file.changed': '/demo/project/src/a.ts',
    'job.exited': 'job-7',
  }
  return {
    signal: {
      id: `sig-${i}`,
      kind,
      at: T0 - i * 4_000,
      source: src('demo'),
      subject: subjects[kind]!,
      data: {},
      cause: rest.cause ?? 'user',
      ...sigOver,
    },
    level: 'record',
    reason: '默认记录规则',
    cause: 'user',
    ...rest,
  }
}

export function makeRules(): SenseRule[] {
  return [
    {
      id: 'rule-pending',
      name: '测试失败时唤醒',
      enabled: true,
      confirmed: false,
      match: { kind: 'job.exited', where: { exitCode: '!=0' } },
      level: 'wake',
      note: '测试失败时看日志并决定是否提醒我',
      createdBy: 'agent',
    },
    {
      id: 'rule-save',
      name: 'src 下文件保存',
      enabled: true,
      confirmed: true,
      match: { kind: 'file.changed', subject: 'src/**' },
      level: 'context',
      createdBy: 'user',
    },
    {
      id: 'rule-app',
      name: '应用切换记录',
      enabled: false,
      confirmed: true,
      match: { kind: 'app.activated' },
      level: 'record',
      createdBy: 'user',
    },
  ]
}
