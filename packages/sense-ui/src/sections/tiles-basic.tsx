/** CPU / 内存 指标卡片（温控/电池见 tiles-extra）。 */

import { memo, type ReactNode } from 'react'
import { FactStatusText } from '../fact'
import {
  formatBytes,
  formatLoad,
  formatPercent,
} from '../format'
import {
  diskFact,
  diskValid,
  effectiveStatus,
  isUsable,
  rowFact,
  rowMetricKeys,
  type BodyRowKey,
} from '../health'
import { Sparkline } from '../sparkline'
import { chartThresholds } from '../thresholds'
import { CpuIcon, MemoryIcon } from '../icons'
import type {
  DisksFact,
  Fact,
  SenseEvent,
  SensePanelModel,
  SensePanelProps,
} from '../view-model'
import { Tile, TileDetail } from './tile'
import css from './body.module.css'

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
 * 行严重度/可见性、回调、自身 deps 引用、相关事件集合（at≤now 全历史，
 * 未来事件到点即入选；rate 事件跨 5 分钟徽标窗也算变化）、以及每个行事实
 * 在前后两个 now 的有效状态翻转（TTL 过期）。年龄/图窗口前进由 BodyClock 独立处理。
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

const PRESSURE_TEXT = {
  normal: '压力正常',
  warn: '压力偏高',
  critical: '压力过载',
} as const

const MEM_PARTS = [
  { key: 'app', label: 'App', cls: css.memApp },
  { key: 'wired', label: '联动', cls: css.memWired },
  { key: 'compressed', label: '压缩', cls: css.memCompressed },
  { key: 'cached', label: '缓存', cls: css.memCached },
] as const

export const CpuTile = memoTile(
  'cpu',
  (m) => [m.state.self.body.cpu, m.insights?.cpu, m.history.cpu],
  function CpuTile({ model, rows, ctx }: MetricTileProps) {
  const { cpu } = model.state.self.body
  const { now } = model
  const fresh = isUsable(cpu, now)
  const v = fresh ? cpu.value! : null
  const thr = fresh ? chartThresholds('cpu', model.insights?.cpu) : { lines: [] }
  return (
    <Tile
      tileKey="cpu"
      icon={<CpuIcon />}
      label="CPU"
      sev={rows.cpu.severity}
      detail={
        <TileDetail
          fact={cpu}
          now={now}
          events={model.events}
          onAdjust={ctx.onAdjust}
          onOpenPermissionSettings={ctx.onOpenPermissionSettings}
          metrics={[
            {
              key: 'cpu',
              label: 'CPU 使用率',
              points: model.history.cpu,
              format: formatPercent,
              valueText: cpu.value ? formatPercent(cpu.value.usage) : undefined,
              insight: model.insights?.cpu,
              severity: rows.cpu.severity,
            },
          ]}
          extra={
            v && (
              <div className={css.detailLine}>
                负载 {formatLoad(v.load1)} / {formatLoad(v.load5)} /{' '}
                {formatLoad(v.load15)}
              </div>
            )
          }
        />
      }
    >
      <FactStatusText fact={cpu} now={now}>
        {(val) => (
          <>
            <span className={css.tileValue}>{formatPercent(val.usage)}</span>
            <span className={css.tileSub}>
              负载 {formatLoad(val.load1)} / {formatLoad(val.load5)} /{' '}
              {formatLoad(val.load15)}
            </span>
            <Sparkline
              points={model.history.cpu}
              now={now}
              label="CPU 使用率"
              format={formatPercent}
              severity={rows.cpu.severity}
              baseline={fresh ? model.insights?.cpu?.baseline : undefined}
              thresholds={thr.lines}
            />
            <span className={css.cores} aria-hidden="true">
              {val.perCore.map((c, i) => (
                <i key={i} style={{ height: `${Math.round(Math.min(1, Math.max(0, c)) * 100)}%` }} />
              ))}
            </span>
          </>
        )}
      </FactStatusText>
    </Tile>
  )
})

export const MemoryTile = memoTile(
  'memory',
  (m) => [m.state.self.body.memory, m.insights?.memory, m.history.memory],
  function MemoryTile({ model, rows, ctx }: MetricTileProps) {
  const { memory } = model.state.self.body
  const { now } = model
  const fresh = isUsable(memory, now)
  const v = fresh ? memory.value! : null
  const thr = fresh ? chartThresholds('memory', model.insights?.memory) : { lines: [] }
  return (
    <Tile
      tileKey="memory"
      icon={<MemoryIcon />}
      label="内存"
      sev={rows.memory.severity}
      detail={
        <TileDetail
          fact={memory}
          now={now}
          events={model.events}
          onAdjust={ctx.onAdjust}
          onOpenPermissionSettings={ctx.onOpenPermissionSettings}
          metrics={[
            {
              key: 'memory',
              label: '内存占用',
              points: model.history.memory,
              format: formatPercent,
              valueText: memory.value
                ? `${formatBytes(memory.value.used)} / ${formatBytes(memory.value.total)}`
                : undefined,
              insight: model.insights?.memory,
              severity: rows.memory.severity,
            },
          ]}
          extra={
            <>
              <div className={css.detailLine}>
                {v?.breakdown
                  ? MEM_PARTS.map(
                      (p) => `${p.label} ${formatBytes(v.breakdown![p.key])}`,
                    ).join(' · ')
                  : '内存细分未提供'}
              </div>
              {v && (
                <div className={css.detailLine}>
                  交换 {formatBytes(v.swapUsed)}
                </div>
              )}
            </>
          }
        />
      }
    >
      <FactStatusText fact={memory} now={now}>
        {(val) => (
          <>
            <span className={css.tileValue}>{formatBytes(val.used)}</span>
            <span className={css.tileSub}>
              共 {formatBytes(val.total)} · {PRESSURE_TEXT[val.pressure]}
            </span>
            {val.breakdown ? (
              <span className={css.memStrip} aria-hidden="true">
                {MEM_PARTS.map((p) => (
                  <i
                    key={p.key}
                    className={p.cls}
                    style={{
                      width: `${Math.min(
                        100,
                        Math.max(0, (val.breakdown![p.key] / Math.max(1, val.total)) * 100),
                      )}%`,
                    }}
                  />
                ))}
              </span>
            ) : (
              <span className={css.memStrip} aria-hidden="true">
                <i
                  className={css.memApp}
                  style={{
                    width: `${Math.min(100, Math.max(0, (val.used / Math.max(1, val.total)) * 100))}%`,
                  }}
                />
              </span>
            )}
            <Sparkline
              points={model.history.memory}
              now={now}
              label="内存占用"
              format={formatPercent}
              severity={rows.memory.severity}
              baseline={fresh ? model.insights?.memory?.baseline : undefined}
              thresholds={thr.lines}
            />
          </>
        )}
      </FactStatusText>
    </Tile>
  )
})
