import type { SttProviderKind } from '@asi/presence-protocol';

export interface AdaptiveVadConfig {
  /** Sensitivity in [0.1, 0.95]; higher triggers more readily on soft speech. */
  sensitivity?: number;
  /** Consecutive active frames required before declaring speech onset (default 3). */
  onsetFrames?: number;
  /** Consecutive quiet frames required before closing an utterance (default 20 ~ 640ms). */
  hangoverFrames?: number;
  /** Enable stricter energy + sustained-frame gating while assistant TTS is playing (default true). */
  echoGuardEnabled?: boolean;
  /** Extra speaker-echo rejection strictness in [0.1, 0.95] (default 0.65). */
  echoGuardStrength?: number;
  /** Optional explicit override for consecutive voiced frames required to barge in while TTS plays. */
  echoOnsetFrames?: number;
  /** Number of trailing frames after TTS finishes to keep echo guard active (default 5). */
  reverbTailFrames?: number;
}

export interface AdaptiveVadStepResult {
  rms: number;
  zcr: number;
  speechActive: boolean;
  onset: boolean;
  offset: boolean;
  echoGuardActive: boolean;
  activeStreak: number;
}

export interface BargeInEchoGuardConfig {
  enabled?: boolean;
  /** Base VAD sensitivity in [0.1, 0.95] (default 0.62). */
  sensitivity?: number;
  /** Extra speaker-echo rejection strictness in [0.1, 0.95] (default 0.65). */
  strength?: number;
  /** Post-TTS room-reverb cooldown window in ms (default 260). */
  reverbTailMs?: number;
  /** Clock provider for deterministic unit tests (default performance.now / Date.now). */
  now?: () => number;
}

export interface BargeInEchoStepResult {
  guardActive: boolean;
  bargeIn: boolean;
  requiredProbability: number;
  requiredRms: number;
  requiredFrames: number;
  sustainedFrames: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computeFrameRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] ?? 0;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples.length);
}

/**
 * Deterministic speaker-echo / self-interruption guard for Silero VAD during active TTS playback.
 * While 雪儿 is speaking through speakers (plus a brief room-reverb tail), barge-in requires
 * sustained high speech probability AND elevated near-field RMS energy so speaker leakage
 * does not self-interrupt or feed 雪儿's own audio into STT, while genuine human voice still
 * breaks in responsively (~200ms).
 */
export class BargeInEchoGuard {
  private enabled: boolean;
  private sensitivity: number;
  private strength: number;
  private readonly reverbTailMs: number;
  private readonly now: () => number;
  private assistantSpeaking = false;
  private reverbTailUntilMs = 0;
  private sustainedFrames = 0;
  private bargeInConfirmed = false;

  constructor(config: BargeInEchoGuardConfig = {}) {
    this.enabled = config.enabled ?? true;
    this.sensitivity = clamp(config.sensitivity ?? 0.62, 0.1, 0.95);
    this.strength = clamp(config.strength ?? 0.65, 0.1, 0.95);
    this.reverbTailMs = Math.max(0, config.reverbTailMs ?? 260);
    this.now = config.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  }

