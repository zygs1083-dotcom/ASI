import { z } from 'zod';

export const PRESENCE_EMOTIONS = ['calm', 'focused', 'joyful', 'alert', 'tired', 'thinking', 'affectionate'] as const;

export const PresenceEmotionSchema = z.enum(PRESENCE_EMOTIONS);
export type PresenceEmotion = z.infer<typeof PresenceEmotionSchema>;

export const AVATAR_FORMS = ['jarvis-core', 'chibi', 'realistic'] as const;
export const AvatarFormSchema = z.enum(AVATAR_FORMS);
export type AvatarForm = z.infer<typeof AvatarFormSchema>;

export function normalizeAvatarForm(raw: unknown, fallback: AvatarForm = 'jarvis-core'): AvatarForm {
  if (raw === 'jarvis-core' || raw === 'chibi' || raw === 'realistic') return raw;
  if (raw === 'particle-face') return 'jarvis-core';
  if (raw === 'humanoid-3d') return 'chibi';
  return fallback;
}

export const VISUAL_THEMES = ['snow-cyan', 'jarvis-amber', 'neon-violet'] as const;
export const VisualThemeSchema = z.enum(VISUAL_THEMES);
export type VisualTheme = z.infer<typeof VisualThemeSchema>;

export const WINDOW_MODES = ['floating', 'stage', 'hidden'] as const;
export const WindowModeSchema = z.enum(WINDOW_MODES);
export type WindowMode = z.infer<typeof WindowModeSchema>;

export const PRESENCE_ACTIVITIES = ['idle', 'listening', 'thinking', 'speaking', 'delegating', 'quiet-defer'] as const;
export const PresenceActivitySchema = z.enum(PRESENCE_ACTIVITIES);
export type PresenceActivity = z.infer<typeof PresenceActivitySchema>;

export const STT_PROVIDERS = ['macos-speech', 'web-speech', 'whisper-http', 'off'] as const;
export const SttProviderKindSchema = z.enum(STT_PROVIDERS);
export type SttProviderKind = z.infer<typeof SttProviderKindSchema>;

/** TalkingHead / Oculus / VRM-compatible 15-viseme alphabet. */
export const VISEME_NAMES = [
  'sil',
  'PP',
  'FF',
  'TH',
  'DD',
  'kk',
  'CH',
  'SS',
  'nn',
  'RR',
  'aa',
  'E',
  'I',
  'O',
  'U',
] as const;
export const VisemeNameSchema = z.enum(VISEME_NAMES);
export type VisemeName = z.infer<typeof VisemeNameSchema>;

/** Five canonical VRM vowel expression blendshapes. */
export const VrmVowelWeightsSchema = z.object({
  aa: z.number().min(0).max(1),
  ih: z.number().min(0).max(1),
  ou: z.number().min(0).max(1),
  ee: z.number().min(0).max(1),
  oh: z.number().min(0).max(1),
});
export type VrmVowelWeights = z.infer<typeof VrmVowelWeightsSchema>;

export const VisemeFrameSchema = z.object({
  viseme: VisemeNameSchema,
  vowels: VrmVowelWeightsSchema,
  rms: z.number().min(0).max(1),
  lowBand: z.number().min(0).max(1),
  midBand: z.number().min(0).max(1),
  highBand: z.number().min(0).max(1),
  speaking: z.boolean(),
  timestamp: z.number().nonnegative(),
});
export type VisemeFrame = z.infer<typeof VisemeFrameSchema>;

export const AvatarPoseSchema = z.object({
  headYaw: z.number().min(-1).max(1),
  headPitch: z.number().min(-1).max(1),
  headRoll: z.number().min(-1).max(1),
  eyeGazeX: z.number().min(-1).max(1),
  eyeGazeY: z.number().min(-1).max(1),
  blinkLeft: z.number().min(0).max(1),
  blinkRight: z.number().min(0).max(1),
  /** Snow-white holographic puppy-ear perk angle in [0, 1] (0.5 neutral, 1 alert/happy, 0.15 tired/quiet). */
  earPerk: z.number().min(0).max(1),
  breathePhase: z.number(),
});
export type AvatarPose = z.infer<typeof AvatarPoseSchema>;

export const HologramSettingsSchema = z.object({
  theme: VisualThemeSchema.default('snow-cyan'),
  hologramIntensity: z.number().min(0).max(1).default(0.72),
  scanlineDensity: z.number().min(0).max(1).default(0.48),
  particleGlow: z.number().min(0.2).max(1.5).default(1.0),
  vrmFileName: z.string().nullable().default(null),
});
export type HologramSettings = z.infer<typeof HologramSettingsSchema>;

export function createSilentVisemeFrame(timestamp = Date.now()): VisemeFrame {
  return {
    viseme: 'sil',
    vowels: { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 },
    rms: 0,
    lowBand: 0,
    midBand: 0,
    highBand: 0,
    speaking: false,
    timestamp,
  };
}
