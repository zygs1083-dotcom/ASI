import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderInput, ProviderKind, TestResult } from '../../shared/types';
import { Segmented, Switch } from '../components/controls';
import { actions, useAppState } from '../store';

function validHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.length > 0;
  } catch {
    return false;
  }
}

type Row = { modelId: string; name: string };
type TestState = Record<string, TestResult | 'loading'>;

export function ProviderEditor({ target }: { target: { id: string | null } }) {
  const s = useAppState();
  const existing = target.id ? s.providers.find((p) => p.id === target.id) : undefined;

  const [kind, setKind] = useState<ProviderKind>(existing?.kind ?? 'builtin');
  const [builtinProvider, setBuiltinProvider] = useState(existing?.builtinProvider ?? s.catalog[0]?.id ?? '');
  const [name, setName] = useState(existing?.name ?? s.catalog[0]?.name ?? '');
  const [nameTouched, setNameTouched] = useState(!!existing);
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '');
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [keyCleared, setKeyCleared] = useState(false);
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [customModels, setCustomModels] = useState<string[]>(existing?.customModels ?? []);
  const [modelInput, setModelInput] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tests, setTests] = useState<TestState>({});
  const deleteRef = useRef<HTMLButtonElement>(null);
  const keyInputRef = useRef<HTMLInputElement | null>(null);

  // 回调 ref：React detach（传 null）或换节点时同步清掉旧 DOM 上的明文——
  // 卸载 effect 看到 ref 已是 null，清不到脱离文档的旧节点，所以必须在 ref 层清
  const keyInputCb = useCallback((node: HTMLInputElement | null) => {
    const prev = keyInputRef.current;
    if (prev && prev !== node) prev.value = '';
    keyInputRef.current = node;
  }, []);

  // 唯一的 Key 草稿清理入口：React state 与当前 DOM 值一起清
  const clearKeyDraft = useCallback(() => {
    setApiKeyDraft('');
    if (keyInputRef.current) keyInputRef.current.value = '';
  }, []);

  // 卸载兜底再清一次（此时 DOM 值已由回调 ref 清掉，这里只保证 state 不残留）
  useEffect(() => () => clearKeyDraft(), [clearKeyDraft]);

  useEffect(() => {
    if (existing) void actions.ensureProviderModels(existing.id);
  }, [existing]);

  // Escape 取消删除确认并把焦点还给删除按钮（IME 组合中的 Escape 不误触发）
  useEffect(() => {
    if (!confirmDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        setConfirmDelete(false);
        deleteRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [confirmDelete]);

  // 传输 / 凭据 / 模型相关的改动都会使已有测试结果失效，必须先保存再测；
  // builtinProvider 仅在内置类型下参与比较
  const transportDirty =
    !!existing &&
    (kind !== existing.kind ||
      baseUrl !== (existing.baseUrl ?? '') ||
      apiKeyDraft !== '' ||
      keyCleared ||
      (kind === 'builtin' && builtinProvider !== (existing.builtinProvider ?? '')) ||
      (kind === 'openai-compatible' &&
        JSON.stringify(customModels) !== JSON.stringify(existing.customModels)));
  const canTest = !!existing && !transportDirty;

  // 配置一变脏，清掉之前展示的测试结果，避免陈旧成功信息留在改过的配置上
  useEffect(() => {
    if (transportDirty) setTests((t) => (Object.keys(t).length ? {} : t));
  }, [transportDirty]);

  if (target.id && !existing) {
    return (
      <div className="settings-scroll">
        <div className="settings-col">
          <div className="pe-head">
            <button
              type="button"
              className="pill-btn"
              aria-label="返回厂商列表"
              onClick={() => {
                clearKeyDraft();
                actions.closeEditor();
              }}
            >
              ‹ 返回
            </button>
          </div>
          <div className="pe-note">厂商不存在或已被删除。</div>
        </div>
      </div>
    );
  }

  const catalogEntry = s.catalog.find((c) => c.id === builtinProvider);
  const savedModels = existing ? s.modelsByProvider[existing.id] : undefined;
  const modelLoadError = existing ? s.modelLoadErrors[existing.id] : undefined;

  let previewRows: Row[] = [];
  let previewNote: string | null = null;
  if (kind === 'builtin') {
    const builtinChanged = existing?.kind !== 'builtin' || builtinProvider !== existing.builtinProvider;
    if (builtinChanged) {
      const count = catalogEntry?.modelCount ?? 0;
      previewNote = `该厂商包含 ${count} 个模型，保存后可预览并测试模型`;
    } else if (modelLoadError && !savedModels) {
      previewNote = `模型加载失败：${modelLoadError}`;
    } else {
      previewRows = (savedModels ?? []).map((m) => ({ modelId: m.modelId, name: m.name }));
      if (transportDirty) previewNote = '已修改配置，保存后可测试';
    }
  } else {
    previewRows = customModels.map((id) => ({ modelId: id, name: id }));
    if (!existing) previewNote = previewRows.length ? '保存后可测试模型连通性' : null;
    else if (transportDirty) previewNote = '已修改配置，保存后可测试';
  }

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = '请输入厂商名称';
    if (kind === 'builtin' && !builtinProvider) errs.builtin = '请选择内置厂商';
    const url = baseUrl.trim();
    if (kind === 'openai-compatible' && !url) errs.baseUrl = '请输入 Base URL';
    else if (url && !validHttpUrl(url)) errs.baseUrl = 'Base URL 需为合法的 http:// 或 https:// 地址';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const addModel = () => {
    const v = modelInput.trim();
    if (!v) return;
    if (!customModels.includes(v)) setCustomModels([...customModels, v]);
    setModelInput('');
  };

  const save = async () => {
    if (!validate() || saving) return;
    setSaving(true);
    const input: ProviderInput = {
      id: existing?.id,
      name: name.trim(),
      kind,
      builtinProvider: kind === 'builtin' ? builtinProvider : undefined,
      baseUrl: baseUrl.trim() || undefined,
      apiKey: keyCleared ? apiKeyDraft || null : apiKeyDraft || undefined,
      enabled,
      customModels: kind === 'openai-compatible' ? customModels : [],
    };
    // 明文 key 一旦进了 payload 立刻清掉草稿，不等保存结果
    clearKeyDraft();
    try {
      await actions.saveProvider(input);
      actions.closeEditor();
    } catch (e) {
      setErrors({ form: e instanceof Error && e.message ? e.message : '保存失败，请重试' });
    } finally {
      // 后端已消费 payload，删掉本地持有的明文引用
      delete input.apiKey;
      setSaving(false);
    }
  };

  const runTest = async (modelId: string) => {
    if (!existing || !canTest) return;
    setTests((t) => ({ ...t, [modelId]: 'loading' }));
    const r = await actions.testProviderModel(existing.id, modelId);
    setTests((t) => ({ ...t, [modelId]: r }));
  };

  const pickBuiltin = (id: string) => {
    setBuiltinProvider(id);
    clearKeyDraft();
    if (!nameTouched) setName(s.catalog.find((c) => c.id === id)?.name ?? '');
  };

  const keyPlaceholder =
    existing?.hasApiKey && !keyCleared
      ? '••••••••（已保存）'
      : keyCleared
        ? '已清除，可输入新 Key'
        : '未设置';

  return (
    <div className="settings-scroll">
      <div className="settings-col">
        <div className="pe-head">
          <button
            type="button"
            className="pill-btn"
            aria-label="返回厂商列表"
            onClick={() => {
              clearKeyDraft();
              actions.closeEditor();
            }}
          >
            ‹ 返回
          </button>
          <h2 className="pe-title">{existing ? '编辑厂商' : '添加厂商'}</h2>
        </div>
        <div className="card pe-card">
          <div className="pe-field">
            <span className="pe-label">类型</span>
            <Segmented
              ariaLabel="厂商类型"
              value={kind}
              onChange={(k) => {
                setKind(k);
                clearKeyDraft();
                if (!nameTouched && k === 'builtin' && catalogEntry) setName(catalogEntry.name);
              }}
              options={[
                { value: 'builtin', label: '内置厂商', testId: 'pe-kind-builtin' },
                { value: 'openai-compatible', label: 'OpenAI 兼容', testId: 'pe-kind-compatible' },
              ]}
            />
            {errors.builtin && <div className="pe-err">{errors.builtin}</div>}
          </div>

          {kind === 'builtin' && (
            <div className="pe-field">
              <label className="pe-label" htmlFor="pe-builtin">
                厂商
              </label>
              <select
                id="pe-builtin"
                className="pe-input"
                data-testid="pe-builtin-select"
                value={builtinProvider}
                onChange={(e) => pickBuiltin(e.target.value)}
              >
                {s.catalog.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}（{c.modelCount} 个模型）
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="pe-field">
            <label className="pe-label" htmlFor="pe-name">
              名称
            </label>
            <input
              id="pe-name"
              className="pe-input"
              data-testid="pe-name"
              type="text"
              value={name}
              placeholder={kind === 'builtin' ? '显示名称' : '例如：本地 Ollama'}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
            />
            {errors.name && <div className="pe-err">{errors.name}</div>}
          </div>

          <div className="pe-field">
            <label className="pe-label" htmlFor="pe-baseurl">
              Base URL{kind === 'builtin' ? '（可选）' : ''}
            </label>
            <input
              id="pe-baseurl"
              className="pe-input"
              data-testid="pe-baseurl"
              type="text"
              value={baseUrl}
              placeholder={kind === 'builtin' ? '使用厂商默认地址' : 'http://localhost:11434/v1'}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            {errors.baseUrl && <div className="pe-err">{errors.baseUrl}</div>}
          </div>

          <div className="pe-field">
            <label className="pe-label" htmlFor="pe-apikey">
              API Key
            </label>
            <div className="pe-key-row">
              <input
                ref={keyInputCb}
                id="pe-apikey"
                className="pe-input"
                data-testid="pe-apikey"
                type="password"
                autoComplete="new-password"
                disabled={saving}
                value={apiKeyDraft}
                placeholder={keyPlaceholder}
                onChange={(e) => setApiKeyDraft(e.target.value)}
              />
              {existing?.hasApiKey && !keyCleared && (
                <button
                  type="button"
                  className="pill-btn"
                  data-testid="pe-apikey-clear"
                  aria-label="清除已保存的 API Key"
                  onClick={() => {
                    setKeyCleared(true);
                    clearKeyDraft();
                  }}
                >
                  清除
                </button>
              )}
            </div>
            {keyCleared && (
              <div className="pe-hint">保存后将清除已保存的 Key{apiKeyDraft ? '，并写入新 Key' : ''}</div>
            )}
          </div>

          <div className="pe-field pe-field-row">
            <span className="pe-label">启用</span>
            <Switch checked={enabled} onChange={setEnabled} ariaLabel="启用厂商" />
          </div>

          {kind === 'openai-compatible' && (
            <div className="pe-field">
              <label className="pe-label" htmlFor="pe-models">
                模型 id
              </label>
              <input
                id="pe-models"
                className="pe-input"
                data-testid="pe-model-input"
                type="text"
                value={modelInput}
                placeholder="输入模型 id，回车添加"
                onChange={(e) => setModelInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    addModel();
                  }
                }}
              />
              {customModels.length > 0 && (
                <div className="pe-tags">
                  {customModels.map((m) => (
                    <span key={m} className="pe-model-tag" data-testid="pe-model-tag">
                      {m}
                      <button
                        type="button"
                        aria-label={`删除模型 ${m}`}
                        onClick={() => setCustomModels(customModels.filter((x) => x !== m))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="pe-field">
            <span className="pe-label">模型预览</span>
            {previewRows.map((r) => {
              const t = tests[r.modelId];
              return (
                <div
                  key={r.modelId}
                  className="pe-model-row"
                  data-testid="pe-model-row"
                  data-model-id={r.modelId}
                >
                  <span className="pe-model-name">{r.name}</span>
                  <button
                    type="button"
                    className="pill-btn"
                    data-testid="pe-model-test"
                    aria-label={`测试 ${r.name}`}
                    disabled={!canTest || t === 'loading'}
                    onClick={() => void runTest(r.modelId)}
                  >
                    测试
                  </button>
                  <span className="pe-model-test-result" data-testid="pe-model-test-result">
                    {t === 'loading'
                      ? '测试中…'
                      : t
                        ? t.ok
                          ? `✓ ${t.latencyMs ?? 0}ms`
                          : `✗ ${t.error ?? '失败'}`
                        : ''}
                  </span>
                </div>
              );
            })}
            {modelLoadError && !savedModels && existing && (
              <button
                type="button"
                className="pill-btn"
                aria-label="重试加载模型"
                onClick={() => void actions.reloadProviderModels(existing.id)}
              >
                重试加载
              </button>
            )}
            {previewNote && <div className="pe-note">{previewNote}</div>}
          </div>

          {errors.form && <div className="pe-err">{errors.form}</div>}

          {confirmDelete ? (
            <div className="pe-confirm">
              <span className="pe-confirm-text">删除后仅移除该厂商配置，不会删除已有会话。</span>
              <button
                type="button"
                className="btn-danger-solid"
                data-testid="pe-delete-confirm"
                aria-label="确认删除厂商"
                onClick={() => existing && void actions.removeProvider(existing.id)}
              >
                确认删除
              </button>
              <button
                type="button"
                className="pill-btn"
                aria-label="取消删除"
                onClick={() => setConfirmDelete(false)}
              >
                取消
              </button>
            </div>
          ) : (
            <div className="pe-actions">
              {existing && (
                <button
                  ref={deleteRef}
                  type="button"
                  className="btn-danger"
                  data-testid="pe-delete"
                  aria-label="删除厂商"
                  onClick={() => setConfirmDelete(true)}
                >
                  删除厂商
                </button>
              )}
              <span className="pe-spacer" />
              <button
                type="button"
                className="pill-btn"
                data-testid="pe-cancel"
                aria-label="取消编辑"
                onClick={() => {
                  clearKeyDraft();
                  actions.closeEditor();
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-primary"
                data-testid="pe-save"
                aria-label="保存厂商"
                disabled={saving}
                onClick={() => void save()}
              >
                保存
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
