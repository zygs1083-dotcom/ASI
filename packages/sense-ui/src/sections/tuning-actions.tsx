import { useEffect, useId, useRef, useState } from 'react'
import { formatBytes, formatPercent, formatPercentValue, formatRate, formatTokens, formatTuningValue } from '../format'
import type { MetricKey, SensePanelProps, TuningState } from '../view-model'
import css from './rules.module.css'

type Suggestion = NonNullable<TuningState['suggestions']>[number]

function ConfirmAction({ label, confirmLabel, message, onConfirm, describedBy }: {
  label: string
  confirmLabel: string
  message: string
  onConfirm: () => void
  describedBy?: string
}) {
  const [open, setOpen] = useState(false)
  const messageId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const confirm = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (open) confirm.current?.focus()
  }, [open])
  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }
  return (
    <div className={css.confirmAction}>
      <button ref={trigger} type="button" aria-expanded={open} aria-describedby={describedBy} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && (
        <div className={css.confirmation}>
          <span id={messageId}>{message}</span>
          <div className={css.confirmButtons}>
            <button ref={confirm} type="button" aria-describedby={[describedBy, messageId].filter(Boolean).join(' ')} onClick={() => { close(); onConfirm() }}>
              {confirmLabel}
            </button>
            <button type="button" onClick={close}>取消</button>
          </div>
        </div>
      )}
    </div>
  )
}

export function TuningDisabled({ model, onResumeTuning, onResetTuning }: Pick<
  SensePanelProps, 'model' | 'onResumeTuning' | 'onResetTuning'
>) {
  const reason = model.tuning?.disabled?.reason
  if (!reason) return null
  return (
    <div className={css.notice} role="status">
      {reason === 'storage-failed' ? (
        <>
          <span>保存调参数据失败，AI 调参已停用</span>
          <button type="button" onClick={onResumeTuning}>恢复 AI 调参</button>
        </>
      ) : (
        <>
          <span>保存的调参数据损坏，AI 调参已停用</span>
          <ConfirmAction
            label="重置调参"
            confirmLabel="确认重置"
            message="确认重置保存的调参数据？"
            onConfirm={onResetTuning}
          />
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
    case 'bytes-per-second': return formatRate(value)
    case 'bytes': return formatBytes(value)
    case 'tokens': return formatTokens(value)
  }
}

function exactValue(unit: Suggestion['unit'], value: number): string {
  if (unit === 'ratio') return `${formatTuningValue(Number((value * 100).toPrecision(15)))}%`
  if (unit === 'percent') return `${formatTuningValue(value)}%`
  const suffix = { bytes: 'B', 'bytes-per-second': 'B/s', tokens: 'token', ordinal: '档' }[unit]
  return formatTuningValue(value, suffix)
}

function SuggestionRow({ suggestion, onAcceptRebaseline }: {
  suggestion: Suggestion
  onAcceptRebaseline: (id: string) => void
}) {
  const { metric, unit, slotLabel, from, to, samples, dates, id } = suggestion
  const descriptionId = useId()
  let previous = metricValue(unit, from)
  let next = metricValue(unit, to)
  if (previous === next && from !== to) {
    previous = exactValue(unit, from)
    next = exactValue(unit, to)
  }
  return (
    <li className={css.suggestion}>
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
        onConfirm={() => onAcceptRebaseline(id)}
      />
    </li>
  )
}

export function RebaselineSuggestions({ model, onAcceptRebaseline }: Pick<
  SensePanelProps, 'model' | 'onAcceptRebaseline'
>) {
  const suggestions = model.tuning?.suggestions
  if (!suggestions?.length) return null
  return (
    <div>
      <div className={css.ruleName}>重新基线建议</div>
      <ul className={css.rules} aria-label="重新基线建议">
        {suggestions.map((suggestion) => (
          <SuggestionRow
            key={JSON.stringify(suggestion)}
            suggestion={suggestion}
            onAcceptRebaseline={onAcceptRebaseline}
          />
        ))}
      </ul>
    </div>
  )
}
