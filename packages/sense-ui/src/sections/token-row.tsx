/** Token 卡片：跨两列，环形图 + 三条紧凑信息行，明细给大图与精确缓存值。 */

import {
  MAX_DISPLAY_MINUTES,
  formatMoney,
  formatPercent,
  formatTokens,
} from '../format'
import { effectiveStatus, isUsable } from '../health'
import { FactStatusText, STATUS_TEXT } from '../fact'
import { Sparkline } from '../sparkline'
import { chartThresholds } from '../thresholds'
import { TokenRing } from '../token-ring'
import { TokenIcon } from '../icons'
import { Tile, TileDetail } from './tile'
import { memoTile, type MetricTileProps } from './tiles-basic'
import type { TokenVitals } from '../view-model'
import css from './body.module.css'

const WINDOW_SOURCE_TEXT = {
  configured: '配置值',
  catalog: '模型目录',
  fallback: '回退估值（未确认）',
} as const

export const TokenTile = memoTile(
  'tokens',
  (m) => [m.state.self.body.tokens, m.insights?.tokens, m.history.tokens],
  function TokenTile({ model, rows, ctx }: MetricTileProps) {
  const f = model.state.self.body.tokens
  const { now } = model
  const fresh = isUsable(f, now)
  // denied/unavailable 的保留值不进摘要/明细；stale 保留值仍可灰显
  const v = fresh || effectiveStatus(f, now) === 'stale' ? f.value : null
  // 回退估值容量未确认：不画容量派生底线，也不消费 token insight
  const unconfirmed = v?.contextWindowSource === 'fallback'
  const insight = fresh && !unconfirmed ? model.insights?.tokens : undefined
  const win = unconfirmed ? undefined : v?.contextWindow
  const thr = fresh ? chartThresholds('tokens', insight, win ?? undefined) : { lines: [] }

  return (
    <Tile
      tileKey="tokens"
      icon={<TokenIcon />}
      label="Token"
      sev={rows.tokens.severity}
      span2
      detail={
        <TileDetail
          fact={f}
          now={now}
          events={model.events}
          onAdjust={ctx.onAdjust}
          onOpenPermissionSettings={ctx.onOpenPermissionSettings}
          metrics={[
            {
              key: 'tokens',
              label: '上下文占用',
              points: model.history.tokens,
              format: formatTokens,
              valueText:
                v?.contextWindow != null && v.contextUsed != null
                  ? `${formatTokens(v.contextUsed)} / ${formatTokens(v.contextWindow)}`
                  : undefined,
              insight,
              severity: rows.tokens.severity,
              tokenWindow: win ?? undefined,
            },
          ]}
          extra={
            v && (
              <>
                {v.contextWindowSource && v.contextWindow != null && (
                  <div className={css.detailLine}>
                    上下文窗口来源：{WINDOW_SOURCE_TEXT[v.contextWindowSource]}
                  </div>
                )}
                <TokenExtra v={v} onOpenPermissionSettings={ctx.onOpenPermissionSettings} />
              </>
            )
          }
        />
      }
    >
      <FactStatusText fact={f} now={now}>
        {(val) => (
          <TokenSummary
            v={val}
            rows={rows}
            model={model}
            thr={thr.lines}
            fresh={fresh}
            confirmed={!unconfirmed}
            baseline={insight?.baseline}
          />
        )}
      </FactStatusText>
    </Tile>
  )
})

/**
 * 按宿主投影的增速估算填满剩余上下文所需分钟数。
 * 任一输入缺失/非有限/增速 ≤0 都不估算（不编造斜率）。
 */
function fillMinutes(v: TokenVitals): number | null {
  const { contextWindow: win, contextUsed: used, contextGrowthPerMinute: rate } = v
  if (win == null || used == null || rate == null) return null
  if (![win, used, rate].every(Number.isFinite) || win <= 0 || rate <= 0) return null
  // 结果同样要有限且在 7 天内：极小正增速会让除法溢出为 Infinity。
  const minutes = (win - used) / rate
  if (!Number.isFinite(minutes) || minutes > MAX_DISPLAY_MINUTES) return null
  return Math.max(0, Math.ceil(minutes))
}

