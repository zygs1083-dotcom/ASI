import type { MaskedSecretsSummary, ModelCatalogEntry, PresenceConfig } from '@asi/omni-router';
import { VISUAL_THEMES, type VisualTheme } from '@asi/presence-protocol';
import { useState } from 'react';
import type { AsiPresenceBridgeApi } from '../../shared/ipc-api.ts';
import { THEME_PALETTES } from '../stage/themes.ts';

interface SettingsModalProps {
  api: AsiPresenceBridgeApi;
  config: PresenceConfig;
  secrets: MaskedSecretsSummary;
  onConfigSaved: (next: PresenceConfig) => void;
  onSecretsSaved: (next: MaskedSecretsSummary) => void;
  onClose: () => void;
}

const EDGE_VOICE_PRESETS = [
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 温暖清甜（雪儿推荐）' },
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 自然温柔' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 清朗陪伴' },
  { id: 'en-US-JennyNeural', label: 'Jenny · English Neural' },
];

export function SettingsModal({ api, config, secrets, onConfigSaved, onSecretsSaved, onClose }: SettingsModalProps) {
  const [draft, setDraft] = useState<PresenceConfig>(config);
  const [typesafeKeyInput, setTypesafeKeyInput] = useState('');
  const [fastKeyInput, setFastKeyInput] = useState('');
  const [customTtsKeyInput, setCustomTtsKeyInput] = useState('');
  const [whisperKeyInput, setWhisperKeyInput] = useState('');
  const [models, setModels] = useState<ModelCatalogEntry[]>([]);
  const [modelsStatus, setModelsStatus] = useState<string>('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleFetchModels = async () => {
    setModelsStatus('正在查询模型列表...');
    try {
      const list = await api.listModels(draft.fastBrain.baseUrl);
      setModels(list);
      setModelsStatus(`已拉取 ${list.length} 个可用模型`);
    } catch (err) {
      setModelsStatus(`拉取失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const savedCfg = await api.saveConfig(draft);
      onConfigSaved(savedCfg);
      if (typesafeKeyInput.trim() || fastKeyInput.trim() || customTtsKeyInput.trim() || whisperKeyInput.trim()) {
        const nextSecrets = await api.saveSecrets({
          ...(typesafeKeyInput.trim() ? { typesafeApiKey: typesafeKeyInput.trim() } : {}),
          ...(fastKeyInput.trim() ? { fastBrainApiKey: fastKeyInput.trim() } : {}),
          ...(customTtsKeyInput.trim() ? { customTtsApiKey: customTtsKeyInput.trim() } : {}),
          ...(whisperKeyInput.trim() ? { whisperApiKey: whisperKeyInput.trim() } : {}),
        });
        onSecretsSaved(nextSecrets);
      }
      onClose();
    } catch (err) {
      setSaveError(
        `保存失败：${err instanceof Error ? err.message : String(err)}（请检查端点 URL 是否包含 http:// 或 https://）`,
      );
    } finally {
      setSaving(false);
    }
  };

  const handleClearTypesafeKey = async () => {
    const next = await api.saveSecrets({ typesafeApiKey: null });
    onSecretsSaved(next);
    setTypesafeKeyInput('');
  };

  const handleClearFastKey = async () => {
    const next = await api.saveSecrets({ fastBrainApiKey: null });
    onSecretsSaved(next);
    setFastKeyInput('');
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="雪儿多脑区与外观设置">
      <div className="modal-panel">
        <div className="modal-header">
          <div>
            <strong>雪儿 · 多脑区与全息工坊设置</strong>
            <div className="brand-sub">
              所有 API Key 仅保存于 ~/.asi-presence/secrets.json（0600 权限，前端永不回显明文）
            </div>
          </div>
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="modal-body">
          {/* 1. System One (TypeSafe AI Jev + magpie fallback) */}
          <div className="form-section">
            <h4>System One 快直觉门控（原生 TypeSafe AI Jev / magpie 降级）</h4>
            <div className="toggle-row">
              <span>优先调用原生 TypeSafe AI Jev（POST /v1/systemone）</span>
              <input
                type="checkbox"
                checked={draft.systemOne.preferTypesafeJev}
                onChange={(e) =>
                  setDraft({ ...draft, systemOne: { ...draft.systemOne, preferTypesafeJev: e.target.checked } })
                }
              />
            </div>
            <div className="form-grid">
              <label className="field">
                <span>
                  TYPESAFE_API_KEY{' '}
                  {secrets.hasTypesafeApiKey
                    ? `（已存 ${secrets.typesafeApiKeyHint ?? '••••'}）`
                    : '（未配置，将自动降级 magpie）'}
                </span>
                <input
                  type="password"
                  placeholder="粘贴新 Key 覆盖保存，留空保持不变"
                  value={typesafeKeyInput}
                  onChange={(e) => setTypesafeKeyInput(e.target.value)}
                />
              </label>
              <label className="field">
                <span>Jev 模型名称</span>
                <input
                  type="text"
                  value={draft.systemOne.jevModel}
                  onChange={(e) => setDraft({ ...draft, systemOne: { ...draft.systemOne, jevModel: e.target.value } })}
                />
              </label>
            </div>
            <div className="toggle-row">
              <span>无 Key 或超时时自动降级至本机 magpie 结构化校准</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {secrets.hasTypesafeApiKey && (
                  <button type="button" className="btn btn-danger" onClick={() => void handleClearTypesafeKey()}>
                    清除 Jev Key
                  </button>
                )}
                <input
                  type="checkbox"
                  checked={draft.systemOne.fallbackToMagpie}
                  onChange={(e) =>
                    setDraft({ ...draft, systemOne: { ...draft.systemOne, fallbackToMagpie: e.target.checked } })
                  }
                />
              </div>
            </div>
            <div className="form-grid">
              <label className="field">
                <span>magpie 降级校准端点</span>
                <input
                  type="text"
                  value={draft.systemOne.fallbackBaseUrl}
                  onChange={(e) =>
                    setDraft({ ...draft, systemOne: { ...draft.systemOne, fallbackBaseUrl: e.target.value } })
                  }
                />
              </label>
              <label className="field">
                <span>magpie 降级校准模型</span>
                <input
                  type="text"
                  value={draft.systemOne.fallbackModel}
                  onChange={(e) =>
                    setDraft({ ...draft, systemOne: { ...draft.systemOne, fallbackModel: e.target.value } })
                  }
                />
              </label>
            </div>
          </div>

          {/* 2. Fast Brain & Vision Models */}
          <div className="form-section">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4>语言快脑 & 视觉皮层模型路由（默认直连本机 magpie:3425）</h4>
              <button type="button" className="btn" onClick={() => void handleFetchModels()}>
                刷新 magpie 模型
              </button>
            </div>
            {modelsStatus && <div className="brand-sub">{modelsStatus}</div>}
            <div className="form-grid">
              <label className="field">
                <span>快脑协议格式</span>
                <select
                  value={draft.fastBrain.provider}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      fastBrain: {
                        ...draft.fastBrain,
                        provider: e.target.value as PresenceConfig['fastBrain']['provider'],
                      },
                    })
                  }
                >
                  <option value="openai-compatible">OpenAI 兼容（magpie / DeepSeek / Ollama）</option>
                  <option value="anthropic-compatible">Anthropic 兼容</option>
                  <option value="gemini-compatible">Gemini 兼容</option>
                </select>
              </label>
              <label className="field">
                <span>快脑端点 URL</span>
                <input
                  type="text"
                  value={draft.fastBrain.baseUrl}
                  onChange={(e) => setDraft({ ...draft, fastBrain: { ...draft.fastBrain, baseUrl: e.target.value } })}
                />
              </label>
              <label className="field">
                <span>快脑对话模型</span>
                <input
                  type="text"
                  list="magpie-models-list"
                  value={draft.fastBrain.model}
                  onChange={(e) => setDraft({ ...draft, fastBrain: { ...draft.fastBrain, model: e.target.value } })}
                />
              </label>
              <label className="field">
                <span>视觉皮层 VLM 模型（M2 屏幕/镜头）</span>
                <input
                  type="text"
                  list="magpie-models-list"
                  value={draft.visionBrain.model}
                  onChange={(e) => setDraft({ ...draft, visionBrain: { ...draft.visionBrain, model: e.target.value } })}
                />
              </label>
              <label className="field">
                <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>
                    自定义端点 API Key（本机 magpie 无需填写
                    {secrets.hasFastBrainApiKey ? ` · 已存 ${secrets.fastBrainApiKeyHint ?? '••••'}` : ''}）
                  </span>
                  {secrets.hasFastBrainApiKey && (
                    <button type="button" className="btn btn-danger" onClick={() => void handleClearFastKey()}>
                      清除
                    </button>
                  )}
                </span>
                <input
                  type="password"
                  placeholder="可选，仅连接外部云端时需要"
                  value={fastKeyInput}
                  onChange={(e) => setFastKeyInput(e.target.value)}
                />
              </label>
              <label className="field">
                <span>慢脑 DSH 委派参考模型</span>
                <input
                  type="text"
                  list="magpie-models-list"
                  value={draft.slowBrain.model}
                  onChange={(e) => setDraft({ ...draft, slowBrain: { ...draft.slowBrain, model: e.target.value } })}
                />
              </label>
            </div>
            <datalist id="magpie-models-list">
              <option value="opencode-go/deepseek-v4.1-flash" />
              <option value="remote-magpie/auto/gemini-4-argon" />
              <option value="remote-magpie/auto/gemini-4-carbon" />
              <option value="remote-magpie/auto/claude-opus-5-5" />
              <option value="codex/gpt-6.2-sol" />
              {models.map((m) => (
                <option key={m.id} value={m.id} />
              ))}
            </datalist>
          </div>

          {/* 3. Voice, Silero VAD & TTS */}
          <div className="form-section">
            <h4>听觉 VAD 打断、声带 TTS 与口型同步</h4>
            <div className="form-grid">
              <label className="field">
                <span>TTS 语音引擎</span>
                <select
                  value={draft.voice.ttsProvider}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      voice: { ...draft.voice, ttsProvider: e.target.value as PresenceConfig['voice']['ttsProvider'] },
                    })
                  }
                >
                  <option value="edge-tts">Edge-TTS 拟真神经中文（开箱免费 + 离线兜底）</option>
                  <option value="macos-say">macOS 原生离线语音</option>
                  <option value="openai-compatible">自定义 OpenAI / FishSpeech / Kokoro 端点</option>
                  <option value="browser-speech">浏览器内置朗读</option>
                </select>
              </label>
              <label className="field">
                <span>Edge-TTS 声线</span>
                <select
                  value={draft.voice.edgeVoice}
                  onChange={(e) => setDraft({ ...draft, voice: { ...draft.voice, edgeVoice: e.target.value } })}
                >
                  {EDGE_VOICE_PRESETS.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>STT 语音识别引擎</span>
                <select
                  value={draft.voice.sttProvider}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      voice: { ...draft.voice, sttProvider: e.target.value as PresenceConfig['voice']['sttProvider'] },
                    })
                  }
                >
                  <option value="macos-speech">macOS 原生语音识别（Apple Speech · 纯内存不落盘，推荐）</option>
                  <option value="web-speech">浏览器 WebSpeech 实时识别（Electron macOS 无效时自动兜底）</option>
                  <option value="whisper-http">本地 Whisper HTTP (/v1/audio/transcriptions)</option>
                  <option value="off">仅文本输入</option>
                </select>
              </label>
              <label className="field">
                <span>VAD 开口打断灵敏度（{Math.round(draft.voice.vadSensitivity * 100)}%）</span>
                <input
                  type="range"
                  min={0.15}
                  max={0.92}
                  step={0.02}
                  value={draft.voice.vadSensitivity}
                  onChange={(e) =>
                    setDraft({ ...draft, voice: { ...draft.voice, vadSensitivity: Number(e.target.value) } })
                  }
                />
              </label>
            </div>
            {draft.voice.ttsProvider === 'openai-compatible' && (
              <div className="form-grid">
                <label className="field">
                  <span>自定义 TTS 端点 URL</span>
                  <input
                    type="text"
                    value={draft.voice.customTtsBaseUrl}
                    onChange={(e) =>
                      setDraft({ ...draft, voice: { ...draft.voice, customTtsBaseUrl: e.target.value } })
                    }
                  />
                </label>
                <label className="field">
                  <span>自定义 TTS 模型</span>
                  <input
                    type="text"
                    value={draft.voice.customTtsModel}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        voice: { ...draft.voice, customTtsModel: e.target.value },
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>自定义 TTS 声线</span>
                  <input
                    type="text"
                    value={draft.voice.customTtsVoice}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        voice: { ...draft.voice, customTtsVoice: e.target.value },
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>自定义 TTS API Key{secrets.hasCustomTtsApiKey ? '（已存）' : '（可选）'}</span>
                  <input
                    type="password"
                    placeholder="留空保持不变"
                    value={customTtsKeyInput}
                    onChange={(e) => setCustomTtsKeyInput(e.target.value)}
                  />
                </label>
              </div>
            )}
            {draft.voice.sttProvider !== 'off' && (
              <div className="form-grid" style={{ marginBottom: 8 }}>
                <label className="field">
                  <span>STT 语音识别语言</span>
                  <select
                    value={draft.voice.sttLocale}
                    onChange={(e) => setDraft({ ...draft, voice: { ...draft.voice, sttLocale: e.target.value } })}
                  >
                    <option value="zh-CN">简体中文 (zh-CN)</option>
                    <option value="zh-TW">繁體中文 (zh-TW)</option>
                    <option value="zh-HK">粵語 (zh-HK)</option>
                    <option value="en-US">English (en-US)</option>
                    <option value="ja-JP">日本語 (ja-JP)</option>
                  </select>
                </label>
              </div>
            )}
            {draft.voice.sttProvider === 'macos-speech' && (
              <div className="brand-sub" style={{ marginBottom: 8 }}>
                使用 Apple Speech（当前 {draft.voice.sttLocale}）直接经 stdin
                内存流识别，音频永不落盘；如未授权请在「系统设置 → 隐私与安全性 → 语音识别」中开启。
              </div>
            )}
            {draft.voice.sttProvider === 'whisper-http' && (
              <div className="form-grid">
                <label className="field">
                  <span>Whisper HTTP 端点 URL</span>
                  <input
                    type="text"
                    value={draft.voice.whisperBaseUrl}
                    onChange={(e) => setDraft({ ...draft, voice: { ...draft.voice, whisperBaseUrl: e.target.value } })}
                  />
                </label>
                <label className="field">
                  <span>Whisper API Key{secrets.hasWhisperApiKey ? '（已存）' : '（本地通常无需）'}</span>
                  <input
                    type="password"
                    placeholder="留空保持不变"
                    value={whisperKeyInput}
                    onChange={(e) => setWhisperKeyInput(e.target.value)}
                  />
                </label>
              </div>
            )}
            <div className="toggle-row">
              <span>自动流式朗读雪儿的回复（按句边生成边播 + 60fps 口型同步）</span>
              <input
                type="checkbox"
                checked={draft.voice.autoSpeak}
                onChange={(e) => setDraft({ ...draft, voice: { ...draft.voice, autoSpeak: e.target.checked } })}
              />
            </div>
            <div className="toggle-row">
              <span>启用 Silero VAD 随时开口打断（你一说话立即停播切入聆听）</span>
              <input
                type="checkbox"
                checked={draft.voice.bargeInEnabled}
                onChange={(e) => setDraft({ ...draft, voice: { ...draft.voice, bargeInEnabled: e.target.checked } })}
              />
            </div>
            <div className="toggle-row">
              <span>扬声器防回声自打断保护（雪儿发声期间提高打断能量与持续帧门槛）</span>
              <input
                type="checkbox"
                checked={draft.voice.echoGuardEnabled}
                onChange={(e) => setDraft({ ...draft, voice: { ...draft.voice, echoGuardEnabled: e.target.checked } })}
              />
            </div>
            {draft.voice.echoGuardEnabled && (
              <label className="field" style={{ marginTop: 6 }}>
                <span>回声防护强度（{Math.round(draft.voice.echoGuardStrength * 100)}%，外放响亮时适当调高）</span>
                <input
                  type="range"
                  min={0.15}
                  max={0.95}
                  step={0.05}
                  value={draft.voice.echoGuardStrength}
                  onChange={(e) =>
                    setDraft({ ...draft, voice: { ...draft.voice, echoGuardStrength: Number(e.target.value) } })
                  }
                />
              </label>
            )}
          </div>

          {/* 4. Persona & Holographic Appearance */}
          <div className="form-section">
            <h4>雪儿人设与全息视觉参数</h4>
            <div className="form-grid">
              <label className="field">
                <span>数字人名字</span>
                <input
                  type="text"
                  value={draft.persona.name}
                  onChange={(e) => setDraft({ ...draft, persona: { ...draft.persona, name: e.target.value } })}
                />
              </label>
              <label className="field">
                <span>全息光效主题</span>
                <select
                  value={draft.appearance.theme}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      appearance: { ...draft.appearance, theme: e.target.value as VisualTheme },
                    })
                  }
                >
                  {VISUAL_THEMES.map((id) => (
                    <option key={id} value={id}>
                      {THEME_PALETTES[id].label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>全息菲涅尔边缘光强度（{Math.round(draft.appearance.hologramIntensity * 100)}%）</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.02}
                  value={draft.appearance.hologramIntensity}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      appearance: { ...draft.appearance, hologramIntensity: Number(e.target.value) },
                    })
                  }
                />
              </label>
              <label className="field">
                <span>扫描线密度（{Math.round(draft.appearance.scanlineDensity * 100)}%）</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.02}
                  value={draft.appearance.scanlineDensity}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      appearance: { ...draft.appearance, scanlineDensity: Number(e.target.value) },
                    })
                  }
                />
              </label>
            </div>
            <label className="field">
              <span>自定义补充人设 Prompt（可选）</span>
              <textarea
                rows={2}
                placeholder="例如：提醒我按时喝水，汇报代码进度时简明扼要..."
                value={draft.persona.customPrompt}
                onChange={(e) => setDraft({ ...draft, persona: { ...draft.persona, customPrompt: e.target.value } })}
              />
            </label>
          </div>
        </div>

        <div className="modal-footer">
          {saveError && (
            <div style={{ color: 'var(--danger)', fontSize: 11, marginRight: 'auto', maxWidth: 420 }}>{saveError}</div>
          )}
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void handleSave()}>
            {saving ? '保存中...' : '保存并热生效'}
          </button>
        </div>
      </div>
    </div>
  );
}
