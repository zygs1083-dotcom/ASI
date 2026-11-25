import { z } from 'zod';
import { BRIDGE_HOST, BRIDGE_WS_PATH, PRESENCE_PROTOCOL_VERSION } from './constants.ts';

export const BridgeDiscoverySchema = z.object({
  version: z.literal(PRESENCE_PROTOCOL_VERSION),
  host: z.literal(BRIDGE_HOST),
  port: z.number().int().min(1).max(65535),
  wsPath: z.literal(BRIDGE_WS_PATH),
  token: z.string().min(32),
  pid: z.number().int().positive(),
  startedAt: z.number().nonnegative(),
  asiVersion: z.string().min(1),
});
export type BridgeDiscovery = z.infer<typeof BridgeDiscoverySchema>;

export const BridgeVitalsSummarySchema = z.object({
  cpuUsage: z.number().min(0).max(100).nullable(),
  memoryPressure: z.enum(['normal', 'warn', 'critical', 'unknown']),
  memoryUsedRatio: z.number().min(0).max(1).nullable(),
  batteryPercent: z.number().min(0).max(100).nullable(),
  batteryCharging: z.boolean().nullable(),
  thermal: z.enum(['nominal', 'fair', 'serious', 'critical', 'unknown']),
  powerMode: z.enum(['normal', 'eco']),
  online: z.boolean().nullable(),
  frontAppName: z.string().nullable(),
  screenLocked: z.boolean(),
});
export type BridgeVitalsSummary = z.infer<typeof BridgeVitalsSummarySchema>;

export const BridgeHelpCardSummarySchema = z.object({
  id: z.string(),
  severity: z.enum(['uncomfortable', 'critical']),
  title: z.string(),
  summary: z.string(),
  need: z.string().optional(),
  driveKey: z.string().optional(),
  status: z.enum(['open', 'approved', 'dismissed', 'resolved']),
  silent: z.boolean().optional(),
  updatedAt: z.number(),
});
export type BridgeHelpCardSummary = z.infer<typeof BridgeHelpCardSummarySchema>;

export const BridgeTomSummarySchema = z.object({
  state: z.enum(['deep_focus', 'rapid_sprint', 'stuck_debugging', 'exploring', 'steady_flow', 'away_resting']),
  source: z.enum(['inferred', 'manual_override', 'paused']),
  confidence: z.number().min(0).max(1),
  shouldDefer: z.boolean(),
  headline: z.string(),
  dimensions: z.object({
    focus: z.number().min(0).max(100),
    friction: z.number().min(0).max(100),
    pace: z.number().min(0).max(100),
    presence: z.number().min(0).max(100),
  }),
});
export type BridgeTomSummary = z.infer<typeof BridgeTomSummarySchema>;

export const BridgeMemoryItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['preference', 'decision', 'pitfall', 'episode']),
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  pinned: z.boolean(),
  retention: z.number().min(0).max(1),
  score: z.number().optional(),
  updatedAt: z.number(),
});
export type BridgeMemoryItem = z.infer<typeof BridgeMemoryItemSchema>;

export const BridgeFlashbackSummarySchema = z.object({
  sourceId: z.string(),
  sourceKind: z.enum(['preference', 'decision', 'pitfall', 'episode', 'scar']),
  title: z.string(),
  caution: z.string(),
  score: z.number(),
  matchedCues: z.array(z.string()),
  retention: z.number(),
});
export type BridgeFlashbackSummary = z.infer<typeof BridgeFlashbackSummarySchema>;

export const BridgeProspectiveItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  instruction: z.string(),
  triggerKind: z.enum(['time', 'context', 'event']),
  triggerSummary: z.string(),
  priority: z.enum(['normal', 'high']),
  status: z.enum(['pending', 'surfaced', 'fulfilled', 'snoozed', 'canceled', 'expired']),
  dueAt: z.number().optional(),
  updatedAt: z.number(),
});
export type BridgeProspectiveItem = z.infer<typeof BridgeProspectiveItemSchema>;

export const BridgeDreamInsightItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['preventive-warning', 'structural-analogy', 'pattern-unification', 'decision-tension']),
  status: z.enum(['open', 'adopted', 'promoted', 'dismissed']),
  title: z.string(),
  summary: z.string(),
  actionableHypothesis: z.string(),
  sourceRepos: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  updatedAt: z.number(),
});
export type BridgeDreamInsightItem = z.infer<typeof BridgeDreamInsightItemSchema>;

