import {
  type AvatarForm,
  AvatarFormSchema,
  DEFAULT_CALIBRATION_MODEL,
  DEFAULT_COMPANION_NAME,
  DEFAULT_EDGE_TTS_VOICE,
  DEFAULT_FAST_BRAIN_MODEL,
  DEFAULT_JEV_MODEL,
  DEFAULT_MAGPIE_BASE_URL,
  DEFAULT_SLOW_BRAIN_MODEL,
  DEFAULT_STT_LOCALE,
  DEFAULT_TYPESAFE_BASE_URL,
  DEFAULT_VISION_MODEL,
  normalizeAvatarForm,
  STT_PROVIDERS,
  type SttProviderKind,
  SttProviderKindSchema,
  VisualThemeSchema,
} from '@asi/presence-protocol';
import { z } from 'zod';

const compatAvatarForm = (fallback: AvatarForm) =>
  z.preprocess((val) => (val === undefined ? undefined : normalizeAvatarForm(val, fallback)), AvatarFormSchema);

export { STT_PROVIDERS, type SttProviderKind, SttProviderKindSchema };

export const LlmProviderKindSchema = z.enum(['openai-compatible', 'anthropic-compatible', 'gemini-compatible']);
export type LlmProviderKind = z.infer<typeof LlmProviderKindSchema>;

export const TtsProviderKindSchema = z.enum(['edge-tts', 'macos-say', 'openai-compatible', 'browser-speech']);
export type TtsProviderKind = z.infer<typeof TtsProviderKindSchema>;

export function getDefaultSttProvider(platform?: string): SttProviderKind {
  const resolved =
    platform ??
    (typeof process !== 'undefined' && typeof process.platform === 'string'
      ? process.platform
      : typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent)
        ? 'darwin'
        : 'other');
  return resolved === 'darwin' ? 'macos-speech' : 'web-speech';
}

