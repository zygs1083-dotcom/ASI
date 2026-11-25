import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  createDefaultPresenceConfig,
  listAvailableModels,
  OmniCompanionOrchestrator,
  type PresenceConfig,
  type PresenceSecrets,
  PresenceSecretsStore,
  sameUrlOrigin,
} from '@asi/omni-router';
import type {
  AvatarForm,
  BridgeRpcMethod,
  ConversationMessage,
  PrivacyState,
  VisualTheme,
  WindowMode,
} from '@asi/presence-protocol';
import { app, ipcMain } from 'electron';
import type { ChatTurnStreamEvent, PresenceAppState } from '../shared/ipc-api.ts';
import { PresenceBridgeClient } from './bridge-client.ts';
import { PrivacyGate } from './privacy-gate.ts';
import { PresenceSttService } from './stt-service.ts';
import { PresenceTtsService } from './tts-service.ts';
import { PresenceWindowManager, registerPresenceAssetProtocol, registerPresenceAssetScheme } from './window-manager.ts';

// Must be called synchronously before app.whenReady()
registerPresenceAssetScheme();

const secretsStore = new PresenceSecretsStore();
const savedVrmPath = join(secretsStore.baseDir, 'custom-avatar.vrm');
const MAX_VRM_BYTES = 80 * 1024 * 1024;
const privacyGate = new PrivacyGate();
const bridgeClient = new PresenceBridgeClient();
const ttsService = new PresenceTtsService({
  getConfig: () => secretsStore.loadConfig(),
  getSecrets: () => secretsStore.loadSecrets(),
});
const sttService = new PresenceSttService({
  getConfig: () => secretsStore.loadConfig(),
  getSecrets: () => secretsStore.loadSecrets(),
});
const orchestrator = new OmniCompanionOrchestrator({
  getConfig: () => secretsStore.loadConfig(),
  getSecrets: () => secretsStore.loadSecrets(),
  bridge: bridgeClient,
});

let activeTurnController: AbortController | null = null;
let windowManager: PresenceWindowManager | null = null;
let isQuitting = false;
let currentConfig: PresenceConfig = createDefaultPresenceConfig();
const windowForms: Record<'floating' | 'stage', AvatarForm> = {
  floating: 'jarvis-core',
  stage: 'chibi',
};
const windowParticleModes: Record<'floating' | 'stage', boolean> = {
  floating: true,
  stage: false,
};

let appState: PresenceAppState = {
  windowMode: 'floating',
  form: 'jarvis-core',
  particleMode: true,
  theme: 'jarvis-amber',
  emotion: 'calm',
  activity: 'idle',
  hologramIntensity: 0.72,
  scanlineDensity: 0.48,
  particleGlow: 1.0,
  vrmFileName: null,
  privacy: privacyGate.getState(),
  bridge: bridgeClient.getSnapshot(),
  lastDecision: null,
  messages: [],
};

function publishState(patch?: Partial<PresenceAppState>): void {
  if (patch) {
    appState = { ...appState, ...patch };
  }
  windowManager?.broadcast('presence:state', appState);
}

function interruptActiveTurn(): void {
  if (activeTurnController) {
    activeTurnController.abort(new Error('Interrupted by user'));
    activeTurnController = null;
  }
  ttsService.abort();
  windowManager?.broadcast('presence:interrupt-audio', null);
  const last = appState.messages[appState.messages.length - 1];
  if (last && last.role === 'assistant' && last.streaming) {
    const updatedMessages = appState.messages.slice(0, -1).concat({
      ...last,
      streaming: false,
      interrupted: true,
    });
    publishState({
      messages: updatedMessages,
      activity: appState.privacy.microphoneEnabled ? 'listening' : 'idle',
    });
  } else {
    publishState({
      activity: appState.privacy.microphoneEnabled ? 'listening' : 'idle',
    });
  }
}

