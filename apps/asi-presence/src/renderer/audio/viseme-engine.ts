import {
  createSilentVisemeFrame,
  type VisemeFrame,
  type VisemeName,
  type VrmVowelWeights,
} from '@asi/presence-protocol';

export interface TimedVisemeCue {
  viseme: VisemeName;
  startMs: number;
  endMs: number;
}

const VISEME_TO_VOWELS: Record<VisemeName, VrmVowelWeights> = {
  sil: { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 },
  PP: { aa: 0.05, ih: 0, ou: 0.1, ee: 0, oh: 0 },
  FF: { aa: 0.08, ih: 0.2, ou: 0, ee: 0.18, oh: 0 },
  TH: { aa: 0.15, ih: 0.25, ou: 0, ee: 0.2, oh: 0 },
  DD: { aa: 0.22, ih: 0.18, ou: 0, ee: 0.16, oh: 0 },
  kk: { aa: 0.28, ih: 0.1, ou: 0.15, ee: 0.1, oh: 0.15 },
  CH: { aa: 0.15, ih: 0.28, ou: 0.3, ee: 0.12, oh: 0.12 },
  SS: { aa: 0.08, ih: 0.35, ou: 0, ee: 0.32, oh: 0 },
  nn: { aa: 0.18, ih: 0.15, ou: 0.08, ee: 0.12, oh: 0.1 },
  RR: { aa: 0.2, ih: 0.1, ou: 0.35, ee: 0, oh: 0.25 },
  aa: { aa: 0.92, ih: 0.05, ou: 0.05, ee: 0.05, oh: 0.15 },
  E: { aa: 0.22, ih: 0.25, ou: 0, ee: 0.85, oh: 0 },
  I: { aa: 0.08, ih: 0.88, ou: 0, ee: 0.35, oh: 0 },
  O: { aa: 0.25, ih: 0, ou: 0.35, ee: 0, oh: 0.9 },
  U: { aa: 0.05, ih: 0, ou: 0.9, ee: 0, oh: 0.25 },
};

const CJK_VOWEL_CYCLE: readonly VisemeName[] = ['aa', 'O', 'I', 'E', 'U', 'nn', 'aa', 'CH', 'O', 'I'];

