/** 事实有效状态与严重度聚合的纯函数；时间一律用传入的 now。 */

import type { Fact, FactStatus, MetricInsight } from './view-model'
import { factStatusAt } from '@asi/sense-types'

export type Severity = 'good' | 'warn' | 'critical' | 'unknown'

/** ok 但超过 TTL 视为 stale（由读取时计算）。 */
export function effectiveStatus<T>(fact: Fact<T>, now: number): FactStatus {
  return factStatusAt(fact, now)
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
