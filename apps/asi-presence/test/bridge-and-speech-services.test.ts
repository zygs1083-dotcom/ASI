import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultPresenceConfig } from '@asi/omni-router';
import { createOfflineBridgeSnapshot } from '@asi/presence-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { PresenceBridgeClient } from '../src/main/bridge-client.ts';
import { PresenceSttService, resolveMacOsSpeechHelperPath } from '../src/main/stt-service.ts';
import { escapeSsmlText, PresenceTtsService } from '../src/main/tts-service.ts';
import { bytesToBase64, encodeFloat32ToWavBytes } from '../src/renderer/audio/vad-engine.ts';

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function startHttpMock(
  handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void | Promise<void>,
): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void Promise.resolve(handler(req, res, Buffer.concat(chunks)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to listen');
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${addr.port}`;
}

describe('PresenceBridgeClient, TTS & STT Main-Process Services', () => {
  it('auto-discovers bridge file, authenticates via Bearer header, receives snapshots, and completes RPC round-trips', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-bridge-client-'));
    tempDirs.push(dir);
    const discoveryPath = join(dir, 'presence-bridge.json');
    const token = randomBytes(32).toString('hex');

    let seenAuth = '';
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/ws' });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    const addr = wss.address();
    if (!addr || typeof addr === 'string') throw new Error('WSS failed to bind');

    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          wss.close(() => resolve());
        }),
    );

    wss.on('connection', (socket, req) => {
      seenAuth = String(req.headers.authorization ?? '');
      const liveSnap = createOfflineBridgeSnapshot(Date.now());
      liveSnap.connected = true;
      liveSnap.asiVersion = '0.7.0';
      liveSnap.sleep.totalMemories = 42;
      socket.send(
        JSON.stringify({
          type: 'hello',
          protocolVersion: 1,
          asiVersion: '0.7.0',
          snapshot: liveSnap,
        }),
      );
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString('utf8')) as { type: string; id?: string; method?: string };
        if (msg.type === 'rpc.request' && msg.id && msg.method === 'memory.recall') {
          socket.send(
            JSON.stringify({
              type: 'rpc.response',
              id: msg.id,
              ok: true,
              result: {
                hits: [
                  {
                    id: 'm1',
                    kind: 'preference',
                    title: '雪儿主题',
                    content: '偏爱雪白冰青全息光色',
                    tags: ['theme'],
                    pinned: true,
                    retention: 0.99,
                    updatedAt: Date.now(),
                  },
                ],
              },
            }),
          );
        }
      });
    });

    await writeFile(
      discoveryPath,
      JSON.stringify({
        version: 1,
        host: '127.0.0.1',
        port: addr.port,
        wsPath: '/ws',
        token,
        pid: process.pid,
        startedAt: Date.now(),
        asiVersion: '0.7.0',
      }),
      { mode: 0o600 },
    );

    const client = new PresenceBridgeClient({ discoveryPath, reconnectIntervalMs: 100 });
    cleanups.push(() => client.stop());

    const connectedSnap = await new Promise<ReturnType<PresenceBridgeClient['getSnapshot']>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Bridge client connect timeout')), 4000);
      client.subscribeSnapshot((snap) => {
        if (snap.connected) {
          clearTimeout(timer);
          resolve(snap);
        }
      });
      client.start();
    });

    expect(seenAuth).toBe(`Bearer ${token}`);
    expect(connectedSnap.sleep.totalMemories).toBe(42);

    const recalled = await client.recallMemory('雪儿主题', 3);
    expect(recalled.length).toBe(1);
    expect(recalled[0]?.title).toBe('雪儿主题');
  });

  it('synthesizes audio via OpenAI-compatible HTTP TTS, falls back to browser-speech cleanly, and supports Whisper HTTP STT', async () => {
    const fakeMp3 = Buffer.from('ID3-fake-mp3-stream-bytes');
    const mockUrl = await startHttpMock((req, res) => {
      if (req.url === '/v1/audio/speech') {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.end(fakeMp3);
        return;
      }
      if (req.url === '/v1/audio/transcriptions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: '雪儿早上好' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const cfg = createDefaultPresenceConfig();
    cfg.voice.ttsProvider = 'openai-compatible';
    cfg.voice.customTtsBaseUrl = `${mockUrl}/v1`;
    cfg.voice.sttProvider = 'whisper-http';
    cfg.voice.whisperBaseUrl = `${mockUrl}/v1`;

    const tts = new PresenceTtsService({
      getConfig: async () => cfg,
      getSecrets: async () => ({}),
      platform: 'linux',
    });

    const ttsRes = await tts.synthesize('你好，我是雪儿', 'utt-1');
    expect(ttsRes.ok).toBe(true);
    expect(ttsRes.providerUsed).toBe('openai-compatible');
    expect(ttsRes.audioBase64).toBe(fakeMp3.toString('base64'));

    // Fallback to browser-speech when endpoint unreachable on non-darwin
    cfg.voice.customTtsBaseUrl = 'http://127.0.0.1:1/v1';
    const fallbackRes = await tts.synthesize('离线回退测试', 'utt-2');
    expect(fallbackRes.ok).toBe(true);
    expect(fallbackRes.providerUsed).toBe('browser-speech');
    expect(fallbackRes.fallbackText).toBe('离线回退测试');

    // Whisper HTTP STT
    const stt = new PresenceSttService({
      getConfig: async () => cfg,
      getSecrets: async () => ({}),
    });
    const sttRes = await stt.transcribeWavBase64(Buffer.from('RIFFdemo').toString('base64'));
    expect(sttRes.ok).toBe(true);
    expect(sttRes.providerUsed).toBe('whisper-http');
    expect(sttRes.text).toBe('雪儿早上好');

    // SSML XML escaping prevents Edge-TTS failures on '<', '>', '&', quotes
    expect(escapeSsmlText('a < b && c > "d" \'e\'')).toBe('a &lt; b &amp;&amp; c &gt; &quot;d&quot; &apos;e&apos;');
  });

  it('streams in-memory WAV bytes to macos-speech helper over stdin, avoids auth dialog spam, handles permission/timeout/abort, and supports web-speech fallback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-speech-helper-test-'));
    tempDirs.push(dir);

    const wavBytes = encodeFloat32ToWavBytes(new Float32Array(1600), 16000);
    const wavBase64 = bytesToBase64(wavBytes);
    const argsLogPath = join(dir, 'args-log.jsonl');

    // 1. Real executable helper verifying stdin RIFF/WAVE bytes & single-attempt --request-auth
    const okHelperPath = join(dir, 'fake-speech-ok.mjs');
    await writeFile(
      okHelperPath,
      [
        '#!/usr/bin/env node',
        'import { appendFileSync } from "node:fs";',
        `const logPath = ${JSON.stringify(argsLogPath)};`,
        'const chunks = [];',
        'for await (const chunk of process.stdin) chunks.push(chunk);',
        'const data = Buffer.concat(chunks);',
        'const isWav = data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WAVE";',
        'appendFileSync(logPath, JSON.stringify({ argv: process.argv.slice(2), bytes: data.length, isWav }) + "\\n");',
        'process.stdout.write(JSON.stringify({ ok: true, text: isWav ? "雪儿你好呀" : "bad", locale: "zh-CN", onDevice: true, authStatus: "authorized" }) + "\\n");',
      ].join('\n'),
      { mode: 0o755 },
    );
    await chmod(okHelperPath, 0o755);

    expect(resolveMacOsSpeechHelperPath({ overridePath: okHelperPath })).toBe(okHelperPath);

    const cfg = createDefaultPresenceConfig('darwin');
    expect(cfg.voice.sttProvider).toBe('macos-speech');

    const stt = new PresenceSttService({
      getConfig: async () => cfg,
      getSecrets: async () => ({}),
      platform: 'darwin',
      speechHelperPath: okHelperPath,
    });

    const res1 = await stt.transcribeWavBase64(wavBase64);
    expect(res1.ok).toBe(true);
    expect(res1.providerUsed).toBe('macos-speech');
    expect(res1.text).toBe('雪儿你好呀');

    // Second invocation must NOT pass --request-auth again (prevents OS dialog spam)
    const res2 = await stt.transcribeWavBase64(wavBase64);
    expect(res2.ok).toBe(true);
    expect(res2.text).toBe('雪儿你好呀');

    const calls = (await readFile(argsLogPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { argv: string[]; bytes: number; isWav: boolean });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.isWav).toBe(true);
    expect(calls[0]?.bytes).toBe(wavBytes.byteLength);
    expect(calls[0]?.argv).toContain('--locale');
    expect(calls[0]?.argv).toContain('zh-CN');
    expect(calls[0]?.argv).toContain('--request-auth');
    expect(calls[1]?.argv).not.toContain('--request-auth');

    // 2. Seamless web-speech -> macos-speech fallback on darwin when Chromium WebSpeech is unavailable in Electron
    const webCfg = createDefaultPresenceConfig('linux');
    expect(webCfg.voice.sttProvider).toBe('web-speech');
    const fallbackStt = new PresenceSttService({
      getConfig: async () => webCfg,
      getSecrets: async () => ({}),
      platform: 'darwin',
      speechHelperPath: okHelperPath,
    });
    const fbRes = await fallbackStt.transcribeWavBase64(wavBase64, { allowMacOsFallback: true });
    expect(fbRes.ok).toBe(true);
    expect(fbRes.providerUsed).toBe('macos-speech');
    expect(fbRes.text).toBe('雪儿你好呀');

    // 3. Permission denied immediate exit (must not throw EPIPE on stdin write)
    const deniedHelperPath = join(dir, 'fake-speech-denied.mjs');
    await writeFile(
      deniedHelperPath,
      [
        '#!/usr/bin/env node',
        'process.stdout.write(JSON.stringify({ ok: false, text: "", code: "permission_denied", error: "macOS 语音识别权限已被拒绝" }) + "\\n");',
        'process.exit(2);',
      ].join('\n'),
      { mode: 0o755 },
    );
    await chmod(deniedHelperPath, 0o755);

    const deniedStt = new PresenceSttService({
      getConfig: async () => cfg,
      getSecrets: async () => ({}),
      platform: 'darwin',
      speechHelperPath: deniedHelperPath,
    });
    const deniedRes = await deniedStt.transcribeWavBase64(wavBase64);
    expect(deniedRes.ok).toBe(false);
    expect(deniedRes.providerUsed).toBe('macos-speech');
    expect(deniedRes.errorCode).toBe('permission_denied');
    expect(deniedRes.error).toContain('权限');

    // 4. Timeout & Abort handling cleanly terminate slow helper processes
    const hangHelperPath = join(dir, 'fake-speech-hang.mjs');
    await writeFile(hangHelperPath, ['#!/usr/bin/env node', 'setTimeout(() => process.exit(0), 30000);'].join('\n'), {
      mode: 0o755,
    });
    await chmod(hangHelperPath, 0o755);

    const timeoutStt = new PresenceSttService({
      getConfig: async () => cfg,
      getSecrets: async () => ({}),
      platform: 'darwin',
      speechHelperPath: hangHelperPath,
      macosSpeechTimeoutMs: 180,
    });
    const timeoutRes = await timeoutStt.transcribeWavBase64(wavBase64);
    expect(timeoutRes.ok).toBe(false);
    expect(timeoutRes.errorCode).toBe('timeout');

    const abortStt = new PresenceSttService({
      getConfig: async () => cfg,
      getSecrets: async () => ({}),
      platform: 'darwin',
      speechHelperPath: hangHelperPath,
      macosSpeechTimeoutMs: 10_000,
    });
    const abortPromise = abortStt.transcribeWavBase64(wavBase64);
    setTimeout(() => abortStt.abort(), 50);
    const abortRes = await abortPromise;
    expect(abortRes.ok).toBe(false);
    expect(abortRes.errorCode).toBe('aborted');

    // 5. Missing explicit override must NOT fall back to env/repo helper binaries
    expect(
      resolveMacOsSpeechHelperPath({
        overridePath: join(dir, 'does-not-exist'),
        env: { ASI_SPEECH_HELPER_PATH: okHelperPath },
      }),
    ).toBeNull();
    expect(
      resolveMacOsSpeechHelperPath({
        env: { ASI_SPEECH_HELPER_PATH: okHelperPath },
      }),
    ).toBe(okHelperPath);

    const missingHelperStt = new PresenceSttService({
      getConfig: async () => cfg,
      getSecrets: async () => ({}),
      platform: 'darwin',
      speechHelperPath: join(dir, 'does-not-exist'),
      env: { ASI_SPEECH_HELPER_PATH: okHelperPath },
    });
    const missingRes = await missingHelperStt.transcribeWavBase64(wavBase64);
    expect(missingRes.ok).toBe(false);
    expect(missingRes.errorCode).toBe('helper_not_found');

    // 6. Non-darwin platform returns clear actionable errors for both macos-speech and web-speech fallback
    const linuxStt = new PresenceSttService({
      getConfig: async () => cfg,
      getSecrets: async () => ({}),
      platform: 'linux',
    });
    const linuxRes = await linuxStt.transcribeWavBase64(wavBase64);
    expect(linuxRes.ok).toBe(false);
    expect(linuxRes.errorCode).toBe('unsupported_platform');

    const linuxWebFallbackStt = new PresenceSttService({
      getConfig: async () => webCfg,
      getSecrets: async () => ({}),
      platform: 'linux',
    });
    const linuxWebFallbackRes = await linuxWebFallbackStt.transcribeWavBase64(wavBase64, {
      allowMacOsFallback: true,
    });
    expect(linuxWebFallbackRes.ok).toBe(false);
    expect(linuxWebFallbackRes.errorCode).toBe('web_speech_unavailable');
    expect(linuxWebFallbackRes.error).toContain('Whisper HTTP');

    // 7. A synchronous spawn failure does not burn the one-time --request-auth attempt
    let failOnce = true;
    const retryArgsLog: string[][] = [];
    const retryStt = new PresenceSttService({
      getConfig: async () => cfg,
      getSecrets: async () => ({}),
      platform: 'darwin',
      speechHelperPath: okHelperPath,
      spawnImpl: ((cmd: string, args?: readonly string[], opts?: unknown) => {
        retryArgsLog.push([...(args ?? [])]);
        if (failOnce) {
          failOnce = false;
          throw new Error('transient spawn failure');
        }
        return spawn(cmd, args ?? [], opts as Parameters<typeof spawn>[2]);
      }) as typeof spawn,
    });
    const firstTry = await retryStt.transcribeWavBase64(wavBase64);
    expect(firstTry.ok).toBe(false);
    expect(firstTry.errorCode).toBe('spawn_failed');
    const secondTry = await retryStt.transcribeWavBase64(wavBase64);
    expect(secondTry.ok).toBe(true);
    expect(retryArgsLog[0]).toContain('--request-auth');
    expect(retryArgsLog[1]).toContain('--request-auth');
  });
});