  get isAssistantSpeaking(): boolean {
    return this.assistantSpeaking;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.reverbTailUntilMs = 0;
      this.sustainedFrames = 0;
    }
  }

  setSensitivity(sensitivity: number): void {
    this.sensitivity = clamp(sensitivity, 0.1, 0.95);
  }

  setStrength(strength: number): void {
    this.strength = clamp(strength, 0.1, 0.95);
  }

  setAssistantSpeaking(speaking: boolean, options?: { immediate?: boolean }): void {
    if (speaking) {
      this.assistantSpeaking = true;
      this.reverbTailUntilMs = 0;
      this.sustainedFrames = 0;
      this.bargeInConfirmed = false;
      return;
    }
    const wasSpeaking = this.assistantSpeaking;
    this.assistantSpeaking = false;
    this.sustainedFrames = 0;
    if (wasSpeaking && this.enabled && !options?.immediate && !this.bargeInConfirmed && this.reverbTailMs > 0) {
      this.reverbTailUntilMs = this.now() + this.reverbTailMs;
    } else {
      this.reverbTailUntilMs = 0;
    }
    this.bargeInConfirmed = false;
  }

  resetStreak(): void {
    this.sustainedFrames = 0;
  }

  isGuardActive(nowMs = this.now()): boolean {
    if (!this.enabled) return false;
    return this.assistantSpeaking || nowMs < this.reverbTailUntilMs;
  }

  getThresholds(): { requiredProbability: number; requiredRms: number; requiredFrames: number } {
    const baseProb = clamp(1.0 - this.sensitivity * 0.65, 0.25, 0.85);
    const requiredProbability = clamp(Math.max(baseProb + 0.16, 0.68 + this.strength * 0.26), 0.7, 0.96);
    const requiredRms = 0.024 + this.strength * 0.072;
    const requiredFrames = Math.max(4, Math.round(4 + this.strength * 4));
    return { requiredProbability, requiredRms, requiredFrames };
  }

  processFrame(speechProbability: number, rms: number, nowMs = this.now()): BargeInEchoStepResult {
    const guardActive = this.isGuardActive(nowMs);
    const { requiredProbability, requiredRms, requiredFrames } = this.getThresholds();

    if (!guardActive) {
      this.sustainedFrames = 0;
      return {
        guardActive: false,
        bargeIn: false,
        requiredProbability,
        requiredRms,
        requiredFrames,
        sustainedFrames: 0,
      };
    }

    if (speechProbability >= requiredProbability && rms >= requiredRms) {
      this.sustainedFrames += 1;
      if (this.sustainedFrames >= requiredFrames) {
        this.bargeInConfirmed = true;
        this.reverbTailUntilMs = 0;
        this.sustainedFrames = 0;
        return {
          guardActive: true,
          bargeIn: true,
          requiredProbability,
          requiredRms,
          requiredFrames,
          sustainedFrames: requiredFrames,
        };
      }
    } else {
      this.sustainedFrames = 0;
    }

    return {
      guardActive: true,
      bargeIn: false,
      requiredProbability,
      requiredRms,
      requiredFrames,
      sustainedFrames: this.sustainedFrames,
    };
  }
}

export interface SileroEchoGateOptions {
  echoGuard?: BargeInEchoGuard;
  sensitivity?: number;
  /** Consecutive voiced frames after TTS+reverb ends to confirm a quick human reply inside an open Silero segment. */
  postGuardOnsetFrames?: number;
  /** Pre-roll frames (~32ms each) preserved before confirmed human barge-in / post-TTS onset. */
  prePadFrames?: number;
}

/**
 * Pure deterministic segment gate for Silero VAD v5 (`@ricky0123/vad-web`) during active TTS playback:
 * 1. Suppresses echo-only segments while assistant TTS (plus reverb tail) is active.
 * 2. On mid-echo human barge-in, emits `onSpeechStart` and slices `onSpeechEnd` audio so prior assistant echo is stripped.
 * 3. On quick human reply right after TTS ends (within Silero's open `redemptionMs` window), confirms speech and trims echo.
 */
export class SileroEchoSegmentGate {
  readonly echoGuard: BargeInEchoGuard;
  private speechThreshold: number;
  private readonly postGuardOnsetFrames: number;
  private readonly prePadFrames: number;
  private inSegment = false;
  private startedUnderGuard = false;
  private confirmedHuman = false;
  private speechStartEmitted = false;
  private trimToHumanTail = false;
  private humanKeepSamples = 0;
  private postGuardSpeechStreak = 0;

  constructor(options: SileroEchoGateOptions = {}) {
    const sensitivity = clamp(options.sensitivity ?? 0.62, 0.1, 0.95);
    this.echoGuard = options.echoGuard ?? new BargeInEchoGuard({ sensitivity });
    this.speechThreshold = clamp(1.0 - sensitivity * 0.65, 0.25, 0.85);
    this.postGuardOnsetFrames = Math.max(1, options.postGuardOnsetFrames ?? 3);
    this.prePadFrames = Math.max(0, options.prePadFrames ?? 4);
  }

  setSensitivity(sensitivity: number): void {
    const clamped = clamp(sensitivity, 0.1, 0.95);
    this.speechThreshold = clamp(1.0 - clamped * 0.65, 0.25, 0.85);
    this.echoGuard.setSensitivity(clamped);
  }

