import { attentionLine } from '../attention'
import { ClockProvider, SamplingProvider } from '../clock'
import { evaluateBody, type Severity } from '../health'
import { formatPercent } from '../format'
import { DisksTile } from './disk-rows'
import { TokenTile } from './token-row'
import { NetworkTile, ProcessTile } from './tiles-net-proc'
import { CpuTile, MemoryTile, type TileCtx } from './tiles-basic'
import { BatteryTile, ThermalTile } from './tiles-extra'
import type { LearningState, SensePanelProps } from '../view-model'
import css from './body.module.css'
import mcss from './monitor.module.css'

type Panel = Pick<SensePanelProps, 'model' | 'onOpenPermissionSettings'>

const SEV_WORD = {
  good: '良好',
  warn: '注意',
  critical: '紧急',
  unknown: '未知',
} as const

/** ECG 心电线：底色为基线，脉冲段按严重度不同周期流动（reduced-motion 时静止）。 */
function Ecg() {
  const d = 'M0 12h14l4-8 6 16 5-14 3 6h28'
  return (
    <svg className={mcss.ecg} viewBox="0 0 60 24" aria-hidden="true">
      <path className={mcss.ecgBase} d={d} />
      <path className={mcss.ecgPulse} d={d} />
    </svg>
  )
}

/** 基线学习进度：只呈现 model 提供的 collected/target，不做推断。 */
function LearningStrip({ l }: { l: LearningState }) {
  const valid = Number.isFinite(l.targetMs) && l.targetMs > 0
  return (
    <span className={mcss.learning}>
      {valid ? (
        <>
          <span className={mcss.monitorSub}>
            基线学习 {formatPercent(Math.min(1, Math.max(0, l.collectedMs / l.targetMs)))} ·{' '}
            {l.status === 'learning' ? '学习中' : '已就绪'}
          </span>
          <progress
            className={mcss.learnBar}
            value={Math.min(1, Math.max(0, l.collectedMs / l.targetMs))}
            max={1}
            aria-label="基线学习进度"
          />
        </>
      ) : (
        <span className={mcss.monitorSub}>基线学习 进度不可用</span>
      )}
    </span>
  )
}

/** 监护概览：大写严重度词 + 状态句（有匹配的近期宿主投影时换成优先警示行）。
 *  读数不完整时词旁另出「部分」徽标——警示句被覆盖也不丢完整性提示。 */
function Monitor({ model, sev, sentence, partial }: { model: Panel['model']; sev: Severity; sentence: string; partial?: boolean }) {
  return (
    <div className={mcss.monitor} data-sev={sev}>
      <Ecg />
      <div className={mcss.monitorText}>
        <strong className={mcss.monitorWord}>
          {SEV_WORD[sev]}
          {partial ? <span className={mcss.monitorPartial}>部分</span> : null}
        </strong>
        <span className={mcss.monitorSub}>{sentence}</span>
        {model.learning?.status === 'learning' && (
          <LearningStrip l={model.learning} />
        )}
      </div>
    </div>
  )
}

export function BodySection({
  model,
  onOpenPermissionSettings,
  onAdjustMetric,
}: Panel & { onAdjustMetric?: () => void }) {
  const { body } = model.state.self
  const { now } = model
  const insights = model.insights ?? {}
  const evalResult = evaluateBody(body, now, insights)
  const rows = evalResult.rows
  const sentence = attentionLine(model, evalResult) ?? evalResult.sentence
  const ctx: TileCtx = {
    model,
    onAdjust: onAdjustMetric,
    onOpenPermissionSettings,
  }
  const interval = model.sampleIntervalMs

  return (
    <>
      <Monitor
        model={model}
        sev={evalResult.severity}
        sentence={sentence}
        partial={evalResult.partial}
      />
      <ClockProvider value={now}>
        <SamplingProvider value={interval && Number.isFinite(interval) && interval > 0 ? interval : 2000}>
          <div className={css.tiles}>
            <CpuTile model={model} rows={rows} ctx={ctx} />
            <MemoryTile model={model} rows={rows} ctx={ctx} />
            <TokenTile model={model} rows={rows} ctx={ctx} />
            <DisksTile model={model} rows={rows} ctx={ctx} />
            <NetworkTile model={model} rows={rows} ctx={ctx} />
            <ThermalTile model={model} rows={rows} ctx={ctx} />
            {!rows.battery.hidden && <BatteryTile model={model} rows={rows} ctx={ctx} />}
            <ProcessTile model={model} rows={rows} ctx={ctx} />
          </div>
        </SamplingProvider>
      </ClockProvider>
    </>
  )
}
