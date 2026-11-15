import { evaluateBody } from '../health'
import {
  formatBytes,
  formatDuration,
  formatLoad,
  formatPercent,
  formatPercentValue,
  formatRate,
  formatThermalOrdinal,
} from '../format'
import { FactValue } from '../fact'
import { Sparkline } from '../sparkline'
import { Bar, InsightLine, Row } from './row'
import { DiskRows } from './disk-rows'
import { TokenRow } from './token-row'
import {
  BatteryIcon,
  CpuIcon,
  DiskIcon,
  MemoryIcon,
  NetworkIcon,
  ProcessIcon,
  PulseIcon,
  ThermalIcon,
} from '../icons'
import type {
  LearningState,
  MetricInsight,
  MetricKey,
  SensePanelProps,
} from '../view-model'
import css from './body.module.css'

type Panel = Pick<SensePanelProps, 'model' | 'onOpenPermissionSettings'>
type Insights = Partial<Record<MetricKey, MetricInsight>>

const SEV_TEXT = { good: '良好', warn: '注意', critical: '紧急', unknown: '未知' } as const
const PRESSURE_TEXT = { normal: '压力正常', warn: '压力偏高', critical: '压力过载' } as const
const THERMAL_TEXT = { nominal: '正常', fair: '偏高', serious: '偏高', critical: '过热' } as const

/** 多指标行（网络/进程/磁盘）合并一条来源/触发标注。 */
function mergeInsights(insights: Insights, keys: MetricKey[]): MetricInsight | undefined {
  const list = keys.map((k) => insights[k]).filter((i): i is MetricInsight => !!i)
  if (!list.length) return undefined
  return {
    baseline: list.find((i) => i.baseline)?.baseline,
    sources: [...new Set(list.flatMap((i) => i.sources))],
    triggered: [...new Set(list.flatMap((i) => i.triggered))],
    severity: list.find((i) => i.severity === 'critical')?.severity ?? list.find((i) => i.severity)?.severity,
  }
}

/** 基线学习进度：只呈现 model 提供的 collected/target，不做推断。 */
function LearningStrip({ l }: { l: LearningState }) {
  const valid = Number.isFinite(l.targetMs) && l.targetMs > 0
  return (
    <div className={css.learning}>
      {valid ? (
        <>
          <span className={css.detail}>
            基线学习 {formatPercent(Math.min(1, Math.max(0, l.collectedMs / l.targetMs)))} ·{' '}
            {l.status === 'learning' ? '学习中' : '已就绪'}
          </span>
          <progress
            className={css.learnBar}
            value={Math.min(1, Math.max(0, l.collectedMs / l.targetMs))}
            max={1}
            aria-label="基线学习进度"
          />
        </>
      ) : (
        <span className={css.detail}>基线学习 进度不可用</span>
      )}
    </div>
  )
}