  resetSegment(): void {
    this.inSegment = false;
    this.startedUnderGuard = false;
    this.confirmedHuman = false;
    this.speechStartEmitted = false;
    this.trimToHumanTail = false;
    this.humanKeepSamples = 0;
    this.postGuardSpeechStreak = 0;
    this.echoGuard.resetStreak();
  }

  onFrame(
    speechProbability: number,
    frame: Float32Array,
    nowMs?: number,
  ): { rms: number; guardActive: boolean; triggerSpeechStart: boolean } {
    const rms = computeFrameRms(frame);
    const guardStep = this.echoGuard.processFrame(speechProbability, rms, nowMs);
    let triggerSpeechStart = false;

    if (this.confirmedHuman && this.trimToHumanTail) {
      this.humanKeepSamples += frame.length;
    }

    if (guardStep.bargeIn && !this.confirmedHuman) {
      this.confirmedHuman = true;
      this.trimToHumanTail = true;
      this.humanKeepSamples = (guardStep.requiredFrames + this.prePadFrames) * frame.length;
      this.postGuardSpeechStreak = 0;
      if (!this.speechStartEmitted) {
        this.speechStartEmitted = true;
        triggerSpeechStart = true;
      }
    } else if (!guardStep.guardActive && this.inSegment && this.startedUnderGuard && !this.confirmedHuman) {
      if (speechProbability >= this.speechThreshold) {
        this.postGuardSpeechStreak += 1;
        if (this.postGuardSpeechStreak >= this.postGuardOnsetFrames) {
          this.confirmedHuman = true;
          this.trimToHumanTail = true;
          this.humanKeepSamples = (this.postGuardOnsetFrames + this.prePadFrames) * frame.length;
          this.postGuardSpeechStreak = 0;
          if (!this.speechStartEmitted) {
            this.speechStartEmitted = true;
            triggerSpeechStart = true;
          }
        }
      } else {
        this.postGuardSpeechStreak = 0;
      }
    } else {
      this.postGuardSpeechStreak = 0;
    }

    return { rms, guardActive: guardStep.guardActive, triggerSpeechStart };
  }

  onSpeechStart(nowMs?: number): { triggerSpeechStart: boolean } {
    this.inSegment = true;
    if (this.confirmedHuman || this.speechStartEmitted) {
      return { triggerSpeechStart: false };
    }
    if (this.echoGuard.isGuardActive(nowMs)) {
      this.startedUnderGuard = true;
      this.confirmedHuman = false;
      this.trimToHumanTail = false;
      this.humanKeepSamples = 0;
      this.postGuardSpeechStreak = 0;
      return { triggerSpeechStart: false };
    }
    this.startedUnderGuard = false;
    this.confirmedHuman = true;
    this.speechStartEmitted = true;
    this.trimToHumanTail = false;
    this.humanKeepSamples = 0;
    this.postGuardSpeechStreak = 0;
    return { triggerSpeechStart: true };
  }

  onVadMisfire(): void {
    this.resetSegment();
  }

  onSpeechEnd(audio16k: Float32Array): Float32Array | null {
    const suppressedEcho = this.startedUnderGuard && !this.confirmedHuman;
    const shouldTrim = this.confirmedHuman && this.trimToHumanTail && this.humanKeepSamples > 0;
    const keepSamples = this.humanKeepSamples;
    this.resetSegment();

    if (suppressedEcho) {
      return null;
    }
    if (shouldTrim && audio16k.length > keepSamples) {
      return audio16k.subarray(audio16k.length - keepSamples);
    }
    return audio16k;
  }
}

/**
 * Pure TypeScript adaptive noise-floor RMS + Zero-Crossing-Rate voice activity detector
 * with built-in assistant-speaking echo guard.
 * Serves both as an instant zero-dependency fallback when ONNX Silero VAD assets are
 * unavailable and as a deterministic testable core for barge-in speech detection.
 */
export class AdaptiveVadDetector {
  private noiseFloor = 0.008;
  private speechActive = false;
  private activeStreak = 0;
  private silentStreak = 0;
  private assistantSpeaking = false;
  private reverbTailRemaining = 0;
  private readonly sensitivity: number;
  private readonly onsetFrames: number;
  private readonly hangoverFrames: number;
  private echoGuardEnabled: boolean;
  private echoGuardStrength: number;
  private readonly echoOnsetFramesOverride: number | undefined;
  private readonly reverbTailFrames: number;

