import { ChevronRight, Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ProviderConfig } from '../../shared/types';
import { Segmented, Switch } from '../components/controls';
import { ModelPicker } from '../components/ModelPicker';
import { actions, useAppState } from '../store';
import { ProviderEditor } from './ProviderEditor';

function builtinLabel(p: ProviderConfig, catalog: { id: string; name: string }[]): string {
  if (p.kind === 'builtin') {
    return catalog.find((c) => c.id === p.builtinProvider)?.name ?? (p.builtinProvider || '内置厂商');
  }
  return p.baseUrl || 'OpenAI 兼容';
}

function ProviderRow({ p }: { p: ProviderConfig }) {
  const s = useAppState();
  const count = s.modelsByProvider[p.id]?.length;
  const open = () => actions.openEditor(p.id);
  return (
    <div className="provider-row" data-testid="provider-row" data-id={p.id}>
      <button type="button" className="prov-open" onClick={open} aria-label={`编辑厂商 ${p.name}`}>
        <span className="prov-icon" aria-hidden="true">
          {(p.name || '?').slice(0, 1).toUpperCase()}
        </span>
        <span className="prov-txt">
          <span className="prov-title">{p.name}</span>
          <span className="prov-sub">
            {builtinLabel(p, s.catalog)} · {count == null ? '…' : `${count} 个模型`}
          </span>
        </span>
      </button>
      <span className="provider-key-status" data-testid="provider-key-status">
        <span className={`dot ${p.hasApiKey ? 'on' : 'off'}`} aria-hidden="true" />
        {p.hasApiKey ? '已设置 Key' : '未设置 Key'}
      </span>
      <Switch
        testId="provider-toggle"
        checked={p.enabled}
        ariaLabel={`启用 ${p.name}`}
        onChange={() => void actions.toggleProvider(p)}
      />
      <button type="button" className="prov-chev" onClick={open} aria-label={`编辑厂商 ${p.name}`}>
        <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>
  );
}

export function ProvidersView() {
  const s = useAppState();
  const [query, setQuery] = useState('');

  useEffect(() => {
    for (const p of s.providers) void actions.ensureProviderModels(p.id);
  }, [s.providers]);

  if (s.editor) return <ProviderEditor target={s.editor} />;

  const q = query.trim().toLowerCase();
  const filtered = s.providers.filter(
    (p) =>
      !q ||
      p.name.toLowerCase().includes(q) ||
      (p.baseUrl ?? '').toLowerCase().includes(q) ||
      (p.builtinProvider ?? '').toLowerCase().includes(q),
  );

  return (
    <div className="settings-scroll">
      <div className="settings-col">
        <div className="settings-head">
          <div className="search-box">
            <Search size={14} strokeWidth={1.5} aria-hidden="true" />
            <input
              type="text"
              data-testid="provider-search"
              aria-label="查找厂商"
              placeholder="查找厂商"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="pill-btn"
            data-testid="provider-add"
            aria-label="添加厂商"
            onClick={() => actions.openEditor(null)}
          >
            <Plus size={14} strokeWidth={1.5} aria-hidden="true" />
            添加厂商
          </button>
        </div>
        <div className="card">
          {filtered.length === 0 && <div className="card-empty">没有匹配的厂商</div>}
          {filtered.map((p) => (
            <ProviderRow key={p.id} p={p} />
          ))}
        </div>
        <div className="sect-label">通用</div>
        <div className="card">
          <div className="gen-row">
            <span className="gen-label">默认模型</span>
            <ModelPicker
              testId="settings-default-model"
              value={s.settings?.defaultModel ?? null}
              models={s.allModels}
              providers={s.providers}
              onChange={(ref) => void actions.setDefaultModel(ref)}
            />
          </div>
          <div className="gen-row">
            <span className="gen-label">外观</span>
            <Segmented
              ariaLabel="外观"
              value={s.settings?.theme ?? 'system'}
              onChange={(t) => void actions.setTheme(t)}
              options={[
                { value: 'system', label: '跟随系统', testId: 'theme-system' },
                { value: 'light', label: '浅色', testId: 'theme-light' },
                { value: 'dark', label: '深色', testId: 'theme-dark' },
              ]}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
