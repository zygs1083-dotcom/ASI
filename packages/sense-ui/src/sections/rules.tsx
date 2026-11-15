import { useState } from 'react'
import { formatTimestamp, formatTuningValue } from '../format'
import { EyeOffIcon, PauseIcon } from '../icons'
import type {
  SensePanelProps,
  SenseRule,
  TuningParam,
} from '../view-model'
import css from './rules.module.css'

const LEVEL_TEXT = { record: '记录', context: '注入', wake: '唤醒' } as const
const BY_TEXT = { agent: 'Agent', user: '用户', auto: '自动' } as const

function isPending(r: SenseRule): boolean {
  return r.createdBy === 'agent' && r.level === 'wake' && !r.confirmed
}

function RuleList({
  model,
  onToggleRule,
  onConfirmRule,
  onDeleteRule,
}: SensePanelProps) {
  return (
    <ul className={css.rules}>
      {model.rules.length === 0 && <li className={css.empty}>暂无规则</li>}
      {model.rules.map((r) => {
        const pending = isPending(r)
        return (
          <li key={r.id} className={css.rule} data-pending={pending || undefined}>
            <div className={css.ruleMain}>
              <span className={css.ruleName}>
                {r.name}
                {pending && <em className={css.pendingTag}>待确认</em>}
              </span>
              <span className={css.ruleDesc}>
                {r.match.kind}
                {r.match.subject ? ` · ${r.match.subject}` : ''} ·{' '}
                {LEVEL_TEXT[r.level]}
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
        )
      })}
    </ul>
  )
}

/**
 * 调整日志视图：参数锁定开关 + 修改记录。
 * 预览层的撤销只改变 model 展示状态，宿主才拥有真正的调参护栏。
 */
function TuningView({
  model,
  onLockParam,
  onRevertTuning,
}: Pick<SensePanelProps, 'model' | 'onLockParam' | 'onRevertTuning'>) {
  const tuning = model.tuning
  const params: TuningParam[] = tuning?.parameters ?? []
  const log = tuning?.log ?? []
  const unitOf = (key: string) => params.find((p) => p.key === key)?.unit
  const labelOf = (key: string) =>
    params.find((p) => p.key === key)?.label ?? key

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
      <ul className={css.rules}>
        {log.length === 0 && <li className={css.empty}>暂无调整记录</li>}
        {log.map((e) => (
          <li key={e.id} className={css.tuneEntry} data-reverted={e.reverted || undefined}>
            <span className={css.tuneMain}>
              <span>
                {labelOf(e.paramKey)} · {formatTuningValue(e.previous, unitOf(e.paramKey))}{' '}
                → {formatTuningValue(e.next, unitOf(e.paramKey))} · {BY_TEXT[e.by]}
              </span>
              <span className={css.ruleDesc}>
                {e.reason} · {formatTimestamp(e.at)}
              </span>
            </span>
            {e.reverted ? (
              <span className={css.reverted}>已撤销</span>
            ) : (
              <button type="button" onClick={() => onRevertTuning(e.id)}>
                撤销
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  )
}

export function RulesSection(props: SensePanelProps) {
  const { model, onPause, onToggleTitles } = props
  const [view, setView] = useState<'rules' | 'tuning'>('rules')

  return (
    <>
      <label className={css.switch}>
        <input
          type="checkbox"
          checked={model.paused}
          onChange={(e) => onPause(e.target.checked)}
        />
        <PauseIcon />
        暂停感知
      </label>
      <label className={css.switch}>
        <input
          type="checkbox"
          checked={model.sendTitles}
          onChange={(e) => onToggleTitles(e.target.checked)}
        />
        <EyeOffIcon />
        窗口标题发给模型
      </label>

      <div className={css.viewSwitch} role="group" aria-label="规则视图">
        <button
          type="button"
          aria-pressed={view === 'rules'}
          onClick={() => setView('rules')}
        >
          规则列表
        </button>
        <button
          type="button"
          aria-pressed={view === 'tuning'}
          onClick={() => setView('tuning')}
        >
          调整日志
        </button>
      </div>

      {view === 'rules' ? <RuleList {...props} /> : <TuningView {...props} />}
    </>
  )
}