  constructor(config: AdaptiveVadConfig = {}) {
    this.sensitivity = clamp(config.sensitivity ?? 0.62, 0.1, 0.95);
    this.onsetFrames = config.onsetFrames ?? 3;
    this.hangoverFrames = config.hangoverFrames ?? 20;
    this.echoGuardEnabled = config.echoGuardEnabled ?? true;
    this.echoGuardStrength = clamp(config.echoGuardStrength ?? 0.65, 0.1, 0.95);
    this.echoOnsetFramesOverride = config.echoOnsetFrames;
    this.reverbTailFrames = Math.max(0, config.reverbTailFrames ?? 5);
  }

  get isAssistantSpeaking(): boolean {
    return this.assistantSpeaking;
  }

  setAssistantSpeaking(speaking: boolean): void {
    if (speaking) {
      this.assistantSpeaking = true;
      this.reverbTailRemaining = 0;
      if (!this.speechActive) {
        this.activeStreak = 0;
      }
      return;
    }
    const wasSpeaking = this.assistantSpeaking;
    this.assistantSpeaking = false;
    if (wasSpeaking && this.echoGuardEnabled && !this.speechActive) {
      this.reverbTailRemaining = this.reverbTailFrames;
    } else {
      this.reverbTailRemaining = 0;
    }
  }

  setEchoGuard(options: { enabled?: boolean; strength?: number }): void {
    if (options.enabled !== undefined) {
      this.echoGuardEnabled = options.enabled;
      if (!options.enabled) {
        this.reverbTailRemaining = 0;
      }
    }
    if (options.strength !== undefined) {
      this.echoGuardStrength = clamp(options.strength, 0.1, 0.95);
    }
  }

  reset(): void {
    this.speechActive = false;
    this.activeStreak = 0;
    this.silentStreak = 0;
    this.reverbTailRemaining = 0;
  }

  processFrame(samples: Float32Array): AdaptiveVadStepResult {
    const echoGuardActive = this.echoGuardEnabled && (this.assistantSpeaking || this.reverbTailRemaining > 0);
    if (!this.assistantSpeaking && this.reverbTailRemaining > 0) {
      this.reverbTailRemaining -= 1;
    }

    if (samples.length === 0) {
      return {
        rms: 0,
        zcr: 0,
        speechActive: this.speechActive,
        onset: false,
        offset: false,
        echoGuardActive,
        activeStreak: this.activeStreak,
      };
    }
    let sumSq = 0;
    let zeroCrossings = 0;
    let prev = samples[0] ?? 0;

    for (let i = 0; i < samples.length; i += 1) {
      const s = samples[i] ?? 0;
      sumSq += s * s;
      if ((s >= 0 && prev < 0) || (s < 0 && prev >= 0)) {
        zeroCrossings += 1;
      }
      prev = s;
    }

    const rms = Math.sqrt(sumSq / samples.length);
    const zcr = zeroCrossings / samples.length;

    // Sensitivity 0.1 => stricter threshold multiplier (4.5x), 0.95 => gentler (1.8x)
    const multiplier = 4.8 - this.sensitivity * 3.1;
    const minAbsThreshold = 0.032 - this.sensitivity * 0.022;
    const baseThreshold = Math.max(minAbsThreshold, this.noiseFloor * multiplier);

    // While assistant TTS is speaking, require substantially stronger near-field energy and sustained frames
    const echoMinRms = 0.024 + this.echoGuardStrength * 0.072;
    const threshold =
      echoGuardActive && !this.speechActive
        ? Math.max(baseThreshold * (1.8 + this.echoGuardStrength * 1.4), echoMinRms)
        : baseThreshold;
    const requiredOnsetFrames =
      echoGuardActive && !this.speechActive
        ? (this.echoOnsetFramesOverride ?? Math.max(this.onsetFrames + 3, Math.round(4 + this.echoGuardStrength * 4)))
        : this.onsetFrames;

    // Human voice has moderate ZCR (not pure DC hum or pure white hiss)
    const voiceLike = rms > threshold && zcr >= 0.01 && zcr <= 0.45;

    let onset = false;
    let offset = false;

    if (voiceLike) {
      this.activeStreak += 1;
      this.silentStreak = 0;
      if (!this.speechActive && this.activeStreak >= requiredOnsetFrames) {
        this.speechActive = true;
        this.reverbTailRemaining = 0;
        onset = true;
      }
    } else {
      this.activeStreak = 0;
      // Avoid letting loudspeaker TTS audio inflate the quiet room's ambient noise floor
      if (!echoGuardActive || rms < this.noiseFloor) {
        this.noiseFloor = this.noiseFloor * 0.96 + rms * 0.04;
      }
      if (this.speechActive) {
        this.silentStreak += 1;
        if (this.silentStreak >= this.hangoverFrames) {
          this.speechActive = false;
          this.silentStreak = 0;
          offset = true;
        }
      }
    }

    return {
      rms,
      zcr,
      speechActive: this.speechActive,
      onset,
      offset,
      echoGuardActive,
      activeStreak: this.activeStreak,
    };
  }
}

