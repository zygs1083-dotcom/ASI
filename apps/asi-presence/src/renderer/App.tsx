import { createDefaultPresenceConfig, type MaskedSecretsSummary, type PresenceConfig } from '@asi/omni-router/schema';
import {
  type AvatarForm,
  createDefaultPrivacyState,
  createOfflineBridgeSnapshot,
  type VisualTheme,
  type WindowMode,
} from '@asi/presence-protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AsiPresenceBridgeApi,
  BridgePushEvent,
  ChatTurnStreamEvent,
  PresenceAppState,
} from '../shared/ipc-api.ts';
import { resolveEffectivePresenceActivity, StreamingTtsPlayer } from './audio/tts-player.ts';
import { PresenceVoiceVadController, shouldTranscribeViaMainProcess } from './audio/vad-engine.ts';
import { FloatingHud } from './hud/FloatingHud.tsx';
import { StageHud } from './hud/StageHud.tsx';
import { PresenceSceneEngine } from './stage/presence-scene.ts';

function resolveWindowRole(): 'floating' | 'stage' {
  if (window.asiPresence?.windowRole) return window.asiPresence.windowRole;
  const params = new URLSearchParams(window.location.search);
  return params.get('window') === 'floating' ? 'floating' : 'stage';
}

function createBrowserPreviewApi(role: 'floating' | 'stage'): AsiPresenceBridgeApi {
  let cfg = createDefaultPresenceConfig();
  let state: PresenceAppState = {
    windowMode: role,
    form: role === 'floating' ? 'particle-face' : 'humanoid-3d',
    theme: 'snow-cyan',
    emotion: 'affectionate',
    activity: 'idle',
    hologramIntensity: 0.72,
    scanlineDensity: 0.48,
    particleGlow: 1.0,
    vrmFileName: null,
    privacy: createDefaultPrivacyState(),
    bridge: createOfflineBridgeSnapshot(),
    lastDecision: null,
    messages: [
      {
        id: 'preview-hello',
        role: 'assistant',
        text: '你好呀，我是雪儿～（当前为纯浏览器预览模式，在 Electron 桌面端启动将自动连通 DSH 与本机 magpie:3425）',
        createdAt: Date.now(),
      },
    ],
  };

  const stateListeners = new Set<(s: PresenceAppState) => void>();
  const chatListeners = new Set<(e: ChatTurnStreamEvent) => void>();
  const emitState = () => {
    for (const l of stateListeners) l({ ...state });
  };

  return {
    windowRole: role,
    getInitialState: async () => ({
      state,
      config: cfg,
      secrets: {
        hasTypesafeApiKey: false,
        typesafeApiKeyHint: null,
        hasFastBrainApiKey: false,
        fastBrainApiKeyHint: null,
        hasVisionBrainApiKey: false,
        hasCustomTtsApiKey: false,
        hasWhisperApiKey: false,
      },
    }),
    sendMessage: async (text) => {
      const turnId = `preview_${Date.now()}`;
      const reply = `雪儿收到啦：“${text}”。在桌面端运行即可连接 magpie:3425 与 DSH 长期记忆流式语音回复哦！`;
      state = {
        ...state,
        emotion: 'joyful',
        messages: [
          ...state.messages,
          { id: `u_${turnId}`, role: 'user', text, createdAt: Date.now() },
          { id: `a_${turnId}`, role: 'assistant', text: reply, createdAt: Date.now() + 1 },
        ],
      };
      emitState();
      for (const l of chatListeners) {
        l({ turnId, kind: 'sentence', sentenceIndex: 0, sentenceText: reply, speechText: reply });
        l({ turnId, kind: 'done', fullText: reply });
      }
      return { turnId };
    },
    interruptTurn: async () => undefined,
    clearConversation: async () => {
      state = { ...state, messages: [] };
      emitState();
    },
    synthesizeSpeech: async ({ text }) => ({ ok: true, providerUsed: 'browser-speech', fallbackText: text }),
    abortSpeech: async () => undefined,
    transcribeAudio: async () => ({ ok: false, text: '', providerUsed: 'off' }),
    setAvatarForm: async (form: AvatarForm) => {
      state = { ...state, form };
      emitState();
    },
    toggleAvatarForm: async () => {
      const next: AvatarForm = state.form === 'particle-face' ? 'humanoid-3d' : 'particle-face';
      state = { ...state, form: next };
      emitState();
      return next;
    },
    setTheme: async (theme: VisualTheme) => {
      state = { ...state, theme };
      emitState();
    },
    updateVisualSettings: async (patch) => {
      state = { ...state, ...patch };
      emitState();
    },
    saveVrmFile: async (_buffer, fileName) => {
      state = { ...state, vrmFileName: fileName, form: 'humanoid-3d' };
      emitState();
      return { ok: true, fileName };
    },
    loadSavedVrm: async () => null,
    clearVrmFile: async () => {
      state = { ...state, vrmFileName: null };
      emitState();
    },
    setWindowMode: async (mode: WindowMode) => {
      state = { ...state, windowMode: mode };
      emitState();
    },
    setIgnoreMouseEvents: () => undefined,
    dragFloatingWindow: () => undefined,
    updatePrivacy: async (patch) => {
      state = { ...state, privacy: { ...state.privacy, ...patch } };
      emitState();
      return state.privacy;
    },
    setPhysicalKillSwitch: async (active) => {
      state = {
        ...state,
        privacy: active
          ? {
              microphoneEnabled: false,
              screenVisionEnabled: false,
              cameraEnabled: false,
              physicalKillSwitch: true,
              activeCapture: { mic: false, screen: false, camera: false },
            }
          : { ...state.privacy, physicalKillSwitch: false },
      };
      emitState();
      return state.privacy;
    },
    saveConfig: async (patch) => {
      cfg = {
        ...cfg,
        persona: { ...cfg.persona, ...(patch.persona ?? {}) },
        appearance: { ...cfg.appearance, ...(patch.appearance ?? {}) },
        systemOne: { ...cfg.systemOne, ...(patch.systemOne ?? {}) },
        fastBrain: { ...cfg.fastBrain, ...(patch.fastBrain ?? {}) },
        visionBrain: { ...cfg.visionBrain, ...(patch.visionBrain ?? {}) },
        slowBrain: { ...cfg.slowBrain, ...(patch.slowBrain ?? {}) },
        voice: { ...cfg.voice, ...(patch.voice ?? {}) },
      };
      state = {
        ...state,
        theme: cfg.appearance.theme,
        hologramIntensity: cfg.appearance.hologramIntensity,
        scanlineDensity: cfg.appearance.scanlineDensity,
        particleGlow: cfg.appearance.particleGlow,
      };
      emitState();
      return cfg;
    },
    saveSecrets: async () => ({
      hasTypesafeApiKey: false,
      typesafeApiKeyHint: null,
      hasFastBrainApiKey: false,
      fastBrainApiKeyHint: null,
      hasVisionBrainApiKey: false,
      hasCustomTtsApiKey: false,
      hasWhisperApiKey: false,
    }),
    listModels: async () => [],
    bridgeRpc: async () => {
      throw new Error('Preview mode has no DSH bridge');
    },
    onStateChanged: (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onConfigChanged: () => () => undefined,
    onSecretsChanged: () => () => undefined,
    onVrmUpdated: () => () => undefined,
    onChatEvent: (listener) => {
      chatListeners.add(listener);
      return () => chatListeners.delete(listener);
    },
    onBridgeEvent: () => () => undefined,
    onInterruptAudio: () => () => undefined,
  };
}

export function App() {
  const role = useMemo(() => resolveWindowRole(), []);
  const api = useMemo<AsiPresenceBridgeApi>(() => window.asiPresence ?? createBrowserPreviewApi(role), [role]);

  const [state, setState] = useState<PresenceAppState>(() => ({
    windowMode: role,
    form: role === 'floating' ? 'particle-face' : 'humanoid-3d',
    theme: 'snow-cyan',
    emotion: 'calm',
    activity: 'idle',
    hologramIntensity: 0.72,
    scanlineDensity: 0.48,
    particleGlow: 1.0,
    vrmFileName: null,
    privacy: createDefaultPrivacyState(),
    bridge: createOfflineBridgeSnapshot(),
    lastDecision: null,
    messages: [],
  }));
  const [config, setConfig] = useState<PresenceConfig>(() => createDefaultPresenceConfig());
  const [secrets, setSecrets] = useState<MaskedSecretsSummary>({
    hasTypesafeApiKey: false,
    typesafeApiKeyHint: null,
    hasFastBrainApiKey: false,
    fastBrainApiKeyHint: null,
    hasVisionBrainApiKey: false,
    hasCustomTtsApiKey: false,
    hasWhisperApiKey: false,
  });
  const [vadBackend, setVadBackend] = useState('待机');
  const [vadRms, setVadRms] = useState(0);
  const [isTtsAudible, setIsTtsAudible] = useState(false);
  const [isTtsQueued, setIsTtsQueued] = useState(false);
  const [toast, setToast] = useState<{ text: string; deferrable: boolean } | null>(null);

  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<PresenceSceneEngine | null>(null);
  const ttsPlayerRef = useRef<StreamingTtsPlayer | null>(null);
  const vadCtrlRef = useRef<PresenceVoiceVadController | null>(null);
  const lastSttToastRef = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const pendingWebSpeechWavRef = useRef<{ wavBase64: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const configRef = useRef<PresenceConfig>(config);
  const stateRef = useRef<PresenceAppState>(state);
  configRef.current = config;
  stateRef.current = state;

  const effectiveActivity = useMemo(
    () => resolveEffectivePresenceActivity(state.activity, { speaking: isTtsAudible, queued: isTtsQueued }),
    [isTtsAudible, isTtsQueued, state.activity],
  );
  const isSpeaking = isTtsAudible || isTtsQueued || effectiveActivity === 'speaking';
  const effectiveState = useMemo(
    () => (effectiveActivity === state.activity ? state : { ...state, activity: effectiveActivity }),
    [effectiveActivity, state],
  );
  const visibleToastText = toast && (!toast.deferrable || !state.bridge.tom.shouldDefer) ? toast.text : null;

  // Apply root body classes for floating transparency vs stage gradient
  useEffect(() => {
    document.documentElement.classList.toggle('floating-mode', role === 'floating');
    document.body.classList.toggle('floating-mode', role === 'floating');
    document.body.classList.toggle('stage-mode', role === 'stage');
  }, [role]);

  // Initialize Three.js scene + Streaming TTS Player
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;

    const scene = new PresenceSceneEngine(host, role);
    sceneRef.current = scene;

    const player = new StreamingTtsPlayer({
      synthesize: (input) => api.synthesizeSpeech(input),
      abortRemote: (id) => api.abortSpeech(id),
      onVisemeFrame: (frame) => scene.setVisemeFrame(frame),
      onSpeakingChanged: (speaking) => {
        setIsTtsAudible(speaking);
        vadCtrlRef.current?.setAssistantSpeaking(speaking);
      },
      onQueueBusyChanged: (queued) => {
        setIsTtsQueued(queued);
      },
    });
    ttsPlayerRef.current = player;

    const ro = new ResizeObserver(() => scene.resize());
    ro.observe(host);

    return () => {
      ro.disconnect();
      player.dispose();
      ttsPlayerRef.current = null;
      scene.dispose();
      sceneRef.current = null;
    };
  }, [api, role]);

  // Sync state (including live TTS speaking persistence) into Three.js engine
  useEffect(() => {
    sceneRef.current?.setState({
      form: effectiveState.form,
      theme: effectiveState.theme,
      emotion: effectiveState.emotion,
      activity: effectiveState.activity,
      hologramIntensity: effectiveState.hologramIntensity,
      scanlineDensity: effectiveState.scanlineDensity,
      particleGlow: effectiveState.particleGlow,
      quietDefer: effectiveState.bridge.tom.shouldDefer,
    });
  }, [effectiveState]);

  // Subscribe to Electron Main IPC streams
  useEffect(() => {
    let mounted = true;

    const hydrateSavedVrm = async () => {
      try {
        const saved = await api.loadSavedVrm();
        if (!mounted) return;
        if (saved && saved.bytes.byteLength > 0) {
          const copy = new Uint8Array(saved.bytes);
          await sceneRef.current?.loadVrmFile(copy.buffer, saved.fileName);
        }
      } catch {
        // Keep built-in 雪儿 humanoid if saved VRM cannot be parsed
      }
    };

    void api.getInitialState().then((init) => {
      if (!mounted) return;
      setState(init.state);
      setConfig(init.config);
      setSecrets(init.secrets);
      if (init.state.vrmFileName) {
        void hydrateSavedVrm();
      }
    });

    const offState = api.onStateChanged((next) => {
      setState(next);
    });
    const offConfig = api.onConfigChanged((nextCfg) => {
      setConfig(nextCfg);
    });
    const offSecrets = api.onSecretsChanged((nextSec) => {
      setSecrets(nextSec);
    });
    const offVrm = api.onVrmUpdated((info) => {
      if (!info.fileName) {
        sceneRef.current?.resetBuiltInHumanoid();
      } else {
        void hydrateSavedVrm();
      }
    });

    const offChat = api.onChatEvent((ev) => {
      // Only the currently active window plays audio so floating & stage never echo each other!
      const isActiveWindow = stateRef.current.windowMode === role;
      if (!isActiveWindow) return;
      if (
        ev.kind === 'sentence' &&
        ev.speechText &&
        configRef.current.voice.autoSpeak &&
        !stateRef.current.privacy.physicalKillSwitch
      ) {
        ttsPlayerRef.current?.enqueueSentence(ev.speechText);
      } else if (ev.kind === 'aborted') {
        ttsPlayerRef.current?.interrupt();
      }
    });

    const offBridge = api.onBridgeEvent((ev: BridgePushEvent) => {
      if (stateRef.current.bridge.tom.shouldDefer) return;
      if (ev.kind === 'help_card') {
        const latest = ev.payload.latest as { title?: string } | undefined;
        setToast({ text: `ASI 稳态提醒：${latest?.title ?? '有新的待处理求助卡'}`, deferrable: true });
      } else if (ev.kind === 'dream_insight') {
        const latest = ev.payload.latest as { title?: string } | undefined;
        setToast({ text: `做梦顿悟：${latest?.title ?? '发现新的跨项目洞察'}`, deferrable: true });
      } else if (ev.kind === 'flashback') {
        setToast({ text: '前额叶直觉闪回：检测到与历史踩坑相似的情境', deferrable: true });
      }
    });

    const offInterrupt = api.onInterruptAudio(() => {
      ttsPlayerRef.current?.interrupt();
    });

    return () => {
      mounted = false;
      offState();
      offConfig();
      offSecrets();
      offVrm();
      offChat();
      offBridge();
      offInterrupt();
    };
  }, [api, role]);

  // Stop hidden-window TTS playback if user switches active window mode so audio & echo guard stay synced
  useEffect(() => {
    if (state.windowMode !== role && ttsPlayerRef.current?.isQueueBusy) {
      ttsPlayerRef.current.interrupt();
    }
  }, [role, state.windowMode]);

  // Auto-dismiss HUD toast after 7 seconds
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);

  const handleInterrupt = useCallback(() => {
    ttsPlayerRef.current?.interrupt();
    void api.interruptTurn();
  }, [api]);

  const handleSendMessage = useCallback(
    (text: string) => {
      ttsPlayerRef.current?.interrupt();
      void api.sendMessage(text);
    },
    [api],
  );

  // Silero VAD + Barge-in lifecycle tied strictly to microphoneEnabled & kill switch
  useEffect(() => {
    const shouldListen =
      state.windowMode === role && state.privacy.microphoneEnabled && !state.privacy.physicalKillSwitch;

    if (!shouldListen) {
      vadCtrlRef.current?.stop();
      vadCtrlRef.current = null;
      setVadRms(0);
      setVadBackend(state.privacy.physicalKillSwitch ? '物理静音' : '待机');
      return;
    }

    const clearPendingWebSpeechWav = () => {
      if (pendingWebSpeechWavRef.current) {
        clearTimeout(pendingWebSpeechWavRef.current.timer);
        pendingWebSpeechWavRef.current = null;
      }
    };

    const runMainProcessStt = (wavBase64: string, fallbackFromWebSpeech: boolean) => {
      void api.transcribeAudio(wavBase64, { fallbackFromWebSpeech }).then((res) => {
        if (res.ok && res.text.trim()) {
          handleSendMessage(res.text.trim());
        } else if (
          !res.ok &&
          res.error &&
          res.errorCode !== 'no_speech' &&
          res.errorCode !== 'aborted' &&
          res.errorCode !== 'renderer_managed'
        ) {
          const now = Date.now();
          const last = lastSttToastRef.current;
          if (last.text !== res.error || now - last.at > 30_000) {
            lastSttToastRef.current = { text: res.error, at: now };
            setToast({ text: `语音识别提示：${res.error}`, deferrable: false });
          }
        }
      });
    };

    const ctrl = new PresenceVoiceVadController({
      onEngineReady: (backend) => setVadBackend(backend === 'silero-vad' ? 'Silero VAD' : 'WebAudio VAD'),
      onRmsLevel: (rms) => setVadRms(rms),
      onSpeechStart: () => {
        // Low-latency barge-in: user starts speaking -> immediately stop 雪儿's TTS & LLM stream!
        if (
          configRef.current.voice.bargeInEnabled &&
          (ttsPlayerRef.current?.isQueueBusy || stateRef.current.activity === 'speaking')
        ) {
          ttsPlayerRef.current?.interrupt();
          void api.interruptTurn();
        }
      },
      onSpeechEnd: (wavBase64) => {
        const route = shouldTranscribeViaMainProcess(configRef.current.voice.sttProvider, ctrl.isWebSpeechActive);
        if (route.enabled) {
          clearPendingWebSpeechWav();
          runMainProcessStt(wavBase64, route.fallbackFromWebSpeech);
        } else if (configRef.current.voice.sttProvider === 'web-speech') {
          // Briefly hold the latest WAV in RAM in case Chromium WebSpeech fails immediately after speech end
          clearPendingWebSpeechWav();
          const timer = setTimeout(() => {
            pendingWebSpeechWavRef.current = null;
          }, 1_200);
          pendingWebSpeechWavRef.current = { wavBase64, timer };
        }
      },
      onTranscript: (text) => {
        clearPendingWebSpeechWav();
        if (configRef.current.voice.sttProvider === 'web-speech' && text.trim()) {
          handleSendMessage(text.trim());
        }
      },
      onWebSpeechUnavailable: () => {
        const pending = pendingWebSpeechWavRef.current;
        clearPendingWebSpeechWav();
        if (pending && configRef.current.voice.sttProvider === 'web-speech') {
          runMainProcessStt(pending.wavBase64, true);
        }
      },
      onError: (err) => setToast({ text: `麦克风启动失败：${err}`, deferrable: false }),
    });

    vadCtrlRef.current = ctrl;
    void ctrl.start({
      sensitivity: config.voice.vadSensitivity,
      useWebSpeech: config.voice.sttProvider === 'web-speech',
      locale: config.voice.sttLocale,
      echoGuardEnabled: configRef.current.voice.echoGuardEnabled,
      echoGuardStrength: configRef.current.voice.echoGuardStrength,
      assistantSpeaking: ttsPlayerRef.current?.isSpeaking ?? false,
    });

    return () => {
      clearPendingWebSpeechWav();
      ctrl.stop();
      if (vadCtrlRef.current === ctrl) {
        vadCtrlRef.current = null;
      }
    };
  }, [
    api,
    config.voice.sttLocale,
    config.voice.sttProvider,
    config.voice.vadSensitivity,
    handleSendMessage,
    role,
    state.privacy.microphoneEnabled,
    state.privacy.physicalKillSwitch,
    state.windowMode,
  ]);

  // Apply speaker echo-guard setting changes hot in place without tearing down the microphone stream
  useEffect(() => {
    vadCtrlRef.current?.setEchoGuard({
      enabled: config.voice.echoGuardEnabled,
      strength: config.voice.echoGuardStrength,
    });
  }, [config.voice.echoGuardEnabled, config.voice.echoGuardStrength]);

  const handleToggleMic = useCallback(() => {
    if (state.privacy.physicalKillSwitch) return;
    void api.updatePrivacy({ microphoneEnabled: !state.privacy.microphoneEnabled });
  }, [api, state.privacy.microphoneEnabled, state.privacy.physicalKillSwitch]);

  const handleLoadVrmFile = useCallback(
    async (file: File) => {
      const buf = await file.arrayBuffer();
      // Parse and verify VRM in Three.js first before persisting & broadcasting to both windows
      await sceneRef.current?.loadVrmFile(buf.slice(0), file.name);
      const saved = await api.saveVrmFile(buf, file.name);
      if (!saved.ok) {
        throw new Error(saved.error ?? 'VRM 保存失败');
      }
    },
    [api],
  );

  const handleResetHumanoid = useCallback(() => {
    sceneRef.current?.resetBuiltInHumanoid();
    void api.clearVrmFile();
  }, [api]);

  if (role === 'floating') {
    return (
      <FloatingHud
        api={api}
        state={effectiveState}
        companionName={config.persona.name || '雪儿'}
        canvasHostRef={canvasHostRef}
        sceneRef={sceneRef}
        vadBackend={vadBackend}
        vadRms={vadRms}
        isSpeaking={isSpeaking}
        onSendMessage={handleSendMessage}
        onToggleMic={handleToggleMic}
        onInterrupt={handleInterrupt}
      />
    );
  }

  return (
    <StageHud
      api={api}
      state={effectiveState}
      config={config}
      secrets={secrets}
      canvasHostRef={canvasHostRef}
      sceneRef={sceneRef}
      vadBackend={vadBackend}
      vadRms={vadRms}
      isSpeaking={isSpeaking}
      toastText={visibleToastText}
      onSendMessage={handleSendMessage}
      onToggleMic={handleToggleMic}
      onInterrupt={handleInterrupt}
      onConfigSaved={setConfig}
      onSecretsSaved={setSecrets}
      onLoadVrmFile={handleLoadVrmFile}
      onResetHumanoid={handleResetHumanoid}
    />
  );
}
