import { useState } from 'react';
import { formatAge } from '../format';
import type { HelpActionKind, HelpCard, NeedKey } from '../view-model';
import css from './needs.module.css';

export const NEED_LABEL: Record<NeedKey, string> = {
  energy: '能量',
  space: '空间',
  memory: '内存与进程',
  mind: '心智容量',
  thermals: '体温负荷',
};

const APPROVE_LABEL: Record<HelpActionKind, string> = {
  acknowledge: '我已处理',
  'clean-cache': '批准清理缓存',
  'clean-external-cache': '批准清理外部缓存',
  'stop-stuck-jobs': '批准结束任务',
  'compact-context': '批准整理上下文',
  'enable-eco': '启用节能模式',
  'open-permissions': '打开权限设置',
  'run-drive-action': '批准执行看护动作',
};

export function HelpCardsSection({
  cards,
  now,
  onApprove,
  onDismiss,
}: {
  cards: HelpCard[];
  now: number;
  onApprove: (cardId: string) => void | Promise<void>;
  onDismiss: (cardId: string) => void | Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const openCards = cards.filter((c) => c.status === 'open');
  if (openCards.length === 0 && !errorMsg) return null;

  const runAction = async (cardId: string, label: string, fn: (id: string) => void | Promise<void>) => {
    setBusyId(cardId);
    setErrorMsg(null);
    try {
      await fn(cardId);
    } catch {
      setErrorMsg(`${label}操作失败，请重试`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className={css.helpWrap} aria-label="啼哭求助">
      {errorMsg && (
        <div className={css.noticeAlert} role="alert">
          <span>{errorMsg}</span>
          <button type="button" aria-label="关闭操作提示" onClick={() => setErrorMsg(null)}>
            关闭
          </button>
        </div>
      )}
      {openCards.length > 0 && (
        <>
          <div className={css.helpHeader}>
            <span>啼哭求助（{openCards.length}）</span>
          </div>
          {openCards.map((card) => {
            const busy = busyId === card.id;
            const age = formatAge(now, card.updatedAt);
            const approveLabel = card.approveLabel || APPROVE_LABEL[card.actionKind];
            const needTag = card.need ? NEED_LABEL[card.need] : (card.driveLabel ?? card.driveKey ?? '高阶看护');
            return (
              <article key={card.id} className={css.helpCard} data-help-card={card.id} data-zone={card.severity}>
                <div className={css.helpTop}>
                  <span className={css.helpTitle}>{card.title}</span>
                  <span className={css.helpNeedTag}>
                    {needTag} · {card.severity === 'critical' ? '危急' : '不适'}
                    {age === '刚刚' ? '' : ` · ${age}`}
                  </span>
                </div>
                <div className={css.helpSummary}>{card.summary}</div>
                {card.actionTarget && (
                  <div className={css.helpReason}>
                    受控目标标识：{card.actionTarget}
                    {card.actionKind === 'clean-external-cache' ? '（自动跳过 1 小时内活跃项）' : ''}
                    {card.actionKind === 'run-drive-action' ? '（执行前二次复核活跃豁免与安全护栏）' : ''}
                  </div>
                )}
                {card.proposedAction && <div className={css.helpReason}>建议处理：{card.proposedAction}</div>}
                <div className={css.helpActions}>
                  <button
                    type="button"
                    className={css.primaryBtn}
                    disabled={busy}
                    onClick={() => void runAction(card.id, approveLabel, onApprove)}
                  >
                    {approveLabel}
                  </button>
                  <button type="button" disabled={busy} onClick={() => void runAction(card.id, '忽略求助', onDismiss)}>
                    忽略
                  </button>
                </div>
              </article>
            );
          })}
        </>
      )}
    </section>
  );
}
