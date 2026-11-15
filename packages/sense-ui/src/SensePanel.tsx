import { useCallback, useState } from 'react'
import type { SensePanelProps } from './view-model'
import { PauseIcon, ShieldIcon } from './icons'
import { BodySection } from './sections/body'
import { NowSection } from './sections/now'
import { EventsSection } from './sections/events'
import { RulesSection } from './sections/rules'
import css from './panel.module.css'

/**
 * asi-sense 侧栏面板：纯 props 渲染。
 * 自身只持有：规则分区开合（默认收起）与「调整入口→调整日志」的内部联动，
 * 不新增对外回调。
 */
export function SensePanel(props: SensePanelProps) {
  const { model } = props
  const [rulesOpen, setRulesOpen] = useState(false)
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
        <summary>规则</summary>
        <div className={css.sectionBody}>
          <RulesSection {...props} tuningReq={tuningReq} />
        </div>
      </details>
    </div>
  )
}
