import type { SensePanelProps } from './view-model'
import { PauseIcon, ShieldIcon } from './icons'
import { BodySection } from './sections/body'
import { NowSection } from './sections/now'
import { EventsSection } from './sections/events'
import { RulesSection } from './sections/rules'
import css from './panel.module.css'

/** asi-sense 侧栏面板：纯 props 渲染，自身只持有 details 开合与事件分页状态。 */
export function SensePanel(props: SensePanelProps) {
  const { model } = props
  return (
    <div className={css.panel}>
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

      <details open className={css.section}>
        <summary>规则</summary>
        <div className={css.sectionBody}>
          <RulesSection {...props} />
        </div>
      </details>
    </div>
  )
}
