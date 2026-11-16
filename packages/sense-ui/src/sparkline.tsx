import { memo, useRef } from 'react'
import { useClock, useSampling } from './clock'
import { formatAge } from './format'
import type { Severity } from './health'
import { buildSpark, sameThresholds } from './geometry'
import type { SparkThreshold } from './thresholds'
import type { MetricInsight, MetricKey, MetricPoint } from './view-model'
import css from './viz.module.css'

export { HISTORY_WINDOW_MS, sampleHistory } from './history'

interface SparklineProps {
  points: MetricPoint[]
  now: number
  sampleIntervalMs?: number
  metric?: MetricKey
  paused?: boolean
  label: string
  format: (v: number) => string
  /** 严重度决定容器 data-sev 与末点标记（颜色只作用于越界段，不整体染色）。 */
  severity?: Severity
  /** 与 points 同单位的基线区间；未提供不画带、不虚构。 */
  baseline?: MetricInsight['baseline']
  /** 阈值线；未提供不画线。 */
  thresholds?: SparkThreshold[]
  /** 展开图（约 110px）：附加 y 极值、-5min/now 坐标与阈值标注。 */
  expanded?: boolean
  className?: string
}

const SEV_WORD: Record<Severity, string> = {
  good: '良好',
  warn: '注意',
  critical: '紧急',
  unknown: '未知',
}

interface GeoKey {
  points: MetricPoint[]
  thresholds: SparkThreshold[]
  baseLow?: number
  baseHigh?: number
  severity?: Severity
  expanded: boolean
}

function sameGeoKey(a: GeoKey | undefined, b: GeoKey): boolean {
  return (
    a !== undefined &&
    a.points === b.points &&
    a.baseLow === b.baseLow &&
    a.baseHigh === b.baseHigh &&
    a.severity === b.severity &&
    a.expanded === b.expanded &&
    sameThresholds(a.thresholds, b.thresholds)
  )
}

/**
 * 最近 5 分钟走势图。
 * x 域固定为 [anchor-300s, anchor]：锚点是最近一次「数据/语义更新」时的 now——
 * 纯时钟推进只刷新 FactMeta 等年龄文案，不驱动窗口前进、不重采样、不重算路径
 * （图窗口随数据更新前进，刻意不做时钟跟随）。越界线段才染告警色，正常历史
 * 保持中性色；末点标记当前行级状态。数据不足给占位文案。
 */
