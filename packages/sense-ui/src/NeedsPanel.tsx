import { useState } from 'react';
import { useFreshModel } from './freshness';
import { PauseIcon, ShieldIcon } from './icons';
import css from './panel.module.css';
import { BodySection } from './sections/body';
import { HelpCardsSection } from './sections/help-cards';
import { MaintenanceSection } from './sections/maintenance';
import { NeedsSection } from './sections/needs';
import ncss from './sections/needs.module.css';
import { NowSection } from './sections/now';
import type { NeedsPanelProps } from './view-model';

/**
 * `asi-needs` 统一侧栏面板：纯 props 渲染。
 * 展示：啼哭求助卡、五大生存需求稳态张力、本能反射与后台自维护会话、
 * 核心身体体征（含 5 分钟趋势环）、当前环境快照、暂停与隐私开关。
 */
export function NeedsPanel(props: NeedsPanelProps) {
  const model = useFreshModel(props.model);
  const [controlsOpen, setControlsOpen] = useState(false);

  return (
    <div className={css.panel} data-panel>
      <header className={css.header}>
        <h1 className={css.title}>生存需求</h1>
        <span className={css.privacy} title="观察数据只留在本机">
          <ShieldIcon />
          仅本机
        </span>
        {model.instinct.powerMode === 'eco' && <span className={ncss.ecoTag}>节能模式</span>}
        {model.paused && (
          <span className={css.pausedTag}>
            <PauseIcon />
            已暂停
          </span>
        )}
      </header>

      <div className={css.notices}>
        <HelpCardsSection
          cards={model.helpCards}
          now={model.now}
          onApprove={props.onApproveHelp}
          onDismiss={props.onDismissHelp}
        />
      </div>

      <details open className={css.section}>
        <summary>生存需求</summary>
        <div className={css.sectionBody}>
          <NeedsSection needs={model.needs} overallZone={model.overallZone} />
        </div>
      </details>

      <details open className={css.section}>
        <summary>自发维护</summary>
        <div className={css.sectionBody}>
          <MaintenanceSection
            now={model.now}
            paused={model.paused}
            instinct={model.instinct}
            session={model.maintenanceSession}
            records={model.recentMaintenance}
            onOpenSession={props.onOpenMaintenanceSession}
            onTriggerCheck={props.onTriggerCheck}
          />
        </div>
      </details>

      <details open className={css.section}>
        <summary>核心体征</summary>
        <div className={css.sectionBody}>
          <BodySection model={model} onOpenPermissionSettings={props.onOpenPermissionSettings} />
        </div>
      </details>

      <details open className={css.section}>
        <summary>当前环境</summary>
        <div className={css.sectionBody}>
          <NowSection model={model} onOpenPermissionSettings={props.onOpenPermissionSettings} />
        </div>
      </details>

      <details open={controlsOpen} className={css.section} onToggle={(e) => setControlsOpen(e.currentTarget.open)}>
        <summary>控制与隐私</summary>
        <div className={css.sectionBody}>
          <div className={ncss.controlsWrap}>
            <label className={ncss.toggleRow}>
              <input
                type="checkbox"
                checked={model.paused}
                onChange={(e) => void props.onPause(e.currentTarget.checked)}
              />
              暂停感知与自维护
            </label>
            <label className={ncss.toggleRow}>
              <input
                type="checkbox"
                checked={model.sendTitles}
                onChange={(e) => void props.onToggleTitles(e.currentTarget.checked)}
              />
              窗口标题发给模型
            </label>
            <p className={ncss.privacyNote}>
              日常对话仅开放只读查询，不主动注入环境动态；清理缓存、结束卡死任务与整理上下文仅限后台自维护会话使用。
            </p>
          </div>
        </div>
      </details>
    </div>
  );
}
