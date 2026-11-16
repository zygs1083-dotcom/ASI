import type { MetricInsight, MetricPoint } from './view-model'
import type { Severity } from './health'
import type { SparkThreshold } from './thresholds'
import { useClock } from './clock'
import { HISTORY_WINDOW_MS, sampleHistory } from './history'
import { sevOf, sevCap, spreadLabels } from './geometry'
import css from './viz.module.css'

export { HISTORY_WINDOW_MS, sampleHistory } from './history'

interface SparklineProps {
  points: MetricPoint[]
  now: number
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

/**
 * 最近 5 分钟走势图。
 * x 域固定为 [now-300s, now]（稀疏点也按真实时间摆位）；y 域取数据/基线/阈值
 * 的并集。越界线段才染告警色，正常历史保持中性色；末点标记当前行级状态。
 * 数据不足给占位文案。
 */
export function Sparkline({
  points,
  now,
  label,
  format,
  severity,
  baseline,
  thresholds = [],
  expanded = false,
  className,
}: SparklineProps) {
  // Body 时钟让固定 5 分钟窗口随时间自行前进（外层卡片不重渲时图仍然准确）
  const effNow = useClock(now)
  const since = effNow - HISTORY_WINDOW_MS
  // 阈值传入采样器：越界/相等迁移的边界点强制保留（含未激活参考线的几何）
  const recent = sampleHistory(points, effNow, thresholds)

  if (recent.length < 2) return <span className={css.sparkEmpty}>暂无趋势数据</span>

  // 数据极值只来自观察点（无障碍文案）；绘图域再纳入基线带与阈值线保证可见。
  let dataMin = Infinity
  let dataMax = -Infinity
  for (const p of recent) {
    if (p.value < dataMin) dataMin = p.value
    if (p.value > dataMax) dataMax = p.value
  }
  const band =
    baseline && Number.isFinite(baseline.low) && Number.isFinite(baseline.high)
      ? baseline
      : null
  let min = dataMin
  let max = dataMax
  if (band) {
    min = Math.min(min, band.low)
    max = Math.max(max, band.high)
  }
  for (const t of thresholds) {
    if (Number.isFinite(t.value)) {
      min = Math.min(min, t.value)
      max = Math.max(max, t.value)
    }
  }
  const pad = (max - min) * 0.08 || Math.max(Math.abs(max) * 0.1, 1e-6)
  min -= pad
  max += pad
  const span = max - min

  const xOf = (at: number) => ((at - since) / HISTORY_WINDOW_MS) * 100
  const yOf = (v: number) => (1 - (v - min) / span) * 100

  // 逐段拆分：跨越激活阈值线的段在交点切开，越界部分单独着色。
  // 染色上限受行级 severity 约束（good/unknown 全中性，warn 不升 critical），
  // active=false 的参考线只画不切。
  const cap = sevCap(severity)
  const normalSegs: string[] = []
  const warnSegs: string[] = []
  const critSegs: string[] = []
  for (let i = 1; i < recent.length; i++) {
    const p0 = recent[i - 1]!
    const p1 = recent[i]!
    const x0 = xOf(p0.at)
    const x1 = xOf(p1.at)
    const cuts = thresholds
      .filter(
        (t) =>
          t.active !== false &&
          Number.isFinite(t.value) &&
          (p0.value - t.value) * (p1.value - t.value) < 0,
      )
      .map((t) => (t.value - p0.value) / (p1.value - p0.value))
      .sort((a, b) => a - b)
    let prev = 0
    for (const cut of [...cuts, 1]) {
      const xa = x0 + (x1 - x0) * prev
      const xb = x0 + (x1 - x0) * cut
      const ya = yOf(p0.value + (p1.value - p0.value) * prev)
      const yb = yOf(p0.value + (p1.value - p0.value) * cut)
      const mid = p0.value + (p1.value - p0.value) * ((prev + cut) / 2)
      const seg = sevOf(mid, thresholds)
      const capped = seg === null || cap === null ? null : seg === 'critical' && cap === 'warn' ? 'warn' : seg
      const bucket =
        capped === 'critical' ? critSegs : capped === 'warn' ? warnSegs : normalSegs
      bucket.push(`M${xa.toFixed(2)},${ya.toFixed(2)} L${xb.toFixed(2)},${yb.toFixed(2)}`)
      prev = cut
    }
  }

  const last = recent[recent.length - 1]!
  const thrMarks = expanded
    ? spreadLabels(
        thresholds
          .filter((t) => Number.isFinite(t.value))
          .map((t) => ({ t, y: Math.min(100, Math.max(0, yOf(t.value))) }))
          .sort((a, b) => a.y - b.y),
      )
    : []

  const summary =
    `${label}最近 5 分钟趋势：当前 ${format(last.value)}，最高 ${format(dataMax)}，` +
    `最低 ${format(dataMin)}` +
    (band ? `，基线区间 ${format(band.low)} 至 ${format(band.high)}` : '') +
    (thresholds.length
      ? `，阈值 ${thresholds
          .map((t) => `${t.label ?? '底线'} ${format(t.value)}`)
          .join(' / ')}`
      : '') +
    (severity ? `，当前状态${SEV_WORD[severity]}` : '')

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
          {band && (
            <rect
              data-baseline="true"
              className={css.sparkBand}
              x={0}
              y={yOf(band.high)}
              width={100}
              height={Math.max(1, yOf(band.low) - yOf(band.high))}
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
                y1={yOf(t.value)}
                y2={yOf(t.value)}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          <path
            className={css.segNormal}
            d={normalSegs.join(' ')}
            vectorEffect="non-scaling-stroke"
          />
          {warnSegs.length > 0 && (
            <path
              className={css.segWarn}
              data-out-of-range="warn"
              d={warnSegs.join(' ')}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {critSegs.length > 0 && (
            <path
              className={css.segCritical}
              data-out-of-range="critical"
              d={critSegs.join(' ')}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {(severity === 'warn' || severity === 'critical') && (
            <circle
              data-current={severity}
              className={
                severity === 'critical' ? css.curCritical : css.curWarn
              }
              cx={xOf(last.at)}
              cy={yOf(last.value)}
              r={1.5}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {expanded && (
          <>
            <span className={css.axisYMax}>{format(max)}</span>
            <span className={css.axisYMin}>{format(min)}</span>
            {thrMarks.map(({ t, y }, i) => (
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
          <span>现在</span>
        </div>
      )}
      <span className={css.srOnly}>{summary}</span>
    </div>
  )
}