function SparklineBase({
  points,
  now,
  sampleIntervalMs,
  metric,
  paused: pausedProp,
  label,
  format,
  severity,
  baseline,
  thresholds = [],
  expanded = false,
  className,
}: SparklineProps) {
  // 降采样 + 路径几何按几何键缓存：format/label/className 变化只重排文案。
  // now 不进键：只有数据/语义变化才以本次渲染的 now 重锚 5 分钟窗口。
  const key: GeoKey = {
    points,
    thresholds,
    baseLow: baseline?.low,
    baseHigh: baseline?.high,
    severity,
    expanded,
  }
  const clock = useClock(now)
  const sampling = useSampling(metric, sampleIntervalMs)
  const cache = useRef<{ key: GeoKey; anchor: number; built: ReturnType<typeof buildSpark> }>()
  if (!sameGeoKey(cache.current?.key, key)) {
    const anchor = cache.current?.key.points === points ? cache.current.anchor : now
    cache.current = {
      key,
      anchor,
      built: buildSpark(points, anchor, { baseline, thresholds, severity, expanded }),
    }
  }
  const built = cache.current!.built

  if (!built) return <span className={css.sparkEmpty}>暂无趋势数据</span>
  const { g } = built
  const paused = pausedProp ?? sampling.paused
  const lagging = !paused && clock - g.last.at > 3 * sampling.interval
  const historical = paused || lagging
  const age = formatAge(clock, g.last.at)
  const historyText = `${paused ? '采集暂停' : '数据滞后'} · 最后 ${age}`

  const summary =
    `${label}${historical ? `历史 5 分钟趋势，${historyText}：上次` : '最近 5 分钟趋势：当前'} ${format(g.last.value)}，最高 ${format(g.dataMax)}，` +
    `最低 ${format(g.dataMin)}` +
    (g.band ? `，基线区间 ${format(g.band.low)} 至 ${format(g.band.high)}` : '') +
    (thresholds.length
      ? `，阈值 ${thresholds
          .map((t) => `${t.label ?? '底线'} ${format(t.value)}`)
          .join(' / ')}`
      : '') +
    (severity && !historical ? `，当前状态${SEV_WORD[severity]}` : '')

  return (
    <div className={expanded ? css.chartBoxExpanded : css.chartBox}>
      <div className={css.chartPlot}>
        <svg
          className={className ?? (expanded ? css.chartExpanded : css.spark)}
          data-sev={severity}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {g.band && (
            <rect
              data-baseline="true"
              className={css.sparkBand}
              x={0}
              y={g.yOf(g.band.high)}
              width={100}
              height={Math.max(1, g.yOf(g.band.low) - g.yOf(g.band.high))}
            />
          )}
          {thresholds
            .filter((t) => Number.isFinite(t.value))
            .map((t, i) => (
              <line
                key={i}
                data-threshold={t.sev}
                className={t.sev === 'critical' ? css.thrCritical : css.thrWarn}
                x1={0}
                x2={100}
                y1={g.yOf(t.value)}
                y2={g.yOf(t.value)}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          <path
            className={css.segNormal}
            d={g.normalSegs.join(' ')}
            vectorEffect="non-scaling-stroke"
          />
          {g.warnSegs.length > 0 && (
            <path
              className={css.segWarn}
              data-out-of-range="warn"
              d={g.warnSegs.join(' ')}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {g.critSegs.length > 0 && (
            <path
              className={css.segCritical}
              data-out-of-range="critical"
              d={g.critSegs.join(' ')}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {!historical && (severity === 'warn' || severity === 'critical') && (
            <circle
              data-current={severity}
              className={
                severity === 'critical' ? css.curCritical : css.curWarn
              }
              cx={g.xOf(g.last.at)}
              cy={g.yOf(g.last.value)}
              r={1.5}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {expanded && (
          <>
            <span className={css.axisYMax}>{format(g.max)}</span>
            <span className={css.axisYMin}>{format(g.min)}</span>
            {g.thrMarks.map(({ t, y }, i) => (
              <span
                key={i}
                className={css.thrLabel}
                data-sev={t.sev}
                style={{ top: `${y}%` }}
              >
                {t.label ? `${t.label} ` : ''}
                {format(t.value)}
              </span>
            ))}
          </>
        )}
      </div>
      {expanded && (
        <div className={css.axisX}>
          <span>-5 分钟</span>
          <span>{historical ? historyText : '现在'}</span>
        </div>
      )}
      {historical && !expanded && <div className={css.axisX} aria-hidden="true">{historyText}</div>}
      <span className={css.srOnly}>{summary}</span>
    </div>
  )
}

// 纯时钟推进（now 变化但数据/语义相同）不重渲：重渲条件为 points 引用、
// label/format/severity/expanded/className、基线标量与阈值语义值的变化。
export const Sparkline = memo(
  SparklineBase,
  (a, b) =>
    a.points === b.points &&
    a.now === b.now &&
    a.sampleIntervalMs === b.sampleIntervalMs &&
    a.metric === b.metric &&
    a.paused === b.paused &&
    a.label === b.label &&
    a.format === b.format &&
    a.severity === b.severity &&
    (a.expanded ?? false) === (b.expanded ?? false) &&
    a.className === b.className &&
    a.baseline?.low === b.baseline?.low &&
    a.baseline?.high === b.baseline?.high &&
    sameThresholds(a.thresholds ?? [], b.thresholds ?? []),
)
