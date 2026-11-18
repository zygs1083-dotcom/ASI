import { type FormEvent, useState } from 'react';
import type { Fact, GlobalFileWatchStatus, GlobalFileWatchValue } from '../view-model';
import css from './now.module.css';

interface GlobalWatchProps {
  fact: Fact<GlobalFileWatchValue>;
  onOpenPermissionSettings: () => void;
  onToggleGlobalFileWatch?: (enabled: boolean) => void;
  onAddFileExclusion?: (pattern: string) => Promise<void>;
  onRemoveFileExclusion?: (pattern: string) => Promise<void>;
}

const WATCH_STATUS_TEXT: Record<GlobalFileWatchStatus, string> = {
  running: '运行中',
  degraded: '已降级',
  'partial-denied': '部分无权限',
  denied: '无权限',
  disabled: '已关闭',
};

function describeWatch(fact: Fact<GlobalFileWatchValue>): string {
  if (fact.status === 'unavailable') {
    return fact.reason ? `不可用（${fact.reason}）` : '不可用';
  }
  const value = fact.value;
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
  onOpenPermissionSettings,
  onToggleGlobalFileWatch,
  onAddFileExclusion,
  onRemoveFileExclusion,
}: GlobalWatchProps) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = fact.value;
  const unavailable = fact.status === 'unavailable';
  const enabled = !unavailable && (value?.enabled ?? false);
  const exclusions = value?.exclusions ?? [];
  const deniedPaths = value?.deniedPaths ?? [];
  const needsPerm = fact.status === 'denied' || value?.status === 'denied' || value?.status === 'partial-denied';

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
            <span>{describeWatch(fact)}</span>
            {needsPerm && (
              <button type="button" className={css.linkButton} onClick={onOpenPermissionSettings}>
                授权
              </button>
            )}
          </span>
        </span>
        <label className={css.globalToggle}>
          <input
            type="checkbox"
            aria-label="全盘文件监视"
            checked={enabled}
            disabled={unavailable}
            onChange={(e) => onToggleGlobalFileWatch?.(e.target.checked)}
          />
          <span>{unavailable ? '不可用' : enabled ? '开启' : '关闭'}</span>
        </label>
      </div>

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
