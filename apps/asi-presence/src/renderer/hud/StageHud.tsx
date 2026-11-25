import type { MaskedSecretsSummary, PresenceConfig } from '@asi/omni-router';
import {
  type BridgeDreamInsightItem,
  type BridgeMemoryItem,
  type BridgeProspectiveItem,
  VISUAL_THEMES,
} from '@asi/presence-protocol';
import { useEffect, useRef, useState } from 'react';
import type { AsiPresenceBridgeApi, PresenceAppState } from '../../shared/ipc-api.ts';
import type { PresenceSceneEngine } from '../stage/presence-scene.ts';
import { THEME_PALETTES } from '../stage/themes.ts';
import { deriveVisionOverlayStatus } from '../vision/vision-controller.ts';
import { SettingsModal } from './SettingsModal.tsx';

interface StageHudProps {
  api: AsiPresenceBridgeApi;
  state: PresenceAppState;
  config: PresenceConfig;
  secrets: MaskedSecretsSummary;
  canvasHostRef: React.RefObject<HTMLDivElement>;
  sceneRef: React.MutableRefObject<PresenceSceneEngine | null>;
  vadBackend: string;
  vadRms: number;
  isSpeaking: boolean;
  toastText: string | null;
  onSendMessage: (text: string) => void;
  onToggleMic: () => void;
  onInterrupt: () => void;
  onConfigSaved: (next: PresenceConfig) => void;
  onSecretsSaved: (next: MaskedSecretsSummary) => void;
  onLoadVrmFile: (file: File) => Promise<void>;
  onResetHumanoid: () => void;
}

type DockTab = 'chat' | 'memory' | 'cognition' | 'vitals';

const TOM_LABELS: Record<PresenceAppState['bridge']['tom']['state'], string> = {
  deep_focus: '深度心流',
  rapid_sprint: '快节奏冲刺',
  stuck_debugging: '排障攻坚',
  exploring: '探索发散',
  steady_flow: '平稳协作',
  away_resting: '离开休息',
};

const ROUTE_LABELS: Record<string, string> = {
  fast_reply: '快脑直回',
  recall_memory: '记忆召回',
  inspect_screen: '屏幕视觉',
  delegate_dsh: 'DSH 慢脑委派',
};

