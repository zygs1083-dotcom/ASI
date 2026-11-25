import { createSilentVisemeFrame, type PresenceActivity, type VisemeFrame } from '@asi/presence-protocol';
import type { TtsSynthesizeResult } from '../../shared/ipc-api.ts';
import { analyzeSpectrumToViseme, VisemeSyncController } from './viseme-engine.ts';

interface QueuedUtterance {
  id: string;
  text: string;
  fetchPromise: Promise<TtsSynthesizeResult>;
}

export interface StreamingTtsPlayerDeps {
  synthesize: (input: { text: string; utteranceId: string }) => Promise<TtsSynthesizeResult>;
  abortRemote: (utteranceId?: string) => Promise<void>;
  onVisemeFrame: (frame: VisemeFrame) => void;
  /** Fires strictly when audible TTS playback starts or finishes (used for VAD echo guard). */
  onSpeakingChanged?: (speaking: boolean) => void;
  /** Fires whenever utterances are queued/prefetching or fully drained (keeps visual speaking state steady). */
  onQueueBusyChanged?: (queued: boolean) => void;
}

/**
 * Keeps the renderer avatar/HUD in `speaking` state until the entire TTS playback queue
 * has actually finished playing, rather than snapping back to `idle` the instant LLM tokens end.
 */