function TokenSummary({
  v,
  rows,
  model,
  thr,
  fresh,
  confirmed,
  baseline,
}: {
  v: TokenVitals
  rows: MetricTileProps['rows']
  model: MetricTileProps['model']
  thr: ReturnType<typeof chartThresholds>['lines']
  /** 事实新鲜（非过期保留值）才允许任何当前推算。 */
  fresh: boolean
  /** 容量已确认（非回退估值）才给余量/压缩派生。 */
  confirmed: boolean
  baseline?: import('../view-model').MetricInsight['baseline']
}) {
  const { now } = model
  const hasContext =
    v.contextWindow != null && v.contextUsed != null && v.contextWindow > 0
  const { input, output, cacheRead } = v.sessionUsage
  const left =
    hasContext && confirmed && v.contextUsed != null
      ? Math.max(0, v.contextWindow! - v.contextUsed)
      : null
  const fillMin = fresh && confirmed ? fillMinutes(v) : null

  return (
    <>
      {hasContext ? (
        <span className={css.tokenMain}>
          <TokenRing
            used={v.contextUsed!}
            total={v.contextWindow!}
            threshold={v.compressionThreshold}
            size={92}
            unconfirmed={!confirmed}
          />
          <span className={css.tokenSide}>
            <span className={css.tileValue}>
              {formatTokens(v.contextUsed!)} / {formatTokens(v.contextWindow!)}
            </span>
            {!confirmed ? (
              <span className={css.tileSub} data-unconfirmed-note>
                容量未确认（回退估值）
              </span>
            ) : (
              <span className={css.tileSub}>
                剩余 {formatTokens(left!)}（
                {formatPercent(Math.max(0, left! / v.contextWindow!))}）
              </span>
            )}
            <span className={css.tileSub}>
              预计下次{' '}
              {v.contextProjected != null
                ? formatTokens(v.contextProjected)
                : '未提供'}
            </span>
            {fillMin != null && (
              <span className={css.tileSub}>
                按当前速度约 {fillMin} 分钟填满
              </span>
            )}
          </span>
        </span>
      ) : (
        <span className={css.tileSub}>上下文数据不可用</span>
      )}
      <span className={css.tileSub}>
        本会话 输入 {formatTokens(input)} · 输出 {formatTokens(output)} ·
        缓存命中率 {input > 0 ? formatPercent(cacheRead / input) : '暂无输入'}
      </span>
      {hasContext && confirmed && (
        <span className={css.tileSub}>
          <CompressionDistance v={v} />
        </span>
      )}
      <BalanceLine v={v} />
      <Sparkline
        points={model.history.tokens}
        now={now}
        label="上下文占用"
        format={formatTokens}
        severity={rows.tokens.severity}
        baseline={baseline}
        thresholds={thr}
      />
    </>
  )
}

/** 明细附加行：精确会话用量 + denied 余额授权动作（填满预估在摘要区）。 */
function TokenExtra({
  v,
  onOpenPermissionSettings,
}: {
  v: TokenVitals
  onOpenPermissionSettings: () => void
}) {
  const { input, output, cacheRead, cacheWrite } = v.sessionUsage

  return (
    <>
      <div className={css.detailLine}>
        本会话 输入 {formatTokens(input)} · 输出 {formatTokens(output)} · 缓存读{' '}
        {formatTokens(cacheRead)} · 缓存写 {formatTokens(cacheWrite)}
      </div>
      {v.balanceStatus === 'denied' && (
        <div className={css.detailLine}>
          账单接口未授权
          <button
            type="button"
            className={css.linkButton}
            onClick={onOpenPermissionSettings}
          >
            授权
          </button>
        </div>
      )}
    </>
  )
}

/** 压缩距离：阈值未提供/已达/预计触发/剩余，四种措辞明确，不显示无解释的 0。 */
function CompressionDistance({ v }: { v: TokenVitals }) {
  const t = v.compressionThreshold
  if (t == null) return <>压缩阈值未提供</>
  if (v.contextUsed != null && v.contextUsed >= t) return <>已达自动压缩阈值</>
  if (v.contextProjected != null) {
    if (v.contextProjected >= t) return <>下次请求预计触发压缩</>
    return (
      <>
        距自动压缩（按下次请求）
        {formatTokens(Math.max(0, t - v.contextProjected))}
      </>
    )
  }
  return <>距自动压缩 {formatTokens(Math.max(0, t - (v.contextUsed ?? 0)))}</>
}

/**
 * 余额：status 为 unavailable/denied 时不泄露金额，只显示状态与原因；
 * stale 灰显并标注；无余额给既有解释。denied 的授权动作在展开明细里。
 */
function BalanceLine({ v }: { v: TokenVitals }) {
  const status = v.balanceStatus
  if (status === 'unavailable' || status === 'unsupported' || status === 'unknown') {
    return (
      <span className={css.tileSub}>
        余额{STATUS_TEXT[status]}{v.balanceReason ? `（${v.balanceReason}）` : ''}
      </span>
    )
  }
  if (status === 'denied') {
    return (
      <span className={css.tileSub}>
        余额无权限{v.balanceReason ? `（${v.balanceReason}）` : ''}
      </span>
    )
  }
  if (!v.balance) {
    return (
      <span className={css.tileSub}>
        余额 {v.balanceReason ?? '提供方未提供余额接口'}
      </span>
    )
  }
  return (
    <span className={status === 'stale' ? css.tileSubStale : css.tileSub}>
      余额 {formatMoney(v.balance.amount, v.balance.currency)}（{v.balance.source}）
      {status === 'stale' ? ' · 已过期' : ''}
    </span>
  )
}
