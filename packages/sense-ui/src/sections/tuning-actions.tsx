import { useEffect, useId, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import { formatBytes, formatPercent, formatPercentValue, formatRate, formatTokens, formatTuningValue } from '../format'
import type { MetricKey, SensePanelProps, TuningState } from '../view-model'
import type { TuningOperations } from './tuning-operation'
import css from './rules.module.css'

type Suggestion = NonNullable<TuningState['suggestions']>[number]

export const defaultTuningCopy: NonNullable<SensePanelProps['tuningCopy']> = {
  backupFailed: '调参数据无法备份：',
  saveFailed: '无法保存调参恢复状态：',
  permission: '权限不足',
  noSpace: '磁盘空间不足',
  readOnly: '文件系统只读',
  snapshotChanged: '原始数据已变化',
  backupUnavailable: '备份功能不可用',
  unknown: '未知原因',
  retry: '重试',
  reset: '重置调参',
  backupCorrupt: '已将损坏的调参数据备份为 ',
  backupUnknown: '已将无法识别版本的调参数据备份为 ',
  restored: '，已恢复默认',
  dismissBackup: '关闭备份提示',
  restoreUnknown: '保存的调参数据版本无法识别，AI 调参已停用',
  restoreCorrupt: '保存的调参数据损坏，AI 调参已停用',
  confirmReset: '确认重置',
  cancel: '取消',
  resetMessage: '将丢弃已保存的调参、锁定和调整记录，所有参数恢复默认值，基线重新学习',
  processing: '处理中',
  actionFailed: '失败，请重试',
  actionUnconfirmed: '：未确认结果，请检查状态',
}

export function TuningBackupStatus({ model, onRetryTuningBackup, onDismissTuningBackup, tuningCopy, operations }: Pick<
  SensePanelProps, 'model' | 'onRetryTuningBackup' | 'onDismissTuningBackup' | 'tuningCopy'
> & { operations: TuningOperations }) {
  const copy = tuningCopy ?? defaultTuningCopy
  const error = model.tuning?.backupError
  const notice = model.tuning?.backupNotice
  const retry = operations.operations['retry-backup']
  const dismiss = operations.operations['dismiss-backup']
  const busy = (operation?: { phase: string }) => operation?.phase === 'pending' || operation?.phase === 'waiting'
  const reason = error && (
    ['EACCES', 'EPERM'].includes(error.code) ? copy.permission :
      error.code === 'ENOSPC' ? copy.noSpace :
        error.code === 'EROFS' ? copy.readOnly :
          ['SNAPSHOT_CHANGED', 'SNAPSHOT_MISSING'].includes(error.code) ? copy.snapshotChanged :
            error.code === 'BACKUP_UNAVAILABLE' ? copy.backupUnavailable : copy.unknown
  )
  return (
    <>
      {error && <div className={css.notice} role="status">
        <span className={css.backupText}>{error.stage === 'backup' ? copy.backupFailed : copy.saveFailed}{reason}{error.code !== 'unknown' ? ` (${error.code})` : ''}</span>
        <button type="button" disabled={!onRetryTuningBackup || busy(retry)} onClick={() => onRetryTuningBackup && operations.run('retry-backup', onRetryTuningBackup, copy.retry)}>{copy.retry}</button>
      </div>}
      {notice && <div className={css.notice} role="status">
        <span className={css.backupText}>{notice.kind === 'corrupt' ? copy.backupCorrupt : copy.backupUnknown}{notice.fileName}{copy.restored}</span>
        <button type="button" disabled={!onDismissTuningBackup || busy(dismiss)} onClick={() => onDismissTuningBackup && operations.run('dismiss-backup', onDismissTuningBackup, copy.dismissBackup)}>{copy.dismissBackup}</button>
      </div>}
    </>
  )
}

function ConfirmAction({ label, confirmLabel, message, onConfirm, describedBy, operation, onOpen, onClose, cancelLabel = '取消', processing = '处理中' }: {
  label: string
  confirmLabel: string
  message: string
  onConfirm: () => void
  describedBy?: string
  operation?: { phase: 'pending' | 'waiting' | 'error' | 'unconfirmed' }
  onOpen?: () => void
  onClose?: () => void
  cancelLabel?: string
  processing?: string
}) {
  const [open, setOpen] = useState(false)
  const messageId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (open) cancel.current?.focus()
  }, [open])
  const close = () => {
    setOpen(false)
    onClose?.()
    trigger.current?.focus()
  }
  const busy = operation?.phase === 'pending' || operation?.phase === 'waiting'
  return (
    <div className={css.confirmAction}>
      <button ref={trigger} type="button" aria-expanded={open} aria-describedby={describedBy} disabled={busy} onClick={() => {
        if (open) cancel.current?.focus()
        else { setOpen(true); onOpen?.() }
      }}>
        {busy ? `${label} · ${processing}` : label}
      </button>
      {open && (
        <div className={css.confirmation} role="alertdialog" aria-label={label} aria-describedby={messageId}>
          <span id={messageId}>{message}</span>
          <div className={css.confirmButtons}>
            <button type="button" aria-describedby={[describedBy, messageId].filter(Boolean).join(' ')} onClick={() => { close(); onConfirm() }}>
              {confirmLabel}
            </button>
            <button ref={cancel} type="button" aria-describedby={[describedBy, messageId].filter(Boolean).join(' ')} onClick={close}>{cancelLabel}</button>
          </div>
        </div>
      )}
    </div>
  )
}

