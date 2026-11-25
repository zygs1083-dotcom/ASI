export {
  createDefaultPresenceConfig,
  getDefaultSttProvider,
  type LlmProviderKind,
  LlmProviderKindSchema,
  type MaskedSecretsSummary,
  maskSecret,
  type PresenceConfig,
  PresenceConfigSchema,
  type PresenceSecrets,
  PresenceSecretsSchema,
  PresenceSecretsStore,
  type SecretsStoreOptions,
  STT_PROVIDERS,
  type SttProviderKind,
  SttProviderKindSchema,
  type TtsProviderKind,
  TtsProviderKindSchema,
} from './config.ts';
export {
  type ChatMessage,
  chatWithImage,
  type LlmStreamChunk,
  listAvailableModels,
  type ModelCatalogEntry,
  type StreamChatParams,
  sameUrlOrigin,
  streamLlmChat,
  type VisionChatParams,
} from './llm-client.ts';
export {
  type CompanionBridgeAdapter,
  type CompanionTurnEvent,
  type CompanionTurnInput,
  OmniCompanionOrchestrator,
  type OrchestratorDeps,
} from './orchestrator.ts';
export { buildXueerSystemPrompt, type PersonaContext } from './persona.ts';
export {
  type SentenceChunkerOptions,
  SentenceStreamChunker,
  sanitizeForSpeech,
} from './sentence-chunker.ts';
export {
  callMagpieCalibrationFallback,
  callTypesafeJev,
  evaluateSystemOne,
  heuristicEvaluateSystemOne,
  type SystemOneEvalOptions,
  type SystemOneInput,
} from './system-one.ts';
