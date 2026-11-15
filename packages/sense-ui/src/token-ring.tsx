import { formatPercent } from './format'
import css from './viz.module.css'

interface TokenRingProps {
  used: number
  total: number
  /** 自动压缩阈值（绝对 token 数），有则画刻度标记 */
  threshold?: number
  className?: string
}

/** 上下文占用环形图：弧长 = used/total，阈值刻度按提供值定位。 */
export function TokenRing({ used, total, threshold, className }: TokenRingProps) {
  const size = 56
  const r = 23
  const cx = size / 2
  const circ = 2 * Math.PI * r
  const ratio = total > 0 ? Math.min(1, Math.max(0, used / total)) : 0
  const filled = ratio * circ

  // 从正上方顺时针起算，阈值比例对应的角度（弧度）
  const thresholdAngle =
    threshold != null && total > 0
      ? Math.min(1, threshold / total) * 2 * Math.PI
      : null
  const tick =
    thresholdAngle != null
      ? {
          x1: cx + Math.sin(thresholdAngle) * (r - 3),
          y1: cx - Math.cos(thresholdAngle) * (r - 3),
          x2: cx + Math.sin(thresholdAngle) * (r + 3),
          y2: cx - Math.cos(thresholdAngle) * (r + 3),
        }
      : null

  return (
    <svg
      className={className ?? css.ring}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
    >
      <circle
        className={css.ringTrack}
        cx={cx}
        cy={cx}
        r={r}
        fill="none"
        strokeWidth="5"
      />
      <circle
        className={css.ringFill}
        cx={cx}
        cy={cx}
        r={r}
        fill="none"
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${circ - filled}`}
        transform={`rotate(-90 ${cx} ${cx})`}
      />
      {tick && (
        <line
          className={css.ringTick}
          x1={tick.x1}
          y1={tick.y1}
          x2={tick.x2}
          y2={tick.y2}
          strokeWidth="1.5"
        />
      )}
      <text className={css.ringText} x={cx} y={cx + 3.5} textAnchor="middle">
        {formatPercent(ratio)}
      </text>
    </svg>
  )
}
