/**
 * 磁盘卡片：默认只显示「需要注意的盘」（触发 insight / 最差剩余比例），
 * 其余挂载点在明细里逐个展开，各自着色、不再重复行级标签。
 * 每卷可带 status/observedAt/ttlMs（diskFact 推导新鲜度）；
 * unavailableMounts 的挂载点只显示「无法读取」，无数字、无历史、无图。
 */

import { DisksStatusText, FactStatusText } from '../fact'
import { formatBytes, formatPercent, formatSignedDelta } from '../format'
import {
  diskFact,
  diskSeverity,
  diskUsable,
  diskValid,
  effectiveStatus,
  effectiveSeverity,
  maxSeverity,
  unavailableMountSet,
  type Severity,
} from '../health'
import { DiskIcon } from '../icons'
import { Sparkline } from '../sparkline'
import { chartThresholds } from '../thresholds'
import type {
  DiskVolume,
  MetricInsight,
  MetricKey,
  SenseEvent,
} from '../view-model'
import { Tile, type DetailMetric } from './tile'
import { DisksDetail } from './disks-detail'
import { memoTile, type MetricTileProps } from './tiles-basic'
import css from './body.module.css'

type Disk = DiskVolume
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
    fresh ? effectiveSeverity(insights[`disk:${d.mount}`]) : 'good',
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
function FreeStrip({ d, label }: { d: Disk; label?: boolean }) {
  const remaining =
    d.total > 0 ? Math.min(1, Math.max(0, d.free / d.total)) : 0
  return (
    <span className={css.stripWrap}>
      {label ? <span className={css.stripText}>剩余</span> : null}
      <span className={css.memStrip} aria-hidden="true">
        <i
          className={css.diskUsed}
          data-strip="remaining"
          data-ratio={remaining}
          style={{ width: `${remaining * 100}%` }}
        />
      </span>
    </span>
  )
}