export function TuningDisabled({ model, onResumeTuning, onResetTuning, tuningCopy, operations }: Pick<
  SensePanelProps, 'model' | 'onResumeTuning' | 'onResetTuning' | 'tuningCopy'
> & { operations: TuningOperations }) {
  const reason = model.tuning?.disabled?.reason
  const resume = operations.operations.resume
  const busy = resume?.phase === 'pending' || resume?.phase === 'waiting'
  const copy = tuningCopy ?? defaultTuningCopy
  if (!reason) return null
  return (
    <div className={css.notice} role="status">
      {reason === 'storage-failed' ? (
        <>
          <span>保存调参数据失败，AI 调参已停用</span>
          <button type="button" disabled={busy} onClick={() => operations.run('resume', onResumeTuning, '恢复 AI 调参')}>
            {busy ? '恢复 AI 调参 · 处理中' : '恢复 AI 调参'}
          </button>
        </>
      ) : (
        <>
          {!model.tuning?.backupError && <span>{(model.tuning?.restoreKind ?? model.tuning?.backupNotice?.kind) === 'unknown-version' ? copy.restoreUnknown : copy.restoreCorrupt}</span>}
          {model.tuning?.backupError ? <button type="button" disabled>{copy.reset}</button> : <ConfirmAction
            label={copy.reset}
            confirmLabel={copy.confirmReset}
            message={copy.resetMessage}
            cancelLabel={copy.cancel}
            processing={copy.processing}
            operation={operations.operations.reset}
            onConfirm={() => operations.run('reset', onResetTuning, copy.reset)}
          />}
        </>
      )}
    </div>
  )
}

function metricLabel(metric: MetricKey): string {
  if (metric.startsWith('disk:')) return `磁盘 ${metric.slice(5)} 剩余`
  const labels: Record<Exclude<MetricKey, `disk:${string}`>, string> = {
    cpu: 'CPU', memory: '内存', battery: '电池', thermal: '温控',
    networkRx: '网络下行', networkTx: '网络上行',
    processCpu: 'DSH 进程 CPU', processRss: 'DSH 进程内存', tokens: 'Token 上下文剩余',
  }
  return labels[metric as keyof typeof labels]
}

function metricValue(unit: Suggestion['unit'], value: number): string {
  switch (unit) {
    case 'ratio': return formatPercent(value)
    case 'percent': return formatPercentValue(value)
    case 'ordinal': return formatTuningValue(value, '档')
    case 'bytes-per-second': return Math.abs(value) < 1024 ? formatTuningValue(value, 'B/s') : formatRate(value)
    case 'bytes': return Math.abs(value) < 1024 ? formatTuningValue(value, 'B') : formatBytes(value)
    case 'tokens': return formatTokens(value)
    default: return formatTuningValue(value, '单位未知')
  }
}

