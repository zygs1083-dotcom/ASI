import { type FormEvent, useEffect, useState } from 'react';
import { useClock } from '../clock';
import { formatDuration } from '../format';
import type { Fact, GlobalFileWatchStatus, GlobalFileWatchValue } from '../view-model';
import css from './now.module.css';

interface GlobalWatchProps {
  fact: Fact<GlobalFileWatchValue>;
  now?: number;
  onOpenPermissionSettings: () => void;
  onToggleGlobalFileWatch?: (enabled: boolean) => void;
  onRetryGlobalFileWatch?: () => void | Promise<void>;
  onAddFileExclusion?: (pattern: string) => Promise<void>;
  onRemoveFileExclusion?: (pattern: string) => Promise<void>;
}

const WATCH_STATUS_TEXT: Record<GlobalFileWatchStatus, string> = {
  running: '运行中',
  degraded: '已降级',
  'partial-denied': '部分无权限',
  denied: '无权限',
  disabled: '已关闭',
  unavailable: '不可用',
  unsupported: '不支持',
};

function describeWatch(fact: Fact<GlobalFileWatchValue>, now: number): string {
  const value = fact.value;
  if (fact.status === 'unsupported' || value?.status === 'unsupported') {
    const reason = value?.reason ?? fact.reason;
    return reason ? `不支持（${reason}）` : '不支持';
  }
  if (fact.status === 'unavailable' || value?.status === 'unavailable') {
    const reason = value?.reason ?? fact.reason;
    const base = reason ? `不可用（${reason}）` : '不可用';
    if (typeof value?.retryAt === 'number' && Number.isFinite(value.retryAt)) {
      const waitSec = Math.ceil((value.retryAt - now) / 1000);
      return waitSec > 0 ? `${base} · ${formatDuration(waitSec)}后自动重试` : `${base} · 即将自动重试`;
    }
    return base;
  }
  if (!value) {
    return fact.status === 'denied' ? (fact.reason ? `无权限（${fact.reason}）` : '无权限') : '已关闭';
  }
  if (value.status === 'degraded') {
    const windowSec = Math.max(1, Math.round(value.windowMs / 1000));
    return `${WATCH_STATUS_TEXT.degraded}（${value.eventsPerSec}/s · ${windowSec} 秒窗仅计数）`;
  }
  if (value.status === 'partial-denied') {
    return `${WATCH_STATUS_TEXT['partial-denied']}（${value.deniedPaths.length} 处）`;
  }
  if (value.status === 'denied') {
    return fact.reason ? `${WATCH_STATUS_TEXT.denied}（${fact.reason}）` : WATCH_STATUS_TEXT.denied;
  }
  return WATCH_STATUS_TEXT[value.status];
}

export function GlobalWatchBlock({
  fact,
  now,
  onOpenPermissionSettings,
  onToggleGlobalFileWatch,
  onRetryGlobalFileWatch,
  onAddFileExclusion,
  onRemoveFileExclusion,
}: GlobalWatchProps) {
  const effNow = useClock(now ?? fact.observedAt);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const value = fact.value;
  const unsupported = fact.status === 'unsupported' || value?.status === 'unsupported';
  const unavailable = !unsupported && (fact.status === 'unavailable' || value?.status === 'unavailable');
  const enabled = !unsupported && (value?.enabled ?? false);
  const exclusions = value?.exclusions ?? [];
  const deniedPaths = value?.deniedPaths ?? [];
  const needsPerm = fact.status === 'denied' || value?.status === 'denied' || value?.status === 'partial-denied';

  useEffect(() => {
    if (!unavailable) setRetryError(null);
  }, [unavailable]);

  async function handleRetry() {
    if (retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      await onRetryGlobalFileWatch?.();
    } catch (err) {
      setRetryError(err instanceof Error && err.message.trim() ? err.message : '重试全盘文件监视失败');
    } finally {
      setRetrying(false);
    }
  }

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) {
      setError('请输入要排除的路径或模式');
      return;
    }
    if (!onAddFileExclusion || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAddFileExclusion(trimmed);
      setDraft('');
    } catch (err) {
      setError(err instanceof Error && err.message.trim() ? err.message : '添加排除项失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(pattern: string) {
    if (!onRemoveFileExclusion || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRemoveFileExclusion(pattern);
    } catch (err) {
      setError(err instanceof Error && err.message.trim() ? err.message : '移除排除项失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={css.item}>
        <span className={css.itemLabel}>全盘文件监视</span>
        <span className={css.itemValue}>
          <span className={css.globalRow}>
            <span>{describeWatch(fact, effNow)}</span>
            {needsPerm && (
              <button type="button" className={css.linkButton} onClick={onOpenPermissionSettings}>
                授权
              </button>
            )}
            {unavailable && (
              <button type="button" className={css.linkButton} disabled={retrying} onClick={() => void handleRetry()}>
                {retrying ? '重试中' : '重试'}
              </button>
            )}
          </span>
        </span>
        <label className={css.globalToggle}>
          <input
            type="checkbox"
            aria-label="全盘文件监视"
            checked={enabled}
            disabled={unsupported}
            onChange={(e) => onToggleGlobalFileWatch?.(e.target.checked)}
          />
          <span>{unsupported ? '不支持' : enabled ? '开启' : '关闭'}</span>
        </label>
      </div>
      {retryError && (
        <p className={css.exclusionError} role="alert">
          {retryError}
        </p>
      )}

      <details className={css.srcDetails}>
        <summary>排除项 {exclusions.length} 条</summary>
        {deniedPaths.length > 0 && <div className={css.exclusionError}>无权限目录：{deniedPaths.join('、')}</div>}
        <form className={css.exclusionForm} onSubmit={(e) => void handleAdd(e)}>
          <input
            type="text"
            className={css.exclusionInput}
            aria-label="新增排除路径或模式"
            placeholder="路径、~/目录 或 目录名"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className={css.exclusionBtn} disabled={busy}>
            添加
          </button>
        </form>
        {error && (
          <p className={css.exclusionError} role="alert">
            {error}
          </p>
        )}
        <ul className={css.exclusionList}>
          {exclusions.map((pattern) => (
            <li key={pattern} className={css.exclusionItem}>
              <code className={css.exclusionPattern}>{pattern}</code>
              <button
                type="button"
                className={css.exclusionBtn}
                disabled={busy}
                aria-label={`移除排除项 ${pattern}`}
                onClick={() => void handleRemove(pattern)}
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}