async function handleSendMessage(userText: string): Promise<{ turnId: string }> {
  const clean = userText.trim();
  if (!clean) {
    return { turnId: '' };
  }

  interruptActiveTurn();

  const turnId = `turn_${randomUUID().slice(0, 10)}`;
  const now = Date.now();
  const userMsg: ConversationMessage = {
    id: `u_${turnId}`,
    role: 'user',
    text: clean,
    createdAt: now,
  };
  const assistantMsg: ConversationMessage = {
    id: `a_${turnId}`,
    role: 'assistant',
    text: '',
    createdAt: now + 1,
    streaming: true,
  };

  const historySnapshot = appState.messages
    .filter(
      (m): m is ConversationMessage & { role: 'user' | 'assistant' } =>
        (m.role === 'user' || m.role === 'assistant') && m.id !== 'welcome-xueer' && m.text.trim().length > 0,
    )
    .slice(-12)
    .map((m) => ({ role: m.role, text: m.text }));

  publishState({
    activity: 'thinking',
    messages: [...appState.messages.slice(-40), userMsg, assistantMsg],
  });

  const controller = new AbortController();
  activeTurnController = controller;

  const emitChat = (event: ChatTurnStreamEvent) => {
    windowManager?.broadcast('presence:chat-event', event);
  };

  void (async () => {
    try {
      for await (const ev of orchestrator.runTurn({
        userText: clean,
        history: historySnapshot,
        privacy: privacyGate.getState(),
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) break;

        if (ev.type === 'decision') {
          publishState({
            emotion: ev.decision.emotion,
            lastDecision: ev.decision,
            activity: ev.decision.route === 'delegate_dsh' ? 'delegating' : 'thinking',
          });
          emitChat({ turnId, kind: 'decision', decision: ev.decision });
        } else if (ev.type === 'memories') {
          emitChat({ turnId, kind: 'memories', memories: ev.memories });
        } else if (ev.type === 'token') {
          const updated = appState.messages.map((m) => (m.id === assistantMsg.id ? { ...m, text: ev.accumulated } : m));
          publishState({
            activity: 'speaking',
            messages: updated,
          });
          emitChat({ turnId, kind: 'token', delta: ev.delta, accumulated: ev.accumulated });
        } else if (ev.type === 'sentence') {
          emitChat({
            turnId,
            kind: 'sentence',
            sentenceIndex: ev.index,
            sentenceText: ev.text,
            speechText: ev.speechText,
          });
        } else if (ev.type === 'delegation_proposal') {
          const updated = appState.messages.map((m) =>
            m.id === assistantMsg.id ? { ...m, delegationProposal: ev.proposal } : m,
          );
          publishState({ messages: updated });
          emitChat({ turnId, kind: 'delegation_proposal', delegationProposal: ev.proposal });
        } else if (ev.type === 'done') {
          const updated = appState.messages.map((m) =>
            m.id === assistantMsg.id
              ? {
                  ...m,
                  text: ev.fullText,
                  streaming: false,
                  decision: ev.decision,
                  recalledMemoriesCount: ev.recalledMemories.length,
                  ...(ev.delegationProposal ? { delegationProposal: ev.delegationProposal } : {}),
                }
              : m,
          );
          publishState({
            activity: appState.bridge.tom.shouldDefer ? 'quiet-defer' : 'idle',
            messages: updated,
          });
          emitChat({
            turnId,
            kind: 'done',
            fullText: ev.fullText,
            decision: ev.decision,
            delegationProposal: ev.delegationProposal,
          });
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        emitChat({ turnId, kind: 'aborted' });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        const fallback = `雪儿刚才连不上语言模型啦（${message}）。你可以检查一下本机 magpie:3425 或在设置里切换端点哦。`;
        const updated = appState.messages.map((m) =>
          m.id === assistantMsg.id ? { ...m, text: m.text || fallback, streaming: false } : m,
        );
        publishState({
          emotion: 'alert',
          activity: 'idle',
          messages: updated,
        });
        emitChat({ turnId, kind: 'error', error: message });
      }
    } finally {
      if (activeTurnController === controller) {
        activeTurnController = null;
      }
    }
  })();

  return { turnId };
}

function registerIpcHandlers(): void {
  ipcMain.handle('presence:get-initial', async () => {
    const [config, secrets] = await Promise.all([secretsStore.loadConfig(), secretsStore.getMaskedSecrets()]);
    return { state: appState, config, secrets };
  });

  ipcMain.handle('presence:send-message', async (_ev, text: string) => handleSendMessage(text));
  ipcMain.handle('presence:interrupt-turn', async () => {
    interruptActiveTurn();
  });
  ipcMain.handle('presence:clear-conversation', async () => {
    interruptActiveTurn();
    publishState({ messages: [], lastDecision: null, emotion: 'calm' });
  });

  ipcMain.handle('presence:tts-synthesize', async (_ev, input: { text: string; utteranceId: string }) =>
    ttsService.synthesize(input.text, input.utteranceId),
  );
  ipcMain.handle('presence:tts-abort', async (_ev, utteranceId?: string) => {
    ttsService.abort(utteranceId);
  });
  ipcMain.handle(
    'presence:stt-transcribe',
    async (_ev, wavBase64: string, options?: { fallbackFromWebSpeech?: boolean }) => {
      if (!privacyGate.canCaptureMic()) {
        return { ok: false, text: '', providerUsed: 'off', error: 'Microphone disabled by privacy gate' };
      }
      return sttService.transcribeWavBase64(wavBase64, {
        allowMacOsFallback: options?.fallbackFromWebSpeech === true,
      });
    },
  );

  const applyForm = (form: AvatarForm) => {
    const nextParticle =
      form === 'jarvis-core' ? true : appState.form === 'jarvis-core' ? false : appState.particleMode;
    if (appState.windowMode === 'floating' || appState.windowMode === 'stage') {
      windowForms[appState.windowMode] = form;
      windowParticleModes[appState.windowMode] = nextParticle;
    }
    publishState({ form, particleMode: nextParticle });
  };

  const cycleForm = (): AvatarForm => {
    const order: AvatarForm[] = ['jarvis-core', 'chibi', 'realistic'];
    const idx = order.indexOf(appState.form);
    const next = order[(idx + 1) % order.length] ?? 'jarvis-core';
    applyForm(next);
    return next;
  };

  const applyParticleMode = (enabled: boolean) => {
    if (appState.form === 'jarvis-core') {
      if (!enabled) {
        applyForm('chibi');
        return;
      }
      publishState({ particleMode: true });
      return;
    }
    if (appState.windowMode === 'floating' || appState.windowMode === 'stage') {
      windowParticleModes[appState.windowMode] = enabled;
    }
    publishState({ particleMode: enabled });
  };

  ipcMain.handle('presence:set-form', async (_ev, form: AvatarForm) => {
    applyForm(form);
  });
  ipcMain.handle('presence:toggle-form', async () => cycleForm());
  ipcMain.handle('presence:set-particle-mode', async (_ev, enabled: boolean) => {
    applyParticleMode(Boolean(enabled));
  });
  ipcMain.handle('presence:toggle-particle-mode', async () => {
    if (appState.form === 'jarvis-core') {
      applyForm('chibi');
      return false;
    }
    const next = !appState.particleMode;
    applyParticleMode(next);
    return next;
  });
  ipcMain.handle('presence:set-theme', async (_ev, theme: VisualTheme) => {
    publishState({ theme });
    currentConfig = await secretsStore.saveConfig({
      appearance: { ...(await secretsStore.loadConfig()).appearance, theme },
    });
    windowManager?.broadcast('presence:config', currentConfig);
  });
  ipcMain.handle(
    'presence:update-visual',
    async (
      _ev,
      patch: {
        hologramIntensity?: number;
        scanlineDensity?: number;
        particleGlow?: number;
        vrmFileName?: string | null;
      },
    ) => {
      publishState({
        ...(patch.hologramIntensity !== undefined ? { hologramIntensity: patch.hologramIntensity } : {}),
        ...(patch.scanlineDensity !== undefined ? { scanlineDensity: patch.scanlineDensity } : {}),
        ...(patch.particleGlow !== undefined ? { particleGlow: patch.particleGlow } : {}),
        ...(patch.vrmFileName !== undefined ? { vrmFileName: patch.vrmFileName } : {}),
      });
      const cfg = await secretsStore.loadConfig();
      currentConfig = await secretsStore.saveConfig({
        appearance: {
          ...cfg.appearance,
          ...(patch.hologramIntensity !== undefined ? { hologramIntensity: patch.hologramIntensity } : {}),
          ...(patch.scanlineDensity !== undefined ? { scanlineDensity: patch.scanlineDensity } : {}),
          ...(patch.particleGlow !== undefined ? { particleGlow: patch.particleGlow } : {}),
          ...(patch.vrmFileName !== undefined ? { vrmFileName: patch.vrmFileName } : {}),
        },
      });
      windowManager?.broadcast('presence:config', currentConfig);
    },
  );
  ipcMain.handle('presence:save-vrm', async (_ev, input: { bytes: Uint8Array; fileName: string }) => {
    const cleanName = basename(input.fileName || 'custom.vrm');
    if (!cleanName.toLowerCase().endsWith('.vrm')) {
      return { ok: false, fileName: cleanName, error: '仅支持 .vrm 模型文件' };
    }
    const buf = Buffer.from(input.bytes);
    if (buf.byteLength === 0 || buf.byteLength > MAX_VRM_BYTES) {
      return { ok: false, fileName: cleanName, error: 'VRM 文件为空或超过 80MB 限制' };
    }
    await mkdir(secretsStore.baseDir, { recursive: true, mode: 0o700 });
    const tmpPath = `${savedVrmPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await writeFile(tmpPath, buf, { mode: 0o600 });
      await chmod(tmpPath, 0o600);
      await rename(tmpPath, savedVrmPath);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      return { ok: false, fileName: cleanName, error: err instanceof Error ? err.message : String(err) };
    }
    const cfg = await secretsStore.loadConfig();
    currentConfig = await secretsStore.saveConfig({
      appearance: { ...cfg.appearance, vrmFileName: cleanName },
    });
    windowForms.stage = 'chibi';
    windowParticleModes.stage = false;
    publishState({ vrmFileName: cleanName, form: 'chibi', particleMode: false });
    windowManager?.broadcast('presence:config', currentConfig);
    windowManager?.broadcast('presence:vrm-updated', { fileName: cleanName });
    return { ok: true, fileName: cleanName };
  });
  ipcMain.handle('presence:load-vrm', async () => {
    if (!appState.vrmFileName || !existsSync(savedVrmPath)) {
      return null;
    }
    try {
      const data = await readFile(savedVrmPath);
      return { fileName: appState.vrmFileName, bytes: new Uint8Array(data) };
    } catch {
      return null;
    }
  });
  ipcMain.handle('presence:clear-vrm', async () => {
    await rm(savedVrmPath, { force: true }).catch(() => undefined);
    const cfg = await secretsStore.loadConfig();
    currentConfig = await secretsStore.saveConfig({
      appearance: { ...cfg.appearance, vrmFileName: null },
    });
    publishState({ vrmFileName: null });
    windowManager?.broadcast('presence:config', currentConfig);
    windowManager?.broadcast('presence:vrm-updated', { fileName: null });
  });

  ipcMain.handle('presence:set-window-mode', async (_ev, mode: WindowMode) => {
    windowManager?.setMode(mode);
  });
  ipcMain.on('presence:set-ignore-mouse', (_ev, ignore: boolean) => {
    windowManager?.setFloatingIgnoreMouseEvents(Boolean(ignore));
  });
  ipcMain.on('presence:drag-floating', (_ev, delta: { deltaX: number; deltaY: number }) => {
    windowManager?.moveFloatingBy(Number(delta.deltaX) || 0, Number(delta.deltaY) || 0);
  });

  ipcMain.handle(
    'presence:update-privacy',
    async (_ev, patch: Partial<Pick<PrivacyState, 'microphoneEnabled' | 'screenVisionEnabled' | 'cameraEnabled'>>) => {
      const next = privacyGate.update(patch);
      publishState({ privacy: next });
      return next;
    },
  );
  ipcMain.handle('presence:set-kill-switch', async (_ev, active: boolean) => {
    const next = privacyGate.setPhysicalKillSwitch(Boolean(active));
    if (active) {
      sttService.abort();
      interruptActiveTurn();
    }
    publishState({ privacy: next });
    return next;
  });

  ipcMain.handle('presence:save-config', async (_ev, patch: Partial<PresenceConfig>) => {
    const saved = await secretsStore.saveConfig(patch);
    currentConfig = saved;
    publishState({
      theme: saved.appearance.theme,
      hologramIntensity: saved.appearance.hologramIntensity,
      scanlineDensity: saved.appearance.scanlineDensity,
      particleGlow: saved.appearance.particleGlow,
      vrmFileName: saved.appearance.vrmFileName,
    });
    windowManager?.broadcast('presence:config', saved);
    return saved;
  });
  ipcMain.handle('presence:save-secrets', async (_ev, patch: Partial<Record<keyof PresenceSecrets, string | null>>) => {
    const masked = await secretsStore.saveSecrets(patch);
    windowManager?.broadcast('presence:secrets', masked);
    return masked;
  });
  ipcMain.handle('presence:list-models', async (_ev, baseUrl?: string) => {
    const [cfg, secrets] = await Promise.all([secretsStore.loadConfig(), secretsStore.loadSecrets()]);
    const targetUrl = baseUrl ?? cfg.fastBrain.baseUrl;
    const key = sameUrlOrigin(targetUrl, cfg.fastBrain.baseUrl) ? secrets.fastBrainApiKey : undefined;
    return listAvailableModels(targetUrl, key);
  });
  ipcMain.handle('presence:bridge-rpc', async (_ev, method: BridgeRpcMethod, params?: Record<string, unknown>) =>
    bridgeClient.callRpc(method, params),
  );
}

async function bootstrap(): Promise<void> {
  registerPresenceAssetProtocol();

  let cfg = await secretsStore.loadConfig();
  if (cfg.appearance.vrmFileName && !existsSync(savedVrmPath)) {
    // Prevent stale phantom VRM badge if the local avatar binary was removed
    cfg = await secretsStore.saveConfig({
      appearance: { ...cfg.appearance, vrmFileName: null },
    });
  }
  currentConfig = cfg;
  windowForms.floating = cfg.appearance.floatingForm;
  windowForms.stage = cfg.appearance.stageForm;
  windowParticleModes.floating = cfg.appearance.floatingParticleMode;
  windowParticleModes.stage = cfg.appearance.stageParticleMode;

  appState = {
    ...appState,
    form: windowForms.floating,
    particleMode: windowForms.floating === 'jarvis-core' ? true : windowParticleModes.floating,
    theme: cfg.appearance.theme,
    hologramIntensity: cfg.appearance.hologramIntensity,
    scanlineDensity: cfg.appearance.scanlineDensity,
    particleGlow: cfg.appearance.particleGlow,
    vrmFileName: cfg.appearance.vrmFileName,
    messages: [
      {
        id: 'welcome-xueer',
        role: 'assistant',
        text: cfg.persona.greeting,
        createdAt: Date.now(),
      },
    ],
  };

  registerIpcHandlers();

  bridgeClient.subscribeSnapshot((snap) => {
    const nextActivity =
      appState.activity === 'idle' && snap.tom.shouldDefer
        ? 'quiet-defer'
        : appState.activity === 'quiet-defer' && !snap.tom.shouldDefer
          ? 'idle'
          : appState.activity;
    const nextEmotion =
      appState.activity === 'idle' || appState.activity === 'quiet-defer'
        ? snap.needs.overallZone === 'critical'
          ? 'alert'
          : snap.vitals.powerMode === 'eco'
            ? 'tired'
            : snap.tom.state === 'deep_focus' || snap.tom.state === 'stuck_debugging'
              ? 'focused'
              : appState.emotion
        : appState.emotion;
    publishState({
      bridge: snap,
      activity: nextActivity,
      emotion: nextEmotion,
    });
  });

  bridgeClient.subscribeEvents((ev) => {
    windowManager?.broadcast('presence:bridge-event', ev);
  });

  bridgeClient.start();

  windowManager = new PresenceWindowManager({
    onToggleForm: () => {
      const order: AvatarForm[] = ['jarvis-core', 'chibi', 'realistic'];
      const next = order[(order.indexOf(appState.form) + 1) % order.length] ?? 'jarvis-core';
      const nextParticle = next === 'jarvis-core';
      if (appState.windowMode === 'floating' || appState.windowMode === 'stage') {
        windowForms[appState.windowMode] = next;
        windowParticleModes[appState.windowMode] = nextParticle;
      }
      publishState({ form: next, particleMode: nextParticle });
    },
    onSelectForm: (form) => {
      const nextParticle = form === 'jarvis-core';
      if (appState.windowMode === 'floating' || appState.windowMode === 'stage') {
        windowForms[appState.windowMode] = form;
        windowParticleModes[appState.windowMode] = nextParticle;
      }
      publishState({ form, particleMode: nextParticle });
    },
    onToggleParticleMode: () => {
      if (appState.form === 'jarvis-core') {
        if (appState.windowMode === 'floating' || appState.windowMode === 'stage') {
          windowForms[appState.windowMode] = 'chibi';
          windowParticleModes[appState.windowMode] = false;
        }
        publishState({ form: 'chibi', particleMode: false });
        return;
      }
      const nextParticle = !appState.particleMode;
      if (appState.windowMode === 'floating' || appState.windowMode === 'stage') {
        windowParticleModes[appState.windowMode] = nextParticle;
      }
      publishState({ particleMode: nextParticle });
    },
    onToggleKillSwitch: () => {
      const next = privacyGate.setPhysicalKillSwitch(!privacyGate.getState().physicalKillSwitch);
      if (next.physicalKillSwitch) {
        sttService.abort();
        interruptActiveTurn();
      }
      publishState({ privacy: next });
    },
    onModeChanged: (mode) => {
      const nextForm = mode === 'floating' || mode === 'stage' ? windowForms[mode] : appState.form;
      const nextParticle =
        nextForm === 'jarvis-core'
          ? true
          : mode === 'floating' || mode === 'stage'
            ? windowParticleModes[mode]
            : appState.particleMode;
      publishState({ windowMode: mode, form: nextForm, particleMode: nextParticle });
    },
    onQuit: () => {
      isQuitting = true;
      app.quit();
    },
  });

  windowManager.initialize();
}

app.whenReady().then(() => {
  void bootstrap();
});

app.on('before-quit', () => {
  isQuitting = true;
  sttService.abort();
  interruptActiveTurn();
  windowManager?.dispose();
  void bridgeClient.stop();
});

app.on('window-all-closed', () => {
  if (isQuitting || process.platform !== 'darwin') {
    app.quit();
  }
});