function exactValue(unit: Suggestion['unit'], value: number): string {
  if (unit === 'ratio') return `${formatTuningValue(Number((value * 100).toPrecision(15)))}%`
  if (unit === 'percent') return `${formatTuningValue(value)}%`
  const suffix = { bytes: 'B', 'bytes-per-second': 'B/s', tokens: 'token', ordinal: '档' }[unit] ?? '单位未知'
  return formatTuningValue(value, suffix)
}

function SuggestionRow({ suggestion, onAcceptRebaseline, operations, onOpen, onClose, focusLost }: {
  suggestion: Suggestion
  onAcceptRebaseline: (id: string) => Promise<void>
  operations: TuningOperations
  onOpen: () => void
  onClose: () => void
  focusLost: MutableRefObject<string | null>
}) {
  const { metric, unit, slotLabel, from, to, samples, dates, id } = suggestion
  const descriptionId = useId()
  const row = useRef<HTMLLIElement>(null)
  useLayoutEffect(() => () => {
    if (row.current?.contains(document.activeElement)) focusLost.current = id
  }, [focusLost, id])
  let previous = metricValue(unit, from)
  let next = metricValue(unit, to)
  if (previous === next && from !== to) {
    previous = exactValue(unit, from)
    next = exactValue(unit, to)
  }
  return (
    <li ref={row} className={css.suggestion}>
      <div id={descriptionId}>
        <div className={css.ruleName}>{metricLabel(metric)} · {slotLabel}</div>
        <div>均值 {previous} → {next}</div>
        <div className={css.ruleDesc}>{samples} 个样本 · {dates} 个日期</div>
      </div>
      <ConfirmAction
        label="确认重新基线"
        confirmLabel="确认应用"
        message="持续故障和新负载无法自动区分，请确认这是正常的新状态"
        describedBy={descriptionId}
        operation={operations.operations[`suggestion:${id}`]}
        onOpen={onOpen}
        onClose={onClose}
        onConfirm={() => operations.run(`suggestion:${id}`, () => onAcceptRebaseline(id), `接受 ${metricLabel(metric)} ${slotLabel} 重新基线`)}
      />
    </li>
  )
}

export function RebaselineSuggestions({ model, onAcceptRebaseline, operations }: Pick<
  SensePanelProps, 'model' | 'onAcceptRebaseline'
> & { operations: TuningOperations }) {
  const suggestions = model.tuning?.suggestions ?? []
  const [active, setActive] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState(0)
  const heading = useRef<HTMLDivElement>(null)
  const focusLost = useRef<string | null>(null)
  useLayoutEffect(() => {
    const valid = Object.fromEntries(Object.entries(active).filter(([id, content]) =>
      suggestions.some((suggestion) => suggestion.id === id && JSON.stringify(suggestion) === content)))
    if (Object.keys(valid).length !== Object.keys(active).length) {
      setActive(valid)
      setNotice((previous) => previous + 1)
      if (focusLost.current && focusLost.current in active && !(focusLost.current in valid)) heading.current?.focus()
    }
    focusLost.current = null
  }, [active, suggestions])
  if (!suggestions.length && !Object.keys(active).length && !notice) return null
  return (
    <div>
      <div ref={heading} tabIndex={-1} className={css.ruleName}>重新基线建议</div>
      <div aria-live="polite">{notice ? `建议已更新，请重新确认（${notice}）` : ''}</div>
      <ul className={css.rules} aria-label="重新基线建议">
        {suggestions.map((suggestion) => (
          <SuggestionRow
            key={JSON.stringify(suggestion)}
            suggestion={suggestion}
            onAcceptRebaseline={onAcceptRebaseline}
            operations={operations}
            focusLost={focusLost}
            onOpen={() => setActive((previous) => ({ ...previous, [suggestion.id]: JSON.stringify(suggestion) }))}
            onClose={() => setActive((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== suggestion.id)))}
          />
        ))}
      </ul>
    </div>
  )
}
