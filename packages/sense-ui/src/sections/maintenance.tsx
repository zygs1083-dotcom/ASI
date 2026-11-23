import { useState } from 'react';
import { formatAge, formatBytes, formatClock, formatPercentValue } from '../format';
import type {
  ActionMeasurement,
  ActionOutcomeLedgerEntry,
  InstinctState,
  MaintenanceActor,
  MaintenanceOutcome,
  MaintenanceRecord,
  MaintenanceSessionStatus,
  ModelConnectivity,
  NeedKey,
} from '../view-model';
import { NEED_LABEL } from './help-cards';
import css from './needs.module.css';

const SESSION_STATUS_TEXT: Record<MaintenanceSessionStatus['status'], string> = {
  'not-created': '按需创建（未唤醒）',
  idle: '空闲待命',
  running: '后台排查自救中',
  unavailable: '暂不可用',
};

const CONNECTIVITY_TEXT: Record<ModelConnectivity, string> = {
  online: '在线',
  degraded: '不稳定',
  offline: '失联',
};

const ACTOR_TEXT: Record<MaintenanceActor, string> = {
  instinct: '本能反射',
  maintainer: '自维护会话',
  user: '人工批准',
};

const OUTCOME_TEXT: Record<MaintenanceOutcome, string> = {
  relieved: '已缓解',
  partial: '部分缓解',
  escalated: '转人工协助',
  info: '已记录',
  failed: '执行失败',
};

function formatNeedKeyLabel(key: string): string {
  return NEED_LABEL[key as NeedKey] ?? key;
}

function formatGainSummary(gain?: ActionMeasurement): string | undefined {
  if (!gain) return undefined;
  const parts: string[] = [];
  if (gain.freedBytes && gain.freedBytes > 0) parts.push(`释放 ${formatBytes(gain.freedBytes)}`);
  if (gain.stoppedJobs && gain.stoppedJobs > 0) parts.push(`结束 ${gain.stoppedJobs} 任务`);
  if (gain.tokensSaved && gain.tokensSaved > 0) parts.push(`节省 ${gain.tokensSaved} tokens`);
  if (gain.satisfactionDelta !== undefined && gain.satisfactionDelta !== 0) {
    const sign = gain.satisfactionDelta > 0 ? '+' : '';
    parts.push(`满足度 ${sign}${gain.satisfactionDelta}%`);
  }
  if (parts.length === 0) {
    return gain.effective ? '实测有效' : '实测零收益';
  }
  return parts.join(' · ');
}

function formatLedgerCumulativeGain(entry: ActionOutcomeLedgerEntry): string {
  const parts: string[] = [];
  if (entry.totalFreedBytes > 0) parts.push(`累计释放 ${formatBytes(entry.totalFreedBytes)}`);
  if (entry.totalStoppedJobs > 0) parts.push(`累计结束 ${entry.totalStoppedJobs} 任务`);
  if (entry.totalTokensSaved > 0) parts.push(`累计省 ${entry.totalTokensSaved} tokens`);
  if (entry.totalSatisfactionDelta > 0) parts.push(`累计提升 +${entry.totalSatisfactionDelta}%`);
  return parts.length > 0 ? parts.join(' · ') : '尚无净收益';
}

