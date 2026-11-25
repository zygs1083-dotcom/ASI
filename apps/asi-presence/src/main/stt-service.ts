import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PresenceConfig, PresenceSecrets } from '@asi/omni-router';
import type { SttTranscribeResult } from '../shared/ipc-api.ts';

const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_HELPER_STDOUT_BYTES = 256 * 1024;
const MAX_HELPER_STDERR_BYTES = 16 * 1024;
const DEFAULT_MACOS_SPEECH_TIMEOUT_MS = 12_000;
const DEFAULT_WHISPER_TIMEOUT_MS = 15_000;

export interface SttServiceDeps {
  getConfig: () => Promise<PresenceConfig>;
  getSecrets: () => Promise<PresenceSecrets>;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  /** Optional explicit path to `asi-speech-helper` binary (for packaging and tests). */
  speechHelperPath?: string;
  /** Optional custom process spawner (primarily for isolated tests). */
  spawnImpl?: typeof spawn;
  /** Per-utterance timeout for macOS Speech helper in ms (default 12_000). */
  macosSpeechTimeoutMs?: number;
  /** Per-utterance timeout for Whisper HTTP in ms (default 15_000). */
  whisperTimeoutMs?: number;
  /** Optional env lookup override (for isolated tests). */
  env?: Record<string, string | undefined>;
}

export interface TranscribeOptions {
  /** When `web-speech` is unavailable in standalone Electron, allow seamless fallback to `macos-speech` on macOS. */
  allowMacOsFallback?: boolean;
  signal?: AbortSignal;
}

interface MacOsHelperJson {
  ok?: boolean;
  text?: string;
  code?: string;
  error?: string;
  authStatus?: string;
  locale?: string;
  onDevice?: boolean;
}

