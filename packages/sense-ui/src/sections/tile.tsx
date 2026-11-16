import { useState, type ReactNode } from 'react'
import { FactMeta, FactValue } from '../fact'
import { formatClock } from '../format'
import { effectiveStatus, isUsable, type Severity } from '../health'
import { Sparkline } from '../sparkline'
import { chartThresholds, thresholdRowText } from '../thresholds'
import type {
  Fact,
  MetricInsight,
  MetricKey,
  MetricPoint,
  SenseEvent,
  ThresholdLayer,
} from '../view-model'
import css from './body.module.css'
import dcss from './tile.module.css'

export const SEV_TAG: Record<string, string> = {
  warn: '注意',
  critical: '紧急',
  unknown: '未知',
}

export const LAYER_TEXT: Record<ThresholdLayer, string> = {
  floor: '底线',
  rate: '变化率',
  baseline: '基线',
}

const LAYERS: ThresholdLayer[] = ['floor', 'rate', 'baseline']

export interface TileProps {
  tileKey: string
  icon: ReactNode
  label: string
  sev: Severity
  /** Token 等宽卡片跨两列。 */
  span2?: boolean
  /** 展开区内容（图/阈值/触发/来源）；不传则卡片没有明细。 */
  detail?: ReactNode
  children: ReactNode
}

/**
 * 指标卡片：原生 details/summary 折叠。
 * summary 内只有静态内容（数值/图），交互控件一律放 detail。
 * 展开时卡片跨满整行宽。detail 仅在打开时挂载（收起不付出明细渲染开销），
 * 开合状态由原生 toggle 事件镜像，不反向控制 open 属性。
 */
export function Tile({
  tileKey,
  icon,
  label,
  sev,
  span2,
  detail,
  children,
}: TileProps) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className={css.tile}
      data-tile={tileKey}
      data-sev={sev}
      data-span2={span2 || undefined}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className={css.tileSummary}>
        <span className={css.tileHead}>
          {icon}
          <span className={css.tileLabel}>{label}</span>
          {sev !== 'good' && (
            <span className={css.sevTag} data-sev={sev}>
              {SEV_TAG[sev]}
            </span>
          )}
          <svg
            className={css.chev}
            width="8"
            height="8"
            viewBox="0 0 8 8"
            aria-hidden="true"
          >
            <path
              d="M2.5 1l3 3-3 3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        {children}
      </summary>
      {open && detail != null && (
        <div className={dcss.tileDetail}>{detail}</div>
      )}
    </details>
  )
}

export interface DetailMetric {
  key: MetricKey
  label: string
  points: MetricPoint[]
  format: (v: number) => string
  /** 当前值文案；事实不可用时省略显示「未提供」。 */
  valueText?: string
  /** 宿主事件投影的变化徽标（如 −2.1 GB/分）；未提供不显示。 */
  badge?: string
  insight?: MetricInsight
  severity?: Severity
  /** tokens 的动态窗口（默认底线按窗口计算）。 */
  tokenWindow?: number
  /**
   * 指标自己的事实（如磁盘按挂载点各算新鲜度）；缺省沿用卡片父事实，
   * 用于表头/消毒判定。
   */
  fact?: Fact<unknown>
}

/** 最近一次匹配指标的触发事件：忽略未来/非法时间戳（历史更早的事件仍算）。 */
function latestTriggerEvent(
  key: MetricKey,
  events: SenseEvent[],
  now: number,
): SenseEvent | null {
  let latest: SenseEvent | null = null
  for (const e of events) {
    const d = e.detail
    if (!d || d.kind === 'file.burst') continue
    if (d.metric !== key) continue
    const at = e.signal.at
    if (!Number.isFinite(at) || at > now) continue
    if (!latest || at > latest.signal.at) latest = e
  }
  return latest
}

type HeadText = 'current' | 'stale' | 'none'

const HEAD_PREFIX: Record<HeadText, string> = {
  current: '当前 ',
  stale: '上次读数 ',
  none: '',
}

