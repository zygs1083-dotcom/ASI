/** 事实有效状态与严重度聚合的纯函数。 */

import type { Fact, FactStatus } from './view-model';

export type Severity = 'good' | 'warn' | 'critical' | 'unknown';

/** 状态由宿主或单调倒计时提供，不用墙钟重判。 */
export function effectiveStatus<T>(fact: Fact<T>, _now: number): FactStatus {
  return fact.status;
}

export function isUsable<T>(fact: Fact<T>, now: number): boolean {
  return effectiveStatus(fact, now) === 'ok' && fact.value !== null;
}

const SEV_RANK: Record<Severity, number> = {
  good: 0,
  unknown: 0,
  warn: 1,
  critical: 2,
};

export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEV_RANK[b] > SEV_RANK[a] ? b : a;
}
