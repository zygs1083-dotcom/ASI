import { useCallback, useRef, useState } from 'react';
import { useFreshModel } from './freshness';
import { PauseIcon, ShieldIcon } from './icons';
import css from './panel.module.css';
import { BodySection } from './sections/body';
import { EventsSection } from './sections/events';
import { HistorySection } from './sections/history';
import { NowSection } from './sections/now';
import { RulesSection } from './sections/rules';
import rulesCss from './sections/rules.module.css';
import { defaultTuningCopy, TuningBackupStatus } from './sections/tuning-actions';
import { useTuningOperations } from './sections/tuning-operation';
import { SessionTarget } from './session-target';
import type { SensePanelProps } from './view-model';

/**
 * asi-sense 侧栏面板：纯 props 渲染。
 * 自身持有：规则分区开合、危险调参操作状态与「调整入口→调整日志」的内部联动，
 * 不新增对外回调。
 */
export function SensePanel(props: SensePanelProps) {
  const model = useFreshModel(props.model);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const rulesSummary = useRef<HTMLElement>(null);
  const operations = useTuningOperations(model);
  // 自增信号：每次点卡片「调整」+1，RulesSection 据此切到调整日志视图并聚焦
  const [tuningReq, setTuningReq] = useState(0);
  const openTuning = useCallback(() => {
    setRulesOpen(true);
    setTuningReq((n) => n + 1);
  }, []);

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

      {model.target && props.onSelectTarget && (
        <SessionTarget
          target={model.target}
          now={model.now}
          onSelect={props.onSelectTarget}
          onDismiss={props.onDismissTargetNotice}
          copy={props.targetCopy}
        />
      )}

      <div className={css.notices}>
        <TuningBackupStatus {...props} model={model} operations={operations} />
        {Object.entries(operations.operations).map(
          ([key, operation]) =>
            (operation.phase === 'error' || operation.phase === 'unconfirmed') && (
              <div key={key} className={rulesCss.notice} role="alert">
                <span>
                  {operation.label}
                  {operation.phase === 'error'
                    ? (props.tuningCopy ?? defaultTuningCopy).actionFailed
                    : (props.tuningCopy ?? defaultTuningCopy).actionUnconfirmed}
                </span>
                <button
                  type="button"
                  aria-label="关闭操作提示"
                  onClick={(event) => {
                    const notice = event.currentTarget.parentElement;
                    const neighbor = notice?.nextElementSibling ?? notice?.previousElementSibling;
                    const target = neighbor?.querySelector('button') ?? rulesSummary.current;
                    target?.focus();
                    operations.dismiss(key);
                  }}
                >
                  关闭
                </button>
              </div>
            ),
        )}
      </div>

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
            onToggleGlobalFileWatch={props.onToggleGlobalFileWatch}
            onRetryGlobalFileWatch={props.onRetryGlobalFileWatch}
            onAddFileExclusion={props.onAddFileExclusion}
            onRemoveFileExclusion={props.onRemoveFileExclusion}
          />
        </div>
      </details>

      <details open className={css.section}>
        <summary>事件流</summary>
        <div className={css.sectionBody}>
          <EventsSection model={model} onFeedback={props.onFeedback} />
        </div>
      </details>

      <details open={historyOpen} className={css.section} onToggle={(e) => setHistoryOpen(e.currentTarget.open)}>
        <summary>历史</summary>
        <div className={css.sectionBody}>
          <HistorySection
            model={model}
            open={historyOpen}
            onListMonths={props.onListMonths}
            onLoadMonthly={props.onLoadMonthly}
            onClearHistory={props.onClearHistory}
          />
        </div>
      </details>

      <details open={rulesOpen} className={css.section} onToggle={(e) => setRulesOpen(e.currentTarget.open)}>
        <summary ref={rulesSummary}>规则</summary>
        <div className={css.sectionBody}>
          <RulesSection {...props} model={model} tuningReq={tuningReq} operations={operations} />
        </div>
      </details>
    </div>
  );
}