export const PresenceConfigSchema = z.object({
  persona: z
    .object({
      name: z.string().min(1).max(32).default(DEFAULT_COMPANION_NAME),
      customPrompt: z.string().max(4000).default(''),
      greeting: z.string().max(240).default('我一直在呢，今天想先忙点什么，还是先聊两句？'),
    })
    .default({
      name: DEFAULT_COMPANION_NAME,
      customPrompt: '',
      greeting: '我一直在呢，今天想先忙点什么，还是先聊两句？',
    }),
  appearance: z
    .object({
      theme: VisualThemeSchema.default('snow-cyan'),
      floatingForm: compatAvatarForm('jarvis-core').default('jarvis-core'),
      stageForm: compatAvatarForm('chibi').default('chibi'),
      floatingParticleMode: z.boolean().default(true),
      stageParticleMode: z.boolean().default(false),
      hologramIntensity: z.number().min(0).max(1).default(0.72),
      scanlineDensity: z.number().min(0).max(1).default(0.48),
      particleGlow: z.number().min(0.2).max(1.5).default(1.0),
      vrmFileName: z.string().nullable().default(null),
    })
    .default({
      theme: 'snow-cyan',
      floatingForm: 'jarvis-core',
      stageForm: 'chibi',
      floatingParticleMode: true,
      stageParticleMode: false,
      hologramIntensity: 0.72,
      scanlineDensity: 0.48,
      particleGlow: 1.0,
      vrmFileName: null,
    }),
  systemOne: z
    .object({
      enabled: z.boolean().default(true),
      preferTypesafeJev: z.boolean().default(true),
      typesafeBaseUrl: z.string().url().default(DEFAULT_TYPESAFE_BASE_URL),
      jevModel: z.string().min(1).default(DEFAULT_JEV_MODEL),
      timeoutMs: z.number().int().min(400).max(15_000).default(3500),
      fallbackToMagpie: z.boolean().default(true),
      fallbackBaseUrl: z.string().url().default(DEFAULT_MAGPIE_BASE_URL),
      fallbackModel: z.string().min(1).default(DEFAULT_CALIBRATION_MODEL),
    })
    .default({
      enabled: true,
      preferTypesafeJev: true,
      typesafeBaseUrl: DEFAULT_TYPESAFE_BASE_URL,
      jevModel: DEFAULT_JEV_MODEL,
      timeoutMs: 3500,
      fallbackToMagpie: true,
      fallbackBaseUrl: DEFAULT_MAGPIE_BASE_URL,
      fallbackModel: DEFAULT_CALIBRATION_MODEL,
    }),
  fastBrain: z
    .object({
      provider: LlmProviderKindSchema.default('openai-compatible'),
      baseUrl: z.string().url().default(DEFAULT_MAGPIE_BASE_URL),
      model: z.string().min(1).default(DEFAULT_FAST_BRAIN_MODEL),
      temperature: z.number().min(0).max(2).default(0.7),
      maxTokens: z.number().int().min(64).max(8192).default(768),
    })
    .default({
      provider: 'openai-compatible',
      baseUrl: DEFAULT_MAGPIE_BASE_URL,
      model: DEFAULT_FAST_BRAIN_MODEL,
      temperature: 0.7,
      maxTokens: 768,
    }),
  visionBrain: z
    .object({
      provider: LlmProviderKindSchema.default('openai-compatible'),
      baseUrl: z.string().url().default(DEFAULT_MAGPIE_BASE_URL),
      model: z.string().min(1).default(DEFAULT_VISION_MODEL),
      maxTokens: z.number().int().min(64).max(4096).default(512),
    })
    .default({
      provider: 'openai-compatible',
      baseUrl: DEFAULT_MAGPIE_BASE_URL,
      model: DEFAULT_VISION_MODEL,
      maxTokens: 512,
    }),
  slowBrain: z
    .object({
      model: z.string().min(1).default(DEFAULT_SLOW_BRAIN_MODEL),
      requireConfirmation: z.boolean().default(true),
    })
    .default({
      model: DEFAULT_SLOW_BRAIN_MODEL,
      requireConfirmation: true,
    }),
  voice: z
    .object({
      ttsProvider: TtsProviderKindSchema.default('edge-tts'),
      edgeVoice: z.string().min(1).default(DEFAULT_EDGE_TTS_VOICE),
      ttsRate: z.string().default('+4%'),
      ttsPitch: z.string().default('+2Hz'),
      customTtsBaseUrl: z.string().url().default(DEFAULT_MAGPIE_BASE_URL),
      customTtsModel: z.string().default('tts-1'),
      customTtsVoice: z.string().default('alloy'),
      sttProvider: SttProviderKindSchema.default(() => getDefaultSttProvider()),
      sttLocale: z.string().min(2).max(16).default(DEFAULT_STT_LOCALE),
      whisperBaseUrl: z.string().url().default('http://127.0.0.1:8178/v1'),
      vadSensitivity: z.number().min(0.1).max(0.95).default(0.62),
      bargeInEnabled: z.boolean().default(true),
      echoGuardEnabled: z.boolean().default(true),
      echoGuardStrength: z.number().min(0.1).max(0.95).default(0.65),
      autoSpeak: z.boolean().default(true),
    })
    .default(() => ({
      ttsProvider: 'edge-tts' as const,
      edgeVoice: DEFAULT_EDGE_TTS_VOICE,
      ttsRate: '+4%',
      ttsPitch: '+2Hz',
      customTtsBaseUrl: DEFAULT_MAGPIE_BASE_URL,
      customTtsModel: 'tts-1',
      customTtsVoice: 'alloy',
      sttProvider: getDefaultSttProvider(),
      sttLocale: DEFAULT_STT_LOCALE,
      whisperBaseUrl: 'http://127.0.0.1:8178/v1',
      vadSensitivity: 0.62,
      bargeInEnabled: true,
      echoGuardEnabled: true,
      echoGuardStrength: 0.65,
      autoSpeak: true,
    })),
});

export type PresenceConfig = z.infer<typeof PresenceConfigSchema>;

export const PresenceSecretsSchema = z.object({
  typesafeApiKey: z.string().optional(),
  fastBrainApiKey: z.string().optional(),
  visionBrainApiKey: z.string().optional(),
  customTtsApiKey: z.string().optional(),
  whisperApiKey: z.string().optional(),
});
export type PresenceSecrets = z.infer<typeof PresenceSecretsSchema>;

export interface MaskedSecretsSummary {
  hasTypesafeApiKey: boolean;
  typesafeApiKeyHint: string | null;
  hasFastBrainApiKey: boolean;
  fastBrainApiKeyHint: string | null;
  hasVisionBrainApiKey: boolean;
  hasCustomTtsApiKey: boolean;
  hasWhisperApiKey: boolean;
}

export function createDefaultPresenceConfig(platform?: string): PresenceConfig {
  const base = PresenceConfigSchema.parse({});
  if (platform !== undefined) {
    return {
      ...base,
      voice: {
        ...base.voice,
        sttProvider: getDefaultSttProvider(platform),
      },
    };
  }
  return base;
}

export function maskSecret(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 6) return '••••';
  return `••••${trimmed.slice(-4)}`;
}
