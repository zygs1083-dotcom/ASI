import type { BodyRowKey, Severity } from '../health'
import { FactMeta } from '../fact'
import type { Fact, MetricInsight, ThresholdLayer } from '../view-model'
import css from './body.module.css'

const LAYER_TEXT: Record<ThresholdLayer, string> = {
  floor: '底线',
  rate: '变化率',
  baseline: '基线',
}

export const SEV_TAG: Record<string, string> = {
  warn: '注意',
  critical: '紧急',
  unknown: '未知',
}

export function Bar({ ratio }: { ratio: number }) {
  const pct = Math.min(100, Math.max(0, ratio * 100))
  return (
    <div className={css.bar} aria-hidden="true">
      <i style={{ width: `${pct}%` }} />
    </div>
  )
}

/** 阈值来源/触发层标注；无 insight 时明示"未提供"而非静默。 */
export function InsightLine({ insight }: { insight?: MetricInsight }) {
  if (!insight) return <div className={css.insight}>阈值来源未提供</div>
  const layers = (ls: ThresholdLayer[]) =>
    ls.length ? ls.map((l) => LAYER_TEXT[l]).join(' / ') : '未提供'
  return (
    <div className={css.insight}>
      来源：{layers(insight.sources)} · 触发：
      {insight.triggered.length ? layers(insight.triggered) : '未触发'}
    </div>
  )
}

export function Row({
  rowKey,
  icon,
  label,
  sev,
  fact,
  now,
  children,
}: {
  rowKey: BodyRowKey
  icon: React.ReactNode
  label: string
  sev: Severity
  fact?: Fact<unknown>
  now?: number
  children: React.ReactNode
}) {
  return (
    <div className={css.row} data-sev={sev} data-row={rowKey}>
      <div className={css.rowHead}>
        {icon}
        <span className={css.rowLabel}>{label}</span>
        {sev !== 'good' && (
          <span className={css.sevTag} data-sev={sev}>
            {SEV_TAG[sev]}
          </span>
        )}
        {fact && now != null && <FactMeta fact={fact} now={now} />}
      </div>
      {children}
    </div>
  )
}
