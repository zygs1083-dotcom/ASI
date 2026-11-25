import type { MaskedSecretsSummary, ModelCatalogEntry, PresenceConfig, PresenceSecrets } from '@asi/omni-router';
import type {
  AvatarForm,
  BridgeMemoryItem,
  BridgeRpcMethod,
  BridgeSnapshot,
  ConversationMessage,
  DelegationProposal,
  PresenceActivity,
  PresenceEmotion,
  PrivacyState,
  SttProviderKind,
  SystemOneDecision,
  VisualTheme,
  WindowMode,
} from '@asi/presence-protocol';

export interface PresenceAppState {
  windowMode: WindowMode;
  form: AvatarForm;
  theme: VisualTheme;
  emotion: PresenceEmotion;
  activity: PresenceActivity;
  hologramIntensity: number;
  scanlineDensity: number;
  particleGlow: number;
  vrmFileName: string | null;
  privacy: PrivacyState;
  bridge: BridgeSnapshot;
  lastDecision: SystemOneDecision | null;
  messages: ConversationMessage[];
}

export interface TtsSynthesizeResult {
  ok: boolean;
  mimeType?: string;
  audioBase64?: string;
  providerUsed: 'edge-tts' | 'openai-compatible' | 'macos-say' | 'browser-speech';
  fallbackText?: string;
  error?: string;
}

export interface SttTranscribeResult {
  ok: boolean;
  text: string;
  providerUsed: SttProviderKind;
  errorCode?: string;
  error?: string;
}

export interface SttTranscribeOptions {
  fallbackFromWebSpeech?: boolean;
}

export interface ChatTurnStreamEvent {
  turnId: string;
  kind: 'decision' | 'memories' | 'token' | 'sentence' | 'delegation_proposal' | 'done' | 'error' | 'aborted';
  decision?: SystemOneDecision;
  memories?: BridgeMemoryItem[];
  delta?: string;
  accumulated?: string;
  sentenceIndex?: number;
  sentenceText?: string;
  speechText?: string;
  delegationProposal?: DelegationProposal;
  fullText?: string;
  error?: string;
}

export interface BridgePushEvent {
  kind: string;
  at: number;
  payload: Record<string, unknown>;
}

export interface AsiPresenceBridgeApi {
  readonly windowRole: 'floating' | 'stage';
  getInitialState(): Promise<{
    state: PresenceAppState;
    config: PresenceConfig;
    secrets: MaskedSecretsSummary;
  }>;
  sendMessage(text: string): Promise<{ turnId: string }>;
  interruptTurn(): Promise<void>;
  clearConversation(): Promise<void>;
  synthesizeSpeech(input: { text: string; utteranceId: string }): Promise<TtsSynthesizeResult>;
  abortSpeech(utteranceId?: string): Promise<void>;
  transcribeAudio(wavBase64: string, options?: SttTranscribeOptions): Promise<SttTranscribeResult>;
  setAvatarForm(form: AvatarForm): Promise<void>;
  toggleAvatarForm(): Promise<AvatarForm>;
  setTheme(theme: VisualTheme): Promise<void>;
  updateVisualSettings(patch: {
    hologramIntensity?: number;
    scanlineDensity?: number;
    particleGlow?: number;
    vrmFileName?: string | null;
  }): Promise<void>;
  saveVrmFile(buffer: ArrayBuffer, fileName: string): Promise<{ ok: boolean; fileName: string; error?: string }>;
  loadSavedVrm(): Promise<{ fileName: string; bytes: Uint8Array } | null>;
  clearVrmFile(): Promise<void>;
  setWindowMode(mode: WindowMode): Promise<void>;
  setIgnoreMouseEvents(ignore: boolean): void;
  dragFloatingWindow(deltaX: number, deltaY: number): void;
  updatePrivacy(
    patch: Partial<Pick<PrivacyState, 'microphoneEnabled' | 'screenVisionEnabled' | 'cameraEnabled'>>,
  ): Promise<PrivacyState>;
  setPhysicalKillSwitch(active: boolean): Promise<PrivacyState>;
  saveConfig(patch: Partial<PresenceConfig>): Promise<PresenceConfig>;
  saveSecrets(patch: Partial<Record<keyof PresenceSecrets, string | null>>): Promise<MaskedSecretsSummary>;
  listModels(baseUrl?: string): Promise<ModelCatalogEntry[]>;
  bridgeRpc<T = unknown>(method: BridgeRpcMethod, params?: Record<string, unknown>): Promise<T>;
  onStateChanged(listener: (state: PresenceAppState) => void): () => void;
  onConfigChanged(listener: (config: PresenceConfig) => void): () => void;
  onSecretsChanged(listener: (secrets: MaskedSecretsSummary) => void): () => void;
  onVrmUpdated(listener: (info: { fileName: string | null }) => void): () => void;
  onChatEvent(listener: (event: ChatTurnStreamEvent) => void): () => void;
  onBridgeEvent(listener: (event: BridgePushEvent) => void): () => void;
  onInterruptAudio(listener: () => void): () => void;
}
