/**
 * 磁盘卡片：默认只显示「需要注意的盘」（触发 insight / 最差剩余比例），
 * 其余挂载点在明细里逐个展开，各自着色、不再重复行级标签。
 */

import { FactStatusText } from '../fact'
import { formatBytes, formatPercent, formatSignedDelta } from '../format'
import {
  diskSeverity,
  effectiveStatus,
  isUsable,
  maxSeverity,
  type Severity,
} from '../health'
import { DiskIcon } from '../icons'
import { Sparkline } from '../sparkline'
import { chartThresholds } from '../thresholds'
import type {
  Fact,
  MetricInsight,
  MetricKey,
  SenseEvent,
} from '../view-model'
import { Tile, TileDetail, type DetailMetric } from './tile'
import type { TileCtx } from './tiles-basic'
import css from './body.module.css'

type Disk = { mount: string; total: number; free: number }
type Rows = ReturnType<typeof import('../health').evaluateBody>['rows']
type Insights = Partial<Record<MetricKey, MetricInsight>>

const SEV_RANK: Record<Severity, number> = {
  good: 0,
  unknown: 0,
  warn: 1,
  critical: 2,
}

/** 最近 5 分钟内匹配的 body.rate 事件 → 每分钟变化徽标（如 −2.1 GB/分）。 */
export function rateBadge(
  metric: MetricKey,
  events: SenseEvent[],
  now: number,
): string | undefined {
  let latest: { at: number; text: string } | null = null
  for (const e of events) {
    const d = e.detail
    if (!d || d.kind !== 'body.rate' || d.metric !== metric) continue
    const at = e.signal.at
    if (!Number.isFinite(at) || at > now || at < now - 300_000) continue
    if (!Number.isFinite(d.windowMs) || d.windowMs <= 0) continue
    const perMin = d.delta / (d.windowMs / 60_000)
    if (!Number.isFinite(perMin)) continue
    const text = `${formatSignedDelta(perMin, d.unit)}/分`
    if (!latest || at > latest.at) latest = { at, text }
  }
  return latest?.text
}

function diskSev(d: Disk, insights: Insights, fresh: boolean): Severity {
  const freeRatio = d.total > 0 ? d.free / d.total : 0
  return maxSeverity(
    diskSeverity(freeRatio),
    fresh ? (insights[`disk:${d.mount}`]?.severity ?? 'good') : 'good',
  )
}

/** 需要注意的盘：严重度最高者优先，同级取剩余比例最低。 */
function attentionDisk(disks: Disk[], insights: Insights, fresh: boolean): Disk {
  return disks.reduce((best, d) => {
    const sevD = SEV_RANK[diskSev(d, insights, fresh)]
    const sevB = SEV_RANK[diskSev(best, insights, fresh)]
    if (sevD !== sevB) return sevD > sevB ? d : best
    const ratio = (x: Disk) => (x.total > 0 ? x.free / x.total : 0)
    return ratio(d) < ratio(best) ? d : best
  })
}

/** 剩余比例条：填充宽度 = free/total（剩余量），不是已用占比。 */
function FreeStrip({ d }: { d: Disk }) {
  const remaining =
    d.total > 0 ? Math.min(1, Math.max(0, d.free / d.total)) : 0
  return (
    <span className={css.memStrip} aria-hidden="true">
      <i
        className={css.diskUsed}
        data-strip="remaining"
        data-ratio={remaining}
        style={{ width: `${remaining * 100}%` }}
      />
    </span>
  )
}

export function DisksTile({
  model,
  rows,
  ctx,
}: {
  model: TileCtx['model']
  rows: Rows
  ctx: TileCtx
}) {
  const { disks } = model.state.self.body
  const { now, events, insights } = model
  const fresh = isUsable(disks, now)
  // 过期但保留值：列表仍可展示，严重度/速率徽标一律降级为未知、不引用 insight
  const stale = !fresh && effectiveStatus(disks, now) === 'stale'
  const list = fresh || (stale && disks.value !== null) ? disks.value! : null
  const focus = list?.length ? attentionDisk(list, insights ?? {}, fresh) : null
  const sev = (d: Disk): Severity =>
    stale ? 'unknown' : diskSev(d, insights ?? {}, fresh)

  const metrics: DetailMetric[] = (list ?? []).map((d) => {
    const key = `disk:${d.mount}` as const
    const ins = fresh ? insights?.[key] : undefined
    return {
      key,
      label: `磁盘 ${d.mount}`,
      points: model.history.disks[d.mount] ?? [],
      format: formatPercent,
      valueText: `剩余 ${formatBytes(d.free)} / ${formatBytes(d.total)}`,
      badge: fresh ? rateBadge(key, events, now) : undefined,
      insight: ins,
      severity: sev(d),
    }
  })

  return (
    <Tile
      tileKey="disks"
      icon={<DiskIcon />}
      label="磁盘"
      sev={rows.disks.severity}
      detail={
        <TileDetail
          fact={disks}
          now={now}
          events={events}
          onAdjust={ctx.onAdjust}
          onOpenPermissionSettings={ctx.onOpenPermissionSettings}
          metrics={metrics}
          extra={
            list?.map((d) => (
              <div key={d.mount} className={css.detailLine} data-sev={sev(d)}>
                {d.mount} <FreeStrip d={d} />
              </div>
            ))
          }
        />
      }
    >
      <FactStatusText fact={disks} now={now}>
        {(val) =>
          focus &&
          val.length > 0 && (
            <>
              <span className={css.tileValue}>
                <span className={css.mainLabel}>剩余</span>
                {formatBytes(focus.free)}
              </span>
              <span className={css.tileSub}>
                共 {formatBytes(focus.total)} · {focus.mount}
                {val.length > 1 ? ` · 共 ${val.length} 盘` : ''}
                {fresh && rateBadge(`disk:${focus.mount}`, events, now) ? (
                  <em className={css.rateEm}>
                    {rateBadge(`disk:${focus.mount}`, events, now)}
                  </em>
                ) : null}
              </span>
              <FreeStrip d={focus} />
              <Sparkline
                points={model.history.disks[focus.mount] ?? []}
                now={now}
                label={`磁盘 ${focus.mount} 使用率`}
                format={formatPercent}
                severity={sev(focus)}
                baseline={insights?.[`disk:${focus.mount}`]?.baseline}
                thresholds={
                  chartThresholds(
                    `disk:${focus.mount}`,
                    insights?.[`disk:${focus.mount}`],
                  ).lines
                }
              />
            </>
          )
        }
      </FactStatusText>
    </Tile>
  )
}
