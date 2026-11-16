import { useCallback, useRef, useState } from 'react'
import type { SensePanelProps } from './view-model'
import { PauseIcon, ShieldIcon } from './icons'
import { BodySection } from './sections/body'
import { NowSection } from './sections/now'
import { EventsSection } from './sections/events'
import { RulesSection } from './sections/rules'
import { useTuningOperations } from './sections/tuning-operation'
import rulesCss from './sections/rules.module.css'
import css from './panel.module.css'

/**
 * asi-sense 侧栏面板：纯 props 渲染。
 * 自身持有：规则分区开合、危险调参操作状态与「调整入口→调整日志」的内部联动，
 * 不新增对外回调。
 */
export function SensePanel(props: SensePanelProps) {
  const { model } = props
  const [rulesOpen, setRulesOpen] = useState(false)
  const rulesSummary = useRef<HTMLElement>(null)
  const operations = useTuningOperations(model)
  // 自增信号：每次点卡片「调整」+1，RulesSection 据此切到调整日志视图并聚焦
  const [tuningReq, setTuningReq] = useState(0)
  const openTuning = useCallback(() => {
    setRulesOpen(true)
    setTuningReq((n) => n + 1)
  }, [])

  return (
    <div className={css.panel} data-panel>
      <header className={css.header}>
        <h1 className={css.title}>环境感知</h1>
        <span className={css.privacy} title="观察数据只留在本机">
          <ShieldIcon />
          仅本机
        </span>
        {model.paused && (
          <span className={css.pausedTag}>
            <PauseIcon />
            已暂停
          </span>
        )}
      </header>

      {Object.entries(operations.operations).map(([key, operation]) =>
        (operation.phase === 'error' || operation.phase === 'unconfirmed') && (
          <div key={key} className={rulesCss.notice} role="alert">
            <span>{operation.label}{operation.phase === 'error' ? '失败，请重试' : '：未确认结果，请检查状态'}</span>
            <button type="button" aria-label="关闭操作提示" onClick={() => {
              operations.dismiss(key)
              rulesSummary.current?.focus()
            }}>关闭</button>
          </div>
        ),
      )}

      <details open className={css.section}>
        <summary>身体</summary>
        <div className={css.sectionBody}>
          <BodySection
            model={model}
            onOpenPermissionSettings={props.onOpenPermissionSettings}
            onAdjustMetric={openTuning}
          />
        </div>
      </details>

      <details open className={css.section}>
        <summary>现在</summary>
        <div className={css.sectionBody}>
          <NowSection
            model={model}
            onOpenPermissionSettings={props.onOpenPermissionSettings}
          />
        </div>
      </details>

      <details open className={css.section}>
        <summary>事件流</summary>
        <div className={css.sectionBody}>
          <EventsSection model={model} onFeedback={props.onFeedback} />
        </div>
      </details>

      <details
        open={rulesOpen}
        className={css.section}
        onToggle={(e) => setRulesOpen(e.currentTarget.open)}
      >
        <summary ref={rulesSummary}>规则</summary>
        <div className={css.sectionBody}>
          <RulesSection {...props} tuningReq={tuningReq} operations={operations} />
        </div>
      </details>
    </div>
  )
}