function charToViseme(ch: string, index: number): VisemeName {
  if (/[\s，,。！？!?；;：:、\-—()（）「」"']/.test(ch)) {
    return 'sil';
  }
  // CJK ideographs: rhythmic syllabic alternation modulated by codepoint for organic lip-sync
  if (/[\u4e00-\u9fff]/.test(ch)) {
    const code = ch.charCodeAt(0);
    return CJK_VOWEL_CYCLE[(code + index) % CJK_VOWEL_CYCLE.length] ?? 'aa';
  }
  const lower = ch.toLowerCase();
  if (lower === 'a') return 'aa';
  if (lower === 'e') return 'E';
  if (lower === 'i' || lower === 'y') return 'I';
  if (lower === 'o') return 'O';
  if (lower === 'u' || lower === 'w') return 'U';
  if (lower === 'p' || lower === 'b' || lower === 'm') return 'PP';
  if (lower === 'f' || lower === 'v') return 'FF';
  if (lower === 's' || lower === 'z' || lower === 'c' || lower === 'x') return 'SS';
  if (lower === 't' || lower === 'd') return 'DD';
  if (lower === 'k' || lower === 'g' || lower === 'q') return 'kk';
  if (lower === 'n' || lower === 'l') return 'nn';
  if (lower === 'r') return 'RR';
  if (lower === 'j' || lower === 'h') return 'CH';
  return 'aa';
}

/**
 * Generates a TalkingHead-compatible timed viseme sequence from Chinese/English text.
 */
export function textToVisemeTimeline(text: string, estimatedDurationMs?: number): TimedVisemeCue[] {
  const chars = [...text.trim()];
  if (chars.length === 0) return [];
  const totalMs = estimatedDurationMs ?? Math.max(450, chars.length * 145);
  const stepMs = totalMs / chars.length;

  const cues: TimedVisemeCue[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? '';
    const viseme = charToViseme(ch, i);
    cues.push({
      viseme,
      startMs: Math.round(i * stepMs),
      endMs: Math.round((i + 1) * stepMs),
    });
  }
  return cues;
}

export function visemeToVowels(viseme: VisemeName): VrmVowelWeights {
  const base = VISEME_TO_VOWELS[viseme];
  return { ...base };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Computes real-time formant-weighted TalkingHead viseme & VRM vowel weights
 * from a WebAudio `AnalyserNode.getByteFrequencyData` snapshot.
 */
export function analyzeSpectrumToViseme(
  bins: Uint8Array,
  sampleRate = 48000,
  fftSize = 1024,
  timestamp = Date.now(),
): VisemeFrame {
  if (bins.length === 0) {
    return createSilentVisemeFrame(timestamp);
  }
  const binHz = sampleRate / fftSize;

  const bandEnergy = (minHz: number, maxHz: number): number => {
    const start = Math.max(0, Math.floor(minHz / binHz));
    const end = Math.min(bins.length - 1, Math.ceil(maxHz / binHz));
    if (end < start) return 0;
    let sum = 0;
    for (let i = start; i <= end; i += 1) {
      sum += (bins[i] ?? 0) / 255;
    }
    return clamp01(sum / (end - start + 1));
  };

  // Speech formant bands: F0/low (100-420Hz), F1 (420-1100Hz), F2 (1100-2600Hz), sibilants (2600-5200Hz)
  const lowBand = bandEnergy(100, 420);
  const f1Band = bandEnergy(420, 1100);
  const midBand = bandEnergy(420, 2200);
  const f2Band = bandEnergy(1100, 2600);
  const highBand = bandEnergy(2400, 5200);

  const rms = clamp01(lowBand * 0.28 + f1Band * 0.36 + f2Band * 0.24 + highBand * 0.12);
  const speaking = rms > 0.045;

  if (!speaking) {
    return createSilentVisemeFrame(timestamp);
  }

  // Formant ratio heuristic approximating TalkingHead / Oculus lip shapes
  const aa = clamp01(f1Band * 1.45 - highBand * 0.3);
  const oh = clamp01(lowBand * 1.1 + f1Band * 0.45 - f2Band * 0.35);
  const ou = clamp01(lowBand * 1.35 - midBand * 0.45);
  const ee = clamp01(f2Band * 1.35 - lowBand * 0.25);
  const ih = clamp01(f2Band * 0.85 + highBand * 0.65 - lowBand * 0.3);

  let viseme: VisemeName = 'aa';
  if (highBand > 0.34 && highBand > f1Band) {
    viseme = 'SS';
  } else if (aa >= oh && aa >= ou && aa >= ee && aa >= ih) {
    viseme = 'aa';
  } else if (oh >= ou && oh >= ee && oh >= ih) {
    viseme = 'O';
  } else if (ou >= ee && ou >= ih) {
    viseme = 'U';
  } else if (ee >= ih) {
    viseme = 'E';
  } else {
    viseme = 'I';
  }

  return {
    viseme,
    vowels: { aa, ih, ou, ee, oh },
    rms,
    lowBand,
    midBand,
    highBand,
    speaking: true,
    timestamp,
  };
}

/**
 * Smooth 60fps coarticulated viseme interpolator fusing WebAudio spectrum
 * and timed text-viseme fallback cues.
 */
export class VisemeSyncController {
  private current: VisemeFrame = createSilentVisemeFrame();
  private timeline: TimedVisemeCue[] = [];
  private timelineStartMs = 0;

  setTextFallbackTimeline(text: string, durationMs?: number, nowMs = performance.now()): void {
    this.timeline = textToVisemeTimeline(text, durationMs);
    this.timelineStartMs = nowMs;
  }

  clearTimeline(): void {
    this.timeline = [];
  }

  reset(): VisemeFrame {
    this.timeline = [];
    this.current = createSilentVisemeFrame();
    return this.current;
  }

  step(target: VisemeFrame, alpha = 0.34): VisemeFrame {
    const smooth = (prev: number, next: number) => prev + (next - prev) * alpha;
    this.current = {
      viseme: target.viseme,
      vowels: {
        aa: clamp01(smooth(this.current.vowels.aa, target.vowels.aa)),
        ih: clamp01(smooth(this.current.vowels.ih, target.vowels.ih)),
        ou: clamp01(smooth(this.current.vowels.ou, target.vowels.ou)),
        ee: clamp01(smooth(this.current.vowels.ee, target.vowels.ee)),
        oh: clamp01(smooth(this.current.vowels.oh, target.vowels.oh)),
      },
      rms: clamp01(smooth(this.current.rms, target.rms)),
      lowBand: clamp01(smooth(this.current.lowBand, target.lowBand)),
      midBand: clamp01(smooth(this.current.midBand, target.midBand)),
      highBand: clamp01(smooth(this.current.highBand, target.highBand)),
      speaking: target.speaking || this.current.rms > 0.03,
      timestamp: target.timestamp,
    };
    return this.current;
  }

  sampleTextTimeline(nowMs = performance.now()): VisemeFrame {
    if (this.timeline.length === 0) {
      return this.step(createSilentVisemeFrame(nowMs), 0.25);
    }
    const elapsed = nowMs - this.timelineStartMs;
    const cue = this.timeline.find((c) => elapsed >= c.startMs && elapsed < c.endMs);
    if (!cue) {
      const last = this.timeline[this.timeline.length - 1];
      if (last && elapsed >= last.endMs) {
        this.timeline = [];
      }
      return this.step(createSilentVisemeFrame(nowMs), 0.25);
    }
    const vowels = visemeToVowels(cue.viseme);
    const active = cue.viseme !== 'sil';
    const synthRms = active ? 0.38 + Math.sin(elapsed * 0.025) * 0.12 : 0;
    return this.step(
      {
        viseme: cue.viseme,
        vowels,
        rms: clamp01(synthRms),
        lowBand: clamp01(vowels.oh * 0.5 + vowels.ou * 0.5),
        midBand: clamp01(vowels.aa * 0.6 + vowels.ee * 0.5),
        highBand: clamp01(vowels.ih * 0.5 + (cue.viseme === 'SS' ? 0.55 : 0.1)),
        speaking: active,
        timestamp: nowMs,
      },
      0.38,
    );
  }
}
