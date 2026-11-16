import { useMemo, type ReactNode } from 'react'
import { effectiveDisks } from '@asi/sense-types'
import { useClock } from './clock'
import { effectiveStatus } from './health'
import { formatAge } from './format'
import type { DisksFact, DiskVolume, Fact, FactStatus } from './view-model'
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
  const effNow = useClock(now)
  const status = effectiveStatus(fact, effNow)
  const age = formatAge(effNow, fact.observedAt)
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
  const effNow = useClock(now)
  const status = effectiveStatus(fact, effNow)
  // children 只随 value/渲染函数变化重算：纯时钟滴答不重复执行子树渲染逻辑
  const value = fact.value
  const rendered = useMemo(
    () => (value === null ? null : children(value)),
    [children, value],
  )
  if ((status === 'ok' || status === 'stale') && fact.value !== null) {
    if (status === 'stale') {
      // 过期保留值：标注「上次读数」+ 整体去色 + 明确「已过期」与年龄，不伪装成新鲜数据
      return (
        <span className={css.factStale} data-status="stale">
          <span className={css.factMeta}>上次读数</span>
          {rendered}
          <span className={css.factMeta}>
            已过期 · {formatAge(effNow, fact.observedAt)}
          </span>
        </span>
      )
    }
    return <>{rendered}</>
  }
  if (status === 'denied') {
    return <>无权限{fact.reason ? `（${fact.reason}）` : ''}</>
  }
  if (status === 'stale') {
    return <>已过期 · {formatAge(effNow, fact.observedAt)}</>
  }
  return (
    <>
      {STATUS_TEXT[status] || STATUS_TEXT.unknown}
      {fact.reason ? `（${fact.reason}）` : ''}
    </>
  )
}

export function DisksStatusText({ fact, now, children }: {
  fact: DisksFact
  now: number
  children: (value: DiskVolume[]) => ReactNode
}) {
  const effNow = useClock(now)
  return <FactStatusText fact={effectiveDisks(fact, effNow)} now={effNow}>{children}</FactStatusText>
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
  const effNow = useClock(now)
  const status = effectiveStatus(fact, effNow)
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
          已过期 · {formatAge(effNow, fact.observedAt)}
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
        已过期 · {formatAge(effNow, fact.observedAt)}
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
