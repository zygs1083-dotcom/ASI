import { useCallback, useEffect, useRef, useState } from 'react';
import { formatTimestamp, formatTuningValue } from '../format';
import { EyeOffIcon, PauseIcon } from '../icons';
import type { SensePanelProps, SenseRule, TuningParam } from '../view-model';
import css from './rules.module.css';
import { RebaselineSuggestions, TuningDisabled } from './tuning-actions';
import type { TuningOperations } from './tuning-operation';

const LEVEL_TEXT = { record: '记录', context: '注入', wake: '唤醒' } as const;
const BY_TEXT = { agent: 'Agent', user: '用户', auto: '自动' } as const;

function isPending(r: SenseRule): boolean {
  return r.createdBy === 'agent' && r.level === 'wake' && !r.confirmed;
}

function UndoButton({ onClick }: { onClick: () => void }) {
  const button = useRef<HTMLButtonElement | null>(null);
  const ref = useCallback((node: HTMLButtonElement | null) => {
    if (!node && button.current === document.activeElement) button.current?.parentElement?.focus();
    button.current = node;
  }, []);
  return (
    <button ref={ref} type="button" onClick={onClick}>
      撤销
    </button>
  );
}

function RuleList({ model, onToggleRule, onConfirmRule, onDeleteRule }: SensePanelProps) {
  return (
    <ul className={css.rules}>
      {model.rules.length === 0 && <li className={css.empty}>暂无规则</li>}
      {model.rules.map((r) => {
        const pending = isPending(r);
        return (
          <li key={r.id} className={css.rule} data-pending={pending || undefined}>
            <div className={css.ruleMain}>
              <span className={css.ruleName}>
                {r.name}
                {pending && <em className={css.pendingTag}>待确认</em>}
              </span>
              <span className={css.ruleDesc}>
                {r.match.kind}
                {r.match.subject ? ` · ${r.match.subject}` : ''} · {LEVEL_TEXT[r.level]}
                {r.createdBy === 'agent' ? ' · Agent 提议' : ''}
              </span>
              {r.note && <span className={css.ruleNote}>{r.note}</span>}
            </div>
            <div className={css.ruleOps}>
              {pending ? (
                <>
                  <button type="button" onClick={() => onConfirmRule(r.id)}>
                    确认
                  </button>
                  <button type="button" onClick={() => onDeleteRule(r.id)}>
                    拒绝
                  </button>
                </>
              ) : (
                <>
                  <label className={css.enable}>
                    <input
                      type="checkbox"
                      aria-label={`${r.name}启用`}
                      checked={r.enabled}
                      onChange={(e) => onToggleRule(r.id, e.target.checked)}
                    />
                    启用
                  </label>
                  <button type="button" onClick={() => onDeleteRule(r.id)}>
                    删除
                  </button>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 调整日志视图：参数锁定开关 + 修改记录。
 * 预览层的撤销只改变 model 展示状态，宿主才拥有真正的调参护栏。
 */
function TuningView({
  model,
  onLockParam,
  onRevertTuning,
  onAcceptRebaseline,
  operations,
}: Pick<SensePanelProps, 'model' | 'onLockParam' | 'onRevertTuning' | 'onAcceptRebaseline'> & {
  operations: TuningOperations;
}) {
  const tuning = model.tuning;
  const params: TuningParam[] = tuning?.parameters ?? [];
  const log = tuning?.log ?? [];
  const unitOf = (key: string) => params.find((p) => p.key === key)?.unit;
  const labelOf = (key: string) => params.find((p) => p.key === key)?.label ?? key;

  return (
    <>
      {params.length > 0 && (
        <ul className={css.rules}>
          {params.map((p) => (
            <li key={p.key} className={css.param}>
              <span className={css.paramMain}>
                <span className={css.ruleName}>{p.label}</span>
                <span className={css.ruleDesc}>{formatTuningValue(p.value, p.unit)}</span>
              </span>
              <label className={css.enable}>
                <input
                  type="checkbox"
                  aria-label={`${p.label}锁定`}
                  checked={p.locked}
                  onChange={(e) => onLockParam(p.key, e.target.checked)}
                />
                锁定
              </label>
            </li>
          ))}
        </ul>
      )}
      <RebaselineSuggestions model={model} onAcceptRebaseline={onAcceptRebaseline} operations={operations} />
      <ul className={css.rules}>
        {log.length === 0 && <li className={css.empty}>暂无调整记录</li>}
        {log.map((e) => (
          <li key={e.id} tabIndex={-1} className={css.tuneEntry} data-reverted={e.reverted || undefined}>
            <span className={css.tuneMain}>
              <span>
                {labelOf(e.paramKey)} ·{' '}
                <span
                  role="img"
                  className={css.tunePrev}
                  aria-label={`原值 ${formatTuningValue(e.previous, unitOf(e.paramKey))}`}
                >
                  {formatTuningValue(e.previous, unitOf(e.paramKey))}
                </span>
                <span className={css.tuneArrow} aria-hidden="true">
                  {' '}
                  →{' '}
                </span>
                <span
                  role="img"
                  className={css.tuneNext}
                  aria-label={`新值 ${formatTuningValue(e.next, unitOf(e.paramKey))}`}
                >
                  {formatTuningValue(e.next, unitOf(e.paramKey))}
                </span>{' '}
                · {BY_TEXT[e.by]}
              </span>
              <span className={css.ruleDesc}>
                {e.reason} · {formatTimestamp(e.at)}
              </span>
            </span>
            {e.reverted ? (
              <span className={css.reverted}>已撤销</span>
            ) : e.undoable === false ? (
              <span className={css.reverted}>不可撤销</span>
            ) : (
              <UndoButton onClick={() => onRevertTuning(e.id)} />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

export function RulesSection(props: SensePanelProps & { tuningReq?: number; operations: TuningOperations }) {
  const { model, onPause, onToggleTitles, tuningReq, operations } = props;
  const [view, setView] = useState<'rules' | 'tuning'>('rules');
  const tuneRef = useRef<HTMLDivElement | null>(null);
  const rulesButton = useRef<HTMLButtonElement | null>(null);
  const tuningButton = useRef<HTMLButtonElement | null>(null);
  const focusView = () => (view === 'rules' ? rulesButton : tuningButton).current?.focus();
  // 「调整」入口：分区被打开后切到调整日志并把焦点带过去
  useEffect(() => {
    if (tuningReq) setView('tuning');
  }, [tuningReq]);
  // tuningReq 也进依赖：已在调整视图时再点卡片「调整」仍重新聚焦
  useEffect(() => {
    void tuningReq;
    if (view === 'tuning') tuneRef.current?.focus();
  }, [view, tuningReq]);

  return (
    <>
      <TuningDisabled
        {...props}
        operations={operations}
        onResumeTuning={() => {
          focusView();
          return props.onResumeTuning();
        }}
        onResetTuning={() => {
          focusView();
          return props.onResetTuning();
        }}
      />
      <label className={css.switch}>
        <input type="checkbox" checked={model.paused} onChange={(e) => onPause(e.target.checked)} />
        <PauseIcon />
        暂停感知
      </label>
      <label className={css.switch}>
        <input type="checkbox" checked={model.sendTitles} onChange={(e) => onToggleTitles(e.target.checked)} />
        <EyeOffIcon />
        窗口标题发给模型
        <span>标题可能包含主机名等信息。</span>
      </label>

      <fieldset className={css.viewSwitch} aria-label="规则视图">
        <button ref={rulesButton} type="button" aria-pressed={view === 'rules'} onClick={() => setView('rules')}>
          规则列表
        </button>
        <button ref={tuningButton} type="button" aria-pressed={view === 'tuning'} onClick={() => setView('tuning')}>
          调整日志
        </button>
      </fieldset>

      {view === 'rules' ? (
        <RuleList {...props} />
      ) : (
        <div ref={tuneRef} tabIndex={-1} className={css.tuneView}>
          <TuningView
            {...props}
            operations={operations}
            onAcceptRebaseline={(id) => {
              tuningButton.current?.focus();
              return props.onAcceptRebaseline(id);
            }}
          />
        </div>
      )}
    </>
  );
}
