import type { MetricInsight, MetricPoint } from './view-model'
import type { Severity } from './health'
import css from './viz.module.css'

export const HISTORY_WINDOW_MS = 5 * 60 * 1000

interface SparklineProps {
  points: MetricPoint[]
  now: number
  label: string
  format: (v: number) => string
  /** 严重度决定描边色（data-sev 驱动 CSS）。 */
  severity?: Severity
  /** 与 points 同单位的基线区间；未提供不画带、不虚构。 */
  baseline?: MetricInsight['baseline']
  className?: string
}

/**
 * 最近 5 分钟迷你走势图。
 * 只取 [now-300s, now] 的点并按时间排序；数据不足显示占位文案，不虚构曲线。
 */
export function Sparkline({
  points,
  now,
  label,
  format,
  severity,
  baseline,
  className,
}: SparklineProps) {
  const since = now - HISTORY_WINDOW_MS
  const recent = points
    .filter((p) => p.at >= since && p.at <= now)
    .sort((a, b) => a.at - b.at)

  if (recent.length < 2) {
    return <span className={css.sparkEmpty}>暂无趋势数据</span>
  }

  const w = 72
  const h = 20
  const values = recent.map((p) => p.value)
  // 数据极值只来自观察点（无障碍文案）；绘图域再纳入基线带保证带可见。
  const dataMin = Math.min(...values)
  const dataMax = Math.max(...values)
  const min = baseline ? Math.min(dataMin, baseline.low) : dataMin
  const max = baseline ? Math.max(dataMax, baseline.high) : dataMax
  const span = max - min || 1
  const t0 = recent[0]!.at
  const tSpan = (recent[recent.length - 1]!.at - t0) || 1
  const yOf = (v: number) => h - 2 - ((v - min) / span) * (h - 4)
  const d = recent
    .map((p, i) => {
      const x = ((p.at - t0) / tSpan) * w
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${yOf(p.value).toFixed(1)}`
    })
    .join(' ')
  const last = values[values.length - 1]!

  return (
    <>
      <svg
        className={className ?? css.spark}
        data-sev={severity}
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        aria-hidden="true"
      >
        {baseline && (
          <rect
            data-baseline="true"
            className={css.sparkBand}
            x={0}
            y={yOf(baseline.high)}
            width={w}
            height={Math.max(1, yOf(baseline.low) - yOf(baseline.high))}
          />
        )}
        <path d={d} fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
      <span className={css.srOnly}>
        {label}最近 5 分钟趋势：当前 {format(last)}，最高 {format(dataMax)}，最低{' '}
        {format(dataMin)}
        {baseline
          ? `，基线区间 ${format(baseline.low)} 至 ${format(baseline.high)}`
          : ''}
      </span>
    </>
  )
}
