import type { MaskedSecretsSummary, PresenceConfig } from '@asi/omni-router';
import { contextBridge, ipcRenderer } from 'electron';
import type {
  AsiPresenceBridgeApi,
  BridgePushEvent,
  ChatTurnStreamEvent,
  PresenceAppState,
} from '../shared/ipc-api.ts';

const roleArg = process.argv.find((arg) => arg.startsWith('--asi-window-role='));
const windowRole: 'floating' | 'stage' = roleArg === '--asi-window-role=stage' ? 'stage' : 'floating';

const api: AsiPresenceBridgeApi = {
  windowRole,
  getInitialState: () => ipcRenderer.invoke('presence:get-initial'),
  sendMessage: (text) => ipcRenderer.invoke('presence:send-message', text),
  interruptTurn: () => ipcRenderer.invoke('presence:interrupt-turn'),
  clearConversation: () => ipcRenderer.invoke('presence:clear-conversation'),
  synthesizeSpeech: (input) => ipcRenderer.invoke('presence:tts-synthesize', input),
  abortSpeech: (utteranceId) => ipcRenderer.invoke('presence:tts-abort', utteranceId),
  transcribeAudio: (wavBase64, options) => ipcRenderer.invoke('presence:stt-transcribe', wavBase64, options),
  setAvatarForm: (form) => ipcRenderer.invoke('presence:set-form', form),
  toggleAvatarForm: () => ipcRenderer.invoke('presence:toggle-form'),
  setTheme: (theme) => ipcRenderer.invoke('presence:set-theme', theme),
  updateVisualSettings: (patch) => ipcRenderer.invoke('presence:update-visual', patch),
  saveVrmFile: (buffer, fileName) =>
    ipcRenderer.invoke('presence:save-vrm', { bytes: new Uint8Array(buffer), fileName }),
  loadSavedVrm: () => ipcRenderer.invoke('presence:load-vrm'),
  clearVrmFile: () => ipcRenderer.invoke('presence:clear-vrm'),
  setWindowMode: (mode) => ipcRenderer.invoke('presence:set-window-mode', mode),
  setIgnoreMouseEvents: (ignore) => ipcRenderer.send('presence:set-ignore-mouse', ignore),
  dragFloatingWindow: (deltaX, deltaY) => ipcRenderer.send('presence:drag-floating', { deltaX, deltaY }),
  updatePrivacy: (patch) => ipcRenderer.invoke('presence:update-privacy', patch),
  setPhysicalKillSwitch: (active) => ipcRenderer.invoke('presence:set-kill-switch', active),
  saveConfig: (patch) => ipcRenderer.invoke('presence:save-config', patch),
  saveSecrets: (patch) => ipcRenderer.invoke('presence:save-secrets', patch),
  listModels: (baseUrl) => ipcRenderer.invoke('presence:list-models', baseUrl),
  bridgeRpc: (method, params) => ipcRenderer.invoke('presence:bridge-rpc', method, params),
  onStateChanged: (listener) => {
    const handler = (_ev: Electron.IpcRendererEvent, state: PresenceAppState) => listener(state);
    ipcRenderer.on('presence:state', handler);
    return () => ipcRenderer.removeListener('presence:state', handler);
  },
  onConfigChanged: (listener) => {
    const handler = (_ev: Electron.IpcRendererEvent, cfg: PresenceConfig) => listener(cfg);
    ipcRenderer.on('presence:config', handler);
    return () => ipcRenderer.removeListener('presence:config', handler);
  },
  onSecretsChanged: (listener) => {
    const handler = (_ev: Electron.IpcRendererEvent, sec: MaskedSecretsSummary) => listener(sec);
    ipcRenderer.on('presence:secrets', handler);
    return () => ipcRenderer.removeListener('presence:secrets', handler);
  },
  onVrmUpdated: (listener) => {
    const handler = (_ev: Electron.IpcRendererEvent, info: { fileName: string | null }) => listener(info);
    ipcRenderer.on('presence:vrm-updated', handler);
    return () => ipcRenderer.removeListener('presence:vrm-updated', handler);
  },
  onChatEvent: (listener) => {
    const handler = (_ev: Electron.IpcRendererEvent, event: ChatTurnStreamEvent) => listener(event);
    ipcRenderer.on('presence:chat-event', handler);
    return () => ipcRenderer.removeListener('presence:chat-event', handler);
  },
  onBridgeEvent: (listener) => {
    const handler = (_ev: Electron.IpcRendererEvent, event: BridgePushEvent) => listener(event);
    ipcRenderer.on('presence:bridge-event', handler);
    return () => ipcRenderer.removeListener('presence:bridge-event', handler);
  },
  onInterruptAudio: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('presence:interrupt-audio', handler);
    return () => ipcRenderer.removeListener('presence:interrupt-audio', handler);
  },
};

contextBridge.exposeInMainWorld('asiPresence', api);
