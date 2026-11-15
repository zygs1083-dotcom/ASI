import { formatMoney, formatPercent, formatTokens } from '../format'
import { FactValue, STATUS_TEXT } from '../fact'
import { Sparkline } from '../sparkline'
import { TokenRing } from '../token-ring'
import { TokenIcon } from '../icons'
import { InsightLine, Row } from './row'
import type { MetricInsight, SensePanelProps, TokenVitals } from '../view-model'
import css from './body.module.css'

type Panel = Pick<SensePanelProps, 'model' | 'onOpenPermissionSettings'>

export function TokenRow({ model, sev, onOpenPermissionSettings }: Panel & { sev: 'good' | 'warn' | 'critical' | 'unknown' }) {
  const f = model.state.self.body.tokens
  const { now, history } = model
  const insight = model.insights?.tokens

  return (
    <Row rowKey="tokens" icon={<TokenIcon />} label="Token" sev={sev} fact={f} now={now}>
      <FactValue fact={f} now={now} onOpenPermissionSettings={onOpenPermissionSettings}>
        {(v) => (
          <TokenDetail
            v={v}
            now={now}
            history={history}
            insight={insight}
            sev={sev}
            onOpenPermissionSettings={onOpenPermissionSettings}
          />
        )}
      </FactValue>
      <InsightLine insight={insight} />
    </Row>
  )
}

function TokenDetail({
  v,
  now,
  history,
  insight,
  sev,
  onOpenPermissionSettings,
}: {
  v: TokenVitals
  now: number
  history: SensePanelProps['model']['history']
  insight?: MetricInsight
  sev: 'good' | 'warn' | 'critical' | 'unknown'
  onOpenPermissionSettings: () => void
}) {
  const hasContext =
    v.contextWindow != null && v.contextUsed != null && v.contextWindow > 0
  const { input, output, cacheRead, cacheWrite } = v.sessionUsage

  return (
    <>
      {hasContext ? (
        <div className={css.tokenMain}>
          <TokenRing
            used={v.contextUsed!}
            total={v.contextWindow!}
            threshold={v.compressionThreshold}
          />
          <div className={css.tokenSide}>
            <div className={css.rowValue}>
              {formatTokens(v.contextUsed!)} / {formatTokens(v.contextWindow!)}
            </div>
            <div className={css.detail}>
              剩余 {formatTokens(Math.max(0, v.contextWindow! - v.contextUsed!))}（
              {formatPercent(
                Math.max(0, (v.contextWindow! - v.contextUsed!) / v.contextWindow!),
              )}
              ）
            </div>
            {v.contextProjected != null && (
              <div className={css.detail}>
                预计下次 {formatTokens(v.contextProjected)}
              </div>
            )}
            <div className={css.detail}>
              <CompressionDistance v={v} />
            </div>
          </div>
        </div>
      ) : (
        <div className={css.detail}>上下文数据不可用</div>
      )}
      <div className={css.detail}>
        本会话 输入 {formatTokens(input)} · 输出 {formatTokens(output)} · 缓存读{' '}
        {formatTokens(cacheRead)} · 缓存写 {formatTokens(cacheWrite)}
      </div>
      <div className={css.detail}>
        缓存命中率 {input > 0 ? formatPercent(cacheRead / input) : '暂无输入'}
      </div>
      <BalanceLine v={v} onOpenPermissionSettings={onOpenPermissionSettings} />
      <Sparkline
        points={history.tokens}
        now={now}
        label="上下文占用"
        format={formatTokens}
        severity={sev}
        baseline={insight?.baseline}
      />
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
    return <>距自动压缩（按下次请求）{formatTokens(Math.max(0, t - v.contextProjected))}</>
  }
  return <>距自动压缩 {formatTokens(Math.max(0, t - (v.contextUsed ?? 0)))}</>
}

/**
 * 余额：status 为 unavailable/denied 时不泄露金额，只显示状态与原因；
 * stale 灰显并标注；无余额给既有解释。
 */
function BalanceLine({
  v,
  onOpenPermissionSettings,
}: {
  v: TokenVitals
  onOpenPermissionSettings: () => void
}) {
  const status = v.balanceStatus
  if (status === 'unavailable' || status === 'unsupported' || status === 'unknown') {
    return (
      <div className={css.detail}>
        余额{STATUS_TEXT[status]}{v.balanceReason ? `（${v.balanceReason}）` : ''}
      </div>
    )
  }
  if (status === 'denied') {
    return (
      <div className={css.detail}>
        余额无权限{v.balanceReason ? `（${v.balanceReason}）` : ''}{' '}
        <button type="button" className={css.linkButton} onClick={onOpenPermissionSettings}>
          授权
        </button>
      </div>
    )
  }
  if (!v.balance) {
    return (
      <div className={css.detail}>
        余额 {v.balanceReason ?? '提供方未提供余额接口'}
      </div>
    )
  }
  return (
    <div className={status === 'stale' ? css.staleDetail : css.detail}>
      余额 {formatMoney(v.balance.amount, v.balance.currency)}（{v.balance.source}）
      {status === 'stale' ? ' · 已过期' : ''}
    </div>
  )
}
