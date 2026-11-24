import { useState } from 'react';
import {
  PARTNER_STATE_KINDS,
  PARTNER_STATE_LABELS,
  PARTNER_STATE_SHORT_LABELS,
  type PartnerOverrideInput,
  type PartnerStateKind,
  TACT_AUTONOMY_LABELS,
  TACT_VERBOSITY_LABELS,
  type TomPanelModel,
} from '../tom/shared/types.ts';
import css from './tom-card.module.css';

function stateTone(state: PartnerStateKind): 'focus' | 'friction' | 'neutral' {
  if (state === 'stuck_debugging') return 'friction';
  if (state === 'deep_focus' || state === 'rapid_sprint') return 'focus';
  return 'neutral';
}

export interface TomCapsuleBadgeProps {
  tom: TomPanelModel;
  onSelectCareTab: () => void;
}

export function TomCapsuleBadge({ tom, onSelectCareTab }: TomCapsuleBadgeProps) {
  if (!tom.enabled || tom.sensePaused) return null;
  const tone = stateTone(tom.state);
  const shortLabel = PARTNER_STATE_SHORT_LABELS[tom.state];
  const fullLabel = PARTNER_STATE_LABELS[tom.state];
  return (
    <button
      type="button"
      className={css.capsuleBadge}
      data-tone={tone}
      data-testid="tom-capsule-badge"
      title={`搭档状态：${fullLabel} — ${tom.guidance.headline}`}
      aria-label={`搭档·${shortLabel}（${fullLabel}，点击查看协作眼力见）`}
      onClick={onSelectCareTab}
    >
      {`搭档·${shortLabel}`}
    </button>
  );
}

export interface TomCardProps {
  tom: TomPanelModel;
  onSetTomEnabled?: (enabled: boolean) => unknown;
  onSetPartnerOverride?: (input: PartnerOverrideInput) => unknown;
  onResetTomBaseline?: () => unknown;
}

