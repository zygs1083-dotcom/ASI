/** 身体各项指标的阈值与聚合健康度。全部纯函数，时间一律用传入的 now。 */

import type {
  Body,
  Fact,
  FactStatus,
  MetricInsight,
  MetricKey,
} from './view-model'

export type Severity = 'good' | 'warn' | 'critical' | 'unknown'

export type BodyRowKey =
  | 'memory'
  | 'tokens'
  | 'cpu'
  | 'disks'
  | 'battery'
  | 'thermal'
  | 'network'
  | 'process'

/** 同级并列时的稳定优先级（也是汇总句子的挑选顺序）。 */
export const BODY_ROW_PRIORITY: readonly BodyRowKey[] = [
  'memory',
  'tokens',
  'cpu',
  'disks',
  'battery',
  'thermal',
  'network',
  'process',
]

export const ROW_WARN_SENTENCE: Record<BodyRowKey, string> = {
  memory: '内存紧张',
  tokens: '上下文快满了',
  cpu: 'CPU 负载较高',
  disks: '磁盘空间不足',
  battery: '电量不足',
  thermal: '设备温度偏高',
  network: '网络已断开',
  process: 'DSH 负载较高',
}

export interface RowResult {
  severity: Severity
  /** 台式机无电池（status ok 且 value null）时该行不展示、不计入缺失。 */
  hidden: boolean
  /** unknown 但不计入聚合缺失（如 contextWindow 回退估值，容量未确认而非数据缺失）。 */
  uncounted?: boolean
}

export interface BodyEvaluation {
  severity: Severity
  sentence: string
  rows: Record<BodyRowKey, RowResult>
}

/** ok 但超过 TTL 视为 stale（由读取时计算）。 */
export function effectiveStatus<T>(fact: Fact<T>, now: number): FactStatus {
  if (fact.status === 'ok' && now - fact.observedAt > fact.ttlMs) return 'stale'
  return fact.status
}

export function isUsable<T>(fact: Fact<T>, now: number): boolean {
  return effectiveStatus(fact, now) === 'ok' && fact.value !== null
}

const SEV_RANK: Record<Severity, number> = {
  good: 0,
  unknown: 0,
  warn: 1,
  critical: 2,
}

export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEV_RANK[b] > SEV_RANK[a] ? b : a
}

/**
 * insight 的有效严重度：severity 优先；triggered 非空但宿主没给 severity → warn
 * （宿主已声明触发，不能显示为良好）；否则 good。
 */
export function effectiveSeverity(
  item?: MetricInsight,
): 'warn' | 'critical' | 'good' {
  if (item?.severity) return item.severity
  return item?.triggered?.length ? 'warn' : 'good'
}

/** 有效磁盘读数：total 为正有限、free 有限（free 可为 0）。 */
export function diskValid(d: { total: number; free: number }): boolean {
  return Number.isFinite(d.total) && d.total > 0 && Number.isFinite(d.free)
}

/** 单个磁盘剩余比例 → 严重度（每个盘独立着色用）。 */
export function diskSeverity(freeRatio: number): Severity {
  return freeRatio <= 0.05 ? 'critical' : freeRatio <= 0.1 ? 'warn' : 'good'
}

function unusable(): RowResult {
  return { severity: 'unknown', hidden: false }
}

function evalCpu(body: Body, now: number): RowResult {
  const f = body.cpu
  if (!isUsable(f, now)) return unusable()
  const u = f.value!.usage
  const severity: Severity = u >= 0.9 ? 'critical' : u >= 0.75 ? 'warn' : 'good'
  return { severity, hidden: false }
}

function evalMemory(body: Body, now: number): RowResult {
  const f = body.memory
  if (!isUsable(f, now)) return unusable()
  const { pressure, used, total } = f.value!
  const pressureSev: Severity =
    pressure === 'critical' ? 'critical' : pressure === 'warn' ? 'warn' : 'good'
  const ratio = total > 0 ? used / total : 0
  const ratioSev: Severity =
    ratio >= 0.95 ? 'critical' : ratio >= 0.85 ? 'warn' : 'good'
  return { severity: maxSeverity(pressureSev, ratioSev), hidden: false }
}

function evalDisks(body: Body, now: number): RowResult {
  const f = body.disks
  if (!isUsable(f, now)) return unusable()
  const valid = f.value!.filter(diskValid)
  if (valid.length === 0) return unusable()
  let severity: Severity = 'good'
  for (const d of valid) {
    severity = maxSeverity(severity, diskSeverity(d.free / d.total))
  }
  return { severity, hidden: false }
}

function evalBattery(body: Body, now: number): RowResult {
  const f = body.battery
  if (effectiveStatus(f, now) === 'ok' && f.value === null) {
    return { severity: 'good', hidden: true }
  }
  if (!isUsable(f, now)) return unusable()
  const v = f.value!
  if (v.charging) return { severity: 'good', hidden: false }
  const severity: Severity =
    v.percent <= 5 ? 'critical' : v.percent <= 15 ? 'warn' : 'good'
  return { severity, hidden: false }
}

