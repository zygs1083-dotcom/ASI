/** 指标卡片 memo 基础设施：行级依赖收集 + 重渲判定。 */

import { memo, type ReactNode } from 'react'
import {
  diskFact,
  diskValid,
  effectiveStatus,
  rowFact,
  rowMetricKeys,
  type BodyRowKey,
} from '../health'
import type {
  DisksFact,
  Fact,
  SenseEvent,
  SensePanelModel,
  SensePanelProps,
} from '../view-model'

export interface TileCtx {
  model: SensePanelProps['model']
  onAdjust?: () => void
  onOpenPermissionSettings: () => void
}

type Rows = ReturnType<typeof import('../health').evaluateBody>['rows']

export interface MetricTileProps {
  model: SensePanelModel
  rows: Rows
  ctx: TileCtx
}

/** 行事实集合：磁盘行含每卷派生事实（卷级 TTL/状态也参与时间翻转检测）。 */
function tileFacts(key: BodyRowKey, m: SensePanelModel, now: number): Fact<unknown>[] {
  const f = rowFact(key, m.state.self.body)
  if (key !== 'disks') return [f]
  const df = f as DisksFact
  return [df, ...(df.value ?? []).map((d) => diskFact(df, d, now))]
}

/** 本行相关事件：匹配行指标的 body.rate/body.anomaly 且 at≤now——不设下界，
 *  明细「最近触发」展示全部历史事件，删掉旧事件也算相关变化。 */
function relevantEvents(
  events: SenseEvent[],
  keys: Set<string>,
  now: number,
): SenseEvent[] {
  return events.filter((e) => {
    const d = e.detail
    if (!d || (d.kind !== 'body.rate' && d.kind !== 'body.anomaly')) return false
    if (!keys.has(d.metric)) return false
    const at = e.signal.at
    return Number.isFinite(at) && at <= now
  })
}

/** 事件匹配的指标 key：磁盘取 value 里所有读数有效的挂载点（不止新鲜卷，
 *  陈旧卷的明细仍由历史事件驱动「最近触发」）。 */
function eventKeys(
  key: BodyRowKey,
  body: SensePanelModel['state']['self']['body'],
  now: number,
): Set<string> {
  if (key !== 'disks') return new Set(rowMetricKeys(key, body, now))
  return new Set(
    (body.disks.value ?? []).filter(diskValid).map((d) => `disk:${d.mount}`),
  )
}

/**
 * 指标卡片 memo：now/events 引用不算依赖。重渲条件：
 * 行严重度/可见性/完整性(partial)、回调、自身 deps 引用、相关事件集合
 * （at≤now 全历史，未来事件到点即入选；rate 事件跨 5 分钟徽标窗也算变化）、
 * 以及每个行事实在前后两个 now 的有效状态翻转（TTL 过期）。
 * 年龄由时钟订阅独立处理，图窗口随数据更新。
 */
export function memoTile(
  key: BodyRowKey,
  deps: (m: SensePanelModel) => readonly unknown[],
  C: (p: MetricTileProps) => ReactNode,
) {
  return memo(C, (a, b) => {
    if (
      a.rows[key].severity !== b.rows[key].severity ||
      a.rows[key].hidden !== b.rows[key].hidden ||
      a.rows[key].partial !== b.rows[key].partial ||
      a.ctx.onAdjust !== b.ctx.onAdjust ||
      a.ctx.onOpenPermissionSettings !== b.ctx.onOpenPermissionSettings
    ) {
      return false
    }
    const na = a.model.now
    const nb = b.model.now
    const fa = tileFacts(key, a.model, na)
    const fb = tileFacts(key, b.model, nb)
    if (fa.length !== fb.length) return false
    for (let i = 0; i < fa.length; i++) {
      if (effectiveStatus(fa[i]!, na) !== effectiveStatus(fb[i]!, nb)) return false
    }
    const keys = eventKeys(key, a.model.state.self.body, na)
    const ea = relevantEvents(a.model.events, keys, na)
    const eb = relevantEvents(b.model.events, keys, nb)
    if (ea.length !== eb.length || !ea.every((e, i) => e === eb[i])) return false
    // 同一 rate 事件在 na→nb 之间跨出 5 分钟徽标窗 → 徽标过期，需重渲
    for (const e of ea) {
      if (e.detail?.kind !== 'body.rate') continue
      const at = e.signal.at
      if (at >= na - 300_000 !== at >= nb - 300_000) return false
    }
    const da = deps(a.model)
    const db = deps(b.model)
    return da.length === db.length && da.every((d, i) => d === db[i])
  })
}
