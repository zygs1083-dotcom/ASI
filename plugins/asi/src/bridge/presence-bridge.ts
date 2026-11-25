import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BridgeClientMessage,
  BridgeDiscovery,
  BridgeDreamInsightItem,
  BridgeEventKind,
  BridgeFlashbackSummary,
  BridgeHelpCardSummary,
  BridgeMemoryItem,
  BridgeProspectiveItem,
  BridgeRpcMethod,
  BridgeServerMessage,
  BridgeSnapshot,
} from '@asi/presence-protocol';
import {
  type PartnerStateKind,
  type ProspectiveStatus,
  type SleepMemoryKind,
  sanitizeForModel,
} from '@asi/sense-types';
import type { DreamRuntime } from '../dream/host/runtime.ts';
import type { IntuitionRuntime } from '../intuition/host/runtime.ts';
import type { ProspectiveCreateInput, ProspectiveResolveInput } from '../intuition/shared/types.ts';
import type { NeedsRuntime } from '../needs/host/runtime.ts';
import type { createSenseRuntime } from '../sense/host/runtime/index.ts';
import type { SleepRuntime } from '../sleep/host/runtime.ts';
import type { MemoryCreateInput } from '../sleep/shared/types.ts';
import type { TomRuntime } from '../tom/host/runtime.ts';
import { LoopbackWsServer, type WsClientConnection } from './ws-server.ts';

type SenseRuntime = ReturnType<typeof createSenseRuntime>;

const BRIDGE_VERSION = 1 as const;
const BRIDGE_HOST = '127.0.0.1' as const;
const BRIDGE_WS_PATH = '/ws' as const;
const BRIDGE_FILE_NAME = 'presence-bridge.json' as const;
const ASI_PLUGIN_VERSION = '0.7.0';

const ALLOWED_MEMORY_KINDS = new Set<SleepMemoryKind>(['preference', 'decision', 'pitfall', 'episode']);
const ALLOWED_TOM_STATES = new Set<PartnerStateKind>([
  'deep_focus',
  'rapid_sprint',
  'stuck_debugging',
  'exploring',
  'steady_flow',
  'away_resting',
]);
const ALLOWED_RPC_METHODS = new Set<BridgeRpcMethod>([
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
]);

export interface PresenceBridgeDeps {
  storageRoot: string;
  sense: SenseRuntime;
  needs: NeedsRuntime;
  sleep: SleepRuntime;
  tom: TomRuntime;
  intuition: IntuitionRuntime;
  dream: DreamRuntime;
  /** Optional hook returning active workspace paths for M2 slow-brain delegation previews. */
  listWorkspaces?: () => string[];
}

export interface PresenceBridgeOptions {
  port?: number;
  asiVersion?: string;
  throttleMs?: number;
}

export interface PresenceBridgeHandle {
  readonly discoveryPath: string;
  readonly port: number;
  readonly token: string;
  snapshot(): BridgeSnapshot;
  stop(): Promise<void>;
}

function cleanText(text: string | undefined | null, maxLen = 320): string {
  if (!text) return '';
  return sanitizeForModel(text).slice(0, maxLen);
}

