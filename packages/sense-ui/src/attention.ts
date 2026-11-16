/** 监护概览的优先警示行：只消费 model 数据，不做任何模拟。 */

import {
  BODY_ROW_PRIORITY,
  rowMetricKeys,
  rowUsable,
  type BodyEvaluation,
  type BodyRowKey,
} from './health'
import type { MetricInsight, MetricKey, SensePanelModel } from './view-model'

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

/** 估算显示上限：超过 7 天的触阈时间不显示。 */
const MAX_ETA_MS = 7 * 24 * 3600_000

/** 耗尽类指标（剩余量向下耗尽）：磁盘剩余字节、电池百分点。其余指标向上触及阈值。 */
const DEPLETES = (k: MetricKey) => k === 'battery' || k.startsWith('disk:')

type Eta = NonNullable<MetricInsight['currentEta']>

/**
 * 宿主当前投影是否有效：
 * asOf 有限且 ≤ now、间隔有限且为正、asOf 不早于 2× 采样间隔、
 * 给出有限非负 timeToThresholdMs、ratePerMinute 有限且朝恶化方向。
 */
function validEta(key: MetricKey, eta: Eta | undefined, now: number): Eta | null {
  if (!eta) return null
  const { asOf, sampleIntervalMs, timeToThresholdMs, ratePerMinute } = eta
  if (!Number.isFinite(asOf) || asOf > now) return null
  if (!Number.isFinite(sampleIntervalMs) || sampleIntervalMs <= 0) return null
  if (now - asOf > 2 * sampleIntervalMs) return null
  if (
    timeToThresholdMs == null ||
    !Number.isFinite(timeToThresholdMs) ||
    timeToThresholdMs < 0 ||
    timeToThresholdMs > MAX_ETA_MS
  ) {
    return null
  }
  if (!Number.isFinite(ratePerMinute)) return null
  if (DEPLETES(key) ? ratePerMinute >= 0 : ratePerMinute <= 0) return null
  return eta
}

/**
 * 优先警示行：
 * 先按严重度选出当前最差行（不先看事件紧急度，避免 warn 磁盘掩盖 critical 内存），
 * 再从该行各指标的 insight.currentEta 里挑最新且仍有效的宿主投影；
 * timeToThresholdMs 是 asOf 时刻的估计，显示前先扣除已流逝时间
 * （remaining = ETA − (now − asOf)，remaining ≤ 0 即视为已到期不显示）；
 * 有更新证据的匹配 body.rate 信号使旧投影失效（信号意味着宿主已重新评估，
 * 包括新的无 ETA / 零速率 / 反向更新，不做历史 ETA 替补）。
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
  const keys = rowMetricKeys(rowKey, body, model.now)

  // 每指标最近一次 body.rate 证据时间（未来事件不算）
  const latestRateAt = new Map<string, number>()
  for (const e of model.events) {
    const d = e.detail
    if (!d || d.kind !== 'body.rate') continue
    if (!Number.isFinite(e.signal.at) || e.signal.at > model.now) continue
    const evidenceAt = e.signal.data.evidenceAt
    const at = typeof evidenceAt === 'number' && Number.isFinite(evidenceAt) && evidenceAt <= e.signal.at
      ? evidenceAt
      : e.signal.at
    const cur = latestRateAt.get(d.metric)
    if (cur == null || at > cur) latestRateAt.set(d.metric, at)
  }

  let best: { key: MetricKey; asOf: number; ms: number } | null = null
  for (const key of keys) {
    const eta = validEta(key, model.insights?.[key]?.currentEta, model.now)
    if (!eta) continue
    // 有更新证据的匹配 body.rate 信号使旧投影失效：宿主已重新评估
    //（含新的无 ETA / 零速率 / 反向更新，不做历史 ETA 替补）。
    const signalAt = latestRateAt.get(key)
    if (signalAt != null && signalAt > eta.asOf) continue
    // timeToThresholdMs 是 asOf 时刻的估计：扣除已流逝时间才是剩余倒计时
    const remainingMs = eta.timeToThresholdMs! - (model.now - eta.asOf)
    if (remainingMs <= 0) continue
    if (!best || eta.asOf > best.asOf) {
      best = { key, asOf: eta.asOf, ms: remainingMs }
    }
  }
  if (!best || best.ms > MAX_ETA_MS) return null
  const minutes = Math.max(0, Math.round(best.ms / 60_000))
  const verb = DEPLETES(best.key) ? '见底' : '触及阈值'
  return `${ROW_LABEL[rowKey]} ${minutes} 分钟后${verb}`
}