export const BridgeSnapshotSchema = z.object({
  connected: z.boolean(),
  asiVersion: z.string(),
  now: z.number(),
  vitals: BridgeVitalsSummarySchema,
  needs: z.object({
    overallSatisfaction: z.number().min(0).max(100),
    overallUrgency: z.number().min(0).max(100),
    overallZone: z.enum(['comfortable', 'uncomfortable', 'critical']),
    activeDrives: z.array(z.string()),
    openHelpCards: z.array(BridgeHelpCardSummarySchema),
  }),
  tom: BridgeTomSummarySchema,
  sleep: z.object({
    totalMemories: z.number().int().nonnegative(),
    lastSleepAt: z.number().nullable(),
  }),
  intuition: z.object({
    pendingIntentions: z.number().int().nonnegative(),
    surfacedIntentions: z.number().int().nonnegative(),
    recentFlashbackCount: z.number().int().nonnegative(),
    upcomingIntentions: z.array(BridgeProspectiveItemSchema),
  }),
  dream: z.object({
    openInsightCount: z.number().int().nonnegative(),
    recentInsights: z.array(BridgeDreamInsightItemSchema),
  }),
});
export type BridgeSnapshot = z.infer<typeof BridgeSnapshotSchema>;

export const BRIDGE_RPC_METHODS = [
  'snapshot.get',
  'memory.recall',
  'memory.profile',
  'memory.create',
  'prospective.list',
  'prospective.create',
  'prospective.resolve',
  'intuition.scan',
  'dream.list',
  'help.list',
  'tom.override',
  'dsh.delegate_preview',
] as const;
export const BridgeRpcMethodSchema = z.enum(BRIDGE_RPC_METHODS);
export type BridgeRpcMethod = z.infer<typeof BridgeRpcMethodSchema>;

export const BridgeClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ping'),
    at: z.number().optional(),
  }),
  z.object({
    type: z.literal('subscribe'),
    channels: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('rpc.request'),
    id: z.string().min(1),
    method: BridgeRpcMethodSchema,
    params: z.record(z.string(), z.unknown()).optional(),
  }),
]);
export type BridgeClientMessage = z.infer<typeof BridgeClientMessageSchema>;

export const BRIDGE_EVENT_KINDS = [
  'vitals_changed',
  'needs_changed',
  'tom_changed',
  'help_card',
  'flashback',
  'dream_insight',
  'memory_updated',
] as const;
export const BridgeEventKindSchema = z.enum(BRIDGE_EVENT_KINDS);
export type BridgeEventKind = z.infer<typeof BridgeEventKindSchema>;

export const BridgeServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    protocolVersion: z.literal(PRESENCE_PROTOCOL_VERSION),
    asiVersion: z.string(),
    snapshot: BridgeSnapshotSchema,
  }),
  z.object({
    type: z.literal('pong'),
    at: z.number(),
  }),
  z.object({
    type: z.literal('snapshot'),
    snapshot: BridgeSnapshotSchema,
  }),
  z.object({
    type: z.literal('event'),
    kind: BridgeEventKindSchema,
    at: z.number(),
    payload: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('rpc.response'),
    id: z.string().min(1),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional(),
  }),
]);
export type BridgeServerMessage = z.infer<typeof BridgeServerMessageSchema>;

export function createOfflineBridgeSnapshot(now = Date.now()): BridgeSnapshot {
  return {
    connected: false,
    asiVersion: 'offline',
    now,
    vitals: {
      cpuUsage: null,
      memoryPressure: 'unknown',
      memoryUsedRatio: null,
      batteryPercent: null,
      batteryCharging: null,
      thermal: 'unknown',
      powerMode: 'normal',
      online: null,
      frontAppName: null,
      screenLocked: false,
    },
    needs: {
      overallSatisfaction: 100,
      overallUrgency: 0,
      overallZone: 'comfortable',
      activeDrives: [],
      openHelpCards: [],
    },
    tom: {
      state: 'steady_flow',
      source: 'inferred',
      confidence: 0,
      shouldDefer: false,
      headline: '独立本地陪伴模式（未检测到 DSH 神经总线）',
      dimensions: { focus: 50, friction: 0, pace: 50, presence: 100 },
    },
    sleep: {
      totalMemories: 0,
      lastSleepAt: null,
    },
    intuition: {
      pendingIntentions: 0,
      surfacedIntentions: 0,
      recentFlashbackCount: 0,
      upcomingIntentions: [],
    },
    dream: {
      openInsightCount: 0,
      recentInsights: [],
    },
  };
}
