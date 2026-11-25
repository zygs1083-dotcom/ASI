import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PresenceConfig, PresenceSecrets } from '@asi/omni-router';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type { TtsSynthesizeResult } from '../shared/ipc-api.ts';

export interface TtsServiceDeps {
  getConfig: () => Promise<PresenceConfig>;
  getSecrets: () => Promise<PresenceSecrets>;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
}

/**
 * Escapes XML special characters so MsEdgeTTS SSML templates never break on `<`, `>`, `&`, quotes.
 */
export function escapeSsmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Multi-tier streaming sentence TTS synthesizer:
 * 1. Built-in free neural Chinese voice via Edge-TTS (`zh-CN-XiaoyiNeural` default for 雪儿).
 * 2. Extensible OpenAI-compatible HTTP TTS (OpenAI / FishSpeech / Kokoro / ElevenLabs proxy).
 * 3. Offline macOS native `say` synthesizer producing clean WAV buffers (temp file immediately unlinked).
 * 4. Browser SpeechSynthesis text fallback so speech never silently stalls.
 */
export class PresenceTtsService {
  private readonly deps: TtsServiceDeps;
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(deps: TtsServiceDeps) {
    this.deps = deps;
  }

  abort(utteranceId?: string): void {
    if (utteranceId) {
      const ctrl = this.activeControllers.get(utteranceId);
      ctrl?.abort(new Error('Interrupted'));
      this.activeControllers.delete(utteranceId);
      return;
    }
    for (const [id, ctrl] of this.activeControllers.entries()) {
      ctrl.abort(new Error('Interrupted'));
      this.activeControllers.delete(id);
    }
  }

  async synthesize(text: string, utteranceId: string): Promise<TtsSynthesizeResult> {
    const clean = text.trim();
    if (!clean) {
      return { ok: false, providerUsed: 'browser-speech', error: 'Empty speech text' };
    }

    const controller = new AbortController();
    this.activeControllers.set(utteranceId, controller);

    try {
      const [config, secrets] = await Promise.all([this.deps.getConfig(), this.deps.getSecrets()]);
      const { voice } = config;
      const platform = this.deps.platform ?? process.platform;

      if (voice.ttsProvider === 'browser-speech') {
        return { ok: true, providerUsed: 'browser-speech', fallbackText: clean };
      }

      if (voice.ttsProvider === 'openai-compatible') {
        try {
          const buf = await this.synthesizeOpenAiCompatible(clean, config, secrets.customTtsApiKey, controller.signal);
          return {
            ok: true,
            providerUsed: 'openai-compatible',
            mimeType: 'audio/mpeg',
            audioBase64: buf.toString('base64'),
          };
        } catch {
          if (controller.signal.aborted) {
            return { ok: false, providerUsed: 'openai-compatible', error: 'Aborted' };
          }
        }
      }

      if (voice.ttsProvider === 'edge-tts') {
        try {
          const buf = await this.synthesizeEdgeTts(
            clean,
            voice.edgeVoice,
            voice.ttsRate,
            voice.ttsPitch,
            controller.signal,
          );
          return {
            ok: true,
            providerUsed: 'edge-tts',
            mimeType: 'audio/mpeg',
            audioBase64: buf.toString('base64'),
          };
        } catch {
          if (controller.signal.aborted) {
            return { ok: false, providerUsed: 'edge-tts', error: 'Aborted' };
          }
        }
      }

      // Offline native macOS `say` fallback
      if (platform === 'darwin') {
        try {
          const wav = await this.synthesizeMacOsSay(clean, controller.signal);
          return {
            ok: true,
            providerUsed: 'macos-say',
            mimeType: 'audio/wav',
            audioBase64: wav.toString('base64'),
          };
        } catch {
          if (controller.signal.aborted) {
            return { ok: false, providerUsed: 'macos-say', error: 'Aborted' };
          }
        }
      }

      return {
        ok: true,
        providerUsed: 'browser-speech',
        fallbackText: clean,
      };
    } finally {
      this.activeControllers.delete(utteranceId);
    }
  }

  private async synthesizeEdgeTts(
    text: string,
    voiceName: string,
    rate: string,
    pitch: string,
    signal: AbortSignal,
  ): Promise<Buffer> {
    if (signal.aborted) throw new Error('Aborted');
    const tts = new MsEdgeTTS({ connectionTimeoutMs: 7000, synthesisTimeoutMs: 9000 });
    const abortEarly = () => {
      try {
        tts.close();
      } catch {
        // Ignore close errors during abort
      }
    };
    signal.addEventListener('abort', abortEarly, { once: true });

    try {
      await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      if (signal.aborted) {
        throw new Error('Aborted');
      }

      return await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let settled = false;

        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          signal.removeEventListener('abort', onAbort);
          try {
            tts.close();
          } catch {
            // Ignore close errors
          }
          if (err) {
            reject(err);
          } else {
            const combined = Buffer.concat(chunks);
            if (combined.length === 0) {
              reject(new Error('Edge-TTS returned empty audio'));
            } else {
              resolve(combined);
            }
          }
        };

        const onAbort = () => finish(new Error('Aborted'));
        if (signal.aborted) {
          finish(new Error('Aborted'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        const timeout = setTimeout(() => finish(new Error('Edge-TTS timed out')), 9000);

        const { audioStream } = tts.toStream(escapeSsmlText(text), { rate, pitch });
        audioStream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        audioStream.on('end', () => finish());
        audioStream.on('error', (err: Error) => finish(err));
      });
    } finally {
      signal.removeEventListener('abort', abortEarly);
      abortEarly();
    }
  }

  private async synthesizeOpenAiCompatible(
    text: string,
    config: PresenceConfig,
    apiKey: string | undefined,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const fetchFn = this.deps.fetchImpl ?? fetch;
    const baseUrl = config.voice.customTtsBaseUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await fetchFn(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.voice.customTtsModel,
        voice: config.voice.customTtsVoice,
        input: text,
        response_format: 'mp3',
      }),
      signal,
    });
    if (!res.ok) {
      throw new Error(`Custom TTS HTTP ${res.status}`);
    }
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  private async runMacOsSay(args: string[], signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Aborted'));
        return;
      }
      const child = spawn('/usr/bin/say', args, { stdio: 'ignore' });
      const onAbort = () => {
        child.kill('SIGTERM');
        reject(new Error('Aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      child.once('error', (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      });
      child.once('close', (code) => {
        signal.removeEventListener('abort', onAbort);
        if (code === 0) resolve();
        else reject(new Error(`macOS say exited with code ${code ?? -1}`));
      });
    });
  }

  private async synthesizeMacOsSay(text: string, signal: AbortSignal): Promise<Buffer> {
    const outPath = join(tmpdir(), `asi-presence-say-${randomUUID().slice(0, 10)}.wav`);
    try {
      try {
        await this.runMacOsSay(
          ['-v', 'Tingting', '-r', '195', '--file-format=WAVE', '--data-format=LEI16@24000', '-o', outPath, '--', text],
          signal,
        );
      } catch (err) {
        if (signal.aborted) throw err;
        // Fallback to macOS default voice if Tingting is not installed on this Mac
        await this.runMacOsSay(
          ['-r', '195', '--file-format=WAVE', '--data-format=LEI16@24000', '-o', outPath, '--', text],
          signal,
        );
      }
      return await readFile(outPath);
    } finally {
      await rm(outPath, { force: true }).catch(() => undefined);
    }
  }
}