export function StageHud({
  api,
  state,
  config,
  secrets,
  canvasHostRef,
  sceneRef,
  vadBackend,
  vadRms,
  isSpeaking,
  toastText,
  onSendMessage,
  onToggleMic,
  onInterrupt,
  onConfigSaved,
  onSecretsSaved,
  onLoadVrmFile,
  onResetHumanoid,
}: StageHudProps) {
  const [dockTab, setDockTab] = useState<DockTab>('chat');
  const [inputText, setInputText] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [vrmNotice, setVrmNotice] = useState<string | null>(null);

  // DSH Memory / Cognition interactive states
  const [memoryQuery, setMemoryQuery] = useState('');
  const [memories, setMemories] = useState<BridgeMemoryItem[]>([]);
  const [newMemTitle, setNewMemTitle] = useState('');
  const [newMemContent, setNewMemContent] = useState('');
  const [prospectiveList, setProspectiveList] = useState<BridgeProspectiveItem[]>([]);
  const [dreamList, setDreamList] = useState<BridgeDreamInsightItem[]>([]);
  const [newRemindTitle, setNewRemindTitle] = useState('');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const companionName = config.persona.name || '雪儿';
  const visionStatus = deriveVisionOverlayStatus(state.privacy, state.lastDecision?.focusBox ?? null);

  const messageCount = state.messages.length;
  useEffect(() => {
    if (messageCount > 0) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messageCount]);

  const memRevision = state.bridge.sleep.totalMemories;
  const cogRevision =
    state.bridge.intuition.pendingIntentions +
    state.bridge.intuition.surfacedIntentions +
    state.bridge.dream.openInsightCount;

  useEffect(() => {
    if (!state.bridge.connected) return;
    if (dockTab === 'memory' && memRevision >= 0) {
      void api
        .bridgeRpc<{ hits?: BridgeMemoryItem[] }>('memory.recall', { query: memoryQuery, limit: 12 })
        .then((res) => setMemories(res.hits ?? []))
        .catch(() => undefined);
    } else if (dockTab === 'cognition' && cogRevision >= 0) {
      void api
        .bridgeRpc<BridgeProspectiveItem[]>('prospective.list', { limit: 10 })
        .then((items) => setProspectiveList(Array.isArray(items) ? items : []))
        .catch(() => undefined);
      void api
        .bridgeRpc<BridgeDreamInsightItem[]>('dream.list', { limit: 8 })
        .then((items) => setDreamList(Array.isArray(items) ? items : []))
        .catch(() => undefined);
    }
  }, [api, cogRevision, dockTab, memRevision, memoryQuery, state.bridge.connected]);

  const handleViewportPointerMove = (ev: React.PointerEvent<HTMLElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const nx = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const ny = -(((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
    sceneRef.current?.setPointerNormalized(nx, ny);
  };

  const handleDropVrm = async (ev: React.DragEvent<HTMLElement>) => {
    ev.preventDefault();
    setDragActive(false);
    const file = ev.dataTransfer.files[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.vrm')) {
      setVrmNotice('仅支持拖入 .vrm 模型文件');
      return;
    }
    try {
      await onLoadVrmFile(file);
      setVrmNotice(`已热挂载 3D 模型：${file.name}`);
    } catch (err) {
      setVrmNotice(`模型加载失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleSubmitChat = (ev: React.FormEvent) => {
    ev.preventDefault();
    const clean = inputText.trim();
    if (!clean) return;
    setInputText('');
    onSendMessage(clean);
  };

  const handleCreateMemory = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!newMemTitle.trim() || !newMemContent.trim()) return;
    try {
      await api.bridgeRpc('memory.create', {
        kind: 'preference',
        title: newMemTitle.trim(),
        content: newMemContent.trim(),
        tags: ['presence', 'xueer'],
        pinned: true,
      });
      setNewMemTitle('');
      setNewMemContent('');
      const res = await api.bridgeRpc<{ hits?: BridgeMemoryItem[] }>('memory.recall', {
        query: memoryQuery,
        limit: 12,
      });
      setMemories(res.hits ?? []);
      setVrmNotice('已固化到 DSH 共享长期记忆库');
    } catch (err) {
      setVrmNotice(`记忆写入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleCreateReminder = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!newRemindTitle.trim()) return;
    try {
      await api.bridgeRpc('prospective.create', {
        title: newRemindTitle.trim(),
        instruction: newRemindTitle.trim(),
        triggerKind: 'time',
        delayMinutes: 30,
      });
      setNewRemindTitle('');
      const items = await api.bridgeRpc<BridgeProspectiveItem[]>('prospective.list', { limit: 10 });
      setProspectiveList(Array.isArray(items) ? items : []);
      setVrmNotice('已记入前瞻提醒（30 分钟后触发）');
    } catch (err) {
      setVrmNotice(`前瞻提醒创建失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleResolveReminder = async (id: string, action: 'fulfill' | 'snooze') => {
    try {
      await api.bridgeRpc('prospective.resolve', {
        id,
        action,
        ...(action === 'snooze' ? { snoozeMinutes: 30 } : {}),
      });
      const items = await api.bridgeRpc<BridgeProspectiveItem[]>('prospective.list', { limit: 10 });
      setProspectiveList(Array.isArray(items) ? items : []);
    } catch (err) {
      setVrmNotice(`操作失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="stage-shell" data-theme={state.theme}>
      {/* Top Global Telemetry & Privacy Control Header */}
      <header className="stage-header">
        <div className="stage-header-group">
          <div className="brand-title">
            <span className={`led ${state.bridge.connected ? 'on' : 'warn'}`} />
            <span>{companionName}</span>
            <span className="brand-sub">
              {state.bridge.connected ? `DSH 神经总线在线 · asi@${state.bridge.asiVersion}` : '离线独立陪伴模式'}
            </span>
          </div>
          <span className="chip">ToM · {TOM_LABELS[state.bridge.tom.state]}</span>
          {state.bridge.vitals.batteryPercent !== null && (
            <span className="chip">
              ⚡ {state.bridge.vitals.batteryPercent}%{state.bridge.vitals.batteryCharging ? ' 充电中' : ''}
            </span>
          )}
        </div>

        <div className="stage-header-group">
          <button
            type="button"
            className={`btn ${state.privacy.microphoneEnabled ? 'btn-primary' : ''}`}
            disabled={state.privacy.physicalKillSwitch}
            onClick={onToggleMic}
            title="开启麦克风 Silero VAD 实时语音与随时开口打断"
          >
            <span
              className={`led ${state.privacy.microphoneEnabled && !state.privacy.physicalKillSwitch ? 'on' : ''}`}
            />
            麦克风
          </button>

          <button
            type="button"
            className={`btn ${visionStatus.screenVisionEnabled ? 'btn-primary' : ''}`}
            disabled={state.privacy.physicalKillSwitch}
            onClick={() => void api.updatePrivacy({ screenVisionEnabled: !state.privacy.screenVisionEnabled })}
            title="屏幕视觉默认关闭；纯内存单帧不落盘（M2 Jev Box 聚焦入口）"
          >
            <span className={`led ${visionStatus.screenVisionEnabled ? 'warn' : ''}`} />
            屏幕视觉
          </button>

          <button
            type="button"
            className={`btn ${visionStatus.cameraEnabled ? 'btn-primary' : ''}`}
            disabled={state.privacy.physicalKillSwitch}
            onClick={() => void api.updatePrivacy({ cameraEnabled: !state.privacy.cameraEnabled })}
            title="面对面摄像头默认关闭；纯内存低帧率不落盘（M2 入口）"
          >
            <span className={`led ${visionStatus.cameraEnabled ? 'warn' : ''}`} />
            面对面
          </button>

          <button
            type="button"
            className={`btn btn-danger ${state.privacy.physicalKillSwitch ? 'active' : ''}`}
            onClick={() => void api.setPhysicalKillSwitch(!state.privacy.physicalKillSwitch)}
            title="一键物理级静音断眼（立即切断麦/屏/摄与全部播报 · Cmd+Shift+X）"
          >
            {state.privacy.physicalKillSwitch ? '已断眼静音 · 解除' : '一键断眼静音'}
          </button>

          <button type="button" className="btn" onClick={() => setSettingsOpen(true)}>
            ⚙ 设置
          </button>
          <button type="button" className="btn" onClick={() => void api.setWindowMode('floating')}>
            ↙ 悬浮窗
          </button>
        </div>
      </header>

      <div className="stage-body">
        {/* Left: Unified 3D Holographic Stage */}
        <section
          role="application"
          aria-label="雪儿 3D 全息舞台"
          className={`viewport-pane ${dragActive ? 'drag-active' : ''}`}
          onPointerMove={handleViewportPointerMove}
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => void handleDropVrm(e)}
        >
          <div ref={canvasHostRef} className="stage-canvas-host" />

          {/* System One (Jev) Decision Telemetry HUD */}
          <aside className="jev-hud-card">
            <div className="jev-hud-title">
              <span>System One 直觉门控</span>
              <span>
                {state.lastDecision
                  ? state.lastDecision.backend === 'typesafe-jev'
                    ? 'Jev 原生'
                    : state.lastDecision.backend === 'magpie-fallback'
                      ? 'magpie 校准'
                      : '本地直觉'
                  : '待命'}
              </span>
            </div>
            <div className="jev-kv">
              <span>执行路由</span>
              <strong>
                {state.lastDecision ? (ROUTE_LABELS[state.lastDecision.route] ?? state.lastDecision.route) : '快脑陪伴'}
              </strong>
            </div>
            <div className="jev-kv">
              <span>情绪 / 活力</span>
              <strong>
                {state.emotion} · {state.lastDecision?.energy ?? 58}/100
              </strong>
            </div>
            <div className="jev-kv">
              <span>判定延迟 / VAD</span>
              <strong>
                {state.lastDecision ? `${state.lastDecision.latencyMs}ms` : '—'} · {vadBackend}
              </strong>
            </div>
            {state.lastDecision?.reason && (
              <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>{state.lastDecision.reason}</div>
            )}
            {vrmNotice && <div style={{ color: 'var(--accent)', fontSize: 10 }}>{vrmNotice}</div>}
          </aside>

          {toastText && <div className="stage-toast">{toastText}</div>}

          {/* Bottom Morph & Appearance Control Deck */}
          <div className="stage-deck">
            <button
              type="button"
              className={`btn ${state.form === 'jarvis-core' ? 'btn-primary' : ''}`}
              onClick={() => void api.setAvatarForm('jarvis-core')}
              title="复仇者联盟 J.A.R.V.I.S. 风格纯粒子神经核心"
            >
              ◉ 贾维斯核心
            </button>
            <button
              type="button"
              className={`btn ${state.form === 'chibi' && !state.vrmFileName ? 'btn-primary' : ''}`}
              onClick={() => {
                if (state.vrmFileName) onResetHumanoid();
                void api.setAvatarForm('chibi');
              }}
              title="Q 版雪儿形象（支持一键切换粒子形态）"
            >
              🐾 Q版雪儿
            </button>
            <button
              type="button"
              className={`btn ${state.form === 'realistic' && !state.vrmFileName ? 'btn-primary' : ''}`}
              onClick={() => {
                if (state.vrmFileName) onResetHumanoid();
                void api.setAvatarForm('realistic');
              }}
              title="真人雪儿形象（支持一键切换粒子形态）"
            >
              ✨ 真人雪儿
            </button>

            {state.form !== 'jarvis-core' && (
              <button
                type="button"
                className={`btn ${state.particleMode ? 'btn-primary' : ''}`}
                onClick={() => void api.toggleParticleMode()}
                title="一键将当前形象在实体与跃动粒子形态间切换 (Cmd+Shift+M)"
              >
                {state.particleMode ? '❖ 切回实体形象' : '✦ 切换粒子形态'}
              </button>
            )}

            {VISUAL_THEMES.map((themeId) => (
              <button
                key={themeId}
                type="button"
                className={`btn ${state.theme === themeId ? 'btn-primary' : ''}`}
                onClick={() => void api.setTheme(themeId)}
              >
                {THEME_PALETTES[themeId].label.split(' · ')[0]}
              </button>
            ))}

            <input
              ref={fileInputRef}
              type="file"
              accept=".vrm"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  void onLoadVrmFile(f)
                    .then(() => setVrmNotice(`已热挂载 3D 模型：${f.name}`))
                    .catch((err: unknown) =>
                      setVrmNotice(`模型加载失败：${err instanceof Error ? err.message : String(err)}`),
                    );
                }
              }}
            />
            <button type="button" className="btn" onClick={() => fileInputRef.current?.click()}>
              导入 .vrm
            </button>
            {state.vrmFileName && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  onResetHumanoid();
                  setVrmNotice('已切回雪儿内置形象');
                }}
              >
                移除 .vrm
              </button>
            )}
          </div>
        </section>

        {/* Right: Dialogue & DSH L0-L5 Cognition Dock */}
        <aside className="dock-pane">
          <nav className="dock-tabs">
            <button
              type="button"
              className={`dock-tab ${dockTab === 'chat' ? 'active' : ''}`}
              onClick={() => setDockTab('chat')}
            >
              全双工对话
            </button>
            <button
              type="button"
              className={`dock-tab ${dockTab === 'memory' ? 'active' : ''}`}
              onClick={() => setDockTab('memory')}
            >
              长期记忆 ({state.bridge.sleep.totalMemories})
            </button>
            <button
              type="button"
              className={`dock-tab ${dockTab === 'cognition' ? 'active' : ''}`}
              onClick={() => setDockTab('cognition')}
            >
              直觉与顿悟 ({state.bridge.intuition.pendingIntentions + state.bridge.dream.openInsightCount})
            </button>
            <button
              type="button"
              className={`dock-tab ${dockTab === 'vitals' ? 'active' : ''}`}
              onClick={() => setDockTab('vitals')}
            >
              稳态体征 ({state.bridge.needs.overallSatisfaction})
            </button>
          </nav>

          {dockTab === 'chat' && (
            <>
              <div className="dock-scroll">
                {state.messages.map((msg) => (
                  <div key={msg.id} className={`msg-bubble ${msg.role}`}>
                    <div>{msg.text || (msg.streaming ? '雪儿正在组织回复…' : '')}</div>
                    {(msg.decision || msg.interrupted || (msg.recalledMemoriesCount ?? 0) > 0) && (
                      <div className="msg-meta">
                        {msg.decision && (
                          <span>
                            {msg.decision.backend} · {ROUTE_LABELS[msg.decision.route] ?? msg.decision.route} (
                            {msg.decision.latencyMs}ms)
                          </span>
                        )}
                        {(msg.recalledMemoriesCount ?? 0) > 0 && (
                          <span>· 召回 {msg.recalledMemoriesCount} 条 DSH 记忆</span>
                        )}
                        {msg.interrupted && <span>· 已由语音开口平滑打断</span>}
                      </div>
                    )}
                    {msg.delegationProposal && (
                      <div className="proposal-card">
                        <strong>DSH 慢脑委派预览（M2 确认执行钩子）</strong>
                        <span>{msg.delegationProposal.summary}</span>
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => {
                            void api
                              .bridgeRpc<{ workspaces?: string[] }>('dsh.delegate_preview', {
                                prompt: msg.delegationProposal?.suggestedPrompt ?? '',
                              })
                              .then((res) => {
                                const wsCount = res.workspaces?.length ?? 0;
                                setVrmNotice(`DSH 慢脑委派通道就绪（发现 ${wsCount} 个活跃工作区）`);
                              })
                              .catch(() => setVrmNotice('请先启动 DSH 并加载 asi 插件以执行慢脑委派'));
                          }}
                        >
                          检查 DSH 可用工作区
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>

              <div className="composer-bar">
                {state.privacy.microphoneEnabled && !state.privacy.physicalKillSwitch && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: 11,
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <span>🎙 {vadBackend} 监听中（开口即刻打断播报）</span>
                      <span>{Math.min(100, Math.round(vadRms * 100))}%</span>
                    </div>
                    <div className="vad-meter-track">
                      <div
                        className="vad-meter-fill"
                        style={{ width: `${Math.min(100, Math.round(vadRms * 100))}%` }}
                      />
                    </div>
                  </div>
                )}

                <form className="composer-row" onSubmit={handleSubmitChat}>
                  <input
                    className="composer-input"
                    type="text"
                    placeholder={`对${companionName}说话或输入消息…（试试“记得上次吗？”或“帮我修个bug”）`}
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                  />
                  {isSpeaking && (
                    <button type="button" className="btn btn-danger" onClick={onInterrupt}>
                      ⏹ 打断
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn"
                    title="清空当前对话记录"
                    onClick={() => void api.clearConversation()}
                  >
                    清空
                  </button>
                  <button type="submit" className="btn btn-primary">
                    发送
                  </button>
                </form>
              </div>
            </>
          )}

          {dockTab === 'memory' && (
            <div className="dock-scroll">
              <div className="info-card">
                <div className="info-card-title">
                  <span>100% 共享 DSH 长期记忆库</span>
                  <span className="brand-sub">~/.dsh/data/asi/sleep/vault/</span>
                </div>
                <input
                  className="composer-input"
                  type="text"
                  placeholder="检索记忆关键词（空值按保留率展示）"
                  value={memoryQuery}
                  onChange={(e) => setMemoryQuery(e.target.value)}
                />
              </div>

              {state.bridge.connected && (
                <form className="info-card" onSubmit={(e) => void handleCreateMemory(e)}>
                  <div className="info-card-title">快速写入共享长期记忆</div>
                  <input
                    className="composer-input"
                    type="text"
                    placeholder="记忆标题（例如：喜欢雪白冰青主题）"
                    value={newMemTitle}
                    onChange={(e) => setNewMemTitle(e.target.value)}
                  />
                  <input
                    className="composer-input"
                    type="text"
                    placeholder="详细内容"
                    value={newMemContent}
                    onChange={(e) => setNewMemContent(e.target.value)}
                  />
                  <button type="submit" className="btn btn-primary">
                    固化到 DSH 记忆库
                  </button>
                </form>
              )}

              {memories.length === 0 ? (
                <div className="info-card">
                  <div className="info-card-body">
                    {state.bridge.connected
                      ? '暂无匹配记忆条目。'
                      : '当前处于离线独立陪伴模式；启动 DSH 后自动同步全部长期记忆。'}
                  </div>
                </div>
              ) : (
                memories.map((m) => (
                  <div key={m.id} className="info-card">
                    <div className="info-card-title">
                      <span>
                        [{m.kind}] {m.title}
                      </span>
                      <span className="chip">{Math.round(m.retention * 100)}%</span>
                    </div>
                    <div className="info-card-body">{m.content}</div>
                  </div>
                ))
              )}
            </div>
          )}

          {dockTab === 'cognition' && (
            <div className="dock-scroll">
              {state.bridge.connected && (
                <form className="info-card" onSubmit={(e) => void handleCreateReminder(e)}>
                  <div className="info-card-title">创建前瞻提醒（30 分钟后触发）</div>
                  <div className="composer-row">
                    <input
                      className="composer-input"
                      type="text"
                      placeholder="例如：提醒我喝口水并检查 PR"
                      value={newRemindTitle}
                      onChange={(e) => setNewRemindTitle(e.target.value)}
                    />
                    <button type="submit" className="btn btn-primary">
                      记住
                    </button>
                  </div>
                </form>
              )}

              <div className="info-card">
                <div className="info-card-title">前瞻记忆意图 ({prospectiveList.length})</div>
                {prospectiveList.length === 0 ? (
                  <div className="info-card-body">暂无待触发前瞻意图。</div>
                ) : (
                  prospectiveList.map((item) => (
                    <div
                      key={item.id}
                      style={{
                        paddingTop: 6,
                        borderTop: '1px solid var(--border)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <div>
                        <strong>{item.title}</strong> · <span className="brand-sub">{item.triggerSummary}</span>
                      </div>
                      {(item.status === 'pending' || item.status === 'surfaced') && (
                        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => void handleResolveReminder(item.id, 'fulfill')}
                          >
                            完成
                          </button>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => void handleResolveReminder(item.id, 'snooze')}
                          >
                            延后
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>

              <div className="info-card">
                <div className="info-card-title">DMN 跨项目做梦顿悟 ({dreamList.length})</div>
                {dreamList.length === 0 ? (
                  <div className="info-card-body">暂无待审跨项目顿悟。</div>
                ) : (
                  dreamList.map((ins) => (
                    <div key={ins.id} style={{ paddingTop: 6, borderTop: '1px solid var(--border)' }}>
                      <div>
                        <strong>{ins.title}</strong> ({Math.round(ins.confidence * 100)}%)
                      </div>
                      <div className="info-card-body">{ins.summary}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {dockTab === 'vitals' && (
            <div className="dock-scroll">
              <div className="info-card">
                <div className="info-card-title">
                  <span>ASI 稳态与身体体征</span>
                  <span className="chip">{state.bridge.needs.overallZone}</span>
                </div>
                <div className="jev-kv">
                  <span>整体满意度</span>
                  <strong>{state.bridge.needs.overallSatisfaction} / 100</strong>
                </div>
                <div className="jev-kv">
                  <span>CPU / 内存压力 / 温控</span>
                  <strong>
                    {state.bridge.vitals.cpuUsage ?? '—'}% · {state.bridge.vitals.memoryPressure} ·{' '}
                    {state.bridge.vitals.thermal}
                  </strong>
                </div>
                <div className="jev-kv">
                  <span>功耗模式 / 前台应用</span>
                  <strong>
                    {state.bridge.vitals.powerMode} · {state.bridge.vitals.frontAppName ?? '—'}
                  </strong>
                </div>
              </div>

              <div className="info-card">
                <div className="info-card-title">
                  <span>心智理论 ToM 协作眼力见</span>
                  <span className="chip">{TOM_LABELS[state.bridge.tom.state]}</span>
                </div>
                <div className="info-card-body">{state.bridge.tom.headline}</div>
                <div className="jev-kv">
                  <span>专注 / 阻力 / 节奏 / 在场</span>
                  <strong>
                    {state.bridge.tom.dimensions.focus} / {state.bridge.tom.dimensions.friction} /{' '}
                    {state.bridge.tom.dimensions.pace} / {state.bridge.tom.dimensions.presence}
                  </strong>
                </div>
                {state.bridge.connected && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                    {(['deep_focus', 'steady_flow', 'exploring', null] as const).map((st) => (
                      <button
                        key={String(st)}
                        type="button"
                        className="btn"
                        onClick={() => void api.bridgeRpc('tom.override', { state: st, durationMinutes: 60 })}
                      >
                        {st === null ? '恢复自动推断' : `校准：${TOM_LABELS[st]}`}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="info-card">
                <div className="info-card-title">待处理 ASI 求助卡 ({state.bridge.needs.openHelpCards.length})</div>
                {state.bridge.needs.openHelpCards.length === 0 ? (
                  <div className="info-card-body">一切稳态舒适，无待处理求助卡。</div>
                ) : (
                  state.bridge.needs.openHelpCards.map((c) => (
                    <div key={c.id} style={{ paddingTop: 6, borderTop: '1px solid var(--border)' }}>
                      <strong>{c.title}</strong>
                      <div className="info-card-body">{c.summary}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </aside>
      </div>

      {settingsOpen && (
        <SettingsModal
          api={api}
          config={config}
          secrets={secrets}
          onConfigSaved={onConfigSaved}
          onSecretsSaved={onSecretsSaved}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
