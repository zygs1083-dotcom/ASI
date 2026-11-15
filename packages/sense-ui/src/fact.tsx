import type { ReactNode } from 'react'
import { effectiveStatus } from './health'
import { formatAge } from './format'
import type { Fact, FactStatus } from './view-model'
import css from './panel.module.css'

export const STATUS_TEXT: Record<FactStatus, string> = {
  ok: '',
  stale: '已过期',
  denied: '无权限',
  unsupported: '不支持',
  unavailable: '不可用',
  unknown: '未知',
}

interface MetaProps {
  fact: Fact<unknown>
  now: number
}

/** 事实的元信息：新鲜度 + 来源（title 提供 api/host）。刚刚采集的不写文字。 */
export function FactMeta({ fact, now }: MetaProps) {
  const status = effectiveStatus(fact, now)
  const age = formatAge(now, fact.observedAt)
  if (status !== 'stale' && age === '刚刚') return null
  return (
    <span
      className={css.factMeta}
      title={`来源 ${fact.source.api} @ ${fact.source.host}`}
    >
      {status === 'stale' ? `${STATUS_TEXT.stale} · ` : ''}
      {age}
    </span>
  )
}

/**
 * 事实的纯文本状态（不含按钮等交互控件）：
 * 供 <summary> 内使用——summary 里不能嵌交互元素，授权按钮放明细里。
 */
export function FactStatusText<T>({
  fact,
  now,
  children,
}: {
  fact: Fact<T>
  now: number
  children: (value: T) => ReactNode
}) {
  const status = effectiveStatus(fact, now)
  if ((status === 'ok' || status === 'stale') && fact.value !== null) {
    if (status === 'stale') {
      // 过期保留值：标注「上次读数」+ 整体去色 + 明确「已过期」与年龄，不伪装成新鲜数据
      return (
        <span className={css.factStale} data-status="stale">
          <span className={css.factMeta}>上次读数</span>
          {children(fact.value)}
          <span className={css.factMeta}>
            已过期 · {formatAge(now, fact.observedAt)}
          </span>
        </span>
      )
    }
    return <>{children(fact.value)}</>
  }
  if (status === 'denied') {
    return <>无权限{fact.reason ? `（${fact.reason}）` : ''}</>
  }
  if (status === 'stale') {
    return <>已过期 · {formatAge(now, fact.observedAt)}</>
  }
  return (
    <>
      {STATUS_TEXT[status] || STATUS_TEXT.unknown}
      {fact.reason ? `（${fact.reason}）` : ''}
    </>
  )
}

interface FactValueProps<T> {
  fact: Fact<T>
  now: number
  onOpenPermissionSettings: () => void
  children: (value: T) => ReactNode
}

/**
 * 按事实状态渲染值：
 * ok→值；stale→保留值(灰)+时间；denied→原因+授权按钮；其余→状态文案，不显示占位零。
 */
export function FactValue<T>({
  fact,
  now,
  onOpenPermissionSettings,
  children,
}: FactValueProps<T>) {
  const status = effectiveStatus(fact, now)
  const sourceTitle = `来源 ${fact.source.api} @ ${fact.source.host}`

  if (status === 'ok' && fact.value !== null) {
    return <>{children(fact.value)}</>
  }
  if (status === 'stale' && fact.value !== null) {
    return (
      <span className={css.factStale} title={sourceTitle}>
        <span className={css.factMeta}>上次读数</span>
        {children(fact.value)}
        <span className={css.factMeta}>
          已过期 · {formatAge(now, fact.observedAt)}
        </span>
      </span>
    )
  }
  if (status === 'denied') {
    return (
      <span className={css.factDenied} title={sourceTitle}>
        <span>
          无权限{fact.reason ? `（${fact.reason}）` : ''}
        </span>
        <button
          type="button"
          className={css.linkButton}
          onClick={onOpenPermissionSettings}
        >
          授权
        </button>
      </span>
    )
  }
  if (status === 'stale') {
    // value 为 null 也明示过期状态与年龄，不留空白
    return (
      <span className={css.factMuted} title={sourceTitle}>
        已过期 · {formatAge(now, fact.observedAt)}
      </span>
    )
  }
  return (
    <span className={css.factMuted} title={sourceTitle}>
      {STATUS_TEXT[status] || STATUS_TEXT.unknown}
      {fact.reason ? `（${fact.reason}）` : ''}
    </span>
  )
}
