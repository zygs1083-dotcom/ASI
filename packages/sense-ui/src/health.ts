/** 身体各项指标的阈值与聚合健康度。全部纯函数，时间一律用传入的 now。 */

import type { Body, Fact, MetricInsight, MetricKey } from './view-model'
import { diskSeverity, diskUsable, diskValid, effectiveDisks } from './disk-health'
import {
  effectiveSeverity,
  effectiveStatus,
  isUsable,
  maxSeverity,
  type Severity,
} from './fact-status'

export {
  effectiveSeverity,
  effectiveStatus,
  isUsable,
  maxSeverity,
  type Severity,
} from './fact-status'
export {
  diskFact,
  diskSeverity,
  diskUsable,
  diskValid,
  unavailableMountSet,
} from './disk-health'

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
  /** 有可用数据但读数不完整（如磁盘存在失鲜/不可读挂载点）：不降低严重度、不改告警。 */
  partial?: boolean
}

export interface BodyEvaluation {
  severity: Severity
  sentence: string
  rows: Record<BodyRowKey, RowResult>
  /** 任一行 partial 即聚合 partial；句子只在「其余全 good」时落成部分补全文案。 */
  partial?: boolean
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
  const f = effectiveDisks(body.disks, now)
  const values = f.value ?? []
  // 只聚合新鲜可用卷：stale/unknown/unavailable/无效读数不告警；
  // 没有任何新鲜卷才算缺失，父级状态不再一票否决。
  const fresh = values.filter((d) => d.status === 'ok' && diskValid(d))
  if (fresh.length === 0) return unusable()
  let severity: Severity = 'good'
  for (const d of fresh) {
    severity = maxSeverity(severity, diskSeverity(d.free / d.total))
  }
  const partial =
    f.indeterminateMounts.length > 0 || values.some((d) => !diskValid(d))
  return { severity, hidden: false, ...(partial ? { partial: true } : {}) }
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

/** 每个行对应可查询的指标 key（网络/进程各两条，磁盘只取新鲜可用挂载点）。 */
export function rowMetricKeys(key: BodyRowKey, body: Body, now: number): MetricKey[] {
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
      // 只有新鲜可用卷才聚合 insight：stale/unknown/unavailable/无效挂载点
      // 不产生 key，防止陈旧卷的 insight/ETA 泄漏进告警
      return (body.disks.value ?? [])
        .filter((d) => diskUsable(body.disks, d, now))
        .map((d) => `disk:${d.mount}` as const)
  }
}

/** 行键 → 对应身体事实（process 行用 harnessProcess 字段）。 */
export function rowFact(key: BodyRowKey, body: Body): Fact<unknown> {
  return {
    cpu: body.cpu,
    memory: body.memory,
    disks: body.disks,
    battery: body.battery,
    thermal: body.thermal,
    network: body.network,
    process: body.harnessProcess,
    tokens: body.tokens,
  }[key]
}

/** 行事实是否新鲜可用（才可并入 insight 严重度，stale/denied 不假装当前）。 */
export function rowUsable(key: BodyRowKey, body: Body, now: number): boolean {
  if (key === 'disks') {
    // 磁盘按卷判定：父级失鲜/拒绝不否决显式新鲜卷
    return (body.disks.value ?? []).some((d) => diskUsable(body.disks, d, now))
  }
  const f = rowFact(key, body)
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
      for (const mk of rowMetricKeys(key, body, now)) {
        const sev = effectiveSeverity(insights[mk])
        if (sev !== 'good') r.severity = maxSeverity(r.severity, sev)
      }
    }
    rows[key] = r
  }

  let worst: Severity = 'good'
  let hasUnknown = false
  let partial = false
  for (const key of BODY_ROW_PRIORITY) {
    const s = rows[key].severity
    if (s === 'unknown') {
      if (!rows[key].uncounted) hasUnknown = true
    } else if (s === 'critical') worst = 'critical'
    else if (s === 'warn' && worst !== 'critical') worst = 'warn'
    if (rows[key].partial) partial = true
  }
  const out = (severity: Severity, sentence: string): BodyEvaluation =>
    partial ? { severity, sentence, rows, partial: true } : { severity, sentence, rows }

  if (worst === 'critical' || worst === 'warn') {
    const key = BODY_ROW_PRIORITY.find((k) => rows[k].severity === worst)!
    const sentence =
      key === 'network' && body.network.value?.online
        ? '网络流量异常'
        : ROW_WARN_SENTENCE[key]
    return out(worst, sentence)
  }
  if (hasUnknown) {
    return out('unknown', '数据待补全')
  }
  if (partial) {
    // 其余行全部良好但读数不完整：不升级严重度，句子标记部分缺失
    return out('good', '部分 · 数据待补全')
  }
  return out('good', '状态良好')
}
