import { MessageSquare, Plus, Settings, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { actions, resolveModel, useAppState } from '../store';

function RenameInput({ initial, onDone }: { initial: string; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      className="conv-rename"
      aria-label="重命名会话"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(value)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          onDone(value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onDone(null);
        }
      }}
    />
  );
}

export function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const s = useAppState();
  const [renaming, setRenaming] = useState<string | null>(null);

  const def = resolveModel(s, s.settings?.defaultModel ?? null);
  const statusText = s.settings?.defaultModel
    ? def.available
      ? def.label
      : `${def.label}（不可用）`
    : '未配置模型';
  const statusClass = !s.settings?.defaultModel ? 'off' : def.available ? 'on' : 'err';

  const finishRename = (id: string) => (title: string | null) => {
    setRenaming(null);
    if (title?.trim()) void actions.renameConversation(id, title);
  };

  return (
    <aside className={`sidebar${open ? ' open' : ''}`}>
      <div className="sidebar-drag" />
      <div className="sidebar-logo">ASI</div>
      <div className="sidebar-body">
        <div className="side-group-label">对话</div>
        <button
          type="button"
          className="side-item"
          data-testid="nav-new-chat"
          aria-label="新对话"
          onClick={() => {
            void actions.newConversation();
            onNavigate();
          }}
        >
          <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
          <span>新对话</span>
        </button>
        <div className="conv-list">
          {s.summaries.map((c) => {
            const current = c.id === s.currentId && s.view === 'chat';
            return (
              <div
                key={c.id}
                className={`conv-item${current ? ' active' : ''}`}
                data-testid="conv-item"
                data-id={c.id}
                aria-current={current ? 'page' : undefined}
              >
                {renaming === c.id ? (
                  <RenameInput initial={c.title} onDone={finishRename(c.id)} />
                ) : (
                  <>
                    <button
                      type="button"
                      className="conv-main"
                      aria-label={`打开会话 ${c.title}`}
                      onClick={() => {
                        if (c.id !== s.currentId || s.view !== 'chat') {
                          void actions.selectConversation(c.id);
                        }
                        onNavigate();
                      }}
                      onDoubleClick={() => setRenaming(c.id)}
                    >
                      <MessageSquare size={16} strokeWidth={1.5} aria-hidden="true" />
                      <span className="conv-title">{c.title}</span>
                    </button>
                    <button
                      type="button"
                      className="conv-delete"
                      data-testid="conv-delete"
                      aria-label={`删除会话 ${c.title}`}
                      onClick={() => void actions.deleteConversation(c.id)}
                    >
                      <X size={14} strokeWidth={1.5} aria-hidden="true" />
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="sidebar-foot">
        <button
          type="button"
          className={`side-item${s.view === 'settings' ? ' active' : ''}`}
          data-testid="nav-settings"
          aria-label="设置"
          onClick={() => {
            actions.openSettings();
            onNavigate();
          }}
        >
          <Settings size={16} strokeWidth={1.5} aria-hidden="true" />
          <span>设置</span>
        </button>
        <div className="side-status">
          <span className={`dot ${statusClass}`} aria-hidden="true" />
          <span className="side-status-text" data-testid="sidebar-default-model">
            {statusText}
          </span>
        </div>
      </div>
    </aside>
  );
}
