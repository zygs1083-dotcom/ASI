import type { PresenceEmotion, VisualTheme } from '@asi/presence-protocol';
import * as THREE from 'three';

export interface ThemePalette {
  id: VisualTheme;
  label: string;
  primaryHex: string;
  secondaryHex: string;
  accentHex: string;
  warmHex: string;
  hudBorder: string;
  hudGlow: string;
}

export const THEME_PALETTES: Record<VisualTheme, ThemePalette> = {
  'snow-cyan': {
    id: 'snow-cyan',
    label: '雪白冰青 · 雪儿',
    primaryHex: '#f4fbff',
    secondaryHex: '#5ce1ff',
    accentHex: '#38bdf8',
    warmHex: '#fde68a',
    hudBorder: 'rgba(125, 227, 255, 0.34)',
    hudGlow: 'rgba(92, 225, 255, 0.28)',
  },
  'jarvis-amber': {
    id: 'jarvis-amber',
    label: '琥珀金 · J.A.R.V.I.S.',
    primaryHex: '#fff7ed',
    secondaryHex: '#fbbf24',
    accentHex: '#f59e0b',
    warmHex: '#fde047',
    hudBorder: 'rgba(251, 191, 36, 0.38)',
    hudGlow: 'rgba(245, 158, 11, 0.28)',
  },
  'neon-violet': {
    id: 'neon-violet',
    label: '霓虹星紫 · Cyber',
    primaryHex: '#f5f3ff',
    secondaryHex: '#c084fc',
    accentHex: '#818cf8',
    warmHex: '#38bdf8',
    hudBorder: 'rgba(192, 132, 252, 0.38)',
    hudGlow: 'rgba(129, 140, 248, 0.3)',
  },
};

export interface EmotionModulation {
  tintHex: string;
  tintMix: number;
  breatheSpeed: number;
  earPerkTarget: number;
  smileAmount: number;
  ringSpeed: number;
}

export const EMOTION_MODULATIONS: Record<PresenceEmotion, EmotionModulation> = {
  calm: {
    tintHex: '#7dd3fc',
    tintMix: 0.08,
    breatheSpeed: 1.0,
    earPerkTarget: 0.56,
    smileAmount: 0.28,
    ringSpeed: 0.55,
  },
  focused: {
    tintHex: '#38bdf8',
    tintMix: 0.22,
    breatheSpeed: 0.78,
    earPerkTarget: 0.68,
    smileAmount: 0.08,
    ringSpeed: 0.95,
  },
  joyful: {
    tintHex: '#fde68a',
    tintMix: 0.26,
    breatheSpeed: 1.32,
    earPerkTarget: 0.95,
    smileAmount: 0.9,
    ringSpeed: 1.15,
  },
  affectionate: {
    tintHex: '#fef08a',
    tintMix: 0.22,
    breatheSpeed: 1.12,
    earPerkTarget: 0.88,
    smileAmount: 0.78,
    ringSpeed: 0.75,
  },
  thinking: {
    tintHex: '#a5b4fc',
    tintMix: 0.24,
    breatheSpeed: 0.9,
    earPerkTarget: 0.74,
    smileAmount: 0.12,
    ringSpeed: 1.35,
  },
  alert: {
    tintHex: '#fb7185',
    tintMix: 0.42,
    breatheSpeed: 1.55,
    earPerkTarget: 1.0,
    smileAmount: 0.0,
    ringSpeed: 1.65,
  },
  tired: {
    tintHex: '#94a3b8',
    tintMix: 0.32,
    breatheSpeed: 0.58,
    earPerkTarget: 0.2,
    smileAmount: 0.14,
    ringSpeed: 0.32,
  },
};

export function resolveThemeColors(
  theme: VisualTheme,
  emotion: PresenceEmotion,
): { primary: THREE.Color; secondary: THREE.Color; accent: THREE.Color } {
  const pal = THEME_PALETTES[theme];
  const mod = EMOTION_MODULATIONS[emotion];
  const tint = new THREE.Color(mod.tintHex);

  const primary = new THREE.Color(pal.primaryHex).lerp(tint, mod.tintMix * 0.35);
  const secondary = new THREE.Color(pal.secondaryHex).lerp(tint, mod.tintMix);
  const accent = new THREE.Color(pal.accentHex).lerp(tint, mod.tintMix * 0.8);

  return { primary, secondary, accent };
}
