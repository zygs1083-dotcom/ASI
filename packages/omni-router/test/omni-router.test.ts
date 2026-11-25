import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BridgeMemoryItem, createDefaultPrivacyState, createOfflineBridgeSnapshot } from '@asi/presence-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  chatWithImage,
  createDefaultPresenceConfig,
  evaluateSystemOne,
  getDefaultSttProvider,
  listAvailableModels,
  OmniCompanionOrchestrator,
  PresenceConfigSchema,
  PresenceSecretsStore,
  SentenceStreamChunker,
  sanitizeForSpeech,
  streamLlmChat,
} from '../src/index.ts';

const tempDirs: string[] = [];
const activeServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (activeServers.length > 0) {
    const srv = activeServers.pop();
    if (srv) await srv.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function startMockServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      void Promise.resolve(handler(req, res, body)).catch((err: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(String(err));
        }
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind mock server');
  }
  const handle = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
  activeServers.push(handle);
  return handle;
}

describe('@asi/omni-router', () => {
  it('persists secrets with strict 0600 permissions and never exposes raw keys in masked summaries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-presence-secrets-'));
    tempDirs.push(dir);

    const store = new PresenceSecretsStore({ baseDir: dir, env: {} });
    const cfg = await store.saveConfig({
      persona: { name: '雪儿', customPrompt: '保持温柔忠诚', greeting: '你好呀' },
    });
    expect(cfg.persona.name).toBe('雪儿');

    const secretToken = 'jev-demo-credential-12345678';
    const masked = await store.saveSecrets({
      typesafeApiKey: secretToken,
      fastBrainApiKey: 'local-key-9999',
    });

    expect(masked.hasTypesafeApiKey).toBe(true);
    expect(masked.typesafeApiKeyHint).toBe('••••5678');
    expect(JSON.stringify(masked)).not.toContain(secretToken);

    const fileStat = await stat(store.secretsPath);
    expect(fileStat.mode & 0o777).toBe(0o600);

    const cleared = await store.saveSecrets({ typesafeApiKey: null });
    expect(cleared.hasTypesafeApiKey).toBe(false);
    expect(cleared.typesafeApiKeyHint).toBeNull();
  });

  it('calls native TypeSafe AI Jev System One (Choice/Score/Noul/Box) and preserves Danger-Zone image header', async () => {
    let seenAuth = '';
    let seenDangerHeader = '';
    let seenBody: Record<string, unknown> = {};

    const mock = await startMockServer((req, res, body) => {
      seenAuth = String(req.headers.authorization ?? '');
      seenDangerHeader = String(req.headers['typesafe-danger-zone-images'] ?? '');
      seenBody = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'jev-latest',
          answers: {
            route: { type: 'choice', choice: 'inspect_screen', confidence: 0.93 },
            emotion: { type: 'choice', choice: 'focused', confidence: 0.89 },
            energy: { type: 'score', score: 3 },
            need_memory: { type: 'noul', noul: 0.2 },
            need_screen: { type: 'noul', noul: 0.95 },
            need_dsh_delegation: { type: 'noul', noul: 0.1 },
            initiative: { type: 'noul', noul: 0.72 },
            focus_box: {
              type: 'box',
              box: { top: 0.12, bottom: 0.45, left: 0.2, right: 0.75 },
              confidence: 0.88,
            },
          },
          usage: { input_tokens: 90, output_tokens: 18 },
        }),
      );
    });

    const config = createDefaultPresenceConfig();
    const privacy = { ...createDefaultPrivacyState(), screenVisionEnabled: true };

    const decision = await evaluateSystemOne(
      {
        userText: '雪儿帮我看看屏幕上这个报错框',
        bridgeSnapshot: createOfflineBridgeSnapshot(1000),
        privacy,
        imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        boxInstruction: 'Locate the error dialog box',
      },
      {
        config: { ...config.systemOne, typesafeBaseUrl: mock.baseUrl },
        typesafeApiKey: 'demo-typesafe-token-abc',
      },
    );

    expect(seenAuth).toBe('Bearer demo-typesafe-token-abc');
    expect(seenDangerHeader).toBe('true');
    expect(seenBody.model).toBe('jev-latest');
    expect(decision.backend).toBe('typesafe-jev');
    expect(decision.route).toBe('inspect_screen');
    expect(decision.emotion).toBe('focused');
    expect(decision.energy).toBe(75);
    expect(decision.needScreen).toBe(true);
    expect(decision.focusBox).toEqual({ top: 0.12, bottom: 0.45, left: 0.2, right: 0.75 });
  });

  it('enforces screen-off privacy guardrail even if System One requests inspect_screen', async () => {
    const mock = await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'jev-latest',
          answers: {
            route: { type: 'choice', choice: 'inspect_screen', confidence: 0.95 },
            emotion: { type: 'choice', choice: 'focused', confidence: 0.8 },
            energy: { type: 'score', score: 2 },
            need_memory: { type: 'noul', noul: 0.1 },
            need_screen: { type: 'noul', noul: 0.99 },
            need_dsh_delegation: { type: 'noul', noul: 0.05 },
            initiative: { type: 'noul', noul: 0.5 },
          },
        }),
      );
    });

    const config = createDefaultPresenceConfig();
    const decision = await evaluateSystemOne(
      {
        userText: '看看屏幕上的报错',
        bridgeSnapshot: createOfflineBridgeSnapshot(1000),
        privacy: createDefaultPrivacyState(), // screenVisionEnabled is false by default!
      },
      {
        config: { ...config.systemOne, typesafeBaseUrl: mock.baseUrl },
        typesafeApiKey: 'demo-typesafe-token-abc',
      },
    );

    expect(decision.route).toBe('fast_reply');
    expect(decision.needScreen).toBe(false);
    expect(decision.reason).toContain('屏幕视觉默认关闭');
  });

  it('falls back seamlessly from Jev failure -> magpie calibration -> deterministic heuristic when offline', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/v1/systemone') {
        res.writeHead(503);
        res.end('upstream unavailable');
        return;
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    route: 'recall_memory',
                    routeConfidence: 0.87,
                    emotion: 'thinking',
                    energy: 62,
                    initiative: 0.5,
                    needMemory: true,
                    needScreen: false,
                    needDshDelegation: false,
                    memoryQuery: 'vitest OOM',
                    reason: '需要回忆之前的排查记录',
                  }),
                },
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const config = createDefaultPresenceConfig();
    const magpieDecision = await evaluateSystemOne(
      {
        userText: '雪儿你记得上次 vitest 为什么 OOM 吗？',
        bridgeSnapshot: createOfflineBridgeSnapshot(1000),
        privacy: createDefaultPrivacyState(),
      },
      {
        config: {
          ...config.systemOne,
          typesafeBaseUrl: mock.baseUrl,
          fallbackBaseUrl: `${mock.baseUrl}/v1`,
        },
        typesafeApiKey: 'demo-failing-key',
      },
    );

    expect(magpieDecision.backend).toBe('magpie-fallback');
    expect(magpieDecision.route).toBe('recall_memory');
    expect(magpieDecision.needMemory).toBe(true);

    // Offline heuristic fallback when magpie is unreachable too
    const snap = createOfflineBridgeSnapshot(1000);
    snap.tom.state = 'stuck_debugging';
    snap.tom.shouldDefer = true;

    const offlineDecision = await evaluateSystemOne(
      {
        userText: '帮我修一下这个 bug 并跑单测',
        bridgeSnapshot: snap,
        privacy: createDefaultPrivacyState(),
      },
      {
        config: {
          ...config.systemOne,
          preferTypesafeJev: false,
          fallbackToMagpie: false,
        },
      },
    );

    expect(offlineDecision.backend).toBe('heuristic-fallback');
    expect(offlineDecision.route).toBe('delegate_dsh');
    expect(offlineDecision.needDshDelegation).toBe(true);
    // ToM defer caps energy and initiative so companion stays gentle while user debugs
    expect(offlineDecision.energy).toBeLessThanOrEqual(48);
    expect(offlineDecision.initiative).toBeLessThanOrEqual(0.25);
  });

  it('splits bilingual CN/EN streams into natural spoken sentences without breaking decimals', () => {
    const chunker = new SentenceStreamChunker();
    const chunks: string[] = [];
    for (const token of ['雪儿在呢！', '当前版本是 v0.7，圆周率约 3.14 哦。', '需要我帮你查一下记忆吗？', '随时叫我']) {
      chunks.push(...chunker.push(token));
    }
    chunks.push(...chunker.flush());

    expect(chunks).toEqual([
      '雪儿在呢！',
      '当前版本是 v0.7，圆周率约 3.14 哦。',
      '需要我帮你查一下记忆吗？',
      '随时叫我',
    ]);

    expect(sanitizeForSpeech('看看 `pnpm check` 和 **核心代码**：\n```ts\nconst x = 1;\n```')).toBe(
      '看看 pnpm check 和 核心代码： （这里有一段代码，我已贴在对话面板里）',
    );
  });

  it('streams SSE replies, supports immediate VAD barge-in abort, lists models, and handles VLM image chat', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              { id: 'opencode-go/deepseek-v4.1-flash', owned_by: 'magpie' },
              { id: 'remote-magpie/auto/gemini-4-carbon', owned_by: 'magpie' },
            ],
          }),
        );
        return;
      }

      if (req.url === '/v1/chat/completions') {
        const chunks = ['雪儿', '来啦！', '随时', '陪着你。'];
        if (req.headers.accept === 'application/json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: '画面里是报错窗口' } }] }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const piece of chunks) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const models = await listAvailableModels(`${mock.baseUrl}/v1`);
    expect(models.map((m) => m.id)).toContain('opencode-go/deepseek-v4.1-flash');

    const tokens: string[] = [];
    for await (const chunk of streamLlmChat({
      provider: 'openai-compatible',
      baseUrl: `${mock.baseUrl}/v1`,
      model: 'opencode-go/deepseek-v4.1-flash',
      messages: [{ role: 'user', content: '雪儿在吗' }],
    })) {
      if (chunk.delta) tokens.push(chunk.delta);
    }
    expect(tokens.join('')).toBe('雪儿来啦！随时陪着你。');

    // Orchestrator end-to-end with conditional DSH memory recall + sentence chunks
    const recalledQueries: string[] = [];
    const memoryHit: BridgeMemoryItem = {
      id: 'mem-1',
      kind: 'pitfall',
      title: 'U1 vitest 内存保护',
      content: '在 U1 上跑 vitest 需加 --maxWorkers=2 防止 earlyoom。',
      tags: ['vitest', 'u1'],
      pinned: true,
      retention: 0.96,
      updatedAt: 1000,
    };

    const config = createDefaultPresenceConfig();
    config.systemOne.preferTypesafeJev = false;
    config.systemOne.fallbackToMagpie = false;
    config.fastBrain.baseUrl = `${mock.baseUrl}/v1`;

    const connectedSnap = createOfflineBridgeSnapshot(2000);
    connectedSnap.connected = true;
    connectedSnap.asiVersion = '0.7.0';

    const orchestrator = new OmniCompanionOrchestrator({
      getConfig: async () => config,
      getSecrets: async () => ({}),
      bridge: {
        getSnapshot: () => connectedSnap,
        recallMemory: async (q) => {
          recalledQueries.push(q);
          return [memoryHit];
        },
      },
    });

    const events = [];
    for await (const ev of orchestrator.runTurn({
      userText: '雪儿记得上次 vitest 踩过什么坑吗？',
      history: [],
      privacy: createDefaultPrivacyState(),
    })) {
      events.push(ev);
    }

    expect(recalledQueries.length).toBe(1);
    expect(events.some((e) => e.type === 'decision' && e.decision.needMemory)).toBe(true);
    expect(events.some((e) => e.type === 'memories' && e.memories.length === 1)).toBe(true);
    const sentences = events.filter((e) => e.type === 'sentence').map((e) => e.speechText);
    expect(sentences).toEqual(['雪儿来啦！', '随时陪着你。']);

    // Vision chat endpoint check
    const visionMock = await startMockServer((_req, res, body) => {
      const parsed = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
      const hasImage = JSON.stringify(parsed.messages).includes('data:image/jpeg;base64,abc');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: hasImage ? '已定位焦点的报错行' : 'missing' } }],
        }),
      );
    });
    const visionReply = await chatWithImage({
      provider: 'openai-compatible',
      baseUrl: `${visionMock.baseUrl}/v1`,
      model: 'remote-magpie/auto/gemini-4-carbon',
      systemPrompt: '你是雪儿',
      userPrompt: '看下这个框里写了什么',
      imageDataUrl: 'data:image/jpeg;base64,abc',
      focusBox: { top: 0.1, left: 0.1, bottom: 0.5, right: 0.5 },
    });
    expect(visionReply).toBe('已定位焦点的报错行');

    // Explicit AbortSignal mid-stream cancellation (simulating Silero VAD voice barge-in)
    const slowMock = await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '第一句。' } }] })}\n\n`);
      const timer = setTimeout(() => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '第二句不应该出现。' } }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 2000);
      res.on('close', () => clearTimeout(timer));
    });

    const abortCtrl = new AbortController();
    const collected: string[] = [];
    let aborted = false;
    try {
      for await (const chunk of streamLlmChat({
        provider: 'openai-compatible',
        baseUrl: `${slowMock.baseUrl}/v1`,
        model: 'opencode-go/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: '讲个故事' }],
        signal: abortCtrl.signal,
      })) {
        if (chunk.delta) {
          collected.push(chunk.delta);
          abortCtrl.abort(new Error('VAD barge-in'));
        }
      }
    } catch {
      aborted = true;
    }
    expect(collected).toEqual(['第一句。']);
    expect(aborted || abortCtrl.signal.aborted).toBe(true);
  });

  it('keeps fenced code blocks intact during streaming, preserves filenames/ellipses, supports Anthropic/Gemini VLM+turn normalization, and scopes fallback keys by origin', async () => {
    // 1. Streaming code fence is NOT split line-by-line, and sanitizeForSpeech replaces it cleanly
    const chunker = new SentenceStreamChunker();
    const rawStream = [
      '给你看示例：\n',
      '```ts\n',
      'const x = 1;\n',
      'console.log(x);\n',
      '```\n',
      '检查 app.',
      'ts 吧。',
      '等等.',
      '..',
    ];
    const emitted: string[] = [];
    for (const piece of rawStream) {
      emitted.push(...chunker.push(piece));
    }
    emitted.push(...chunker.flush());

    expect(emitted.map((s) => sanitizeForSpeech(s))).toEqual([
      '给你看示例：',
      '（这里有一段代码，我已贴在对话面板里）',
      '检查 app.ts 吧。',
      '等等...',
    ]);

    // 2. Anthropic-compatible & Gemini-compatible streaming normalize leading assistant messages & support VLM images
    let anthropicPayload: Record<string, unknown> = {};
    let geminiPath = '';
    let geminiPayload: Record<string, unknown> = {};
    let fallbackSeenAuth = '';

    const multiMock = await startMockServer((req, res, body) => {
      if (req.url === '/v1/messages') {
        anthropicPayload = JSON.parse(body) as Record<string, unknown>;
        if (anthropicPayload.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(
            `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '雪儿收到！' } })}\n\n`,
          );
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ content: [{ type: 'text', text: 'Anthropic 画面分析完成' }] }));
        }
        return;
      }
      if (req.url?.startsWith('/v1beta/models/')) {
        geminiPath = req.url;
        geminiPayload = JSON.parse(body) as Record<string, unknown>;
        if (req.url.includes('streamGenerateContent')) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(
            `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini 流式回复' }] } }] })}\n\n`,
          );
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini 画面分析完成' }] } }] }));
        }
        return;
      }
      if (req.url === '/fallback/chat/completions') {
        fallbackSeenAuth = String(req.headers.authorization ?? '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    route: 'fast_reply',
                    routeConfidence: 0.9,
                    emotion: 'calm',
                    energy: 55,
                    initiative: 0.4,
                    needMemory: false,
                    needScreen: false,
                    needDshDelegation: false,
                  }),
                },
              },
            ],
          }),
        );
        return;
      }
      if (req.url === '/fast/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '好呀。' } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const anthropicTokens: string[] = [];
    for await (const c of streamLlmChat({
      provider: 'anthropic-compatible',
      baseUrl: `${multiMock.baseUrl}/v1`,
      model: 'claude-opus-5-5',
      apiKey: 'anthro-test-key',
      messages: [
        { role: 'system', content: '你是雪儿' },
        { role: 'assistant', content: '欢迎语' }, // Must be stripped so first turn is 'user'
        { role: 'user', content: '你好' },
        { role: 'user', content: '再问一句' }, // Must coalesce with previous user turn
      ],
    })) {
      if (c.delta) anthropicTokens.push(c.delta);
    }
    expect(anthropicTokens.join('')).toBe('雪儿收到！');
    const anthMsgs = anthropicPayload.messages as Array<{ role: string; content: string }>;
    expect(anthMsgs).toEqual([{ role: 'user', content: '你好\n\n再问一句' }]);

    const anthVision = await chatWithImage({
      provider: 'anthropic-compatible',
      baseUrl: `${multiMock.baseUrl}/v1`,
      model: 'claude-opus-5-5',
      apiKey: 'anthro-test-key',
      systemPrompt: '你是雪儿',
      userPrompt: '看看这个图',
      imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    });
    expect(anthVision).toBe('Anthropic 画面分析完成');
    expect(JSON.stringify(anthropicPayload)).toContain('"media_type":"image/png"');

    const geminiTokens: string[] = [];
    for await (const c of streamLlmChat({
      provider: 'gemini-compatible',
      baseUrl: `${multiMock.baseUrl}/v1beta`,
      model: 'models/gemini-4-argon', // Leading models/ must NOT be double-prefixed or %2F encoded
      apiKey: 'gem-test-key',
      messages: [
        { role: 'assistant', content: '欢迎语' },
        { role: 'user', content: '测试 Gemini' },
      ],
    })) {
      if (c.delta) geminiTokens.push(c.delta);
    }
    expect(geminiTokens.join('')).toBe('Gemini 流式回复');
    expect(geminiPath).toBe('/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse');

    const gemVision = await chatWithImage({
      provider: 'gemini-compatible',
      baseUrl: `${multiMock.baseUrl}/v1beta`,
      model: 'models/gemini-4-carbon',
      apiKey: 'gem-test-key',
      systemPrompt: '你是雪儿',
      userPrompt: '看图',
      imageDataUrl: 'data:image/jpeg;base64,AAAA',
    });
    expect(gemVision).toBe('Gemini 画面分析完成');
    expect(geminiPath).toBe('/v1beta/models/gemini-4-carbon:generateContent');
    expect(JSON.stringify(geminiPayload)).toContain('"inlineData"');

    // 3. Cross-origin fastBrainApiKey must NOT be sent to a different-origin systemOne fallback URL
    const fastServer = await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '好呀。' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const cfg = createDefaultPresenceConfig();
    cfg.systemOne.preferTypesafeJev = false;
    cfg.systemOne.fallbackToMagpie = true;
    cfg.systemOne.fallbackBaseUrl = `${multiMock.baseUrl}/fallback`;
    cfg.fastBrain.baseUrl = `${fastServer.baseUrl}/fast`;

    const orch = new OmniCompanionOrchestrator({
      getConfig: async () => cfg,
      getSecrets: async () => ({ fastBrainApiKey: 'cloud-secret-do-not-leak' }),
      bridge: {
        getSnapshot: () => createOfflineBridgeSnapshot(1000),
        recallMemory: async () => [],
      },
    });
    for await (const _ev of orch.runTurn({
      userText: '你好雪儿',
      history: [],
      privacy: createDefaultPrivacyState(),
    })) {
      // drain
    }
    expect(fallbackSeenAuth).toBe('');
  });

  it('supports macos-speech STT provider, platform-aware defaults, and speaker echo-guard config schema', () => {
    expect(getDefaultSttProvider('darwin')).toBe('macos-speech');
    expect(getDefaultSttProvider('linux')).toBe('web-speech');

    const macDefaults = createDefaultPresenceConfig('darwin');
    expect(macDefaults.voice.sttProvider).toBe('macos-speech');
    expect(macDefaults.voice.sttLocale).toBe('zh-CN');
    expect(macDefaults.voice.echoGuardEnabled).toBe(true);
    expect(macDefaults.voice.echoGuardStrength).toBe(0.65);

    const parsed = PresenceConfigSchema.parse({
      voice: {
        sttProvider: 'macos-speech',
        sttLocale: 'zh-CN',
        echoGuardEnabled: true,
        echoGuardStrength: 0.8,
      },
    });
    expect(parsed.voice.sttProvider).toBe('macos-speech');
    expect(parsed.voice.echoGuardStrength).toBe(0.8);
  });
});