/**
 * Decides whether finalized VAD WAV bytes should be sent to Electron main-process STT.
 * Always true for `macos-speech` and `whisper-http`, and seamlessly falls back to main-process
 * `macos-speech` when `web-speech` is unavailable or fails in standalone Electron builds.
 */
export function shouldTranscribeViaMainProcess(
  sttProvider: SttProviderKind,
  webSpeechActive: boolean,
): { enabled: boolean; fallbackFromWebSpeech: boolean } {
  if (sttProvider === 'macos-speech' || sttProvider === 'whisper-http') {
    return { enabled: true, fallbackFromWebSpeech: false };
  }
  if (sttProvider === 'web-speech' && !webSpeechActive) {
    return { enabled: true, fallbackFromWebSpeech: true };
  }
  return { enabled: false, fallbackFromWebSpeech: false };
}

/**
 * Encodes 16kHz mono Float32 PCM samples strictly in memory into a valid 16-bit PCM WAV byte array.
 */
export function encodeFloat32ToWavBytes(samples: Float32Array, sampleRate = 16000): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === 16000) return input;
  const ratio = inputRate / 16000;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    out[i] = input[Math.min(input.length - 1, Math.floor(i * ratio))] ?? 0;
  }
  return out;
}

export interface VoiceVadCallbacks {
  onSpeechStart: () => void;
  onSpeechEnd: (wavBase64: string, durationMs: number) => void;
  onTranscript?: (text: string) => void;
  onRmsLevel?: (rms: number) => void;
  onEngineReady?: (backend: 'silero-vad' | 'adaptive-webaudio') => void;
  onWebSpeechUnavailable?: (reason: string) => void;
  onError?: (error: string) => void;
}

export interface VoiceVadStartOptions {
  sensitivity?: number;
  useWebSpeech?: boolean;
  locale?: string;
  echoGuardEnabled?: boolean;
  echoGuardStrength?: number;
  assistantSpeaking?: boolean;
}

interface SpeechRecognitionEventLike {
  resultIndex?: number;
  results: ArrayLike<{ isFinal: boolean; 0?: { transcript?: string } }>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

const FATAL_WEB_SPEECH_ERRORS = new Set([
  'service-not-allowed',
  'not-allowed',
  'network',
  'audio-capture',
  'language-not-supported',
]);

/**
 * Extracts only newly finalized transcripts starting at `ev.resultIndex`,
 * preventing duplicate re-submission of earlier sentences when `continuous = true`.
 */
export function extractFinalWebSpeechTranscripts(ev: SpeechRecognitionEventLike): string[] {
  const startIdx = Math.max(0, ev.resultIndex ?? 0);
  const out: string[] = [];
  for (let i = startIdx; i < ev.results.length; i += 1) {
    const res = ev.results[i];
    if (res?.isFinal) {
      const text = res[0]?.transcript?.trim();
      if (text) out.push(text);
    }
  }
  return out;
}

/**
 * Full-duplex microphone VAD controller:
 * Attempts native Silero VAD (`@ricky0123/vad-web`) first for millisecond-accurate barge-in,
 * falling back seamlessly to `AdaptiveVadDetector` over WebAudio + optional Web Speech STT.
 * Integrates `BargeInEchoGuard` so active TTS playback does not self-interrupt on laptop speakers.
 */
export class PresenceVoiceVadController {
  private readonly callbacks: VoiceVadCallbacks;
  private readonly echoGuard = new BargeInEchoGuard();
  private sileroGate: SileroEchoSegmentGate | null = null;
  private sileroInstance: {
    start: () => Promise<void>;
    pause: () => Promise<void>;
    destroy: () => Promise<void>;
  } | null = null;
  private adaptiveDetector: AdaptiveVadDetector | null = null;
  private mediaStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private silentSinkNode: GainNode | null = null;
  private recognition: SpeechRecognitionLike | null = null;
  private running = false;
  private sensitivity = 0.62;
  private echoGuardEnabled = true;
  private echoGuardStrength = 0.65;
  private assistantSpeaking = false;
  private useWebSpeech = true;
  private webSpeechAvailable = false;
  private webSpeechFatal = false;
  private webSpeechRapidEnds = 0;
  private webSpeechLastStartMs = 0;
  private webSpeechEverProducedResult = false;