export function MaintenanceSection({
  now,
  paused,
  instinct,
  session,
  records,
  actionLedger,
  onOpenSession,
  onTriggerCheck,
}: {
  now: number;
  paused: boolean;
  instinct: InstinctState;
  session: MaintenanceSessionStatus;
  records: MaintenanceRecord[];
  actionLedger?: ActionOutcomeLedgerEntry[];
  onOpenSession: () => void | Promise<void>;
  onTriggerCheck: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const run = async (label: string, fn: () => void | Promise<void>) => {
    setBusy(true);
    setErrorMsg(null);
    try {
      await fn();
    } catch {
      setErrorMsg(`${label}失败，请稍后重试`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={css.maintBlock}>
      {errorMsg && (
        <div className={css.noticeAlert} role="alert">
          <span>{errorMsg}</span>
          <button type="button" aria-label="关闭操作提示" onClick={() => setErrorMsg(null)}>
            关闭
          </button>
        </div>
      )}

      <div className={css.maintRow}>
        <span className={css.maintLabel}>本能反射</span>
        <span className={css.maintVal}>
          {instinct.powerMode === 'eco'
            ? `节能降频中${instinct.powerReason ? `（${instinct.powerReason}）` : ''}`
            : '正常采样'}
          {' · '}
          模型网关：{CONNECTIVITY_TEXT[instinct.modelConnectivity]}
          {instinct.modelConnectivity !== 'online' && instinct.probeCount > 0
            ? `（已探活 ${instinct.probeCount} 次）`
            : ''}
        </span>
      </div>

      <div className={css.maintRow}>
        <span className={css.maintLabel}>后台自维护会话</span>
        <span className={css.maintVal}>
          {SESSION_STATUS_TEXT[session.status]}
          {` · 累计 ${session.turnCount} 轮`}
          {session.circuitBrokenNeeds && session.circuitBrokenNeeds.length > 0
            ? ` · 静默熔断省流中（${session.circuitBrokenNeeds.map(formatNeedKeyLabel).join('、')}）`
            : ''}
        </span>
      </div>

      <div className={css.maintActions}>
        <button
          type="button"
          disabled={busy || (paused && !session.sessionId)}
          onClick={() => void run('打开自维护会话', onOpenSession)}
        >
          查看自维护会话
        </button>
        <button
          type="button"
          disabled={busy || paused || session.status === 'running'}
          onClick={() => void run('立即自检', onTriggerCheck)}
        >
          立即自检
        </button>
      </div>

      {actionLedger && actionLedger.length > 0 && (
        <div className={css.ledgerBox} data-action-ledger>
          <div className={css.ledgerTitle}>动作收益账本（历史实测）</div>
          <ul className={css.ledgerList} aria-label="动作收益账本">
            {actionLedger.slice(0, 6).map((entry) => {
              const ratePct = Math.round(entry.successRate * 100);
              return (
                <li key={`${entry.need}:${entry.action}`} className={css.ledgerItem}>
                  <div className={css.recordTop}>
                    <span className={css.ledgerActionName}>
                      {formatNeedKeyLabel(entry.need)} · {entry.action}
                    </span>
                    <span className={css.ledgerRate} data-effective={entry.effectiveCount > 0 ? 'true' : 'false'}>
                      有效率 {formatPercentValue(ratePct)}（{entry.effectiveCount} 次有效 · 共 {entry.attempts} 次）
                    </span>
                  </div>
                  <div className={css.recordMeta}>{formatLedgerCumulativeGain(entry)}</div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {records.length === 0 ? (
        <div className={css.emptyText}>暂无自发维护记录</div>
      ) : (
        <ul className={css.recordList} aria-label="最近自维护记录">
          {records.slice(0, 10).map((rec) => {
            const age = formatAge(now, rec.at);
            const gainText = formatGainSummary(rec.gain);
            const targetLabel = rec.need ? NEED_LABEL[rec.need] : rec.driveKey;
            return (
              <li key={rec.id} className={css.recordItem} data-record={rec.id}>
                <div className={css.recordTop}>
                  <span>
                    <span className={css.recordActor}>{ACTOR_TEXT[rec.actor]}</span>
                    {targetLabel ? ` · ${targetLabel}` : ''}
                  </span>
                  <span className={css.recordOutcome} data-outcome={rec.outcome}>
                    {OUTCOME_TEXT[rec.outcome]}
                  </span>
                </div>
                <div>{rec.summary}</div>
                <div className={css.recordMeta}>
                  动作：{rec.action} · {formatClock(rec.at)}
                  {age === '刚刚' ? '' : `（${age}）`}
                  {gainText ? ` · ${gainText}` : ''}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
