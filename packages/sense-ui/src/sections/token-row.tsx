/** Token 卡片：跨两列，环形图 + 三条紧凑信息行，明细给大图与精确缓存值。 */

import {
  formatMoney,
  formatPercent,
  formatTokens,
} from '../format'
import { isUsable } from '../health'
import { FactStatusText, STATUS_TEXT } from '../fact'
import { Sparkline } from '../sparkline'
import { chartThresholds } from '../thresholds'
import { TokenRing } from '../token-ring'
import { TokenIcon } from '../icons'
import { Tile, TileDetail } from './tile'
import type { TileCtx } from './tiles-basic'
import type { TokenVitals } from '../view-model'
import css from './body.module.css'

type Rows = ReturnType<typeof import('../health').evaluateBody>['rows']

export function TokenTile({
  model,
  rows,
  ctx,
}: {
  model: TileCtx['model']
  rows: Rows
  ctx: TileCtx
}) {
  const f = model.state.self.body.tokens
  const { now } = model
  const insight = model.insights?.tokens
  const v = isUsable(f, now) ? f.value! : null
  const win = v?.contextWindow
  const thr = chartThresholds('tokens', insight, win ?? undefined)

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
                v && win != null && v.contextUsed != null
                  ? `${formatTokens(v.contextUsed)} / ${formatTokens(win)}`
                  : undefined,
              insight,
              severity: rows.tokens.severity,
              tokenWindow: win ?? undefined,
            },
          ]}
          extra={
            v && (
              <TokenExtra v={v} onOpenPermissionSettings={ctx.onOpenPermissionSettings} />
            )
          }
        />
      }
    >
      <FactStatusText fact={f} now={now}>
        {(val) => <TokenSummary v={val} rows={rows} model={model} thr={thr.lines} />}
      </FactStatusText>
    </Tile>
  )
}

/**
 * 按宿主投影的增速估算填满剩余上下文所需分钟数。
 * 任一输入缺失/非有限/增速 ≤0 都不估算（不编造斜率）。
 */
function fillMinutes(v: TokenVitals): number | null {
  const { contextWindow: win, contextUsed: used, contextGrowthPerMinute: rate } =
    v
  if (
    win == null ||
    used == null ||
    rate == null ||
    !Number.isFinite(win) ||
    !Number.isFinite(used) ||
    !Number.isFinite(rate) ||
    win <= 0 ||
    rate <= 0
  ) {
    return null
  }
  return Math.max(0, Math.ceil((win - used) / rate))
}

function TokenSummary({
  v,
  rows,
  model,
  thr,
}: {
  v: TokenVitals
  rows: Rows
  model: TileCtx['model']
  thr: ReturnType<typeof chartThresholds>['lines']
}) {
  const { now } = model
  const hasContext =
    v.contextWindow != null && v.contextUsed != null && v.contextWindow > 0
  const { input, output, cacheRead } = v.sessionUsage
  const left =
    hasContext && v.contextUsed != null
      ? Math.max(0, v.contextWindow! - v.contextUsed)
      : null
  const fillMin = fillMinutes(v)

  return (
    <>
      {hasContext ? (
        <span className={css.tokenMain}>
          <TokenRing
            used={v.contextUsed!}
            total={v.contextWindow!}
            threshold={v.compressionThreshold}
            size={92}
          />
          <span className={css.tokenSide}>
            <span className={css.tileValue}>
              {formatTokens(v.contextUsed!)} / {formatTokens(v.contextWindow!)}
            </span>
            <span className={css.tileSub}>
              剩余 {formatTokens(left!)}（
              {formatPercent(Math.max(0, left! / v.contextWindow!))}）
            </span>
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
      {hasContext && (
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
        baseline={model.insights?.tokens?.baseline}
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