function isExecutableFile(filePath: string): boolean {
  if (!filePath || !existsSync(filePath)) return false;
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveMacOsSpeechHelperPath(options?: {
  overridePath?: string;
  env?: Record<string, string | undefined>;
  moduleDir?: string;
  resourcesPath?: string;
}): string | null {
  const env = options?.env ?? process.env;
  const moduleDir = options?.moduleDir ?? dirname(fileURLToPath(import.meta.url));
  const resourcesPath =
    options?.resourcesPath ??
    (typeof (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath === 'string'
      ? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
      : undefined);

  if (options?.overridePath !== undefined) {
    const explicit = options.overridePath.trim();
    return explicit && isExecutableFile(explicit) ? explicit : null;
  }

  const candidates = [
    env.ASI_SPEECH_HELPER_PATH?.trim() ?? '',
    join(moduleDir, 'asi-speech-helper'),
    resolve(moduleDir, '../../dist/main/asi-speech-helper'),
    resourcesPath ? join(resourcesPath, 'asi-speech-helper') : '',
    resolve(moduleDir, '../../../native/asi-speech-helper/.build/release/asi-speech-helper'),
    resolve(moduleDir, '../../../../native/asi-speech-helper/.build/release/asi-speech-helper'),
    resolve(moduleDir, '../../../native/asi-speech-helper/.build/arm64-apple-macosx/release/asi-speech-helper'),
    resolve(moduleDir, '../../../../native/asi-speech-helper/.build/arm64-apple-macosx/release/asi-speech-helper'),
    resolve(moduleDir, '../../../native/asi-speech-helper/.build/x86_64-apple-macosx/release/asi-speech-helper'),
    resolve(moduleDir, '../../../../native/asi-speech-helper/.build/x86_64-apple-macosx/release/asi-speech-helper'),
  ];

  for (const candidate of candidates) {
    if (candidate && isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

function linkExternalSignal(external: AbortSignal | undefined, internal: AbortController): () => void {
  if (!external) return () => undefined;
  if (external.aborted) {
    internal.abort(external.reason ?? new Error('Aborted'));
    return () => undefined;
  }
  const onAbort = () => internal.abort(external.reason ?? new Error('Aborted'));
  external.addEventListener('abort', onAbort, { once: true });
  return () => external.removeEventListener('abort', onAbort);
}

/**
 * Pluggable Speech-to-Text service.
 * - `macos-speech`: Native Apple `Speech` CLI helper (`asi-speech-helper`) streaming in-memory WAV bytes over stdin (zero disk writes).
 * - `whisper-http`: OpenAI Whisper / local whisper.cpp HTTP endpoints using in-memory WAV buffers (never written to disk).
 * - `web-speech`: Handled in renderer, with seamless macOS native fallback when Chromium WebSpeech is unavailable in Electron.
 */
export class PresenceSttService {
  private readonly deps: SttServiceDeps;
  private readonly activeControllers = new Set<AbortController>();
  private hasAttemptedMacOsSpeechAuth = false;

  constructor(deps: SttServiceDeps) {
    this.deps = deps;
  }

  abort(): void {
    for (const ctrl of this.activeControllers) {
      ctrl.abort(new Error('Aborted'));
    }
    this.activeControllers.clear();
  }

  async transcribeWavBase64(wavBase64: string, options: TranscribeOptions = {}): Promise<SttTranscribeResult> {
    const [config, secrets] = await Promise.all([this.deps.getConfig(), this.deps.getSecrets()]);
    const provider = config.voice.sttProvider;
    const platform = this.deps.platform ?? process.platform;

    if (provider === 'off') {
      return { ok: false, text: '', providerUsed: 'off', errorCode: 'disabled', error: 'STT disabled' };
    }

    if (provider === 'web-speech') {
      if (options.allowMacOsFallback) {
        if (platform === 'darwin') {
          return this.runTracked(options.signal, (sig) => this.transcribeMacOsSpeech(wavBase64, config, sig));
        }
        return {
          ok: false,
          text: '',
          providerUsed: 'web-speech',
          errorCode: 'web_speech_unavailable',
          error: '当前 Electron 环境无法使用浏览器 WebSpeech，请在设置中切换本地 Whisper HTTP 端点。',
        };
      }
      return {
        ok: false,
        text: '',
        providerUsed: 'web-speech',
        errorCode: 'renderer_managed',
        error: 'Web Speech STT runs in renderer process',
      };
    }

    if (provider === 'macos-speech') {
      if (platform !== 'darwin') {
        return {
          ok: false,
          text: '',
          providerUsed: 'macos-speech',
          errorCode: 'unsupported_platform',
          error: 'macOS 原生语音识别仅支持 macOS（当前系统请改用本地 Whisper HTTP 或 WebSpeech）',
        };
      }
      return this.runTracked(options.signal, (sig) => this.transcribeMacOsSpeech(wavBase64, config, sig));
    }

    return this.runTracked(options.signal, (sig) => this.transcribeWhisperHttp(wavBase64, config, secrets, sig));
  }

  private async runTracked(
    externalSignal: AbortSignal | undefined,
    runner: (signal: AbortSignal) => Promise<SttTranscribeResult>,
  ): Promise<SttTranscribeResult> {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const unlink = linkExternalSignal(externalSignal, controller);
    try {
      return await runner(controller.signal);
    } finally {
      unlink();
      this.activeControllers.delete(controller);
    }
  }

  private decodeWavPayload(
    wavBase64: string,
    providerUsed: 'macos-speech' | 'whisper-http',
  ): { bytes: Buffer } | { error: SttTranscribeResult } {
    const trimmed = wavBase64.trim();
    if (!trimmed) {
      return {
        error: {
          ok: false,
          text: '',
          providerUsed,
          errorCode: 'empty_audio',
          error: 'Empty audio payload',
        },
      };
    }
    const bytes = Buffer.from(trimmed, 'base64');
    if (bytes.byteLength === 0) {
      return {
        error: {
          ok: false,
          text: '',
          providerUsed,
          errorCode: 'empty_audio',
          error: 'Empty audio payload',
        },
      };
    }
    if (bytes.byteLength > MAX_AUDIO_BYTES) {
      return {
        error: {
          ok: false,
          text: '',
          providerUsed,
          errorCode: 'audio_too_large',
          error: 'Audio payload exceeds 16 MiB safety limit',
        },
      };
    }
    return { bytes };
  }

  private async transcribeMacOsSpeech(
    wavBase64: string,
    config: PresenceConfig,
    signal: AbortSignal,
  ): Promise<SttTranscribeResult> {
    if (signal.aborted) {
      return { ok: false, text: '', providerUsed: 'macos-speech', errorCode: 'aborted', error: 'Aborted' };
    }

    const decoded = this.decodeWavPayload(wavBase64, 'macos-speech');
    if ('error' in decoded) return decoded.error;

    const helperPath =
      this.deps.spawnImpl && this.deps.speechHelperPath
        ? this.deps.speechHelperPath
        : resolveMacOsSpeechHelperPath({
            ...(this.deps.speechHelperPath !== undefined ? { overridePath: this.deps.speechHelperPath } : {}),
            ...(this.deps.env ? { env: this.deps.env } : {}),
          });

    if (!helperPath) {
      return {
        ok: false,
        text: '',
        providerUsed: 'macos-speech',
        errorCode: 'helper_not_found',
        error:
          '未找到 macOS 语音助手 asi-speech-helper，请先运行 native/asi-speech-helper/scripts/build.sh 编译，或在设置中切换 Whisper HTTP。',
      };
    }

    const baseTimeoutMs = Math.max(100, this.deps.macosSpeechTimeoutMs ?? DEFAULT_MACOS_SPEECH_TIMEOUT_MS);
    const helperTimeoutArg = Math.max(1_000, Math.min(60_000, baseTimeoutMs));
    const locale = config.voice.sttLocale?.trim() || 'zh-CN';
    const args = ['--locale', locale, '--timeout-ms', String(helperTimeoutArg)];

    // Request macOS Speech authorization at most once per app session to avoid dialog spam.
    const requestingAuth = !this.hasAttemptedMacOsSpeechAuth;
    if (requestingAuth) {
      args.push('--request-auth');
    }

    // When using the default timeout on the first-run TCC authorization attempt, add headroom for
    // the 15s OS permission dialog so we don't SIGTERM the helper while the user reads the prompt.
    const timeoutMs =
      requestingAuth && this.deps.macosSpeechTimeoutMs === undefined ? baseTimeoutMs + 16_000 : baseTimeoutMs;

    const spawnFn = this.deps.spawnImpl ?? spawn;

    return await new Promise<SttTranscribeResult>((resolveResult) => {
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let killEscalationTimer: ReturnType<typeof setTimeout> | null = null;

      let child: ReturnType<typeof spawn>;
      try {
        child = spawnFn(helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        resolveResult({
          ok: false,
          text: '',
          providerUsed: 'macos-speech',
          errorCode: 'spawn_failed',
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (requestingAuth) {
        this.hasAttemptedMacOsSpeechAuth = true;
      }

      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      const stderrChunks: Buffer[] = [];
      let stderrBytes = 0;

      const killChild = () => {
        try {
          if (!child.killed) {
            child.kill('SIGTERM');
          }
        } catch {
          // Process may have already exited
        }
        if (killEscalationTimer === null) {
          killEscalationTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // Ignore
            }
          }, 400);
          killEscalationTimer.unref?.();
        }
      };

      const finish = (result: SttTranscribeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (killEscalationTimer !== null) {
          clearTimeout(killEscalationTimer);
          killEscalationTimer = null;
        }
        signal.removeEventListener('abort', onAbort);
        resolveResult(result);
      };

      const onAbort = () => {
        aborted = true;
        killChild();
        finish({
          ok: false,
          text: '',
          providerUsed: 'macos-speech',
          errorCode: 'aborted',
          error: 'Aborted',
        });
      };

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        killChild();
        finish({
          ok: false,
          text: '',
          providerUsed: 'macos-speech',
          errorCode: 'timeout',
          error: `macOS 语音识别超时（>${timeoutMs}ms）`,
        });
      }, timeoutMs);
      timeoutTimer.unref?.();

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutBytes >= MAX_HELPER_STDOUT_BYTES) return;
        const remain = MAX_HELPER_STDOUT_BYTES - stdoutBytes;
        const slice = chunk.length > remain ? chunk.subarray(0, remain) : chunk;
        stdoutChunks.push(slice);
        stdoutBytes += slice.length;
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBytes >= MAX_HELPER_STDERR_BYTES) return;
        const remain = MAX_HELPER_STDERR_BYTES - stderrBytes;
        const slice = chunk.length > remain ? chunk.subarray(0, remain) : chunk;
        stderrChunks.push(slice);
        stderrBytes += slice.length;
      });

      child.once('error', (err) => {
        if (requestingAuth && stdoutBytes === 0 && stderrBytes === 0) {
          this.hasAttemptedMacOsSpeechAuth = false;
        }
        finish({
          ok: false,
          text: '',
          providerUsed: 'macos-speech',
          errorCode: 'spawn_failed',
          error: err.message,
        });
      });

      child.once('close', (code) => {
        if (aborted || timedOut) return;
        const stdoutText = Buffer.concat(stdoutChunks).toString('utf8').trim();
        const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();

        if (stdoutText) {
          // Support single JSON line (or take the last JSON line if any extraneous notice was emitted).
          const lines = stdoutText
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean);
          const candidateLine = lines[lines.length - 1] ?? stdoutText;
          try {
            const parsed = JSON.parse(candidateLine) as MacOsHelperJson;
            if (parsed.ok === true) {
              finish({
                ok: true,
                text: (parsed.text ?? '').trim(),
                providerUsed: 'macos-speech',
                ...(parsed.code ? { errorCode: parsed.code } : {}),
              });
              return;
            }
            finish({
              ok: false,
              text: '',
              providerUsed: 'macos-speech',
              ...(parsed.code ? { errorCode: parsed.code } : {}),
              error: parsed.error || `macOS Speech helper error (${parsed.code ?? `exit ${code ?? -1}`})`,
            });
            return;
          } catch {
            // Fall through to non-JSON error handling
          }
        }

        finish({
          ok: false,
          text: '',
          providerUsed: 'macos-speech',
          errorCode: 'helper_failed',
          error: stderrText || `asi-speech-helper exited with code ${code ?? -1}`,
        });
      });

      // Stream WAV bytes purely in memory over stdin; swallow EPIPE if helper exits early (e.g. permission denied).
      if (child.stdin) {
        child.stdin.on('error', () => undefined);
        child.stdin.end(decoded.bytes);
      }
    });
  }

  private async transcribeWhisperHttp(
    wavBase64: string,
    config: PresenceConfig,
    secrets: PresenceSecrets,
    signal: AbortSignal,
  ): Promise<SttTranscribeResult> {
    if (signal.aborted) {
      return { ok: false, text: '', providerUsed: 'whisper-http', errorCode: 'aborted', error: 'Aborted' };
    }
    const decoded = this.decodeWavPayload(wavBase64, 'whisper-http');
    if ('error' in decoded) return decoded.error;

    const fetchFn = this.deps.fetchImpl ?? fetch;
    const baseUrl = config.voice.whisperBaseUrl.replace(/\/+$/, '');
    const langShort = (config.voice.sttLocale || 'zh-CN').split('-')[0] || 'zh';

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(decoded.bytes)], { type: 'audio/wav' }), 'utterance.wav');
    form.append('model', 'whisper-1');
    form.append('language', langShort);

    const headers: Record<string, string> = {};
    if (secrets.whisperApiKey) {
      headers.Authorization = `Bearer ${secrets.whisperApiKey}`;
    }

    const reqController = new AbortController();
    const unlink = linkExternalSignal(signal, reqController);
    const timeoutMs = Math.max(500, this.deps.whisperTimeoutMs ?? DEFAULT_WHISPER_TIMEOUT_MS);
    const timeoutTimer = setTimeout(() => reqController.abort(new Error('Whisper HTTP timed out')), timeoutMs);
    timeoutTimer.unref?.();

    try {
      const response = await fetchFn(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers,
        body: form,
        signal: reqController.signal,
      });
      if (!response.ok) {
        return {
          ok: false,
          text: '',
          providerUsed: 'whisper-http',
          errorCode: `http_${response.status}`,
          error: `Whisper HTTP ${response.status}`,
        };
      }
      const data = (await response.json()) as { text?: string };
      return {
        ok: true,
        text: (data.text ?? '').trim(),
        providerUsed: 'whisper-http',
      };
    } catch (error) {
      if (signal.aborted) {
        return {
          ok: false,
          text: '',
          providerUsed: 'whisper-http',
          errorCode: 'aborted',
          error: 'Aborted',
        };
      }
      return {
        ok: false,
        text: '',
        providerUsed: 'whisper-http',
        errorCode: 'network_error',
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeoutTimer);
      unlink();
    }
  }
}
