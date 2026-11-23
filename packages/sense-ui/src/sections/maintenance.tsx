import { useState } from 'react';
import { formatAge, formatClock } from '../format';
import type {
  InstinctState,
  MaintenanceActor,
  MaintenanceOutcome,
  MaintenanceRecord,
  MaintenanceSessionStatus,
  ModelConnectivity,
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

export function MaintenanceSection({
  now,
  paused,
  instinct,
  session,
  records,
  onOpenSession,
  onTriggerCheck,
}: {
  now: number;
  paused: boolean;
  instinct: InstinctState;
  session: MaintenanceSessionStatus;
  records: MaintenanceRecord[];
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

      {records.length === 0 ? (
        <div className={css.emptyText}>暂无自发维护记录</div>
      ) : (
        <ul className={css.recordList} aria-label="最近自维护记录">
          {records.slice(0, 10).map((rec) => {
            const age = formatAge(now, rec.at);
            return (
              <li key={rec.id} className={css.recordItem} data-record={rec.id}>
                <div className={css.recordTop}>
                  <span>
                    <span className={css.recordActor}>{ACTOR_TEXT[rec.actor]}</span>
                    {rec.need ? ` · ${NEED_LABEL[rec.need]}` : ''}
                  </span>
                  <span className={css.recordOutcome} data-outcome={rec.outcome}>
                    {OUTCOME_TEXT[rec.outcome]}
                  </span>
                </div>
                <div>{rec.summary}</div>
                <div className={css.recordMeta}>
                  动作：{rec.action} · {formatClock(rec.at)}
                  {age === '刚刚' ? '' : `（${age}）`}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
