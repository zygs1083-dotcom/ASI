import { Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { actions, applyTheme, currentConv, useAppState } from './store';
import { ChatView } from './views/ChatView';
import { ProvidersView } from './views/ProvidersView';

export default function App() {
  const s = useAppState();
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    void actions.init();
    return () => actions.dispose();
  }, []);

  useEffect(() => {
    if (s.settings) applyTheme(s.settings.theme);
  }, [s.settings]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.isComposing) return;
      if (!e.metaKey && !e.ctrlKey) return;
      if (e.key === 'n') {
        e.preventDefault();
        void actions.newConversation();
      } else if (e.key === ',') {
        e.preventDefault();
        actions.openSettings();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!s.ready) {
    return (
      <div className="app" data-testid="app-root">
        <div className="boot">加载中…</div>
      </div>
    );
  }

  if (s.fatal) {
    return (
      <div className="app" data-testid="app-root">
        <div className="boot">
          <div>{s.fatal}</div>
          <button type="button" className="pill-btn" aria-label="重试" onClick={() => actions.retryInit()}>
            重试
          </button>
        </div>
      </div>
    );
  }

  const conv = currentConv(s);
  const editing = s.view === 'settings' ? s.editor : null;
  const editingProvider = editing?.id ? s.providers.find((p) => p.id === editing.id) : null;
  const crumbs: [string, string] =
    s.view === 'chat'
      ? ['对话', conv?.title ?? '']
      : editing
        ? ['设置', editing.id === null ? '添加厂商' : (editingProvider?.name ?? '编辑厂商')]
        : ['设置', '模型厂商'];

  return (
    <div className="app" data-testid="app-root">
      <button
        type="button"
        className={`nav-scrim${navOpen ? ' show' : ''}`}
        aria-label="关闭导航"
        onClick={() => setNavOpen(false)}
      />
      <Sidebar open={navOpen} onNavigate={() => setNavOpen(false)} />
      <div className="main">
        <header className="toolbar">
          <button
            type="button"
            className="menu-btn"
            aria-label="打开导航"
            onClick={() => setNavOpen((v) => !v)}
          >
            <Menu size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <nav className="crumbs" aria-label="面包屑">
            <span className="crumb-parent">{crumbs[0]}</span>
            <span className="crumb-sep"> / </span>
            <span className="crumb-cur">{crumbs[1]}</span>
          </nav>
        </header>
        {s.notice && (
          <div className="notice-bar" role="status">
            <span className="notice-text">{s.notice}</span>
            <button
              type="button"
              className="notice-close"
              aria-label="关闭提示"
              onClick={() => actions.dismissNotice()}
            >
              <X size={13} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </div>
        )}
        {s.view === 'chat' ? <ChatView /> : <ProvidersView />}
      </div>
    </div>
  );
}
