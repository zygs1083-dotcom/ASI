import { formatPercent } from './format'
import css from './viz.module.css'

interface TokenRingProps {
  used: number
  total: number
  /** 自动压缩阈值（绝对 token 数），有则画刻度标记 */
  threshold?: number
  /** 环直径（px）；缺省 56，主展示区用 88~96。 */
  size?: number
  /** total 为回退估值（容量未确认）：整体降饱和、不画阈值刻度。 */
  unconfirmed?: boolean
  className?: string
}

/** 上下文占用环形图：弧长 = used/total，阈值刻度按提供值定位。 */
export function TokenRing({ used, total, threshold, size = 56, unconfirmed, className }: TokenRingProps) {
  const r = size * 0.41
  const cx = size / 2
  const circ = 2 * Math.PI * r
  const ratio = total > 0 ? Math.min(1, Math.max(0, used / total)) : 0
  const filled = ratio * circ
  const strokeWidth = Math.max(4, size * 0.075)
  const tickLen = size * 0.055

  // 从正上方顺时针起算，阈值比例对应的角度（弧度）
  const thresholdAngle =
    !unconfirmed && threshold != null && total > 0
      ? Math.min(1, threshold / total) * 2 * Math.PI
      : null
  const tick =
    thresholdAngle != null
      ? {
          x1: cx + Math.sin(thresholdAngle) * (r - tickLen),
          y1: cx - Math.cos(thresholdAngle) * (r - tickLen),
          x2: cx + Math.sin(thresholdAngle) * (r + tickLen),
          y2: cx - Math.cos(thresholdAngle) * (r + tickLen),
        }
      : null

  return (
    <svg
      className={className ?? css.ring}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      data-unconfirmed={unconfirmed || undefined}
    >
      <circle
        className={css.ringTrack}
        cx={cx}
        cy={cx}
        r={r}
        fill="none"
        strokeWidth={strokeWidth}
      />
      <circle
        className={css.ringFill}
        cx={cx}
        cy={cx}
        r={r}
        fill="none"
        strokeWidth={strokeWidth}
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
      <text
        className={css.ringText}
        x={cx}
        y={cx + size * 0.065}
        textAnchor="middle"
        fontSize={Math.round(size * 0.21)}
      >
        {formatPercent(ratio)}
      </text>
    </svg>
  )
}