  constructor(callbacks: VoiceVadCallbacks) {
    this.callbacks = callbacks;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isWebSpeechActive(): boolean {
    return this.useWebSpeech && this.webSpeechAvailable && !this.webSpeechFatal;
  }

  setAssistantSpeaking(speaking: boolean): void {
    this.assistantSpeaking = speaking;
    this.echoGuard.setAssistantSpeaking(speaking);
    this.adaptiveDetector?.setAssistantSpeaking(speaking);
  }

  setEchoGuard(options: { enabled: boolean; strength?: number }): void {
    this.echoGuardEnabled = options.enabled;
    if (options.strength !== undefined) {
      this.echoGuardStrength = clamp(options.strength, 0.1, 0.95);
    }
    this.echoGuard.setEnabled(this.echoGuardEnabled);
    this.echoGuard.setStrength(this.echoGuardStrength);
    this.adaptiveDetector?.setEchoGuard({
      enabled: this.echoGuardEnabled,
      strength: this.echoGuardStrength,
    });
  }

  async start(options: VoiceVadStartOptions = {}): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.sensitivity = clamp(options.sensitivity ?? 0.62, 0.1, 0.95);
    this.useWebSpeech = options.useWebSpeech ?? false;
    this.echoGuardEnabled = options.echoGuardEnabled ?? true;
    this.echoGuardStrength = clamp(options.echoGuardStrength ?? 0.65, 0.1, 0.95);
    this.assistantSpeaking = options.assistantSpeaking ?? this.assistantSpeaking;
    this.webSpeechAvailable = false;
    this.webSpeechFatal = false;

    this.echoGuard.setEnabled(this.echoGuardEnabled);
    this.echoGuard.setSensitivity(this.sensitivity);
    this.echoGuard.setStrength(this.echoGuardStrength);
    this.echoGuard.setAssistantSpeaking(this.assistantSpeaking, { immediate: true });

    if (this.useWebSpeech) {
      this.startWebSpeechRecognition(options.locale ?? 'zh-CN');
    }

    // 1. Try genuine Silero VAD (`@ricky0123/vad-web`)
    // Resolve absolute base URL against window.location.href so ONNX dynamic import()
    // from Vite's `/assets/*.js` chunk resolves `/vad/ort-wasm-simd-threaded.mjs` instead of `/assets/vad/...`!
    try {
      const vadAssetBase = typeof window !== 'undefined' ? new URL('./vad/', window.location.href).href : './vad/';
      const vadMod = (await import('@ricky0123/vad-web')) as {
        MicVAD?: {
          new: (opts: {
            model?: 'v5' | 'v6' | 'legacy';
            baseAssetPath?: string;
            onnxWASMBasePath?: string;
            startOnLoad?: boolean;
            positiveSpeechThreshold?: number;
            negativeSpeechThreshold?: number;
            redemptionMs?: number;
            minSpeechMs?: number;
            preSpeechPadMs?: number;
            ortConfig?: (ort: { env: { logLevel?: string; wasm?: { numThreads?: number } } }) => void;
            onFrameProcessed?: (probs: { isSpeech: number }, frame: Float32Array) => void;
            onSpeechStart?: () => void;
            onVADMisfire?: () => void;
            onSpeechEnd?: (audio: Float32Array) => void;
          }) => Promise<{ start: () => Promise<void>; pause: () => Promise<void>; destroy: () => Promise<void> }>;
        };
      };
      if (vadMod.MicVAD) {
        const threshold = clamp(1.0 - this.sensitivity * 0.65, 0.25, 0.85);
        const gate = new SileroEchoSegmentGate({
          echoGuard: this.echoGuard,
          sensitivity: this.sensitivity,
        });
        this.sileroGate = gate;

        const vad = await vadMod.MicVAD.new({
          model: 'v5',
          baseAssetPath: vadAssetBase,
          onnxWASMBasePath: vadAssetBase,
          startOnLoad: false,
          positiveSpeechThreshold: threshold,
          negativeSpeechThreshold: Math.max(0.15, threshold - 0.15),
          redemptionMs: 520,
          minSpeechMs: 160,
          preSpeechPadMs: 240,
          ortConfig: (ort) => {
            ort.env.logLevel = 'error';
            if (ort.env.wasm) {
              ort.env.wasm.numThreads = 1;
            }
          },
          onFrameProcessed: (probs, frame) => {
            if (!this.running) return;
            const step = gate.onFrame(probs.isSpeech, frame);
            this.callbacks.onRmsLevel?.(Math.min(1, step.rms * 6));
            if (step.triggerSpeechStart) {
              this.callbacks.onSpeechStart();
            }
          },
          onSpeechStart: () => {
            if (!this.running) return;
            if (gate.onSpeechStart().triggerSpeechStart) {
              this.callbacks.onSpeechStart();
            }
          },
          onVADMisfire: () => {
            gate.onVadMisfire();
          },
          onSpeechEnd: (audio16k: Float32Array) => {
            const cleanAudio = gate.onSpeechEnd(audio16k);
            if (!this.running || !cleanAudio || cleanAudio.length < 1600) return;
            const wav = encodeFloat32ToWavBytes(cleanAudio, 16000);
            this.callbacks.onSpeechEnd(bytesToBase64(wav), Math.round((cleanAudio.length / 16000) * 1000));
          },
        });
        if (!this.running) {
          void vad.destroy().catch(() => undefined);
          return;
        }
        await vad.start();
        if (!this.running) {
          void vad.destroy().catch(() => undefined);
          return;
        }
        this.sileroInstance = vad;
        this.callbacks.onEngineReady?.('silero-vad');
        return;
      }
    } catch {
      // Seamlessly fall back to WebAudio adaptive VAD
    }

    // 2. Fallback: WebAudio Adaptive RMS + ZCR VAD with full barge-in, echo guard & WAV capture
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!this.running) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      this.mediaStream = stream;
      const ctx = new AudioContext();
      this.audioCtx = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(2048, 1, 1);
      const silentSink = ctx.createGain();
      silentSink.gain.value = 0;
      this.processorNode = processor;
      this.silentSinkNode = silentSink;