function MetricBlock({
  m,
  now,
  events,
  head,
}: {
  m: DetailMetric
  now: number
  events: SenseEvent[]
  head: HeadText
}) {
  // 只有当前读数才画阈值线：stale/none 不再生成默认显示底线
  //（历史保留值上重画「当前」阈值会伪装成新鲜投影）。
  const chart =
    head === 'current'
      ? chartThresholds(m.key, m.insight, m.tokenWindow)
      : { lines: [] }
  const layers = (ls: ThresholdLayer[]) =>
    ls.length ? ls.map((l) => LAYER_TEXT[l]).join(' / ') : '未触发'
  const lastEvent = latestTriggerEvent(m.key, events, now)
  const missingSev =
    (m.insight?.triggered?.length ?? 0) > 0 && !m.insight?.severity
  return (
    <div
      className={dcss.metricBlock}
      data-metric={m.key}
      data-sev={m.severity}
      data-status={head === 'stale' ? 'stale' : undefined}
    >
      <div className={dcss.metricHead}>
        <span className={dcss.metricName}>{m.label}</span>
        <span>
          {HEAD_PREFIX[head]}
          {m.valueText ?? '未提供'}
          {m.badge ? <em className={dcss.badge}>{m.badge}</em> : null}
          {m.fact ? <FactMeta fact={m.fact} now={now} /> : null}
        </span>
      </div>
      <Sparkline
        expanded
        points={m.points}
        now={now}
        label={m.label}
        format={m.format}
        severity={m.severity}
        baseline={m.insight?.baseline}
        thresholds={chart.lines}
      />
      <div className={dcss.metricRows}>
        {LAYERS.map((layer) => (
          <div key={layer} className={dcss.metricRow}>
            <span className={dcss.metricRowKey}>{LAYER_TEXT[layer]}</span>
            <span>
              {thresholdRowText(m.key, layer, m.insight, m.tokenWindow, m.format)}
            </span>
          </div>
        ))}
      </div>
      <div className={dcss.metricRow}>
        <span className={dcss.metricRowKey}>触发</span>
        <span>
          {layers(m.insight?.triggered ?? [])}
          {missingSev ? '（宿主未给严重度）' : ''} · 最近触发：
          {lastEvent ? formatClock(lastEvent.signal.at) : '无'}
        </span>
      </div>
    </div>
  )
}

/**
 * 卡片展开区：事实状态 → 每指标大图 + 阈值/触发 → 来源 → 调整入口。
 * 事实不可用（stale/denied/…）时消毒指标：清 insight/徽标/动态窗口，
 * 保留历史曲线；stale 表头标「上次读数」、其余不可用不显示保留值。
 */
export function TileDetail({
  fact,
  now,
  metrics,
  events,
  onAdjust,
  onOpenPermissionSettings,
  extra,
}: {
  fact: Fact<unknown>
  now: number
  metrics: DetailMetric[]
  events: SenseEvent[]
  onAdjust?: () => void
  onOpenPermissionSettings: () => void
  extra?: ReactNode
}) {
  const usable = isUsable(fact, now)
  const headOf = (f: Fact<unknown>): HeadText =>
    isUsable(f, now)
      ? 'current'
      : effectiveStatus(f, now) === 'stale' && f.value !== null
        ? 'stale'
        : 'none'
  const head = headOf(fact)
  return (
    <>
      <div className={dcss.detailFact}>
        <FactValue
          fact={fact}
          now={now}
          onOpenPermissionSettings={onOpenPermissionSettings}
        >
          {() => null}
        </FactValue>
      </div>
      {metrics.map((m) => {
        // 指标自带事实（磁盘卷）时按自身新鲜度判定；否则沿用父事实
        const mf = m.fact ?? fact
        const mHead = m.fact ? headOf(mf) : head
        const mUsable = m.fact ? mHead === 'current' : usable
        return (
          <MetricBlock
            key={m.key}
            m={
              mUsable
                ? m
                : {
                    ...m,
                    insight: undefined,
                    badge: undefined,
                    tokenWindow: undefined,
                    // 非 stale 的不可用（denied/unavailable…）连保留值也不进明细
                    valueText: mHead === 'none' ? undefined : m.valueText,
                  }
            }
            now={now}
            events={events}
            head={mHead}
          />
        )
      })}
      {extra}
      <div className={dcss.detailMeta}>
        <span>
          来源 {fact.source.api} @ {fact.source.host}
        </span>
        <FactMeta fact={fact} now={now} />
        {onAdjust && (
          <button type="button" className={dcss.adjustBtn} onClick={onAdjust}>
            调整
          </button>
        )}
      </div>
    </>
  )
}
