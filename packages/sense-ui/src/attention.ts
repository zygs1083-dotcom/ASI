/** 监护概览的优先警示行：只消费 model 数据，不做任何模拟。 */

import {
  BODY_ROW_PRIORITY,
  rowMetricKeys,
  rowUsable,
  type BodyEvaluation,
  type BodyRowKey,
} from './health'
import type { MetricKey, SensePanelModel } from './view-model'

const ROW_LABEL: Record<BodyRowKey, string> = {
  cpu: 'CPU',
  memory: '内存',
  disks: '磁盘',
  tokens: 'Token',
  battery: '电池',
  thermal: '温控',
  network: '网络',
  process: 'DSH 进程',
}

const RECENT_MS = 5 * 60 * 1000

/**
 * 优先警示行：
 * 先按严重度选出当前最差行（不先看事件紧急度，避免 warn 磁盘掩盖 critical 内存），
 * 再在最近 5 分钟事件里找匹配该行且对应事实可用的 body.rate 投影；
 * 事件给出 timeToFloorMs 才显示「N 分钟后见底」，否则回退 evaluateBody 的句子。
 */
export function attentionLine(
  model: SensePanelModel,
  evaluation: BodyEvaluation,
): string | null {
  const sev = evaluation.severity
  if (sev !== 'warn' && sev !== 'critical') return null
  const rowKey = BODY_ROW_PRIORITY.find((k) => evaluation.rows[k].severity === sev)
  if (!rowKey) return null
  const body = model.state.self.body
  if (!rowUsable(rowKey, body, model.now)) return null
  const keys = new Set<MetricKey>(rowMetricKeys(rowKey, body))

  let latest: { at: number; timeToFloorMs: number } | null = null
  for (const e of model.events) {
    const d = e.detail
    if (!d || d.kind !== 'body.rate') continue
    if (!keys.has(d.metric as MetricKey)) continue
    const at = e.signal.at
    if (!Number.isFinite(at) || at > model.now || at < model.now - RECENT_MS)
      continue
    const ms = d.timeToFloorMs
    if (ms == null || !Number.isFinite(ms) || ms < 0) continue
    if (!latest || at > latest.at) latest = { at, timeToFloorMs: ms }
  }
  if (!latest) return null
  const minutes = Math.max(0, Math.round(latest.timeToFloorMs / 60_000))
  return `${ROW_LABEL[rowKey]} ${minutes} 分钟后见底`
}
