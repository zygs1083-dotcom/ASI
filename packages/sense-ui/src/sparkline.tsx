import type { MetricInsight, MetricPoint } from './view-model'
import type { Severity } from './health'
import type { SparkThreshold } from './thresholds'
import { useClock } from './clock'
import css from './viz.module.css'

export const HISTORY_WINDOW_MS = 5 * 60 * 1000

/** 折线最多绘制的原始观测点数：2×119 桶 + 首末 = 240。 */
const MAX_PLOT_POINTS = 240
const BUCKETS = MAX_PLOT_POINTS / 2 - 1 // 119

/**
 * 预渲染降采样：窗口内有效点 ≤240 原样保留（仅按时间排序）；超过则分
 * 119 桶各留 min/max + 首末端点，O(n)。另对任一有限 thresholds（含未
 * 激活参考线）发生「穿越/相等状态迁移」的相邻点对两点都强制保留——容量
 * 为软上限（≤240 普通采样 + 不设上限的越界边界点），不静默丢弃 excursion。
 * 同时间戳按输入顺序稳定（仅非非降序时才排序），末点为最晚时间戳的最后点。
 */
export function sampleHistory(
  points: MetricPoint[],
  now: number,
  thresholds: SparkThreshold[] = [],
): MetricPoint[] {
  const since = now - HISTORY_WINDOW_MS
  const valid: MetricPoint[] = []
  for (const p of points) {
    if (!Number.isFinite(p.at) || !Number.isFinite(p.value) || p.at < since || p.at > now) continue
    valid.push(p)
  }
  // 已按时间非降序则零拷贝；否则稳定排序（同时间戳保留原始顺序）
  let sorted = valid
  for (let i = 1; i < valid.length; i++) {
    if (valid[i]!.at < valid[i - 1]!.at) {
      sorted = [...valid].sort((a, b) => a.at - b.at)
      break
    }
  }
  if (sorted.length <= MAX_PLOT_POINTS) return sorted

  const buckets: ({ min: MetricPoint; max: MetricPoint } | undefined)[] = new Array(BUCKETS)
  for (const p of sorted) {
    const i = Math.min(BUCKETS - 1, Math.floor(((p.at - since) / HISTORY_WINDOW_MS) * BUCKETS))
    const b = buckets[i]
    if (!b) buckets[i] = { min: p, max: p }
    else {
      if (p.value < b.min.value) b.min = p
      if (p.value > b.max.value) b.max = p
    }
  }
  const kept = new Set<MetricPoint>([sorted[0]!, sorted[sorted.length - 1]!])
  for (const b of buckets) if (b) { kept.add(b.min); kept.add(b.max) }

  // 阈值方位（下方/恰等/上方）在相邻点间变化时两点都保留；sorted 已按
  // (时间, 原始序号) 排好，filter 保序输出。
  const finite = thresholds.filter((t) => Number.isFinite(t.value))
  if (finite.length > 0) {
    for (const t of finite) {
      const side = (v: number) => (v < t.value ? -1 : v > t.value ? 1 : 0)
      for (let i = 1; i < sorted.length; i++) {
        if (side(sorted[i]!.value) !== side(sorted[i - 1]!.value)) {
          kept.add(sorted[i - 1]!)
          kept.add(sorted[i]!)
        }
      }
    }
  }
  return sorted.filter((p) => kept.has(p))
}

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

type SegSev = 'warn' | 'critical'

const SEV_WORD: Record<Severity, string> = {
  good: '良好',
  warn: '注意',
  critical: '紧急',
  unknown: '未知',
}

/** 值相对激活阈值线的告警级；active=false 的信息参考线不参与分类。 */
function sevOf(v: number, thresholds: SparkThreshold[]): SegSev | null {
  let hit: SegSev | null = null
  for (const t of thresholds) {
    if (t.active === false) continue
    const beyond = t.direction === 'above' ? v >= t.value : v <= t.value
    if (beyond && hit !== 'critical') hit = t.sev
  }
  return hit
}

/**
 * 曲线告警上限：critical/未给 severity → 允许 critical；
 * warn → 至多 warn（fallback critical 越线也只染 warn）；
 * good/unknown → 全部中性（历史越线不冒充当前告警）。
 */
function sevCap(severity: Severity | undefined): SegSev | null {
  if (severity === undefined || severity === 'critical') return 'critical'
  return severity === 'warn' ? 'warn' : null
}

/** 展开图阈值标注：按线位排序后保证 ≥13px/110px 间距并夹在图内。 */
function spreadLabels(
  marks: { t: SparkThreshold; y: number }[],
): { t: SparkThreshold; y: number }[] {
  const GAP = (13 / 110) * 100
  for (let i = 1; i < marks.length; i++) {
    marks[i]!.y = Math.max(marks[i]!.y, marks[i - 1]!.y + GAP)
  }
  const over = marks.length ? marks[marks.length - 1]!.y - 100 : 0
  if (over > 0) {
    const shift = Math.min(over, marks[0]!.y)
    for (const m of marks) m.y -= shift
  }
  return marks
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
