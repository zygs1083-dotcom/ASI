import { describe, expect, it } from 'vitest';
import {
  BRIDGE_HOST,
  BRIDGE_WS_PATH,
  BridgeClientMessageSchema,
  BridgeDiscoverySchema,
  BridgeServerMessageSchema,
  BridgeSnapshotSchema,
  createDefaultPrivacyState,
  createOfflineBridgeSnapshot,
  createSilentVisemeFrame,
  DEFAULT_COMPANION_NAME,
  DEFAULT_STT_LOCALE,
  HologramSettingsSchema,
  JevRequestSchema,
  JevResponseSchema,
  PRESENCE_PROTOCOL_VERSION,
  STT_PROVIDERS,
  SttProviderKindSchema,
  SystemOneDecisionSchema,
  VisemeFrameSchema,
} from '../src/index.ts';

describe('@asi/presence-protocol contracts', () => {
  it('defaults companion persona name to 雪儿 and validates offline snapshots', () => {
    expect(DEFAULT_COMPANION_NAME).toBe('雪儿');
    const offline = createOfflineBridgeSnapshot(1_700_000_000_000);
    const parsed = BridgeSnapshotSchema.parse(offline);
    expect(parsed.connected).toBe(false);
    expect(parsed.tom.state).toBe('steady_flow');
    expect(parsed.needs.overallZone).toBe('comfortable');
  });

  it('validates bridge discovery strictly on 127.0.0.1 and rejects external hosts or weak tokens', () => {
    const valid = BridgeDiscoverySchema.parse({
      version: PRESENCE_PROTOCOL_VERSION,
      host: BRIDGE_HOST,
      port: 49152,
      wsPath: BRIDGE_WS_PATH,
      token: 'a'.repeat(64),
      pid: 12345,
      startedAt: Date.now(),
      asiVersion: '0.7.0',
    });
    expect(valid.host).toBe('127.0.0.1');
    expect(valid.wsPath).toBe('/ws');

    expect(() =>
      BridgeDiscoverySchema.parse({
        version: PRESENCE_PROTOCOL_VERSION,
        host: '0.0.0.0',
        port: 49152,
        wsPath: '/ws',
        token: 'a'.repeat(64),
        pid: 12345,
        startedAt: Date.now(),
        asiVersion: '0.7.0',
      }),
    ).toThrow();

    expect(() =>
      BridgeDiscoverySchema.parse({
        version: PRESENCE_PROTOCOL_VERSION,
        host: '127.0.0.1',
        port: 49152,
        wsPath: '/ws',
        token: 'short',
        pid: 12345,
        startedAt: Date.now(),
        asiVersion: '0.7.0',
      }),
    ).toThrow();
  });

  it('validates native TypeSafe AI Jev request & response primitives (noul, choice, score, box)', () => {
    const req = JevRequestSchema.parse({
      model: 'jev-latest',
      state: '帮我查一下上周为什么 vitest 卡住',
      questions: {
        route: {
          type: 'choice',
          instructions: 'Select execution route',
          criteria: {
            fast_reply: 'Direct conversational response',
            recall_memory: 'Requires recalling long-term memory',
          },
        },
        energy: {
          type: 'score',
          instructions: 'Energy level',
          criteria: ['calm', 'warm', 'lively', 'energetic'],
        },
        need_memory: {
          type: 'noul',
          instructions: 'Does this need memory lookup?',
        },
        target_panel: {
          type: 'box',
          instructions: 'Locate the error trace on screen',
        },
      },
    });
    expect(req.questions.route.type).toBe('choice');

    const res = JevResponseSchema.parse({
      model: 'jev-latest',
      answers: {
        route: {
          type: 'choice',
          choice: 'recall_memory',
          probabilities: { recall_memory: 0.92, fast_reply: 0.08 },
          confidence: 0.92,
        },
        energy: {
          type: 'score',
          score: 1.8,
        },
        need_memory: {
          type: 'noul',
          noul: 0.94,
        },
        target_panel: {
          type: 'box',
          box: { top: 0.1, bottom: 0.5, left: 0.2, right: 0.8 },
          confidence: 0.87,
        },
      },
      usage: { input_tokens: 80, output_tokens: 14 },
    });
    expect(res.answers.target_panel.type).toBe('box');
  });

  it('validates SystemOneDecision, VisemeFrame, Privacy defaults, and WS RPC envelopes', () => {
    const decision = SystemOneDecisionSchema.parse({
      route: 'fast_reply',
      routeConfidence: 0.88,
      emotion: 'affectionate',
      energy: 72,
      initiative: 0.45,
      needMemory: false,
      needScreen: false,
      needDshDelegation: false,
      backend: 'typesafe-jev',
      latencyMs: 112,
    });
    expect(decision.emotion).toBe('affectionate');

    const silentFrame = VisemeFrameSchema.parse(createSilentVisemeFrame(100));
    expect(silentFrame.viseme).toBe('sil');
    expect(silentFrame.speaking).toBe(false);

    const privacy = createDefaultPrivacyState();
    expect(privacy.screenVisionEnabled).toBe(false);
    expect(privacy.cameraEnabled).toBe(false);
    expect(privacy.microphoneEnabled).toBe(false);
    expect(privacy.physicalKillSwitch).toBe(false);

    const hologram = HologramSettingsSchema.parse({});
    expect(hologram.theme).toBe('snow-cyan');

    const reqMsg = BridgeClientMessageSchema.parse({
      type: 'rpc.request',
      id: 'req-1',
      method: 'memory.recall',
      params: { query: 'vitest' },
    });
    expect(reqMsg.type).toBe('rpc.request');

    const srvMsg = BridgeServerMessageSchema.parse({
      type: 'hello',
      protocolVersion: 1,
      asiVersion: '0.7.0',
      snapshot: createOfflineBridgeSnapshot(100),
    });
    expect(srvMsg.type).toBe('hello');

    expect(STT_PROVIDERS).toContain('macos-speech');
    expect(SttProviderKindSchema.parse('macos-speech')).toBe('macos-speech');
    expect(DEFAULT_STT_LOCALE).toBe('zh-CN');
  });
});