export function resolveEffectivePresenceActivity(
  mainActivity: PresenceActivity,
  ttsState: { speaking: boolean; queued: boolean },
): PresenceActivity {
  if (ttsState.speaking) {
    return 'speaking';
  }
  if (ttsState.queued && (mainActivity === 'idle' || mainActivity === 'quiet-defer' || mainActivity === 'speaking')) {
    return 'speaking';
  }
  return mainActivity;
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Pipelined sentence-by-sentence streaming TTS player with WebAudio 60fps spectrum
 * lip-sync + TalkingHead visemes + 20ms smooth barge-in interruption.
 */
export class StreamingTtsPlayer {
  private readonly deps: StreamingTtsPlayerDeps;
  private readonly visemeCtrl = new VisemeSyncController();
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private activeSource: AudioBufferSourceNode | null = null;
  private activeGain: GainNode | null = null;
  private cancelActivePlayback: (() => void) | null = null;
  private freqBins: Uint8Array<ArrayBuffer> = new Uint8Array(512);
  private queue: QueuedUtterance[] = [];
  private processing = false;
  private playingSpeechSynthesis = false;
  private generation = 0;
  private rafId: number | null = null;
  private speaking = false;
  private queued = false;
  private disposed = false;

  constructor(deps: StreamingTtsPlayerDeps) {
    this.deps = deps;
    this.startVisemeLoop();
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  get isQueueBusy(): boolean {
    return this.queued || this.speaking;
  }

  enqueueSentence(text: string): void {
    if (this.disposed) return;
    const clean = text.trim();
    if (!clean) return;
    const id = `utt_${this.generation}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    // Prefetch audio immediately in parallel while earlier sentence plays; swallow unexpected rejections
    // so discarding the queue on interrupt() never causes an unhandled promise rejection.
    const fetchPromise = Promise.resolve()
      .then(() => this.deps.synthesize({ text: clean, utteranceId: id }))
      .catch(
        (err: unknown): TtsSynthesizeResult => ({
          ok: false,
          providerUsed: 'browser-speech',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    this.queue.push({ id, text: clean, fetchPromise });
    this.setQueued(true);
    if (!this.processing) {
      void this.drainQueue();
    }
  }

  interrupt(): void {
    this.generation += 1;
    this.queue = [];
    this.playingSpeechSynthesis = false;
    void this.deps.abortRemote().catch(() => undefined);

    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore
      }
    }

    if (this.activeSource && this.audioCtx && this.activeGain) {
      const src = this.activeSource;
      const srcGain = this.activeGain;
      this.activeSource = null;
      this.activeGain = null;
      try {
        const now = this.audioCtx.currentTime;
        srcGain.gain.cancelScheduledValues(now);
        srcGain.gain.setValueAtTime(srcGain.gain.value, now);
        srcGain.gain.linearRampToValueAtTime(0.0001, now + 0.02);
        setTimeout(() => {
          try {
            src.stop();
          } catch {
            // Already stopped
          }
          try {
            src.disconnect();
            srcGain.disconnect();
          } catch {
            // Ignore
          }
        }, 24);
      } catch {
        try {
          src.stop();
        } catch {
          // Ignore
        }
      }
    }

    const cancelWait = this.cancelActivePlayback;
    this.cancelActivePlayback = null;
    cancelWait?.();

    this.setSpeaking(false);
    this.setQueued(false);
    this.deps.onVisemeFrame(this.visemeCtrl.reset());
  }

  dispose(): void {
    this.disposed = true;
    this.interrupt();
    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
  }

  private ensureAudioContext(): { ctx: AudioContext; analyser: AnalyserNode } {
    if (!this.audioCtx) {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.55;
      analyser.connect(ctx.destination);
      this.audioCtx = ctx;
      this.analyser = analyser;
      this.freqBins = new Uint8Array(analyser.frequencyBinCount);
    }
    return {
      ctx: this.audioCtx,
      analyser: this.analyser as AnalyserNode,
    };
  }

  private setSpeaking(next: boolean): void {
    if (this.speaking !== next) {
      this.speaking = next;
      this.deps.onSpeakingChanged?.(next);
    }
  }

  private setQueued(next: boolean): void {
    if (this.queued !== next) {
      this.queued = next;
      this.deps.onQueueBusyChanged?.(next);
    }
  }

  private async drainQueue(): Promise<void> {
    if (this.processing || this.disposed) return;
    this.processing = true;
    this.setQueued(true);
    const myGen = this.generation;

    try {
      while (this.queue.length > 0 && myGen === this.generation && !this.disposed) {
        const item = this.queue.shift();
        if (!item) break;
        const result = await item.fetchPromise;
        if (myGen !== this.generation || this.disposed) break;
        if (!result.ok) continue;

        if (result.audioBase64) {
          await this.playAudioBase64(result.audioBase64, myGen);
        } else if (result.fallbackText) {
          await this.playBrowserSpeechFallback(result.fallbackText, myGen);
        }
      }
    } finally {
      this.processing = false;
      if (!this.disposed && this.queue.length > 0) {
        // A new sentence arrived after an interrupt before the previous drain unwound
        void this.drainQueue();
      } else if (this.queue.length === 0) {
        this.setSpeaking(false);
        this.setQueued(false);
      }
    }
  }

  private async playAudioBase64(audioBase64: string, gen: number): Promise<void> {
    const { ctx, analyser } = this.ensureAudioContext();
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => undefined);
    }
    let decoded: AudioBuffer;
    try {
      decoded = await ctx.decodeAudioData(base64ToArrayBuffer(audioBase64));
    } catch {
      return;
    }
    if (gen !== this.generation || this.disposed) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (this.cancelActivePlayback === done) {
          this.cancelActivePlayback = null;
        }
        resolve();
      };

      const source = ctx.createBufferSource();
      const sourceGain = ctx.createGain();
      sourceGain.gain.value = 1.0;
      source.buffer = decoded;
      source.connect(sourceGain);
      sourceGain.connect(analyser);

      this.activeSource = source;
      this.activeGain = sourceGain;
      this.cancelActivePlayback = done;
      this.setSpeaking(true);

      source.onended = () => {
        if (this.activeSource === source) {
          this.activeSource = null;
          this.activeGain = null;
        }
        try {
          source.disconnect();
          sourceGain.disconnect();
        } catch {
          // Ignore
        }
        done();
      };
      source.start();
    });
  }

  private async playBrowserSpeechFallback(text: string, gen: number): Promise<void> {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    if (gen !== this.generation || this.disposed) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (this.cancelActivePlayback === finish) {
          this.cancelActivePlayback = null;
        }
        this.playingSpeechSynthesis = false;
        this.visemeCtrl.clearTimeline();
        resolve();
      };

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      utterance.rate = 1.06;
      utterance.pitch = 1.08;
      this.playingSpeechSynthesis = true;
      this.cancelActivePlayback = finish;
      this.setSpeaking(true);
      this.visemeCtrl.setTextFallbackTimeline(text);

      utterance.onend = finish;
      utterance.onerror = finish;
      window.speechSynthesis.speak(utterance);
    });
  }

  private startVisemeLoop(): void {
    if (typeof requestAnimationFrame !== 'function') return;
    const tick = () => {
      if (this.disposed) return;
      this.rafId = requestAnimationFrame(tick);
      if (this.activeSource && this.analyser && this.audioCtx) {
        this.analyser.getByteFrequencyData(this.freqBins);
        const raw = analyzeSpectrumToViseme(
          this.freqBins,
          this.audioCtx.sampleRate,
          this.analyser.fftSize,
          performance.now(),
        );
        this.deps.onVisemeFrame(this.visemeCtrl.step(raw, 0.36));
      } else if (this.playingSpeechSynthesis) {
        this.deps.onVisemeFrame(this.visemeCtrl.sampleTextTimeline(performance.now()));
      } else {
        this.deps.onVisemeFrame(this.visemeCtrl.step(createSilentVisemeFrame(performance.now()), 0.22));
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }
}
