import { describe, expect, it } from 'vitest';
import { resolveEffectivePresenceActivity, StreamingTtsPlayer } from '../src/renderer/audio/tts-player.ts';
import {
  AdaptiveVadDetector,
  BargeInEchoGuard,
  bytesToBase64,
  encodeFloat32ToWavBytes,
  extractFinalWebSpeechTranscripts,
  PresenceVoiceVadController,
  SileroEchoSegmentGate,
  shouldTranscribeViaMainProcess,
} from '../src/renderer/audio/vad-engine.ts';
import {
  analyzeSpectrumToViseme,
  textToVisemeTimeline,
  VisemeSyncController,
} from '../src/renderer/audio/viseme-engine.ts';

function makeSineFrame(length: number, freqHz: number, sampleRate: number, amp: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * amp;
  }
  return out;
}

describe('TalkingHead Viseme & Silero/Adaptive VAD Audio Pipeline', () => {
  it('generates timed viseme cues for bilingual CN/EN text and preserves punctuation silences', () => {
    const cues = textToVisemeTimeline('雪儿，你好! Hello', 1200);
    expect(cues.length).toBeGreaterThan(8);
    expect(cues[2]?.viseme).toBe('sil'); // Chinese comma
    expect(cues[0]?.startMs).toBe(0);
    const last = cues[cues.length - 1];
    expect(last?.endMs).toBe(1200);
  });

  it('classifies WebAudio frequency spectra into silence, open vowel aa, rounded ou, and sibilant SS', () => {
    const sampleRate = 48000;
    const fftSize = 1024;
    const binHz = sampleRate / fftSize;

    // 1. Silence
    const silent = analyzeSpectrumToViseme(new Uint8Array(512), sampleRate, fftSize, 10);
    expect(silent.speaking).toBe(false);
    expect(silent.viseme).toBe('sil');
    expect(silent.rms).toBe(0);

    // 2. Strong F1 (700Hz) -> open 'aa'
    const f1Bins = new Uint8Array(512);
    for (let i = Math.floor(500 / binHz); i <= Math.ceil(950 / binHz); i += 1) {
      f1Bins[i] = 220;
    }
    const aaFrame = analyzeSpectrumToViseme(f1Bins, sampleRate, fftSize, 20);
    expect(aaFrame.speaking).toBe(true);
    expect(aaFrame.viseme).toBe('aa');
    expect(aaFrame.vowels.aa).toBeGreaterThan(0.5);

    // 3. Strong sibilants (3500Hz) -> 'SS'
    const sibBins = new Uint8Array(512);
    for (let i = Math.floor(2800 / binHz); i <= Math.ceil(4600 / binHz); i += 1) {
      sibBins[i] = 230;
    }
    const ssFrame = analyzeSpectrumToViseme(sibBins, sampleRate, fftSize, 30);
    expect(ssFrame.speaking).toBe(true);
    expect(ssFrame.viseme).toBe('SS');
    expect(ssFrame.highBand).toBeGreaterThan(0.5);

    // 4. Smooth controller interpolation & reset
    const ctrl = new VisemeSyncController();
    const stepped = ctrl.step(aaFrame, 0.5);
    expect(stepped.vowels.aa).toBeGreaterThan(0.25);
    const reset = ctrl.reset();
    expect(reset.rms).toBe(0);
    expect(reset.viseme).toBe('sil');
  });

  it('detects voiced speech onset for instant barge-in and offset after trailing silence', () => {
    const vad = new AdaptiveVadDetector({ sensitivity: 0.65, onsetFrames: 3, hangoverFrames: 4 });
    const quiet = new Float32Array(512);
    const voice = makeSineFrame(512, 320, 16000, 0.25);

    // Warm up noise floor with quiet frames
    for (let i = 0; i < 5; i += 1) {
      const r = vad.processFrame(quiet);
      expect(r.speechActive).toBe(false);
      expect(r.onset).toBe(false);
    }

    // 3 consecutive voiced frames -> triggers onset on frame #3
    expect(vad.processFrame(voice).onset).toBe(false);
    expect(vad.processFrame(voice).onset).toBe(false);
    const onsetStep = vad.processFrame(voice);
    expect(onsetStep.onset).toBe(true);
    expect(onsetStep.speechActive).toBe(true);

    // 4 silent frames -> triggers offset on frame #4
    for (let i = 0; i < 3; i += 1) {
      expect(vad.processFrame(quiet).offset).toBe(false);
    }
    const offsetStep = vad.processFrame(quiet);
    expect(offsetStep.offset).toBe(true);
    expect(offsetStep.speechActive).toBe(false);
  });

  it('encodes 16kHz Float32 PCM cleanly into valid RIFF/WAVE bytes in memory', () => {
    const pcm = makeSineFrame(1600, 440, 16000, 0.8);
    const wav = encodeFloat32ToWavBytes(pcm, 16000);
    expect(wav.byteLength).toBe(44 + 1600 * 2);

    const header = String.fromCharCode(wav[0] ?? 0, wav[1] ?? 0, wav[2] ?? 0, wav[3] ?? 0);
    const format = String.fromCharCode(wav[8] ?? 0, wav[9] ?? 0, wav[10] ?? 0, wav[11] ?? 0);
    expect(header).toBe('RIFF');
    expect(format).toBe('WAVE');

    const view = new DataView(wav.buffer);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(16);

    const b64 = bytesToBase64(wav);
    expect(b64.startsWith('UklGR')).toBe(true); // Base64 for "RIFF"
  });

  it('extracts only newly finalized WebSpeech transcripts from resultIndex (no duplicate re-submissions)', () => {
    const firstEvent = {
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: '雪儿你好' } }],
    };
    expect(extractFinalWebSpeechTranscripts(firstEvent)).toEqual(['雪儿你好']);

    const secondEvent = {
      resultIndex: 1,
      results: [
        { isFinal: true, 0: { transcript: '雪儿你好' } },
        { isFinal: true, 0: { transcript: '今天天气怎么样' } },
      ],
    };
    expect(extractFinalWebSpeechTranscripts(secondEvent)).toEqual(['今天天气怎么样']);
  });

  it('recovers cleanly when interrupt() is immediately followed by enqueueSentence() even if speechSynthesis.cancel never fires onend', async () => {
    const spoken: string[] = [];
    const origWindow = globalThis.window;
    const origUtterance = globalThis.SpeechSynthesisUtterance;

    class MockUtterance {
      text: string;
      lang = '';
      rate = 1;
      pitch = 1;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }

    (globalThis as Record<string, unknown>).SpeechSynthesisUtterance = MockUtterance;
    (globalThis as Record<string, unknown>).window = {
      speechSynthesis: {
        speak: (utt: MockUtterance) => {
          spoken.push(utt.text);
          // Deliberately NEVER invoke onend for sentence 1 (simulating Chromium cancel() quirk),
          // and resolve sentence 2 asynchronously.
          if (utt.text !== '第一句') {
            setTimeout(() => utt.onend?.(), 5);
          }
        },
        cancel: () => undefined,
      },
    };

    try {
      const player = new StreamingTtsPlayer({
        synthesize: async ({ text }) => ({ ok: true, providerUsed: 'browser-speech', fallbackText: text }),
        abortRemote: async () => undefined,
        onVisemeFrame: () => undefined,
      });

      player.enqueueSentence('第一句');
      await new Promise((r) => setTimeout(r, 15));
      expect(spoken).toEqual(['第一句']);

      // Immediately interrupt and enqueue sentence 2 — must NOT deadlock!
      player.interrupt();
      player.enqueueSentence('打断后的新句子');

      await new Promise((r) => setTimeout(r, 40));
      expect(spoken).toEqual(['第一句', '打断后的新句子']);
      player.dispose();
    } finally {
      (globalThis as Record<string, unknown>).window = origWindow;
      (globalThis as Record<string, unknown>).SpeechSynthesisUtterance = origUtterance;
    }
  });

  it('suppresses speaker echo during assistant TTS playback while allowing sustained genuine human barge-in (BargeInEchoGuard)', () => {
    let fakeNow = 1_000;
    const guard = new BargeInEchoGuard({
      enabled: true,
      sensitivity: 0.62,
      strength: 0.65,
      reverbTailMs: 260,
      now: () => fakeNow,
    });

    // When assistant is silent, guard is inactive
    expect(guard.isGuardActive()).toBe(false);

    // Assistant begins speaking -> echo guard engages
    guard.setAssistantSpeaking(true);
    expect(guard.isGuardActive()).toBe(true);

    // 1. Sustained laptop speaker echo (moderate Silero prob & RMS) must NOT self-interrupt
    for (let i = 0; i < 20; i += 1) {
      const step = guard.processFrame(0.78, 0.042);
      expect(step.guardActive).toBe(true);
      expect(step.bargeIn).toBe(false);
    }

    // 2. Short 3-frame loud echo spike followed by drop must NOT self-interrupt
    for (let i = 0; i < 3; i += 1) {
      expect(guard.processFrame(0.95, 0.16).bargeIn).toBe(false);
    }
    expect(guard.processFrame(0.4, 0.02).sustainedFrames).toBe(0);

    // 3. Normal TTS end engages brief reverb tail cooldown before releasing guard
    guard.setAssistantSpeaking(false);
    expect(guard.isGuardActive(fakeNow + 100)).toBe(true);
    expect(guard.isGuardActive(fakeNow + 300)).toBe(false);

    // 4. Genuine near-field human barge-in (high probability + high RMS sustained across required frames) breaks through!
    fakeNow += 500;
    guard.setAssistantSpeaking(true);
    const { requiredFrames } = guard.getThresholds();
    let bargeInTriggered = false;
    for (let i = 0; i < requiredFrames; i += 1) {
      const step = guard.processFrame(0.93, 0.15);
      if (i < requiredFrames - 1) {
        expect(step.bargeIn).toBe(false);
      } else {
        bargeInTriggered = step.bargeIn;
      }
    }
    expect(bargeInTriggered).toBe(true);

    // After confirmed barge-in, stopping TTS immediately releases the guard (no artificial reverb tail blocking user speech)
    guard.setAssistantSpeaking(false);
    expect(guard.isGuardActive()).toBe(false);

    // Disabling echo guard disarms it even while assistant is speaking
    guard.setAssistantSpeaking(true);
    expect(guard.isGuardActive()).toBe(true);
    guard.setEnabled(false);
    expect(guard.isGuardActive()).toBe(false);
  });

  it('suppresses speaker echo in AdaptiveVadDetector without polluting noise floor, while preserving genuine human barge-in', () => {
    const vad = new AdaptiveVadDetector({
      sensitivity: 0.62,
      onsetFrames: 3,
      hangoverFrames: 4,
      echoGuardEnabled: true,
      echoGuardStrength: 0.65,
      echoOnsetFrames: 6,
      reverbTailFrames: 3,
    });
    const quiet = new Float32Array(512);
    // Moderate speaker-echo amplitude (RMS ~0.042) — loud enough to trigger normal VAD when silent,
    // but below echo-guard near-field threshold (~0.071).
    const speakerEcho = makeSineFrame(512, 340, 16000, 0.06);
    // Strong near-field human voice (RMS ~0.18) for genuine barge-in.
    const humanBargeIn = makeSineFrame(512, 320, 16000, 0.26);

    for (let i = 0; i < 6; i += 1) {
      vad.processFrame(quiet);
    }

    // 1. Assistant starts speaking: sustained speaker echo must NOT trigger onset
    vad.setAssistantSpeaking(true);
    for (let i = 0; i < 15; i += 1) {
      const step = vad.processFrame(speakerEcho);
      expect(step.echoGuardActive).toBe(true);
      expect(step.onset).toBe(false);
      expect(step.speechActive).toBe(false);
    }

    // 2. Brief 3-frame loud transient during TTS must NOT trigger onset (< echoOnsetFrames = 6)
    for (let i = 0; i < 3; i += 1) {
      expect(vad.processFrame(humanBargeIn).onset).toBe(false);
    }
    vad.processFrame(quiet);

    // 3. After TTS ends normally + reverb tail drains, noise floor was NOT polluted so moderate speech triggers normally
    vad.setAssistantSpeaking(false);
    for (let i = 0; i < 3; i += 1) {
      // During 3-frame reverb tail, echo is still suppressed
      expect(vad.processFrame(speakerEcho).onset).toBe(false);
    }
    // Now guard is off -> 3 frames of moderate human speech trigger onset normally
    let triggeredAfterTail = false;
    for (let i = 0; i < 4; i += 1) {
      if (vad.processFrame(speakerEcho).onset) triggeredAfterTail = true;
    }
    expect(triggeredAfterTail).toBe(true);
    for (let i = 0; i < 5; i += 1) vad.processFrame(quiet); // close utterance

    // 4. Genuine sustained human barge-in while TTS is actively speaking breaks through on frame #6
    vad.setAssistantSpeaking(true);
    for (let i = 0; i < 5; i += 1) {
      const step = vad.processFrame(humanBargeIn);
      expect(step.onset).toBe(false);
    }
    const bargeStep = vad.processFrame(humanBargeIn);
    expect(bargeStep.onset).toBe(true);
    expect(bargeStep.speechActive).toBe(true);

    // Once app interrupts TTS in response to barge-in, user utterance completes cleanly on trailing silence
    vad.setAssistantSpeaking(false);
    for (let i = 0; i < 3; i += 1) {
      expect(vad.processFrame(quiet).offset).toBe(false);
    }
    expect(vad.processFrame(quiet).offset).toBe(true);
  });

  it('routes finalized VAD WAV audio to main-process STT for macos-speech, whisper-http, and Electron web-speech fallback', () => {
    expect(shouldTranscribeViaMainProcess('macos-speech', false)).toEqual({
      enabled: true,
      fallbackFromWebSpeech: false,
    });
    expect(shouldTranscribeViaMainProcess('whisper-http', false)).toEqual({
      enabled: true,
      fallbackFromWebSpeech: false,
    });
    expect(shouldTranscribeViaMainProcess('web-speech', true)).toEqual({
      enabled: false,
      fallbackFromWebSpeech: false,
    });
    expect(shouldTranscribeViaMainProcess('web-speech', false)).toEqual({
      enabled: true,
      fallbackFromWebSpeech: true,
    });
    expect(shouldTranscribeViaMainProcess('off', false)).toEqual({
      enabled: false,
      fallbackFromWebSpeech: false,
    });
  });

  it('keeps speaking visual state active until the entire TTS queue drains rather than snapping to idle on LLM done', async () => {
    const origWindow = globalThis.window;
    const origUtterance = globalThis.SpeechSynthesisUtterance;
    const pendingUtterances: Array<{ text: string; finish: () => void }> = [];

    class ControlledUtterance {
      text: string;
      lang = '';
      rate = 1;
      pitch = 1;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }

    (globalThis as Record<string, unknown>).SpeechSynthesisUtterance = ControlledUtterance;
    (globalThis as Record<string, unknown>).window = {
      speechSynthesis: {
        speak: (utt: ControlledUtterance) => {
          pendingUtterances.push({ text: utt.text, finish: () => utt.onend?.() });
        },
        cancel: () => undefined,
      },
    };

    try {
      let speaking = false;
      let queued = false;
      const player = new StreamingTtsPlayer({
        synthesize: async ({ text }) => {
          await new Promise((r) => setTimeout(r, 8));
          return { ok: true, providerUsed: 'browser-speech', fallbackText: text };
        },
        abortRemote: async () => undefined,
        onVisemeFrame: () => undefined,
        onSpeakingChanged: (s) => {
          speaking = s;
        },
        onQueueBusyChanged: (q) => {
          queued = q;
        },
      });

      // Enqueue two sentences; immediately simulate LLM `done` transitioning mainActivity -> 'idle'
      player.enqueueSentence('第一句话');
      player.enqueueSentence('第二句话');
      expect(queued).toBe(true);
      expect(resolveEffectivePresenceActivity('idle', { speaking, queued })).toBe('speaking');
      expect(resolveEffectivePresenceActivity('quiet-defer', { speaking, queued })).toBe('speaking');

      // Wait for sentence 1 to start playing
      await new Promise((r) => setTimeout(r, 25));
      expect(speaking).toBe(true);
      expect(pendingUtterances).toHaveLength(1);
      expect(resolveEffectivePresenceActivity('idle', { speaking, queued })).toBe('speaking');

      // Sentence 1 finishes -> sentence 2 still playing, must remain in 'speaking'
      pendingUtterances[0]?.finish();
      await new Promise((r) => setTimeout(r, 25));
      expect(pendingUtterances).toHaveLength(2);
      expect(speaking).toBe(true);
      expect(resolveEffectivePresenceActivity('idle', { speaking, queued })).toBe('speaking');

      // Sentence 2 finishes -> queue is fully drained, now cleanly returns to 'idle'
      pendingUtterances[1]?.finish();
      await new Promise((r) => setTimeout(r, 20));
      expect(speaking).toBe(false);
      expect(queued).toBe(false);
      expect(resolveEffectivePresenceActivity('idle', { speaking, queued })).toBe('idle');
      expect(resolveEffectivePresenceActivity('quiet-defer', { speaking, queued })).toBe('quiet-defer');

      player.dispose();
    } finally {
      (globalThis as Record<string, unknown>).window = origWindow;
      (globalThis as Record<string, unknown>).SpeechSynthesisUtterance = origUtterance;
    }
  });

  it('strips prior assistant echo on Silero mid-echo barge-in and preserves quick post-TTS replies inside open redemption window (SileroEchoSegmentGate)', () => {
    let fakeNow = 10_000;
    const guard = new BargeInEchoGuard({
      enabled: true,
      sensitivity: 0.62,
      strength: 0.65,
      reverbTailMs: 260,
      now: () => fakeNow,
    });
    const gate = new SileroEchoSegmentGate({
      echoGuard: guard,
      sensitivity: 0.62,
      postGuardOnsetFrames: 3,
      prePadFrames: 4,
    });

    const echoFrame = makeSineFrame(512, 340, 16000, 0.05); // RMS ~0.035 (below echo threshold ~0.071)
    const humanFrame = makeSineFrame(512, 320, 16000, 0.25); // RMS ~0.177 (strong near-field human voice)
    const quietFrame = new Float32Array(512);

    // 1. Echo-only segment during TTS -> suppressed completely (null onSpeechEnd)
    guard.setAssistantSpeaking(true);
    expect(gate.onFrame(0.75, echoFrame).triggerSpeechStart).toBe(false);
    expect(gate.onSpeechStart().triggerSpeechStart).toBe(false);
    for (let i = 0; i < 20; i += 1) {
      expect(gate.onFrame(0.75, echoFrame).triggerSpeechStart).toBe(false);
    }
    expect(gate.onSpeechEnd(new Float32Array(21 * 512))).toBeNull();

    // 2. Mid-echo human barge-in after 40 echo frames -> triggers speech start & trims prior echo from audio16k
    const { requiredFrames } = guard.getThresholds();
    expect(gate.onFrame(0.76, echoFrame).triggerSpeechStart).toBe(false);
    expect(gate.onSpeechStart().triggerSpeechStart).toBe(false);
    for (let i = 0; i < 39; i += 1) {
      expect(gate.onFrame(0.76, echoFrame).triggerSpeechStart).toBe(false);
    }

    let bargeTriggered = false;
    for (let i = 0; i < requiredFrames; i += 1) {
      const step = gate.onFrame(0.94, humanFrame);
      if (step.triggerSpeechStart) bargeTriggered = true;
    }
    expect(bargeTriggered).toBe(true);
    guard.setAssistantSpeaking(false); // App interrupts TTS immediately upon barge-in

    const trailingHumanFrames = 10;
    for (let i = 0; i < trailingHumanFrames; i += 1) {
      gate.onFrame(0.88, humanFrame);
    }
    // Build synthetic concatenated segment: 40 echo frames marked -0.02, then barge-in + trailing human marked +0.5
    const totalFrames = 40 + requiredFrames + trailingHumanFrames;
    const rawSegment = new Float32Array(totalFrames * 512);
    rawSegment.fill(-0.02, 0, 40 * 512);
    rawSegment.fill(0.5, 40 * 512);

    const trimmed = gate.onSpeechEnd(rawSegment);
    expect(trimmed).not.toBeNull();
    // Should retain only (requiredFrames + 4 prePad + 10 trailing) frames, stripping 36 frames of prior echo!
    const expectedFrames = requiredFrames + 4 + trailingHumanFrames;
    expect(trimmed?.length).toBe(expectedFrames * 512);
    // Tail contains human samples, NOT the entire 40-frame echo prefix
    expect(trimmed?.[trimmed.length - 1]).toBe(0.5);

    // 3. Quick human reply right after TTS ends (within Silero's 520ms redemption window, no new onSpeechStart)
    fakeNow += 1_000;
    guard.setAssistantSpeaking(true);
    expect(gate.onFrame(0.76, echoFrame).triggerSpeechStart).toBe(false);
    expect(gate.onSpeechStart().triggerSpeechStart).toBe(false);
    for (let i = 0; i < 29; i += 1) {
      gate.onFrame(0.76, echoFrame);
    }

    // TTS stops naturally; reverb tail holds for 260ms, then expires at +300ms while Silero segment stays open
    guard.setAssistantSpeaking(false);
    fakeNow += 150;
    expect(gate.onFrame(0.72, echoFrame).triggerSpeechStart).toBe(false); // still inside reverb tail
    fakeNow += 160; // +310ms > 260ms reverbTailMs -> guard inactive!

    // User speaks normally for 3 onset frames + 8 more frames -> must NOT be discarded!
    let postTtsTriggered = false;
    for (let i = 0; i < 3; i += 1) {
      if (gate.onFrame(0.74, echoFrame).triggerSpeechStart) postTtsTriggered = true;
    }
    expect(postTtsTriggered).toBe(true);
    for (let i = 0; i < 8; i += 1) {
      gate.onFrame(0.74, quietFrame);
    }

    const postTtsSegment = new Float32Array(42 * 512);
    const postTtsAudio = gate.onSpeechEnd(postTtsSegment);
    expect(postTtsAudio).not.toBeNull();
    expect(postTtsAudio?.length).toBe((3 + 4 + 8) * 512); // Prior echo frames trimmed cleanly

    // 4. Normal quiet-room speech passes full segment untouched
    expect(gate.onFrame(0.85, humanFrame).triggerSpeechStart).toBe(false);
    expect(gate.onSpeechStart().triggerSpeechStart).toBe(true);
    const normalAudio = new Float32Array(12 * 512);
    expect(gate.onSpeechEnd(normalAudio)?.length).toBe(12 * 512);
  });

  it('halts rapid silent webkitSpeechRecognition restart loops in Electron and triggers macos-speech fallback callback', async () => {
    const origWindow = globalThis.window;
    const origNavigator = globalThis.navigator;
    let startCount = 0;
    let unavailableReason = '';

    class SilentLoopSpeechRecognition {
      continuous = false;
      interimResults = false;
      lang = '';
      onresult: ((ev: unknown) => void) | null = null;
      onerror: ((ev: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start(): void {
        startCount += 1;
        // Simulate standalone Electron Chromium silently ending recognition immediately with no error/result
        queueMicrotask(() => {
          this.onend?.();
        });
      }
      stop(): void {
        // no-op
      }
    }

    (globalThis as Record<string, unknown>).window = {
      location: { href: 'http://127.0.0.1:5179/' },
      webkitSpeechRecognition: SilentLoopSpeechRecognition,
    };
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        mediaDevices: {
          getUserMedia: async () => {
            throw new Error('no-mic-in-unit-test');
          },
        },
      },
      configurable: true,
    });

    try {
      const ctrl = new PresenceVoiceVadController({
        onSpeechStart: () => undefined,
        onSpeechEnd: () => undefined,
        onWebSpeechUnavailable: (reason) => {
          unavailableReason = reason;
        },
        onError: () => undefined,
      });

      // Kick off start() — WebSpeech starts synchronously before async VAD/mic checks
      const startPromise = ctrl.start({ useWebSpeech: true, locale: 'zh-CN' });
      await new Promise((r) => setTimeout(r, 20));
      await startPromise;

      expect(unavailableReason).toBe('silent-restart-loop');
      expect(ctrl.isWebSpeechActive).toBe(false);
      expect(startCount).toBe(3); // Stopped cleanly instead of infinite loop!
      ctrl.stop();
    } finally {
      (globalThis as Record<string, unknown>).window = origWindow;
      Object.defineProperty(globalThis, 'navigator', {
        value: origNavigator,
        configurable: true,
      });
    }
  });

  it('handles synthesize() rejection after interrupt() without unhandled promise rejection or stuck speaking state', async () => {
    const holder: { reject?: (err: Error) => void } = {};
    const player = new StreamingTtsPlayer({
      synthesize: () =>
        new Promise((_resolve, reject) => {
          holder.reject = reject;
        }),
      abortRemote: async () => undefined,
      onVisemeFrame: () => undefined,
    });

    player.enqueueSentence('将被中断的句子');
    expect(player.isQueueBusy).toBe(true);
    player.interrupt();
    expect(player.isQueueBusy).toBe(false);
    expect(player.isSpeaking).toBe(false);

    // Reject the orphaned in-flight synthesis promise — must NOT throw unhandledRejection
    holder.reject?.(new Error('IPC aborted'));
    await new Promise((r) => setTimeout(r, 15));
    expect(player.isQueueBusy).toBe(false);
    expect(player.isSpeaking).toBe(false);
    player.dispose();
  });
});
