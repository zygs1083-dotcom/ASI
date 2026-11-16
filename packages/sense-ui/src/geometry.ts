import type { Severity } from './health'
import type { SparkThreshold } from './thresholds'

type SegSev = 'warn' | 'critical'

/** 值相对激活阈值线的告警级；active=false 的信息参考线不参与分类。 */
export function sevOf(v: number, thresholds: SparkThreshold[]): SegSev | null {
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
export function sevCap(severity: Severity | undefined): SegSev | null {
  if (severity === undefined || severity === 'critical') return 'critical'
  return severity === 'warn' ? 'warn' : null
}

/** 展开图阈值标注：按线位排序后保证 ≥13px/110px 间距并夹在图内。 */
export function spreadLabels(
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