export function BodySection({ model, onOpenPermissionSettings }: Panel) {
  const { body } = model.state.self
  const { now, history } = model
  const insights = model.insights ?? {}
  const evalResult = evaluateBody(body, now, insights)
  const rows = evalResult.rows
  const fvp = { now, onOpenPermissionSettings }
  const diskKeys = (body.disks.value ?? []).map((d) => `disk:${d.mount}` as const)

  return (
    <>
      <div className={css.health} data-sev={evalResult.severity}>
        <PulseIcon size={16} className={css.healthIcon} />
        <div className={css.healthText}>
          <strong>{SEV_TEXT[evalResult.severity]}</strong>
          <span>{evalResult.sentence}</span>
        </div>
      </div>
      {model.learning && <LearningStrip l={model.learning} />}

      <Row rowKey="cpu" icon={<CpuIcon />} label="CPU" sev={rows.cpu.severity} fact={body.cpu} now={now}>
        <FactValue fact={body.cpu} {...fvp}>
          {(v) => (
            <>
              <div className={css.rowValue}>{formatPercent(v.usage)}</div>
              <Bar ratio={v.usage} />
              <div className={css.cores} aria-hidden="true">
                {v.perCore.map((c, i) => (
                  <i key={i} style={{ height: `${Math.round(Math.min(1, c) * 100)}%` }} />
                ))}
              </div>
              <div className={css.detail}>
                负载 {formatLoad(v.load1)} / {formatLoad(v.load5)} / {formatLoad(v.load15)}
              </div>
              <Sparkline
                points={history.cpu}
                now={now}
                label="CPU 使用率"
                format={formatPercent}
                severity={rows.cpu.severity}
                baseline={insights.cpu?.baseline}
              />
            </>
          )}
        </FactValue>
        <InsightLine insight={insights.cpu} />
      </Row>

      <Row rowKey="memory" icon={<MemoryIcon />} label="内存" sev={rows.memory.severity} fact={body.memory} now={now}>
        <FactValue fact={body.memory} {...fvp}>
          {(v) => (
            <>
              <div className={css.rowValue}>
                {formatBytes(v.used)} / {formatBytes(v.total)}
              </div>
              <Bar ratio={v.total > 0 ? v.used / v.total : 0} />
              <div className={css.detail}>
                {PRESSURE_TEXT[v.pressure]} · 交换 {formatBytes(v.swapUsed)}
              </div>
              <Sparkline
                points={history.memory}
                now={now}
                label="内存占用"
                format={formatPercent}
                severity={rows.memory.severity}
                baseline={insights.memory?.baseline}
              />
            </>
          )}
        </FactValue>
        <InsightLine insight={insights.memory} />
      </Row>

      <Row rowKey="disks" icon={<DiskIcon />} label="磁盘" sev={rows.disks.severity} fact={body.disks} now={now}>
        <FactValue fact={body.disks} {...fvp}>
          {(disks) => (
            <DiskRows
              disks={disks}
              fact={body.disks}
              now={now}
              history={history.disks}
              insights={insights}
            />
          )}
        </FactValue>
        <InsightLine insight={mergeInsights(insights, diskKeys)} />
      </Row>

      {!rows.battery.hidden && (
        <Row rowKey="battery" icon={<BatteryIcon />} label="电池" sev={rows.battery.severity} fact={body.battery} now={now}>
          <FactValue fact={body.battery} {...fvp}>
            {(v) =>
              v && (
                <>
                  <div className={css.rowValue}>{formatPercentValue(v.percent)}</div>
                  <div className={css.detail}>
                    {v.charging ? '充电中' : '未充电'}
                    {v.minutesLeft != null ? ` · 约剩 ${formatDuration(v.minutesLeft * 60)}` : ''}
                  </div>
                  <Sparkline
                    points={history.battery}
                    now={now}
                    label="电池电量"
                    format={formatPercentValue}
                    severity={rows.battery.severity}
                    baseline={insights.battery?.baseline}
                  />
                </>
              )
            }
          </FactValue>
          <InsightLine insight={insights.battery} />
        </Row>
      )}

      <Row rowKey="thermal" icon={<ThermalIcon />} label="温控" sev={rows.thermal.severity} fact={body.thermal} now={now}>
        <FactValue fact={body.thermal} {...fvp}>
          {(v) => (
            <>
              <div className={css.rowValue}>{THERMAL_TEXT[v]}</div>
              <Sparkline
                points={history.thermal}
                now={now}
                label="温控档位"
                format={formatThermalOrdinal}
                severity={rows.thermal.severity}
                baseline={insights.thermal?.baseline}
              />
            </>
          )}
        </FactValue>
        <InsightLine insight={insights.thermal} />
      </Row>

      <Row rowKey="network" icon={<NetworkIcon />} label="网络" sev={rows.network.severity} fact={body.network} now={now}>
        <FactValue fact={body.network} {...fvp}>
          {(v) => (
            <>
              <div className={css.rowValue}>{v.online ? '已连接' : '已断开'}</div>
              <div className={css.detail}>
                ↓ {formatRate(v.rxBps)} · ↑ {formatRate(v.txBps)}
              </div>
              <Sparkline
                points={history.networkRx}
                now={now}
                label="网络下行"
                format={formatRate}
                severity={rows.network.severity}
                baseline={insights.networkRx?.baseline}
              />
              <Sparkline
                points={history.networkTx}
                now={now}
                label="网络上行"
                format={formatRate}
                severity={rows.network.severity}
                baseline={insights.networkTx?.baseline}
              />
            </>
          )}
        </FactValue>
        <InsightLine insight={mergeInsights(insights, ['networkRx', 'networkTx'])} />
      </Row>

      <Row rowKey="process" icon={<ProcessIcon />} label="DSH 进程" sev={rows.process.severity} fact={body.harnessProcess} now={now}>
        <FactValue fact={body.harnessProcess} {...fvp}>
          {(v) => (
            <>
              <div className={css.rowValue}>
                {formatBytes(v.rss)} · CPU {formatPercent(v.cpu)}
              </div>
              <div className={css.detail}>已运行 {formatDuration(v.uptimeSec)}</div>
              <Sparkline
                points={history.processRss}
                now={now}
                label="DSH 内存"
                format={formatBytes}
                severity={rows.process.severity}
                baseline={insights.processRss?.baseline}
              />
              <Sparkline
                points={history.processCpu}
                now={now}
                label="DSH CPU"
                format={formatPercent}
                severity={rows.process.severity}
                baseline={insights.processCpu?.baseline}
              />
            </>
          )}
        </FactValue>
        <InsightLine insight={mergeInsights(insights, ['processCpu', 'processRss'])} />
      </Row>

      <TokenRow
        model={model}
        sev={rows.tokens.severity}
        onOpenPermissionSettings={onOpenPermissionSettings}
      />
    </>
  )
}