export function TomCard({ tom, onSetTomEnabled, onSetPartnerOverride, onResetTomBaseline }: TomCardProps) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; isError: boolean } | null>(null);

  const tone = !tom.enabled || tom.sensePaused ? 'neutral' : stateTone(tom.state);
  const stateLabel = PARTNER_STATE_LABELS[tom.state];
  const confidencePct = Math.round(Math.max(0, Math.min(1, tom.confidence)) * 100);

  const runAction = async (fn: () => Promise<void>, okMessage: string) => {
    setBusy(true);
    try {
      await fn();
      setFeedback({ text: okMessage, isError: false });
    } catch (err) {
      setFeedback({
        text: err instanceof Error && err.message.trim() ? err.message : '操作失败，请重试',
        isError: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleOverride = (target: PartnerStateKind | null) => {
    if (!onSetPartnerOverride) return;
    const msg =
      target === null
        ? '已恢复自动心智状态推断。'
        : `已校准并锁定为「${PARTNER_STATE_LABELS[target]}」（60 分钟），个人偏好权重已更新。`;
    void runAction(async () => {
      await onSetPartnerOverride({ state: target, durationMinutes: 60 });
    }, msg);
  };

  const handleToggleEnabled = (enabled: boolean) => {
    if (!onSetTomEnabled) return;
    void runAction(
      async () => {
        await onSetTomEnabled(enabled);
      },
      enabled ? '已开启搭档状态感知与协作眼力见。' : '已关闭搭档状态感知。',
    );
  };

  const handleResetBaseline = () => {
    if (!onResetTomBaseline) return;
    void runAction(async () => {
      await onResetTomBaseline();
    }, '已重置个人交互节律基线与校准偏置。');
  };

  const statusTagText = !tom.enabled
    ? '已关闭'
    : tom.sensePaused
      ? '随全局暂停'
      : tom.source === 'manual_override'
        ? `手动锁定 · ${stateLabel}`
        : `${stateLabel} · ${confidencePct}%`;

  const dims: { key: string; label: string; value: number; warn?: boolean }[] = [
    { key: 'focus', label: '心流专注', value: tom.dimensions.focus },
    { key: 'friction', label: '交互摩擦', value: tom.dimensions.friction, warn: tom.dimensions.friction >= 48 },
    { key: 'pace', label: '推进节奏', value: tom.dimensions.pace },
    { key: 'presence', label: '在场活跃', value: tom.dimensions.presence },
  ];

  return (
    <section className={css.tomCard} data-testid="tom-partner-card" aria-label="搭档状态与协作眼力见">
      <div className={css.headerRow}>
        <h2 className={css.heading}>搭档状态与协作眼力见</h2>
        <span className={css.statePill} data-tone={tone} data-testid="tom-state-pill">
          {statusTagText}
        </span>
      </div>

      {feedback && (
        <div
          role={feedback.isError ? 'alert' : 'status'}
          className={`${css.feedbackRow} ${feedback.isError ? css.feedbackError : ''}`}
          data-testid="tom-feedback"
        >
          <span>{feedback.text}</span>
          <button type="button" className={css.inlineTextBtn} onClick={() => setFeedback(null)}>
            关闭
          </button>
        </div>
      )}

      <div className={css.tactBox}>
        <p className={css.tactHeadline} data-testid="tom-tact-headline">
          {tom.guidance.headline}
        </p>
        <div className={css.tactChips}>
          <span className={css.tactChip}>{`详略：${TACT_VERBOSITY_LABELS[tom.guidance.verbosity]}`}</span>
          <span className={css.tactChip}>{`姿态：${TACT_AUTONOMY_LABELS[tom.guidance.autonomy]}`}</span>
          <span className={css.tactChip}>{`追问预算：<= ${tom.guidance.questionBudget}`}</span>
          {tom.guidance.deferNonCriticalInterruptions && <span className={css.tactChip}>免扰避让</span>}
        </div>
      </div>

      <div className={css.dimGrid}>
        {dims.map((d) => {
          const pct = Math.max(0, Math.min(100, Math.round(d.value)));
          return (
            <div key={d.key} className={css.dimCell} data-tom-dim={d.key}>
              <div className={css.dimTop}>
                <span>{d.label}</span>
                <span className={css.dimVal}>{`${pct}%`}</span>
              </div>
              <div className={css.dimTrack} aria-hidden="true">
                <i className={css.dimFill} data-tone={d.warn ? 'warn' : 'normal'} style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>

      {tom.reasons[0] && <p className={css.reasonText}>{tom.reasons[0]}</p>}

      {onSetPartnerOverride && (
        <fieldset className={css.calibrateGroup} aria-label="搭档状态一键校准">
          <button
            type="button"
            className={`${css.calibrateBtn} ${tom.source === 'inferred' && tom.enabled ? css.calibrateBtnActive : ''}`}
            data-testid="tom-override-auto"
            aria-pressed={tom.source === 'inferred' && tom.enabled}
            disabled={busy || !tom.enabled}
            onClick={() => handleOverride(null)}
          >
            自动感知
          </button>
          {PARTNER_STATE_KINDS.map((kind) => {
            const isSelected = tom.source === 'manual_override' && tom.state === kind;
            return (
              <button
                key={kind}
                type="button"
                className={`${css.calibrateBtn} ${isSelected ? css.calibrateBtnActive : ''}`}
                data-testid={`tom-override-${kind}`}
                aria-label={`${PARTNER_STATE_SHORT_LABELS[kind]}：校准为${PARTNER_STATE_LABELS[kind]}`}
                aria-pressed={isSelected}
                disabled={busy || !tom.enabled}
                onClick={() => handleOverride(kind)}
              >
                {PARTNER_STATE_SHORT_LABELS[kind]}
              </button>
            );
          })}
        </fieldset>
      )}

      <details className={css.tomDrawer} data-testid="drawer-tom">
        <summary className={css.tomDrawerSummary}>
          <span>{`个体节律基线与感知控制（样本 ${tom.baseline.sampleCount} · 校准 ${tom.baseline.calibrationCount}）`}</span>
          <span aria-hidden="true">▸</span>
        </summary>
        <div className={css.tomDrawerBody}>
          <span>
            {`个人基线：均间隔 ${tom.baseline.avgCadenceSec}s/条 · 均字数 ${tom.baseline.avgPromptChars} 字 · 5m 切换均值 ${tom.baseline.avgSwitchesPer5m} 次（零原文留存）`}
          </span>
          {tom.reasons.slice(1).map((r) => (
            <span key={r}>{r}</span>
          ))}
          {onSetTomEnabled && (
            <label className={css.toggleRow}>
              <input
                type="checkbox"
                data-testid="tom-enabled-toggle"
                checked={tom.enabled}
                disabled={busy}
                onChange={(e) => handleToggleEnabled(e.currentTarget.checked)}
              />
              启用搭档状态感知与协作眼力见
            </label>
          )}
          {onResetTomBaseline && (
            <button
              type="button"
              className={css.secondaryBtn}
              data-testid="tom-reset-baseline-btn"
              disabled={busy}
              onClick={handleResetBaseline}
            >
              重置个人节律基线
            </button>
          )}
        </div>
      </details>
    </section>
  );
}
