import { diskSeverity, isUsable, maxSeverity } from '../health'
import { formatBytes, formatPercent } from '../format'
import { Sparkline } from '../sparkline'
import { Bar, SEV_TAG } from './row'
import type {
  Fact,
  MetricInsight,
  MetricKey,
  MetricPoint,
} from '../view-model'
import css from './body.module.css'

type Disk = { mount: string; total: number; free: number }

/**
 * 磁盘行列表：每盘独立 maxSeverity(剩余比例, insight.severity)，
 * 只有新鲜的 disks 事实才吃 insight 严重度；非 good 显示可见徽标。
 */
export function DiskRows({
  disks,
  fact,
  now,
  history,
  insights,
}: {
  disks: Disk[]
  fact: Fact<Disk[]>
  now: number
  history: Record<string, MetricPoint[]>
  insights: Partial<Record<MetricKey, MetricInsight>>
}) {
  const fresh = isUsable(fact, now)
  return (
    <>
      {disks.map((d) => {
        const freeRatio = d.total > 0 ? d.free / d.total : 0
        const ins = insights[`disk:${d.mount}`]
        const sev = maxSeverity(
          diskSeverity(freeRatio),
          fresh ? (ins?.severity ?? 'good') : 'good',
        )
        return (
          <div key={d.mount} className={css.diskRow} data-sev={sev}>
            <div className={css.rowValue}>
              <span className={css.mount}>{d.mount}</span>
              剩余 {formatBytes(d.free)} / {formatBytes(d.total)}
              {sev !== 'good' && (
                <span className={css.sevTag} data-sev={sev}>
                  {SEV_TAG[sev]}
                </span>
              )}
            </div>
            <Bar ratio={1 - freeRatio} />
            <Sparkline
              points={history[d.mount] ?? []}
              now={now}
              label={`磁盘 ${d.mount} 使用率`}
              format={formatPercent}
              severity={sev}
              baseline={ins?.baseline}
            />
          </div>
        )
      })}
    </>
  )
}