      const detector = new AdaptiveVadDetector({
        sensitivity: this.sensitivity,
        echoGuardEnabled: this.echoGuardEnabled,
        echoGuardStrength: this.echoGuardStrength,
      });
      detector.setAssistantSpeaking(this.assistantSpeaking);
      this.adaptiveDetector = detector;

      let utteranceChunks: Float32Array[] = [];
      const preRollChunks: Float32Array[] = [];

      processor.onaudioprocess = (ev) => {
        if (!this.running) return;
        const input = ev.inputBuffer.getChannelData(0);
        const frame = new Float32Array(input);
        const step = detector.processFrame(frame);
        this.callbacks.onRmsLevel?.(Math.min(1, step.rms * 6));

        if (step.onset) {
          utteranceChunks = [...preRollChunks, frame];
          preRollChunks.length = 0;
          this.callbacks.onSpeechStart();
        } else if (step.speechActive) {
          utteranceChunks.push(frame);
        } else if (step.offset && utteranceChunks.length > 0) {
          const totalLen = utteranceChunks.reduce((acc, c) => acc + c.length, 0);
          const merged = new Float32Array(totalLen);
          let pos = 0;
          for (const chunk of utteranceChunks) {
            merged.set(chunk, pos);
            pos += chunk.length;
          }
          utteranceChunks = [];
          preRollChunks.length = 0;
          const pcm16k = downsampleTo16k(merged, ctx.sampleRate);
          if (pcm16k.length >= 2000) {
            const wav = encodeFloat32ToWavBytes(pcm16k, 16000);
            this.callbacks.onSpeechEnd(bytesToBase64(wav), Math.round((pcm16k.length / 16000) * 1000));
          }
        } else if (step.echoGuardActive) {
          // While TTS plays, only buffer candidate loud barge-in streak frames so echo is never pre-rolled
          if (step.activeStreak > 0) {
            preRollChunks.push(frame);
            if (preRollChunks.length > 12) preRollChunks.shift();
          } else {
            preRollChunks.length = 0;
          }
        } else {
          preRollChunks.push(frame);
          if (preRollChunks.length > 5) preRollChunks.shift();
        }
      };