export const DisksTile = memoTile(
  'disks',
  (m) => [
    m.state.self.body.disks,
    m.history.disks,
    // 只盯本卡用到的挂载点 insight，无关指标 insight 更新不重渲
    ...(m.state.self.body.disks.value ?? []).map(
      (d) => m.insights?.[`disk:${d.mount}` as const],
    ),
  ],
  function DisksTile({ model, rows, ctx }: MetricTileProps) {
  const { disks } = model.state.self.body
  const { now, events, insights } = model
  const unavail = unavailableMountSet(disks)
  // 卷级状态权威：父级失鲜/拒绝不再整列置灰，显式新鲜卷照常展示
  const raw = disks.value ?? []
  const usable = (d: Disk): boolean => diskUsable(disks, d, now)

  // 可展示卷：有效读数、带卷级元数据（stale 保留值/unknown 状态行）、或
  // unavailableMounts（value 未含也补「无法读取」）；无元数据无效读数不展示
  const entries: Disk[] = [
    ...(raw ?? []).filter(
      (d) =>
        diskValid(d) ||
        unavail.has(d.mount) ||
        d.status != null ||
        d.observedAt != null ||
        d.ttlMs != null,
    ),
    ...[...unavail]
      .filter((m) => !(raw ?? []).some((d) => d.mount === m))
      .map((m) => ({ mount: m, total: 0, free: 0 })),
  ]
  const freshVols = entries.filter(usable)
  // 主摘要选盘：新鲜告警卷 > 根卷非新鲜（陈旧值优先展示根）> 最差新鲜卷
  const worstFresh = freshVols.length
    ? attentionDisk(freshVols, insights ?? {}, true)
    : null
  const alert =
    worstFresh && SEV_RANK[diskSev(worstFresh, insights ?? {}, true)] > 0
      ? worstFresh
      : null
  const root = entries.find((d) => d.mount === '/')
  const focus =
    alert ?? (root && !usable(root) ? root : null) ?? worstFresh ?? entries[0] ?? null
  const sev = (d: Disk): Severity =>
    usable(d) ? diskSev(d, insights ?? {}, true) : 'unknown'
  const focusDf =
    focus && diskValid(focus) && !unavail.has(focus.mount)
      ? diskFact(disks, focus, now)
      : null
  const focusEff = focusDf ? effectiveStatus(focusDf, now) : null
  const focusUsable = focus != null && usable(focus)

  // 明细图块只给 ok/stale 卷：unavailable/unknown 卷无读数，不产数字与图
  const metrics: DetailMetric[] = entries
    .filter((d) => {
      if (unavail.has(d.mount) || !diskValid(d)) return false
      const s = effectiveStatus(diskFact(disks, d, now), now)
      return s === 'ok' || s === 'stale'
    })
    .map((d) => {
      const key = `disk:${d.mount}` as const
      const u = usable(d)
      return {
        key,
        label: `磁盘 ${d.mount} 已用率`,
        points: model.history.disks[d.mount] ?? [],
        format: formatPercent,
        valueText: `剩余 ${formatBytes(d.free)} / ${formatBytes(d.total)}`,
        badge: u ? rateBadge(key, events, now) : undefined,
        insight: u ? insights?.[key] : undefined,
        severity: sev(d),
        fact: diskFact(disks, d, now),
      }
    })

  return (
    <Tile
      tileKey="disks"
      icon={<DiskIcon />}
      label="磁盘"
      sev={rows.disks.severity}
      detail={
        <DisksDetail
          disks={disks}
          now={now}
          events={events}
          onAdjust={ctx.onAdjust}
          onOpenPermissionSettings={ctx.onOpenPermissionSettings}
          metrics={metrics}
          extra={
            entries.map((d) => {
              if (unavail.has(d.mount)) {
                return (
                  <div key={d.mount} className={css.detailLine} data-sev="unknown">
                    {d.mount} 无法读取
                  </div>
                )
              }
              return (
                <div key={d.mount} className={css.detailLine} data-sev={sev(d)}>
                  {d.mount}{' '}
                  <FactStatusText fact={diskFact(disks, d, now)} now={now}>
                    {(v) => <FreeStrip d={v} label />}
                  </FactStatusText>
                </div>
              )
            })
          }
        />
      }
    >
      {rows.disks.partial ? (
        <span className={css.tileSub} data-partial>
          部分 · 数据待补全
        </span>
      ) : null}
      {focus == null ? (
        // 无可展示卷时父事实兜底：denied 原因 / 不可用状态 / 无有效读数
        <DisksStatusText fact={disks} now={now}>
          {() => <span className={css.tileSub}>无有效磁盘读数</span>}
        </DisksStatusText>
      ) : unavail.has(focus.mount) || !diskValid(focus) ? (
        <span className={css.tileSub}>
          {focus.mount} {unavail.has(focus.mount) ? '无法读取' : '· 未知'}
        </span>
      ) : focusEff !== 'ok' && focusEff !== 'stale' ? (
        <span className={css.tileSub}>
          {focus.mount} ·{' '}
          <FactStatusText fact={focusDf!} now={now}>
            {() => null}
          </FactStatusText>
        </span>
      ) : (
        // 卷级事实标注：新鲜告警卷优先，陈旧值灰显，父级不再一票置灰
        <FactStatusText fact={focusDf!} now={now}>
          {(d) => (
            <>
              <span className={css.tileValue}>
                <span className={css.mainLabel}>剩余</span>
                {formatBytes(d.free)}
              </span>
              <span className={css.tileSub}>
                共 {formatBytes(d.total)} · {d.mount}
                {entries.length > 1 ? ` · 共 ${entries.length} 盘` : ''}
                {focusUsable && rateBadge(`disk:${d.mount}`, events, now) ? (
                  <em className={css.rateEm}>
                    {rateBadge(`disk:${d.mount}`, events, now)}
                  </em>
                ) : null}
              </span>
              <FreeStrip d={d} />
              <Sparkline
                metric={`disk:${d.mount}`}
                points={model.history.disks[d.mount] ?? []}
                now={now}
                label={`磁盘 ${d.mount} 已用率`}
                format={formatPercent}
                severity={sev(focus)}
                baseline={
                  focusUsable
                    ? insights?.[`disk:${d.mount}`]?.baseline
                    : undefined
                }
                thresholds={
                  focusUsable
                    ? chartThresholds(`disk:${d.mount}`, insights?.[`disk:${d.mount}`])
                        .lines
                    : []
                }
              />
            </>
          )}
        </FactStatusText>
      )}
    </Tile>
  )
})