async function atomicWriteSecureJson(filePath: string, payload: unknown): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const data = `${JSON.stringify(payload, null, 2)}\n`;
  try {
    await writeFile(tmpPath, data, { encoding: 'utf8', mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, filePath);
    await chmod(filePath, 0o600);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

type ParsedIncomingMessage = BridgeClientMessage | { type: 'rpc.unknown'; id: string; method: string };

function parseIncomingClientMessage(raw: string): ParsedIncomingMessage | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const record = obj as Record<string, unknown>;

  if (record.type === 'ping') {
    return { type: 'ping', ...(typeof record.at === 'number' ? { at: record.at } : {}) };
  }
  if (record.type === 'subscribe') {
    const channels = Array.isArray(record.channels)
      ? record.channels.filter((c): c is string => typeof c === 'string')
      : undefined;
    return { type: 'subscribe', ...(channels ? { channels } : {}) };
  }
  if (
    record.type === 'rpc.request' &&
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.method === 'string'
  ) {
    if (!ALLOWED_RPC_METHODS.has(record.method as BridgeRpcMethod)) {
      return { type: 'rpc.unknown', id: record.id, method: record.method };
    }
    const params =
      record.params && typeof record.params === 'object' && !Array.isArray(record.params)
        ? (record.params as Record<string, unknown>)
        : undefined;
    return {
      type: 'rpc.request',
      id: record.id,
      method: record.method as BridgeRpcMethod,
      ...(params ? { params } : {}),
    };
  }
  return null;
}

/**
 * Starts the authenticated `127.0.0.1` neural bus WebSocket server inside the unified `asi` plugin.
 * Streams sanitized L0-L5 snapshots/events and exposes RPCs for shared memory, prospective intentions,
 * intuition flashbacks, dream insights, and slow-brain delegation hooks.
 */
export async function startPresenceBridge(
  deps: PresenceBridgeDeps,
  options: PresenceBridgeOptions = {},
): Promise<PresenceBridgeHandle> {
  const asiVersion = options.asiVersion ?? ASI_PLUGIN_VERSION;
  const throttleMs = options.throttleMs ?? 250;
  const token = randomBytes(32).toString('hex');
  const discoveryPath = join(deps.storageRoot, BRIDGE_FILE_NAME);

  let stopped = false;
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  let lastTomState: string | null = null;
  let lastNeedsZone: string | null = null;
  let lastOpenHelpIds: Set<string> | null = null;
  let lastMemoryCount = -1;
  let lastFlashbackCount = -1;
  let lastDreamOpenCount = -1;

  const seedBaselines = (snap: BridgeSnapshot) => {
    lastTomState = snap.tom.state;
    lastNeedsZone = snap.needs.overallZone;
    lastOpenHelpIds = new Set(snap.needs.openHelpCards.map((c) => c.id));
    lastMemoryCount = snap.sleep.totalMemories;
    lastFlashbackCount = snap.intuition.recentFlashbackCount;
    lastDreamOpenCount = snap.dream.openInsightCount;
  };

  const buildSnapshot = (): BridgeSnapshot => {
    const senseSnap = deps.sense.snapshot();
    const needsSnap = deps.needs.snapshot();
    const tomSnap = deps.tom.snapshot();
    const sleepProfile = deps.sleep.profile({ limitPerKind: 1 });
    const intuitionSnap = deps.intuition.serviceSnapshot();
    const dreamInsights = deps.dream.listInsights({ statuses: ['open'], limit: 6 });

    const body = senseSnap.state.self.body;
    const battery = body.battery.value;
    const mem = body.memory.value;
    const cpu = body.cpu.value;
    const net = body.network.value;
    const frontApp = senseSnap.state.env.frontApp.value;
    const sys = senseSnap.state.env.system?.value;

    const openHelpCards: BridgeHelpCardSummary[] = needsSnap.helpCards
      .filter((c) => c.status === 'open')
      .slice(0, 8)
      .map((card) => ({
        id: card.id,
        severity: card.severity,
        title: cleanText(card.title, 120),
        summary: cleanText(card.summary, 240),
        ...(card.need ? { need: card.need } : {}),
        ...(card.driveKey ? { driveKey: card.driveKey } : {}),
        status: card.status,
        ...(card.silent !== undefined ? { silent: card.silent } : {}),
        updatedAt: card.updatedAt,
      }));

    const upcomingIntentions: BridgeProspectiveItem[] = intuitionSnap.intentions
      .filter((i) => i.status === 'pending' || i.status === 'surfaced')
      .slice(0, 8)
      .map((item) => ({
        id: item.id,
        title: cleanText(item.title, 120),
        instruction: cleanText(item.instruction, 240),
        triggerKind: item.triggerKind,
        triggerSummary: cleanText(item.triggerSummary, 120),
        priority: item.priority,
        status: item.status,
        ...(item.dueAt !== undefined ? { dueAt: item.dueAt } : {}),
        updatedAt: item.updatedAt,
      }));

    const recentInsights: BridgeDreamInsightItem[] = dreamInsights.map((ins) => ({
      id: ins.id,
      kind: ins.kind,
      status: ins.status,
      title: cleanText(ins.title, 140),
      summary: cleanText(ins.summary, 260),
      actionableHypothesis: cleanText(ins.actionableHypothesis, 220),
      sourceRepos: ins.sourceRepos.slice(0, 6).map((r) => cleanText(r, 80)),
      confidence: Math.max(0, Math.min(1, ins.confidence)),
      updatedAt: ins.updatedAt,
    }));

    return {
      connected: true,
      asiVersion,
      now: Date.now(),
      vitals: {
        cpuUsage: cpu ? Math.max(0, Math.min(100, Math.round(cpu.usage * 100))) : null,
        memoryPressure: mem?.pressure ?? 'unknown',
        memoryUsedRatio: mem && mem.total > 0 ? Math.max(0, Math.min(1, mem.used / mem.total)) : null,
        batteryPercent: battery ? Math.max(0, Math.min(100, Math.round(battery.percent))) : null,
        batteryCharging: battery ? battery.charging : null,
        thermal: body.thermal.value ?? 'unknown',
        powerMode: senseSnap.settings.powerMode,
        online: net ? net.online : null,
        frontAppName: frontApp?.name ? cleanText(frontApp.name, 80) : null,
        screenLocked: Boolean(sys?.locked),
      },
      needs: {
        overallSatisfaction: Math.max(0, Math.min(100, Math.round(needsSnap.overallSatisfaction))),
        overallUrgency: Math.max(0, Math.min(100, Math.round(needsSnap.overallUrgency))),
        overallZone: needsSnap.overallZone,
        activeDrives: needsSnap.activeDrives.slice(0, 12),
        openHelpCards,
      },
      tom: {
        state: tomSnap.state,
        source: tomSnap.source,
        confidence: Math.max(0, Math.min(1, tomSnap.confidence)),
        shouldDefer: tomSnap.guidance.deferNonCriticalInterruptions || deps.tom.shouldDeferProactiveWork(),
        headline: cleanText(tomSnap.guidance.headline, 160),
        dimensions: {
          focus: Math.max(0, Math.min(100, Math.round(tomSnap.dimensions.focus))),
          friction: Math.max(0, Math.min(100, Math.round(tomSnap.dimensions.friction))),
          pace: Math.max(0, Math.min(100, Math.round(tomSnap.dimensions.pace))),
          presence: Math.max(0, Math.min(100, Math.round(tomSnap.dimensions.presence))),
        },
      },
      sleep: {
        totalMemories: sleepProfile.totalMemories,
        lastSleepAt: sleepProfile.lastSleepAt,
      },
      intuition: {
        pendingIntentions: intuitionSnap.pendingCount,
        surfacedIntentions: intuitionSnap.surfacedCount,
        recentFlashbackCount: intuitionSnap.recentFlashbackCount,
        upcomingIntentions,
      },
      dream: {
        openInsightCount: dreamInsights.length,
        recentInsights,
      },
    };
  };

  const sendMessage = (client: WsClientConnection, msg: BridgeServerMessage) => {
    client.sendText(JSON.stringify(msg));
  };

  const broadcastMessage = (msg: BridgeServerMessage) => {
    if (stopped || wsServer.clientCount === 0) return;
    wsServer.broadcastText(JSON.stringify(msg));
  };

  const emitSemanticEvent = (kind: BridgeEventKind, payload: Record<string, unknown>) => {
    broadcastMessage({
      type: 'event',
      kind,
      at: Date.now(),
      payload,
    });
  };

  const flushBroadcast = () => {
    broadcastTimer = null;
    if (stopped || wsServer.clientCount === 0) return;
    const snap = buildSnapshot();
    broadcastMessage({ type: 'snapshot', snapshot: snap });

    if (lastTomState !== null && lastTomState !== snap.tom.state) {
      emitSemanticEvent('tom_changed', {
        previous: lastTomState,
        state: snap.tom.state,
        shouldDefer: snap.tom.shouldDefer,
        headline: snap.tom.headline,
      });
    }
    lastTomState = snap.tom.state;

    if (lastNeedsZone !== null && lastNeedsZone !== snap.needs.overallZone) {
      emitSemanticEvent('needs_changed', {
        previous: lastNeedsZone,
        zone: snap.needs.overallZone,
        satisfaction: snap.needs.overallSatisfaction,
      });
    }
    lastNeedsZone = snap.needs.overallZone;

    const prevHelpIds = lastOpenHelpIds;
    const addedHelpCards = prevHelpIds === null ? [] : snap.needs.openHelpCards.filter((c) => !prevHelpIds.has(c.id));
    if (prevHelpIds !== null && addedHelpCards.length > 0) {
      emitSemanticEvent('help_card', {
        count: snap.needs.openHelpCards.length,
        latest: addedHelpCards[0] ?? snap.needs.openHelpCards[0],
      });
    }
    lastOpenHelpIds = new Set(snap.needs.openHelpCards.map((c) => c.id));

    if (lastMemoryCount >= 0 && snap.sleep.totalMemories !== lastMemoryCount) {
      emitSemanticEvent('memory_updated', {
        totalMemories: snap.sleep.totalMemories,
      });
    }
    lastMemoryCount = snap.sleep.totalMemories;

    if (lastFlashbackCount >= 0 && snap.intuition.recentFlashbackCount > lastFlashbackCount) {
      emitSemanticEvent('flashback', {
        recentFlashbackCount: snap.intuition.recentFlashbackCount,
      });
    }
    lastFlashbackCount = snap.intuition.recentFlashbackCount;

    if (lastDreamOpenCount >= 0 && snap.dream.openInsightCount > lastDreamOpenCount) {
      emitSemanticEvent('dream_insight', {
        openInsightCount: snap.dream.openInsightCount,
        latest: snap.dream.recentInsights[0],
      });
    }
    lastDreamOpenCount = snap.dream.openInsightCount;
  };

  const scheduleBroadcast = () => {
    if (stopped || broadcastTimer !== null || wsServer.clientCount === 0) return;
    broadcastTimer = setTimeout(flushBroadcast, throttleMs);
  };

  const handleRpc = async (method: BridgeRpcMethod, params: Record<string, unknown> = {}): Promise<unknown> => {
    switch (method) {
      case 'snapshot.get':
        return buildSnapshot();

      case 'memory.recall': {
        const query = typeof params.query === 'string' ? params.query.trim() : '';
        const limit = typeof params.limit === 'number' ? Math.max(1, Math.min(20, Math.round(params.limit))) : 6;
        const kindRaw = typeof params.kind === 'string' ? (params.kind as SleepMemoryKind) : undefined;
        const kind = kindRaw && ALLOWED_MEMORY_KINDS.has(kindRaw) ? kindRaw : undefined;
        if (!query) {
          const items: BridgeMemoryItem[] = deps.sleep
            .listMemories({ ...(kind ? { kinds: [kind] } : {}), limit })
            .map((m) => ({
              id: m.id,
              kind: m.kind,
              title: cleanText(m.title, 140),
              content: cleanText(m.content, 500),
              tags: m.tags.slice(0, 8),
              pinned: m.pinned,
              retention: m.retention,
              updatedAt: m.updatedAt,
            }));
          return { query, hits: items };
        }
        const res = await deps.sleep.recall({
          query,
          ...(kind ? { kind } : {}),
          limit,
          strengthen: params.strengthen === true,
        });
        const hits: BridgeMemoryItem[] = res.hits.map((h) => ({
          id: h.id,
          kind: h.kind,
          title: cleanText(h.title, 140),
          content: cleanText(h.content, 500),
          tags: h.tags.slice(0, 8),
          pinned: h.pinned,
          retention: h.retention,
          score: h.score,
          updatedAt: h.updatedAt,
        }));
        return { query, totalMemories: res.totalMemories, hits };
      }

      case 'memory.profile': {
        const limitPerKind =
          typeof params.limitPerKind === 'number' ? Math.max(1, Math.min(12, Math.round(params.limitPerKind))) : 5;
        const raw = deps.sleep.profile({ limitPerKind });
        const sanitizedProfile: Record<string, BridgeMemoryItem[]> = {};
        for (const [k, list] of Object.entries(raw.profile)) {
          sanitizedProfile[k] = (list ?? []).map((m) => ({
            id: m.id,
            kind: m.kind,
            title: cleanText(m.title, 140),
            content: cleanText(m.content, 500),
            tags: m.tags.slice(0, 8).map((t) => cleanText(t, 40)),
            pinned: m.pinned,
            retention: m.retention,
            updatedAt: m.updatedAt,
          }));
        }
        return {
          now: raw.now,
          totalMemories: raw.totalMemories,
          pinnedCount: raw.pinnedCount,
          lastSleepAt: raw.lastSleepAt,
          countsByKind: raw.countsByKind,
          profile: sanitizedProfile,
        };
      }

      case 'memory.create': {
        const kindRaw = typeof params.kind === 'string' ? (params.kind as SleepMemoryKind) : 'episode';
        const kind: SleepMemoryKind = ALLOWED_MEMORY_KINDS.has(kindRaw) ? kindRaw : 'episode';
        const title = typeof params.title === 'string' ? params.title.trim() : '';
        const content = typeof params.content === 'string' ? params.content.trim() : '';
        if (!title || !content) {
          throw new Error('memory.create requires non-empty title and content');
        }
        const tags = Array.isArray(params.tags)
          ? params.tags.filter((t): t is string => typeof t === 'string').slice(0, 8)
          : ['presence'];
        const input: MemoryCreateInput = {
          kind,
          title: cleanText(title, 140),
          content: cleanText(content, 1200),
          tags,
          pinned: params.pinned === true,
        };
        const created = await deps.sleep.actions.createMemory(input);
        scheduleBroadcast();
        return {
          id: created.id,
          kind: created.kind,
          title: cleanText(created.title, 140),
          content: cleanText(created.content, 500),
          tags: created.tags.slice(0, 8),
          pinned: created.pinned,
          retention: created.retention,
          updatedAt: created.updatedAt,
        };
      }

      case 'prospective.list': {
        const limit = typeof params.limit === 'number' ? Math.max(1, Math.min(30, Math.round(params.limit))) : 12;
        const statuses = Array.isArray(params.statuses)
          ? (params.statuses.filter((s): s is ProspectiveStatus => typeof s === 'string') as ProspectiveStatus[])
          : undefined;
        return deps.intuition.listIntentionSummaries({ ...(statuses ? { statuses } : {}), limit }).map((item) => ({
          id: item.id,
          title: cleanText(item.title, 120),
          instruction: cleanText(item.instruction, 240),
          triggerKind: item.triggerKind,
          triggerSummary: cleanText(item.triggerSummary, 120),
          priority: item.priority,
          status: item.status,
          ...(item.dueAt !== undefined ? { dueAt: item.dueAt } : {}),
          updatedAt: item.updatedAt,
        }));
      }

      case 'prospective.create': {
        const title = typeof params.title === 'string' ? params.title.trim() : '';
        const instruction = typeof params.instruction === 'string' ? params.instruction.trim() : '';
        const triggerKind =
          params.triggerKind === 'time' || params.triggerKind === 'context' || params.triggerKind === 'event'
            ? params.triggerKind
            : 'time';
        if (!title || !instruction) {
          throw new Error('prospective.create requires non-empty title and instruction');
        }
        const input: ProspectiveCreateInput = {
          title: cleanText(title, 120),
          instruction: cleanText(instruction, 320),
          triggerKind,
          priority: params.priority === 'high' ? 'high' : 'normal',
          ...(typeof params.delayMinutes === 'number' ? { delayMinutes: params.delayMinutes } : {}),
          ...(typeof params.dueAt === 'number' ? { dueAt: params.dueAt } : {}),
          ...(typeof params.workspaceMatch === 'string' ? { workspaceMatch: params.workspaceMatch } : {}),
          ...(typeof params.keywordMatch === 'string' ? { keywordMatch: params.keywordMatch } : {}),
        };
        const created = await deps.intuition.actions.createIntention(input);
        scheduleBroadcast();
        return {
          id: created.id,
          title: cleanText(created.title, 120),
          instruction: cleanText(created.instruction, 240),
          triggerKind: created.trigger.kind,
          triggerSummary: cleanText(created.triggerSummary, 120),
          priority: created.priority,
          status: created.status,
          ...(created.trigger.dueAt !== undefined ? { dueAt: created.trigger.dueAt } : {}),
          updatedAt: created.updatedAt,
        };
      }

      case 'prospective.resolve': {
        const id = typeof params.id === 'string' ? params.id.trim() : '';
        const action =
          params.action === 'fulfill' || params.action === 'snooze' || params.action === 'cancel'
            ? params.action
            : 'fulfill';
        if (!id) throw new Error('prospective.resolve requires id');
        const input: ProspectiveResolveInput = {
          id,
          action,
          ...(typeof params.snoozeMinutes === 'number' ? { snoozeMinutes: params.snoozeMinutes } : {}),
          ...(typeof params.note === 'string' ? { note: cleanText(params.note, 200) } : {}),
        };
        const updated = await deps.intuition.actions.resolveIntention(input);
        scheduleBroadcast();
        if (!updated) return null;
        return {
          id: updated.id,
          title: cleanText(updated.title, 120),
          instruction: cleanText(updated.instruction, 240),
          triggerKind: updated.trigger.kind,
          triggerSummary: cleanText(updated.triggerSummary, 120),
          priority: updated.priority,
          status: updated.status,
          ...(updated.trigger.dueAt !== undefined ? { dueAt: updated.trigger.dueAt } : {}),
          updatedAt: updated.updatedAt,
        };
      }

      case 'intuition.scan': {
        const cueText = typeof params.cueText === 'string' ? params.cueText.trim() : '';
        if (!cueText) return [];
        const limit = typeof params.limit === 'number' ? Math.max(1, Math.min(10, Math.round(params.limit))) : 5;
        const hits: BridgeFlashbackSummary[] = deps.intuition
          .scanFlashbacks(cueText, {
            limit,
            ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : {}),
          })
          .map((h) => ({
            sourceId: h.sourceId,
            sourceKind: h.sourceKind,
            title: cleanText(h.title, 140),
            caution: cleanText(h.caution, 260),
            score: h.score,
            matchedCues: h.matchedCues.slice(0, 6),
            retention: h.retention,
          }));
        return hits;
      }

      case 'dream.list': {
        const limit = typeof params.limit === 'number' ? Math.max(1, Math.min(20, Math.round(params.limit))) : 10;
        const insights = deps.dream.listInsights({ limit });
        return insights.map((ins) => ({
          id: ins.id,
          kind: ins.kind,
          status: ins.status,
          title: cleanText(ins.title, 140),
          summary: cleanText(ins.summary, 280),
          actionableHypothesis: cleanText(ins.actionableHypothesis, 220),
          sourceRepos: ins.sourceRepos.slice(0, 6).map((r) => cleanText(r, 80)),
          confidence: ins.confidence,
          updatedAt: ins.updatedAt,
        }));
      }

      case 'help.list': {
        return buildSnapshot().needs.openHelpCards;
      }

      case 'tom.override': {
        const stateRaw = params.state;
        const state: PartnerStateKind | null =
          stateRaw === null
            ? null
            : typeof stateRaw === 'string' && ALLOWED_TOM_STATES.has(stateRaw as PartnerStateKind)
              ? (stateRaw as PartnerStateKind)
              : null;
        const durationMinutes =
          typeof params.durationMinutes === 'number'
            ? Math.max(5, Math.min(480, Math.round(params.durationMinutes)))
            : undefined;
        await deps.tom.actions.setManualOverride({
          state,
          ...(durationMinutes !== undefined ? { durationMinutes } : {}),
        });
        scheduleBroadcast();
        return buildSnapshot().tom;
      }

      case 'dsh.delegate_preview': {
        const prompt = typeof params.prompt === 'string' ? cleanText(params.prompt, 400) : '';
        const workspaces = (deps.listWorkspaces?.() ?? []).slice(0, 12).map((w) => cleanText(w, 180));
        return {
          supported: true,
          mode: 'm1-preview-hook',
          prompt,
          workspaces,
          activeSessionId: deps.sense.snapshot().activeSessionId ?? null,
        };
      }
    }
  };

  const wsServer = new LoopbackWsServer({
    wsPath: BRIDGE_WS_PATH,
    token,
    ...(options.port !== undefined ? { port: options.port } : {}),
    onConnect: (client) => {
      const snap = buildSnapshot();
      // Sync diff baselines only on 0 -> 1 client transition so offline state changes
      // already delivered in `hello` don't cause spurious events on the next tick, while
      // concurrent secondary connects (clientCount > 1) never swallow pending events.
      if (wsServer.clientCount === 1) {
        seedBaselines(snap);
      }
      sendMessage(client, {
        type: 'hello',
        protocolVersion: BRIDGE_VERSION,
        asiVersion,
        snapshot: snap,
      });
    },
    onMessage: (client, raw) => {
      const parsed = parseIncomingClientMessage(raw);
      if (!parsed) return;
      if (parsed.type === 'ping') {
        sendMessage(client, { type: 'pong', at: Date.now() });
        return;
      }
      if (parsed.type === 'subscribe') {
        sendMessage(client, { type: 'snapshot', snapshot: buildSnapshot() });
        return;
      }
      if (parsed.type === 'rpc.unknown') {
        sendMessage(client, {
          type: 'rpc.response',
          id: parsed.id,
          ok: false,
          error: `Unsupported RPC method: ${parsed.method}`,
        });
        return;
      }
      if (parsed.type === 'rpc.request') {
        void handleRpc(parsed.method, parsed.params)
          .then((result) => {
            sendMessage(client, {
              type: 'rpc.response',
              id: parsed.id,
              ok: true,
              result,
            });
          })
          .catch((error: unknown) => {
            sendMessage(client, {
              type: 'rpc.response',
              id: parsed.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
    },
    onDisconnect: () => {
      if (wsServer.clientCount === 0 && broadcastTimer !== null) {
        clearTimeout(broadcastTimer);
        broadcastTimer = null;
      }
    },
  });

  // Seed semantic event diff baselines at bridge startup as well.
  seedBaselines(buildSnapshot());

  const port = await wsServer.start();

  const discovery: BridgeDiscovery = {
    version: BRIDGE_VERSION,
    host: BRIDGE_HOST,
    port,
    wsPath: BRIDGE_WS_PATH,
    token,
    pid: process.pid,
    startedAt: Date.now(),
    asiVersion,
  };

  try {
    await mkdir(deps.storageRoot, { recursive: true });
    await atomicWriteSecureJson(discoveryPath, discovery);
  } catch (err) {
    await wsServer.stop().catch(() => undefined);
    throw err;
  }

  const unsubscribers = [
    deps.sense.subscribe(() => scheduleBroadcast()),
    deps.needs.subscribe(() => scheduleBroadcast()),
    deps.tom.subscribe(() => scheduleBroadcast()),
    deps.sleep.subscribe(() => scheduleBroadcast()),
    deps.intuition.subscribe(() => scheduleBroadcast()),
    deps.dream.subscribe(() => scheduleBroadcast()),
  ];

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (broadcastTimer !== null) {
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
    }
    for (const off of unsubscribers) {
      try {
        off();
      } catch {
        // Ignore teardown unsubscribe errors
      }
    }
    try {
      const existingRaw = await readFile(discoveryPath, 'utf8');
      const existing = JSON.parse(existingRaw) as Partial<BridgeDiscovery>;
      if (existing.token === token && existing.pid === process.pid) {
        await rm(discoveryPath, { force: true });
      }
    } catch {
      // Discovery file already gone or replaced by a newer instance
    }
    await wsServer.stop();
  };

  return {
    discoveryPath,
    port,
    token,
    snapshot: buildSnapshot,
    stop,
  };
}