      source.connect(processor);
      processor.connect(silentSink);
      silentSink.connect(ctx.destination);
      this.callbacks.onEngineReady?.('adaptive-webaudio');
    } catch (error) {
      this.running = false;
      this.callbacks.onError?.(error instanceof Error ? error.message : '无法开启麦克风权限');
    }
  }

  private startWebSpeechRecognition(locale: string): void {
    const win = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
    if (!Ctor) {
      this.webSpeechAvailable = false;
      this.webSpeechFatal = true;
      this.callbacks.onWebSpeechUnavailable?.('unsupported');
      return;
    }

    try {
      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = false;
      rec.lang = locale || 'zh-CN';
      this.webSpeechRapidEnds = 0;
      this.webSpeechEverProducedResult = false;
      this.webSpeechLastStartMs = Date.now();
      rec.onresult = (ev) => {
        if (!this.running || this.echoGuard.isGuardActive()) return;
        const transcripts = extractFinalWebSpeechTranscripts(ev);
        if (transcripts.length > 0) {
          this.webSpeechEverProducedResult = true;
          this.webSpeechRapidEnds = 0;
        }
        for (const text of transcripts) {
          this.callbacks.onTranscript?.(text);
        }
      };
      rec.onerror = (ev) => {
        const errCode = ev.error ?? '';
        if (FATAL_WEB_SPEECH_ERRORS.has(errCode)) {
          this.webSpeechFatal = true;
          this.webSpeechAvailable = false;
          rec.onend = null;
          try {
            rec.stop();
          } catch {
            // Ignore
          }
          this.callbacks.onWebSpeechUnavailable?.(errCode);
        }
      };
      rec.onend = () => {
        if (this.running && this.useWebSpeech && !this.webSpeechFatal) {
          const elapsed = Date.now() - this.webSpeechLastStartMs;
          if (!this.webSpeechEverProducedResult && elapsed < 1_500) {
            this.webSpeechRapidEnds += 1;
            if (this.webSpeechRapidEnds >= 3) {
              this.webSpeechFatal = true;
              this.webSpeechAvailable = false;
              rec.onend = null;
              this.callbacks.onWebSpeechUnavailable?.('silent-restart-loop');
              return;
            }
          } else if (elapsed >= 1_500) {
            this.webSpeechRapidEnds = 0;
          }
          try {
            this.webSpeechLastStartMs = Date.now();
            rec.start();
          } catch {
            this.webSpeechFatal = true;
            this.webSpeechAvailable = false;
            this.callbacks.onWebSpeechUnavailable?.('restart-failed');
          }
        }
      };
      rec.start();
      this.recognition = rec;
      this.webSpeechAvailable = true;
    } catch {
      this.recognition = null;
      this.webSpeechAvailable = false;
      this.webSpeechFatal = true;
      this.callbacks.onWebSpeechUnavailable?.('start-failed');
    }
  }

  stop(): void {
    this.running = false;
    this.sileroGate?.resetSegment();
    this.sileroGate = null;
    this.adaptiveDetector = null;
    this.webSpeechAvailable = false;
    this.webSpeechFatal = false;
    this.webSpeechRapidEnds = 0;
    this.webSpeechEverProducedResult = false;
    this.echoGuard.setAssistantSpeaking(false, { immediate: true });
    if (this.sileroInstance) {
      const inst = this.sileroInstance;
      this.sileroInstance = null;
      // destroy() already pauses internally; avoid calling pause() and destroy() concurrently
      void inst.destroy().catch(() => undefined);
    }
    if (this.recognition) {
      try {
        this.recognition.onend = null;
        this.recognition.stop();
      } catch {
        // Ignore
      }
      this.recognition = null;
    }
    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode = null;
    }
    if (this.silentSinkNode) {
      this.silentSinkNode.disconnect();
      this.silentSinkNode = null;
    }
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }
  }
}
