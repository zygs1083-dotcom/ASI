import { useEffect, useId, useRef, useState } from 'react';
import css from './session-target.module.css';
import type { SensePanelModel, SensePanelProps } from './view-model';

const zh: NonNullable<SensePanelProps['targetCopy']> = {
  label: '投递到',
  auto: '自动（最近活跃的对话）',
  search: '搜索对话',
  empty: '没有匹配的对话',
  untitled: '未命名对话',
  running: '运行中',
  unavailable: '对话列表暂不可用',
  reset: '指定的对话已关闭，已切回自动投递。',
  dismiss: '关闭提示',
  failed: '选择失败，请重试。',
  locale: 'zh-CN',
};

type Target = NonNullable<SensePanelModel['target']>;

function relativeTime(at: number, now: number, locale: string): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  const [value, unit] =
    seconds < 60
      ? ([seconds, 'second'] as const)
      : seconds < 3600
        ? ([Math.floor(seconds / 60), 'minute'] as const)
        : seconds < 86400
          ? ([Math.floor(seconds / 3600), 'hour'] as const)
          : ([Math.floor(seconds / 86400), 'day'] as const);
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-value, unit);
}

export function SessionTarget({
  target,
  now,
  onSelect,
  onDismiss,
  copy = zh,
}: {
  target: Target;
  now: number;
  onSelect: (id?: string) => Promise<void>;
  onDismiss?: () => Promise<void>;
  copy?: NonNullable<SensePanelProps['targetCopy']>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const root = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef(false);
  const listId = useId();
  const selected = target.sessions.find((item) => item.id === target.sessionId);
  const title = target.mode === 'pinned' ? selected?.title || copy.untitled : copy.auto;
  const normalized = query.trim().toLocaleLowerCase();
  const items = [
    ...(!normalized || copy.auto.toLocaleLowerCase().includes(normalized) ? [{ id: '', title: copy.auto }] : []),
    ...[...target.sessions]
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .filter((item) => (item.title || copy.untitled).toLocaleLowerCase().includes(normalized)),
  ];
  useEffect(() => {
    if (open) input.current?.focus();
    else if (!busy && restoreFocus.current) {
      restoreFocus.current = false;
      button.current?.focus();
    }
  }, [open, busy]);
  const close = () => {
    restoreFocus.current = true;
    setOpen(false);
    setQuery('');
    setActive(-1);
  };
  const select = async (id: string) => {
    setBusy(true);
    setFailed(false);
    try {
      await onSelect(id || undefined);
      close();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className={css.target}
      ref={root}
      aria-label={copy.label}
      onBlur={(event) => {
        if (event.relatedTarget && !root.current?.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <div className={css.row}>
        <span>{copy.label}</span>
        <button
          ref={button}
          className={css.trigger}
          type="button"
          aria-label={`${copy.label}: ${title}`}
          aria-expanded={open}
          aria-haspopup="listbox"
          disabled={busy}
          onClick={() => {
            setOpen(!open);
            setActive(-1);
          }}
        >
          {title}
          <span aria-hidden>⌄</span>
        </button>
      </div>
      {open && (
        <div className={css.popup}>
          <input
            ref={input}
            role="combobox"
            aria-label={copy.search}
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={active >= 0 && items[active] ? `${listId}-${active}` : undefined}
            autoComplete="off"
            value={query}
            placeholder={copy.search}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(-1);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                close();
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((index) => Math.min(index + 1, items.length - 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((index) => Math.max(index - 1, 0));
              } else if (event.key === 'Enter' && items[active] && !busy) {
                event.preventDefault();
                void select(items[active].id);
              }
            }}
          />
          <div role="listbox" id={listId} aria-label={copy.label} className={css.list}>
            {items.map((item, index) => (
              <div
                key={item.id}
                id={`${listId}-${index}`}
                role="option"
                tabIndex={-1}
                aria-selected={item.id === (target.sessionId ?? '')}
                className={index === active ? css.active : css.option}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActive(index)}
                onClick={() => {
                  if (!busy) void select(item.id);
                }}
                onKeyDown={(event) => {
                  if ((event.key === 'Enter' || event.key === ' ') && !busy) {
                    event.preventDefault();
                    void select(item.id);
                  }
                }}
              >
                <span className={css.optionTitle}>{item.title || copy.untitled}</span>
                {'updatedAt' in item && (
                  <span className={css.meta}>
                    {item.running ? `${copy.running} · ` : ''}
                    {relativeTime(item.updatedAt, now, copy.locale)}
                  </span>
                )}
              </div>
            ))}
          </div>
          {!items.length && <div className={css.message}>{copy.empty}</div>}
        </div>
      )}
      {target.unavailable && (
        <div role="status" className={css.message}>
          {copy.unavailable}
        </div>
      )}
      {target.notice && (
        <div role="status" className={css.message}>
          {copy.reset}{' '}
          <button type="button" onClick={() => void onDismiss?.()}>
            {copy.dismiss}
          </button>
        </div>
      )}
      {failed && (
        <div role="alert" className={css.message}>
          {copy.failed}
        </div>
      )}
    </section>
  );
}