function evalThermal(body: Body, now: number): RowResult {
  const f = body.thermal
  if (!isUsable(f, now)) return unusable()
  const t = f.value!
  const severity: Severity =
    t === 'critical' ? 'critical' : t === 'serious' || t === 'fair' ? 'warn' : 'good'
  return { severity, hidden: false }
}

function evalNetwork(body: Body, now: number): RowResult {
  const f = body.network
  if (!isUsable(f, now)) return unusable()
  return { severity: f.value!.online ? 'good' : 'warn', hidden: false }
}

function evalProcess(body: Body, now: number): RowResult {
  const f = body.harnessProcess
  if (!isUsable(f, now)) return unusable()
  const u = f.value!.cpu
  const severity: Severity = u >= 0.9 ? 'critical' : u >= 0.75 ? 'warn' : 'good'
  return { severity, hidden: false }
}

function evalTokens(body: Body, now: number): RowResult {
  const f = body.tokens
  if (!isUsable(f, now)) return unusable()
  const { contextWindow, contextUsed, contextWindowSource } = f.value!
  // 回退估值容量未确认：磁贴标未知，但不计入聚合缺失（会话用量等仍然有效）
  if (contextWindowSource === 'fallback') {
    return { severity: 'unknown', hidden: false, uncounted: true }
  }
  if (contextWindow == null || contextWindow <= 0 || contextUsed == null) {
    return unusable()
  }
  const ratio = contextUsed / contextWindow
  const severity: Severity =
    ratio >= 0.95 ? 'critical' : ratio >= 0.85 ? 'warn' : 'good'
  return { severity, hidden: false }
}

const ROW_EVALUATORS: Record<BodyRowKey, (body: Body, now: number) => RowResult> = {
  memory: evalMemory,
  tokens: evalTokens,
  cpu: evalCpu,
  disks: evalDisks,
  battery: evalBattery,
  thermal: evalThermal,
  network: evalNetwork,
  process: evalProcess,
}

/** 每个行对应可查询的指标 key（网络/进程各两条，磁盘按挂载点展开）。 */
export function rowMetricKeys(key: BodyRowKey, body: Body): MetricKey[] {
  switch (key) {
    case 'cpu':
    case 'memory':
    case 'battery':
    case 'thermal':
    case 'tokens':
      return [key]
    case 'network':
      return ['networkRx', 'networkTx']
    case 'process':
      return ['processCpu', 'processRss']
    case 'disks':
      // 无效挂载点（total<=0/NaN）不产生可聚合的 insight key
      return (body.disks.value ?? [])
        .filter(diskValid)
        .map((d) => `disk:${d.mount}` as const)
  }
}

/** 行事实是否新鲜可用（才可并入 insight 严重度，stale/denied 不假装当前）。 */
export function rowUsable(key: BodyRowKey, body: Body, now: number): boolean {
  const f: Fact<unknown> = {
    cpu: body.cpu,
    memory: body.memory,
    disks: body.disks,
    battery: body.battery,
    thermal: body.thermal,
    network: body.network,
    process: body.harnessProcess,
    tokens: body.tokens,
  }[key]
  if (!isUsable(f, now)) return false
  if (key === 'tokens') {
    const v = body.tokens.value!
    return (
      v.contextWindowSource !== 'fallback' &&
      v.contextWindow != null &&
      v.contextWindow > 0 &&
      v.contextUsed != null
    )
  }
  if (key === 'disks') {
    return body.disks.value!.some(diskValid)
  }
  return true
}

export function evaluateBody(
  body: Body,
  now: number,
  insights?: Partial<Record<MetricKey, MetricInsight>>,
): BodyEvaluation {
  const rows = {} as Record<BodyRowKey, RowResult>
  for (const key of BODY_ROW_PRIORITY) {
    const r = ROW_EVALUATORS[key](body, now)
    if (insights && !r.hidden && rowUsable(key, body, now)) {
      for (const mk of rowMetricKeys(key, body)) {
        const sev = effectiveSeverity(insights[mk])
        if (sev !== 'good') r.severity = maxSeverity(r.severity, sev)
      }
    }
    rows[key] = r
  }

  let worst: Severity = 'good'
  let hasUnknown = false
  for (const key of BODY_ROW_PRIORITY) {
    const s = rows[key].severity
    if (s === 'unknown') {
      if (!rows[key].uncounted) hasUnknown = true
    } else if (s === 'critical') worst = 'critical'
    else if (s === 'warn' && worst !== 'critical') worst = 'warn'
  }

  if (worst === 'critical' || worst === 'warn') {
    const key = BODY_ROW_PRIORITY.find((k) => rows[k].severity === worst)!
    const sentence =
      key === 'network' && body.network.value?.online
        ? '网络流量异常'
        : ROW_WARN_SENTENCE[key]
    return { severity: worst, sentence, rows }
  }
  if (hasUnknown) {
    return { severity: 'unknown', sentence: '数据待补全', rows }
  }
  return { severity: 'good', sentence: '状态良好', rows }
}
