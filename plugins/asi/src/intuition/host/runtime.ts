/**
 * Prefrontal Cortex Runtime (`src/intuition/host/runtime.ts`).
 *
 * Coordinates:
 * 1. vmPFC Gut-Feeling Somatic Markers (<10ms local MiniSearch over L2 memories + live tool scars)
 * 2. BA10 Prospective Memory (`time`, `context`, `event` triggers + snooze/expire/fulfill lifecycle)
 * 3. Maslow `tier: 3` arbitration (`ctx.asiDrives`, `autoMaintain: false` -> zero background LLM turns)
 * 4. Tail-only, Prompt-Cache-safe delivery (`pre-step` tail batch, `next-turn` inbox coalescing, `inject`)
 */

import { randomUUID } from 'node:crypto';
import {
  type FlashbackHitSummary,
  type IntuitionScanOptions,
  type IntuitionSnapshot,
  type ProspectiveIntentionSummary,
  type ProspectiveStatus,
  type SenseSnapshot,
  type SleepMemorySummary,
  sanitizeForModel,
} from '@asi/sense-types';
import {
  type FlashbackFeedback,
  type FlashbackMatch,
  type FlashbackRecord,
  type IntuitionPanelModel,
  PROSPECTIVE_EVENT_KINDS,
  PROSPECTIVE_TRIGGER_KINDS,
  type ProspectiveCreateInput,
  type ProspectiveEventKind,
  type ProspectiveIntention,
  type ProspectiveResolveInput,
  type ProspectiveTriggerSpec,
  type SomaticScar,
} from '../shared/types.js';
import { formatIntuitionMessage } from './message-format.js';
import type { IntuitionHostPorts, ToolPreExecuteCue, ToolResultCue, UserPreStepCue } from './ports.js';
import {
  evaluateIntuitionDrive,
  evaluateProspectiveCues,
  formatTriggerSummary,
  type ProspectiveCueContext,
  reconcileProspectiveLifecycle,
} from './prospective-evaluator.js';
import { extractConcreteCues, SomaticMatcher } from './somatic-matcher.js';
import {
  IntuitionStore,
  MAX_STORED_FEEDBACK,
  MAX_STORED_FLASHBACKS,
  MAX_STORED_SCARS,
  type PersistedIntuitionState,
  sanitizeFlashbackRecord,
  sanitizeIntention,
  sanitizeScar,
} from './store.js';

export const DEFAULT_FLASHBACK_COOLDOWN_MS = 30 * 60_000;
export const DEFAULT_INTUITION_TICK_MS = 30_000;
const SCAR_WINDOW_MS = 2 * 3_600_000;
const MAX_SESSION_FLASHBACK_HISTORY = 512;
const MAX_TRANSIENT_FAILURES = 256;

function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export interface IntuitionActionsApi {
  setAutoIntuitionPaused(paused: boolean): Promise<void>;
  createIntention(input: ProspectiveCreateInput, sourceSessionId?: string): Promise<ProspectiveIntention>;
  resolveIntention(input: ProspectiveResolveInput): Promise<ProspectiveIntention>;
  deleteIntention(id: string): Promise<void>;
  recordFlashbackFeedback(sourceId: string, feedback: FlashbackFeedback): Promise<void>;
  scanNow(cueText: string, options?: IntuitionScanOptions): Promise<FlashbackMatch[]>;
}

export interface IntuitionRuntime {
  readonly actions: IntuitionActionsApi;
  start(): Promise<void>;
  stop(): Promise<void>;
  panelModel(): IntuitionPanelModel;
  serviceSnapshot(): IntuitionSnapshot;
  scanFlashbacks(cueText: string, options?: IntuitionScanOptions): FlashbackHitSummary[];
  listIntentionSummaries(options?: {
    statuses?: readonly ProspectiveStatus[];
    limit?: number;
  }): ProspectiveIntentionSummary[];
  subscribe(listener: () => void): () => void;
}

export interface IntuitionRuntimeOptions {
  tickIntervalMs?: number;
  flashbackCooldownMs?: number;
}

interface PendingTurnQueueBucket {
  intentions: Map<string, ProspectiveIntention>;
  flashbacks: Map<string, FlashbackMatch>;
}

interface TransientFailureTracker {
  count: number;
  firstAt: number;
  lastError: string;
}

function toIntentionSummary(item: ProspectiveIntention): ProspectiveIntentionSummary {
  const out: ProspectiveIntentionSummary = {
    id: item.id,
    title: item.title,
    instruction: item.instruction,
    triggerKind: item.trigger.kind,
    triggerSummary: item.triggerSummary,
    priority: item.priority,
    status: item.status,
    surfacedCount: item.surfacedCount,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  if (typeof item.trigger.dueAt === 'number') out.dueAt = item.trigger.dueAt;
  if (item.trigger.workspaceMatch) out.workspaceMatch = item.trigger.workspaceMatch;
  if (typeof item.lastSurfacedAt === 'number') out.lastSurfacedAt = item.lastSurfacedAt;
  return out;
}

function sortIntentionsForDisplay(items: readonly ProspectiveIntention[]): ProspectiveIntention[] {
  const statusRank: Record<ProspectiveStatus, number> = {
    surfaced: 0,
    pending: 1,
    snoozed: 2,
    fulfilled: 3,
    canceled: 4,
    expired: 5,
  };
  return [...items].sort((a, b) => {
    const sr = statusRank[a.status] - statusRank[b.status];
    if (sr !== 0) return sr;
    if (a.priority !== b.priority) return a.priority === 'high' ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

function normalizeFailureSignature(toolName: string, targetText: string): string {
  const cleanTarget = sanitizeForModel(targetText).replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 140);
  return `${toolName.trim().toLowerCase()}::${cleanTarget || 'general'}`;
}

export function createIntuitionRuntime(ports: IntuitionHostPorts, options?: IntuitionRuntimeOptions): IntuitionRuntime {
  const nowFn = ports.now ?? (() => Date.now());
  const store = new IntuitionStore(ports.storageRoot);
  const matcher = new SomaticMatcher();
  const cooldownMs = Math.max(5_000, options?.flashbackCooldownMs ?? DEFAULT_FLASHBACK_COOLDOWN_MS);
  const tickIntervalMs = Math.max(1_000, options?.tickIntervalMs ?? DEFAULT_INTUITION_TICK_MS);

  let started = false;
  let stopped = false;
  let state: PersistedIntuitionState = {
    version: 1,
    autoIntuitionPaused: false,
    feedbackBySourceId: {},
    scars: [],
    recentFlashbacks: [],
  };
  let intentions: ProspectiveIntention[] = [];

  const listeners = new Set<() => void>();
  const disposers: (() => void)[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;

  // Cooldown map: `${sessionId}:${sourceId}` -> wall timestamp (ms)
  const sessionFlashbackHistory = new Map<string, number>();
  // Coalesced next-turn queue per session until claimed
  const pendingBySession = new Map<string, PendingTurnQueueBucket>();
  // Short-term tool error counter before promoting to a SomaticScar
  const transientFailures = new Map<string, TransientFailureTracker>();

  let lastObservedFrontApp = '';
  let lastObservedOnline: boolean | undefined;

  let saveChain: Promise<void> = Promise.resolve();
  const enqueueSave = (kind: 'state' | 'intentions' | 'both'): Promise<void> => {
    if (stopped) return saveChain;
    const snapState: PersistedIntuitionState = structuredClone(state);
    const snapIntentions: ProspectiveIntention[] = structuredClone(intentions);
    saveChain = saveChain
      .catch(() => undefined)
      .then(async () => {
        if (kind === 'state' || kind === 'both') {
          await store.saveState(snapState);
        }
        if (kind === 'intentions' || kind === 'both') {
          await store.saveIntentions(snapIntentions);
        }
      })
      .catch(() => undefined);
    return saveChain;
  };

  const notifyAll = () => {
    ports.drives?.notifySourceChanged('asi-intuition');
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        // Isolate subscriber errors
      }
    }
  };

  const isSuppressed = (): { suppressed: boolean; reason?: string } => {
    const senseSettings = ports.sense.getSettings();
    if (senseSettings.paused) {
      return { suppressed: true, reason: '全局感知与自维护已暂停' };
    }
    if (state.autoIntuitionPaused) {
      return { suppressed: true, reason: '前额叶自动直觉入队已暂停' };
    }
    const drivesSnap = ports.drives?.snapshot();
    if (drivesSnap?.higherOrderSuppressed) {
      return {
        suppressed: true,
        ...(drivesSnap.suppressionReason ? { reason: drivesSnap.suppressionReason } : {}),
      };
    }
    if (senseSettings.powerMode === 'eco') {
      return { suppressed: true, reason: '当前处于节能模式（eco），高阶直觉自动触发已降频挂起' };
    }
    return { suppressed: false };
  };

  const listEligibleMemories = (): SleepMemorySummary[] => {
    return (
      ports.sleep?.listMemories({
        kinds: ['pitfall', 'decision', 'preference'],
        minRetention: 0.25,
        limit: 200,
      }) ?? []
    );
  };

  const allowedWindowTitle = (snap?: SenseSnapshot): string | undefined => {
    const s = snap ?? ports.sense.snapshot();
    if (!s.settings.sendTitles) return undefined;
    const val = s.state.env.focusedWindow.value?.title;
    if (!val || val === '[REDACTED]') return undefined;
    return sanitizeForModel(val);
  };

  const pickTargetSessionId = (preferredSessionId?: string, workspaceHint?: string): string | undefined => {
    const ordinaryIds = ports.sessions.listOrdinarySessionIds();
    if (preferredSessionId && ordinaryIds.includes(preferredSessionId)) {
      return preferredSessionId;
    }
    if (workspaceHint?.trim()) {
      const lower = workspaceHint.trim().toLowerCase();
      const matched = ordinaryIds.find((sid) =>
        (ports.sessions.getSessionCwd(sid) ?? '').toLowerCase().includes(lower),
      );
      if (matched) return matched;
    }
    const activeSid = ports.sense.snapshot().activeSessionId;
    if (activeSid && ordinaryIds.includes(activeSid)) {
      return activeSid;
    }
    return ordinaryIds.at(-1);
  };

  const recordFlashbacks = (
    channel: FlashbackRecord['channel'],
    matches: readonly FlashbackMatch[],
    sessionId: string | undefined,
    now: number,
  ): void => {
    if (matches.length === 0) return;
    const newRecords: FlashbackRecord[] = matches.map((m) =>
      sanitizeFlashbackRecord({
        id: `fb_${now.toString(36)}_${randomUUID().slice(0, 6)}`,
        at: now,
        channel,
        sourceId: m.sourceId,
        sourceKind: m.sourceKind,
        title: m.title,
        caution: m.caution,
        score: m.score,
        matchedCues: m.matchedCues,
        ...(sessionId ? { sessionId } : {}),
        ...(state.feedbackBySourceId[m.sourceId] ? { feedback: state.feedbackBySourceId[m.sourceId] } : {}),
      }),
    );
    state = {
      ...state,
      recentFlashbacks: [...newRecords, ...state.recentFlashbacks].slice(0, MAX_STORED_FLASHBACKS),
    };
  };

  const filterFreshFlashbacksForSession = (
    sessionId: string,
    candidates: readonly FlashbackMatch[],
    now: number,
  ): FlashbackMatch[] => {
    const fresh: FlashbackMatch[] = [];
    for (const c of candidates) {
      const key = `${sessionId}:${c.sourceId}`;
      const prevAt = sessionFlashbackHistory.get(key);
      if (prevAt !== undefined && now - prevAt < cooldownMs) continue;
      fresh.push(c);
    }
    return fresh;
  };

  const markFlashbacksDelivered = (sessionId: string, delivered: readonly FlashbackMatch[], now: number): void => {
    for (const item of delivered) {
      setBoundedMap(sessionFlashbackHistory, `${sessionId}:${item.sourceId}`, now, MAX_SESSION_FLASHBACK_HISTORY);
    }
  };

  const markIntentionsSurfaced = (matchedIds: ReadonlySet<string>, now: number): ProspectiveIntention[] => {
    if (matchedIds.size === 0) return [];
    const surfacedNow: ProspectiveIntention[] = [];
    intentions = intentions.map((item) => {
      if (!matchedIds.has(item.id)) return item;
      const updated: ProspectiveIntention = sanitizeIntention({
        ...item,
        status: 'surfaced',
        surfacedCount: item.surfacedCount + 1,
        lastSurfacedAt: now,
        updatedAt: now,
        triggerSummary: formatTriggerSummary(item.trigger, now),
      });
      surfacedNow.push(updated);
      return updated;
    });
    return surfacedNow;
  };

  const syncSessionBucket = (sessionId: string): boolean => {
    const bucket = pendingBySession.get(sessionId);
    if (!bucket || isSuppressed().suppressed) {
      pendingBySession.delete(sessionId);
      ports.sessions.syncParkedMessage(sessionId, null);
      return false;
    }
    const formatted = formatIntuitionMessage({
      intentions: [...bucket.intentions.values()],
      flashbacks: [...bucket.flashbacks.values()],
    });
    if (!formatted) {
      pendingBySession.delete(sessionId);
      ports.sessions.syncParkedMessage(sessionId, null);
      return false;
    }
    return ports.sessions.syncParkedMessage(sessionId, formatted);
  };

  const retractAllParkedBuckets = (): void => {
    for (const sid of [...pendingBySession.keys()]) {
      pendingBySession.delete(sid);
      ports.sessions.syncParkedMessage(sid, null);
    }
  };

  const pruneInactiveFromPendingBuckets = (): void => {
    if (pendingBySession.size === 0) return;
    const activeSurfaced = new Map<string, ProspectiveIntention>();
    for (const item of intentions) {
      if (item.status === 'surfaced') activeSurfaced.set(item.id, item);
    }
    for (const [sid, bucket] of [...pendingBySession.entries()]) {
      let changed = false;
      for (const id of [...bucket.intentions.keys()]) {
        const live = activeSurfaced.get(id);
        if (!live) {
          bucket.intentions.delete(id);
          changed = true;
        } else {
          bucket.intentions.set(id, live);
        }
      }
      if (changed) {
        syncSessionBucket(sid);
      }
    }
  };

  const parkToNextStepCoalesced = (
    targetSessionId: string | undefined,
    newIntentions: readonly ProspectiveIntention[],
    newFlashbacks: readonly FlashbackMatch[],
  ): boolean => {
    if (newIntentions.length === 0 && newFlashbacks.length === 0) return false;
    const resolvedSid = pickTargetSessionId(targetSessionId, newIntentions[0]?.trigger.workspaceMatch);
    if (!resolvedSid) return false;

    let bucket = pendingBySession.get(resolvedSid);
    if (!bucket) {
      bucket = { intentions: new Map(), flashbacks: new Map() };
      pendingBySession.set(resolvedSid, bucket);
    }
    for (const i of newIntentions) bucket.intentions.set(i.id, i);
    for (const f of newFlashbacks) bucket.flashbacks.set(f.sourceId, f);

    return syncSessionBucket(resolvedSid);
  };

  const runCueEvaluationAndPark = (cue: ProspectiveCueContext, preferredSessionId?: string): void => {
    const now = cue.now;
    const rec = reconcileProspectiveLifecycle(intentions, now);
    let dirtyIntentions = rec.changed;
    if (rec.changed) {
      intentions = rec.updated;
      pruneInactiveFromPendingBuckets();
    }

    const sup = isSuppressed();
    if (sup.suppressed) {
      retractAllParkedBuckets();
      if (dirtyIntentions) {
        void enqueueSave('intentions');
        notifyAll();
      }
      return;
    }

    const deferProactive = Boolean(ports.tom?.shouldDeferProactiveWork());
    const rawMatched = evaluateProspectiveCues(intentions, cue);
    const matched = deferProactive ? rawMatched.filter((m) => m.priority === 'high') : rawMatched;
    if (matched.length > 0) {
      const matchedIds = new Set(matched.map((m) => m.id));
      const surfacedItems = markIntentionsSurfaced(matchedIds, now);
      dirtyIntentions = true;

      // Group by best target session so workspace/session-bound intentions reach the right session
      const bySession = new Map<string | undefined, ProspectiveIntention[]>();
      for (const item of surfacedItems) {
        const sid = pickTargetSessionId(preferredSessionId ?? item.sourceSessionId, item.trigger.workspaceMatch);
        const arr = bySession.get(sid) ?? [];
        arr.push(item);
        bySession.set(sid, arr);
      }
      for (const [sid, group] of bySession) {
        if (sid) {
          parkToNextStepCoalesced(sid, group, []);
        }
      }
    }

    if (dirtyIntentions) {
      void enqueueSave('intentions');
      notifyAll();
    }
  };

  const handleUserPreStep = (cue: UserPreStepCue): string | null => {
    const now = nowFn();
    const rec = reconcileProspectiveLifecycle(intentions, now);
    let dirtyIntentions = rec.changed;
    if (rec.changed) {
      intentions = rec.updated;
      pruneInactiveFromPendingBuckets();
    }

    const sup = isSuppressed();
    if (sup.suppressed) {
      retractAllParkedBuckets();
      if (dirtyIntentions) {
        void enqueueSave('intentions');
        notifyAll();
      }
      return null;
    }

    const deferProactive = Boolean(ports.tom?.shouldDeferProactiveWork());
    const senseSnap = ports.sense.snapshot(cue.sessionId);
    const winTitle = allowedWindowTitle(senseSnap);
    const frontApp = senseSnap.state.env.frontApp.value;

    const rawMatchedTimeOrCtx = evaluateProspectiveCues(intentions, {
      now,
      reason: 'pre-step',
      ...(cue.cwd ? { cwd: cue.cwd } : {}),
      promptText: cue.promptText,
      ...(winTitle ? { windowTitle: winTitle } : {}),
      ...(frontApp?.name ? { frontAppName: frontApp.name } : {}),
      ...(frontApp?.bundleId ? { frontAppBundleId: frontApp.bundleId } : {}),
    });
    const matchedTimeOrCtx = deferProactive
      ? rawMatchedTimeOrCtx.filter((i) => i.priority === 'high')
      : rawMatchedTimeOrCtx;

    const bucket = pendingBySession.get(cue.sessionId);
    const newlyMatched = matchedTimeOrCtx.filter((i) => !bucket?.intentions.has(i.id));
    let surfacedNow: ProspectiveIntention[] = [];
    if (newlyMatched.length > 0) {
      surfacedNow = markIntentionsSurfaced(new Set(newlyMatched.map((i) => i.id)), now);
      dirtyIntentions = true;
    }

    const scanCues = [cue.promptText, winTitle].filter(Boolean).join('\n');
    const rawFlashbacks = matcher.scan({
      cueText: scanCues,
      ...(cue.cwd ? { cwd: cue.cwd } : {}),
      memories: listEligibleMemories(),
      scars: state.scars,
      feedbackBySourceId: state.feedbackBySourceId,
      minScore: deferProactive ? 0.68 : 0.6,
      limit: 2,
    });
    const freshFlashbacks = filterFreshFlashbacksForSession(cue.sessionId, rawFlashbacks, now).filter(
      (f) => !bucket?.flashbacks.has(f.sourceId),
    );

    let dirtyState = false;
    if (freshFlashbacks.length > 0) {
      markFlashbacksDelivered(cue.sessionId, freshFlashbacks, now);
      recordFlashbacks('pre-step', freshFlashbacks, cue.sessionId, now);
      dirtyState = true;
    }

    // If a parked next-step message was not yet claimed before pre-step, retract it from inbox
    // and coalesce its items into this single step-1 tail note so nothing is delivered twice.
    const carriedIntentions = bucket ? [...bucket.intentions.values()] : [];
    const carriedFlashbacks = bucket ? [...bucket.flashbacks.values()] : [];
    if (bucket) {
      pendingBySession.delete(cue.sessionId);
      ports.sessions.syncParkedMessage(cue.sessionId, null);
    }

    if (dirtyIntentions || dirtyState) {
      void enqueueSave(dirtyIntentions && dirtyState ? 'both' : dirtyIntentions ? 'intentions' : 'state');
      notifyAll();
    }

    return formatIntuitionMessage({
      intentions: [...carriedIntentions, ...surfacedNow],
      flashbacks: [...carriedFlashbacks, ...freshFlashbacks],
    });
  };

  const handleToolPreExecute = (cue: ToolPreExecuteCue): void => {
    const now = nowFn();
    const rec = reconcileProspectiveLifecycle(intentions, now);
    let dirtyIntentions = rec.changed;
    if (rec.changed) {
      intentions = rec.updated;
      pruneInactiveFromPendingBuckets();
    }

    const sup = isSuppressed();
    if (sup.suppressed) {
      retractAllParkedBuckets();
      if (dirtyIntentions) {
        void enqueueSave('intentions');
        notifyAll();
      }
      return;
    }

    const deferProactive = Boolean(ports.tom?.shouldDeferProactiveWork());
    const rawMatchedTools = evaluateProspectiveCues(intentions, {
      now,
      reason: 'tool',
      eventKind: 'tool_call',
      toolName: cue.toolName,
      targetText: cue.targetText,
      ...(cue.cwd ? { cwd: cue.cwd } : {}),
    });
    const matchedTools = deferProactive ? rawMatchedTools.filter((i) => i.priority === 'high') : rawMatchedTools;

    let surfacedNow: ProspectiveIntention[] = [];
    if (matchedTools.length > 0) {
      surfacedNow = markIntentionsSurfaced(new Set(matchedTools.map((i) => i.id)), now);
      dirtyIntentions = true;
    }

    // Higher threshold on mid-turn tool execution so only strong pitfalls/scars fire;
    // pass unified listEligibleMemories() + allowedKinds so MiniSearch index never thrashes!
    const rawFlashbacks = matcher.scan({
      cueText: cue.targetText,
      ...(cue.cwd ? { cwd: cue.cwd } : {}),
      toolName: cue.toolName,
      memories: listEligibleMemories(),
      scars: state.scars,
      allowedKinds: ['scar', 'pitfall', 'decision'],
      feedbackBySourceId: state.feedbackBySourceId,
      minScore: deferProactive ? 0.74 : 0.66,
      limit: 1,
    });
    const freshFlashbacks = filterFreshFlashbacksForSession(cue.sessionId, rawFlashbacks, now);

    let dirtyState = false;
    if (freshFlashbacks.length > 0) {
      markFlashbacksDelivered(cue.sessionId, freshFlashbacks, now);
      recordFlashbacks('tool-guard', freshFlashbacks, cue.sessionId, now);
      dirtyState = true;
    }

    const msg = formatIntuitionMessage({
      intentions: surfacedNow,
      flashbacks: freshFlashbacks,
    });
    if (msg) {
      ports.sessions.injectNextStep(cue.sessionId, msg);
    }

    if (dirtyIntentions || dirtyState) {
      void enqueueSave(dirtyIntentions && dirtyState ? 'both' : dirtyIntentions ? 'intentions' : 'state');
      notifyAll();
    }
  };

  const handleToolResult = (cue: ToolResultCue): void => {
    if (isSuppressed().suppressed) return;
    const now = nowFn();
    const sig = normalizeFailureSignature(cue.toolName, cue.targetText);

    if (!cue.failed) {
      transientFailures.delete(sig);
      return;
    }

    const prev = transientFailures.get(sig);
    const errText = sanitizeForModel(cue.errorSummary ?? '工具调用执行失败').slice(0, 260);
    if (!prev || now - prev.firstAt > SCAR_WINDOW_MS) {
      setBoundedMap(transientFailures, sig, { count: 1, firstAt: now, lastError: errText }, MAX_TRANSIENT_FAILURES);
      return;
    }

    const nextCount = prev.count + 1;
    setBoundedMap(
      transientFailures,
      sig,
      { count: nextCount, firstAt: prev.firstAt, lastError: errText },
      MAX_TRANSIENT_FAILURES,
    );
    if (nextCount < 2) return;

    const existingIdx = state.scars.findIndex((s) => s.signature === sig);
    const tags = extractConcreteCues(`${cue.toolName} ${cue.targetText}`).slice(0, 8);
    const cleanTargetShort = sanitizeForModel(cue.targetText).replace(/\s+/g, ' ').trim().slice(0, 80);

    const existing = existingIdx >= 0 ? state.scars[existingIdx] : undefined;
    let nextScars: SomaticScar[];
    if (existing) {
      const updated = sanitizeScar({
        ...existing,
        failureCount: existing.failureCount + 1,
        caution: `近期在该目标连续失败 ${existing.failureCount + 1} 次（最近错误：${errText}），请先排查根因避免盲目重试。`,
        updatedAt: now,
      });
      nextScars = [updated, ...state.scars.filter((_, i) => i !== existingIdx)].slice(0, MAX_STORED_SCARS);
    } else {
      const created = sanitizeScar({
        id: `scar_${now.toString(36)}_${randomUUID().slice(0, 6)}`,
        toolName: cue.toolName,
        signature: sig,
        title: `${cue.toolName} 在「${cleanTargetShort || '同一目标'}」重复报错`,
        caution: `近期连续失败 ${nextCount} 次（最近错误：${errText}），请检查参数、环境或权限后再试。`,
        tags,
        ...(cue.cwd ? { workspaceHint: cue.cwd } : {}),
        failureCount: nextCount,
        firstSeenAt: prev.firstAt,
        updatedAt: now,
      });
      nextScars = [created, ...state.scars].slice(0, MAX_STORED_SCARS);
    }

    state = { ...state, scars: nextScars };
    void enqueueSave('state');
    notifyAll();
  };

  const buildTriggerSpecFromInput = (input: ProspectiveCreateInput, now: number): ProspectiveTriggerSpec => {
    if (!PROSPECTIVE_TRIGGER_KINDS.includes(input.triggerKind)) {
      throw new Error('triggerKind 必须为 time、context 或 event');
    }
    if (input.triggerKind === 'time') {
      let dueAt = input.dueAt;
      if (dueAt === undefined && typeof input.delayMinutes === 'number' && Number.isFinite(input.delayMinutes)) {
        dueAt = now + Math.max(0.1, Math.min(43_200, input.delayMinutes)) * 60_000;
      }
      if (typeof dueAt !== 'number' || !Number.isFinite(dueAt)) {
        throw new Error('定时型前瞻记忆须提供有效的 delayMinutes 或 dueAt');
      }
      return { kind: 'time', dueAt: Math.trunc(dueAt) };
    }

    if (input.triggerKind === 'context') {
      const ws = input.workspaceMatch?.trim();
      const kw = input.keywordMatch?.trim();
      const app = input.appMatch?.trim();
      if (!ws && !kw && !app) {
        throw new Error('情境型前瞻记忆至少须指定 workspaceMatch、keywordMatch 或 appMatch 之一');
      }
      return {
        kind: 'context',
        ...(ws ? { workspaceMatch: ws } : {}),
        ...(kw ? { keywordMatch: kw } : {}),
        ...(app ? { appMatch: app } : {}),
      };
    }

    const evKind: ProspectiveEventKind =
      input.eventKind && PROSPECTIVE_EVENT_KINDS.includes(input.eventKind) ? input.eventKind : 'next_session';
    return {
      kind: 'event',
      eventKind: evKind,
      ...(input.workspaceMatch?.trim() ? { workspaceMatch: input.workspaceMatch.trim() } : {}),
      ...(input.toolName?.trim() ? { toolName: input.toolName.trim() } : {}),
      ...(input.targetPattern?.trim() ? { targetPattern: input.targetPattern.trim() } : {}),
    };
  };

  const actions: IntuitionActionsApi = {
    async setAutoIntuitionPaused(paused: boolean): Promise<void> {
      state = { ...state, autoIntuitionPaused: Boolean(paused) };
      if (state.autoIntuitionPaused) {
        retractAllParkedBuckets();
      }
      await enqueueSave('state');
      notifyAll();
    },

    async createIntention(input: ProspectiveCreateInput, sourceSessionId?: string): Promise<ProspectiveIntention> {
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : '';
      if (!title || !instruction) {
        throw new Error('前瞻记忆的标题（title）与执行提醒（instruction）不能为空');
      }
      const now = nowFn();
      const trigger = buildTriggerSpecFromInput(input, now);
      const expiresAt =
        typeof input.expiresInHours === 'number' && Number.isFinite(input.expiresInHours) && input.expiresInHours > 0
          ? Math.trunc(now + Math.min(8_760, input.expiresInHours) * 3_600_000)
          : undefined;

      const created = sanitizeIntention({
        id: `pm_${now.toString(36)}_${randomUUID().slice(0, 6)}`,
        title,
        instruction,
        trigger,
        triggerSummary: formatTriggerSummary(trigger, now),
        priority: input.priority === 'high' ? 'high' : 'normal',
        status: 'pending',
        ...(sourceSessionId ? { sourceSessionId } : {}),
        createdAt: now,
        updatedAt: now,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        surfacedCount: 0,
      });

      intentions = [created, ...intentions];
      await enqueueSave('intentions');
      notifyAll();
      return structuredClone(created);
    },

    async resolveIntention(input: ProspectiveResolveInput): Promise<ProspectiveIntention> {
      const id = typeof input.id === 'string' ? input.id.trim() : '';
      if (!id) throw new Error('前瞻记忆 id 不能为空');
      const idx = intentions.findIndex((i) => i.id === id);
      const current = idx >= 0 ? intentions[idx] : undefined;
      if (!current) throw new Error(`未找到对应的前瞻记忆条目：${sanitizeForModel(id)}`);

      const now = nowFn();
      let next: ProspectiveIntention;

      if (input.action === 'fulfill') {
        next = sanitizeIntention({
          ...current,
          status: 'fulfilled',
          fulfilledAt: now,
          updatedAt: now,
          ...(input.note?.trim() ? { resolutionNote: input.note.trim() } : {}),
        });
        delete next.snoozedUntil;
      } else if (input.action === 'snooze') {
        const mins =
          typeof input.snoozeMinutes === 'number' && Number.isFinite(input.snoozeMinutes)
            ? Math.max(1, Math.min(10_080, input.snoozeMinutes))
            : 30;
        const snoozedUntil = Math.trunc(now + mins * 60_000);
        const nextTrigger: ProspectiveTriggerSpec =
          current.trigger.kind === 'time' ? { ...current.trigger, dueAt: snoozedUntil } : current.trigger;
        next = sanitizeIntention({
          ...current,
          trigger: nextTrigger,
          triggerSummary: formatTriggerSummary(nextTrigger, now),
          status: 'snoozed',
          snoozedUntil,
          updatedAt: now,
          ...(input.note?.trim() ? { resolutionNote: input.note.trim() } : {}),
        });
      } else if (input.action === 'cancel') {
        next = sanitizeIntention({
          ...current,
          status: 'canceled',
          updatedAt: now,
          ...(input.note?.trim() ? { resolutionNote: input.note.trim() } : {}),
        });
        delete next.snoozedUntil;
      } else {
        throw new Error('action 必须为 fulfill、snooze 或 cancel');
      }

      intentions = intentions.map((item, i) => (i === idx ? next : item));
      for (const [sid, bucket] of [...pendingBySession.entries()]) {
        if (bucket.intentions.delete(id)) {
          syncSessionBucket(sid);
        }
      }
      await enqueueSave('intentions');
      notifyAll();
      return structuredClone(next);
    },

    async deleteIntention(id: string): Promise<void> {
      const cleanId = typeof id === 'string' ? id.trim() : '';
      if (!cleanId) throw new Error('前瞻记忆 id 不能为空');
      const beforeLen = intentions.length;
      intentions = intentions.filter((i) => i.id !== cleanId);
      if (intentions.length === beforeLen) return;
      for (const [sid, bucket] of [...pendingBySession.entries()]) {
        if (bucket.intentions.delete(cleanId)) {
          syncSessionBucket(sid);
        }
      }
      await enqueueSave('intentions');
      notifyAll();
    },

    async recordFlashbackFeedback(sourceId: string, feedback: FlashbackFeedback): Promise<void> {
      const cleanSource = typeof sourceId === 'string' ? sanitizeForModel(sourceId.trim()).slice(0, 120) : '';
      if (!cleanSource) throw new Error('sourceId 不能为空');
      if (feedback !== 'helpful' && feedback !== 'dismissed' && feedback !== 'muted') {
        throw new Error('feedback 必须为 helpful、dismissed 或 muted');
      }
      const nextEntries = Object.entries(state.feedbackBySourceId).filter(([k]) => k !== cleanSource);
      nextEntries.push([cleanSource, feedback]);
      const cappedFeedback = Object.fromEntries(
        nextEntries.length > MAX_STORED_FEEDBACK
          ? nextEntries.slice(nextEntries.length - MAX_STORED_FEEDBACK)
          : nextEntries,
      );
      state = {
        ...state,
        feedbackBySourceId: cappedFeedback,
        recentFlashbacks: state.recentFlashbacks.map((r) => (r.sourceId === cleanSource ? { ...r, feedback } : r)),
      };
      await enqueueSave('state');
      notifyAll();
    },

    async scanNow(cueText: string, scanOpts?: IntuitionScanOptions): Promise<FlashbackMatch[]> {
      const clean = typeof cueText === 'string' ? cueText.trim() : '';
      if (!clean) return [];
      const matches = matcher.scan({
        cueText: clean,
        ...(scanOpts?.cwd ? { cwd: scanOpts.cwd } : {}),
        ...(scanOpts?.toolName ? { toolName: scanOpts.toolName } : {}),
        memories: listEligibleMemories(),
        scars: state.scars,
        feedbackBySourceId: state.feedbackBySourceId,
        minScore: scanOpts?.minScore ?? 0.48,
        limit: scanOpts?.limit ?? 5,
      });
      return structuredClone(matches);
    },
  };

  const computeCounts = () => {
    let pendingCount = 0;
    let surfacedCount = 0;
    let fulfilledCount = 0;
    for (const item of intentions) {
      if (item.status === 'pending' || item.status === 'snoozed') pendingCount += 1;
      else if (item.status === 'surfaced') surfacedCount += 1;
      else if (item.status === 'fulfilled') fulfilledCount += 1;
    }
    const mutedSourceCount = Object.values(state.feedbackBySourceId).filter((v) => v === 'muted').length;
    return { pendingCount, surfacedCount, fulfilledCount, mutedSourceCount };
  };

  return {
    actions,

    async start(): Promise<void> {
      if (started) return;
      started = true;
      stopped = false;

      const loaded = await store.load();
      state = loaded.state;
      const now = nowFn();
      const rec = reconcileProspectiveLifecycle(loaded.intentions, now);
      intentions = rec.updated;
      if (rec.changed) {
        await store.saveIntentions(intentions).catch(() => undefined);
      }

      if (ports.drives) {
        disposers.push(
          ports.drives.registerSource({
            id: 'asi-intuition',
            tier: 3,
            label: 'L3 前额叶直觉与前瞻',
            evaluate: () => {
              const sup = isSuppressed();
              const { externalReading } = evaluateIntuitionDrive({
                intentions,
                activeScarCount: state.scars.length,
                suppressed: sup.suppressed,
                ...(sup.reason ? { suppressionReason: sup.reason } : {}),
              });
              return [externalReading];
            },
          }),
        );
        disposers.push(
          ports.drives.subscribe((drivesSnap) => {
            if (drivesSnap.higherOrderSuppressed) {
              retractAllParkedBuckets();
            }
            for (const fn of [...listeners]) {
              try {
                fn();
              } catch {
                // ignore
              }
            }
          }),
        );
      }

      if (ports.tom?.subscribe) {
        let lastTomDefer = Boolean(ports.tom.shouldDeferProactiveWork());
        disposers.push(
          ports.tom.subscribe(() => {
            const nextDefer = Boolean(ports.tom?.shouldDeferProactiveWork());
            if (nextDefer === lastTomDefer) return;
            lastTomDefer = nextDefer;
            if (!stopped && !nextDefer) {
              runCueEvaluationAndPark({
                now: nowFn(),
                reason: 'tick',
              });
            }
          }),
        );
      }

      const initialSense = ports.sense.snapshot();
      lastObservedFrontApp = initialSense.state.env.frontApp.value?.bundleId ?? '';
      const initNet = initialSense.state.self.body.network;
      lastObservedOnline =
        initNet.status === 'ok' && initNet.value !== null ? Boolean(initNet.value.online) : undefined;

      disposers.push(
        ports.sense.subscribe((snap) => {
          if (snap.settings.paused || snap.settings.powerMode === 'eco') {
            retractAllParkedBuckets();
          }
          const ts = nowFn();
          const front = snap.state.env.frontApp.value;
          const nextBundle = front?.bundleId ?? '';
          const appChanged = Boolean(nextBundle && nextBundle !== lastObservedFrontApp);
          lastObservedFrontApp = nextBundle;

          const netFact = snap.state.self.body.network;
          const curOnline =
            netFact.status === 'ok' && netFact.value !== null ? Boolean(netFact.value.online) : undefined;
          const netRestored = lastObservedOnline === false && curOnline === true;
          if (curOnline !== undefined) lastObservedOnline = curOnline;

          const activeSid = snap.activeSessionId;
          const activeCwd = activeSid
            ? ports.sessions.getSessionCwd(activeSid)
            : snap.state.env.where.toolExec.value?.cwd;
          const winTitle = allowedWindowTitle(snap);

          if (netRestored) {
            runCueEvaluationAndPark(
              {
                now: ts,
                reason: 'event',
                eventKind: 'network_online',
                ...(activeCwd ? { cwd: activeCwd } : {}),
              },
              activeSid,
            );
          }

          if (appChanged || intentions.some((i) => i.status === 'pending' && i.trigger.kind === 'time')) {
            runCueEvaluationAndPark(
              {
                now: ts,
                reason: 'sense',
                ...(activeCwd ? { cwd: activeCwd } : {}),
                ...(winTitle ? { windowTitle: winTitle } : {}),
                ...(front?.name ? { frontAppName: front.name } : {}),
                ...(front?.bundleId ? { frontAppBundleId: front.bundleId } : {}),
              },
              activeSid,
            );
          }
        }),
      );

      if (ports.sleep) {
        disposers.push(
          ports.sleep.subscribe(() => {
            notifyAll();
          }),
        );
      }

      if (ports.events.onSleepConsolidationCompleted) {
        disposers.push(
          ports.events.onSleepConsolidationCompleted(() => {
            runCueEvaluationAndPark({
              now: nowFn(),
              reason: 'event',
              eventKind: 'sleep_completed',
            });
          }),
        );
      }

      disposers.push(
        ports.events.onSessionCreated(({ sessionId, cwd }) => {
          runCueEvaluationAndPark(
            {
              now: nowFn(),
              reason: 'event',
              eventKind: 'next_session',
              ...(cwd ? { cwd } : {}),
            },
            sessionId,
          );
        }),
      );

      disposers.push(
        ports.events.onSessionTurnClaimed((sessionId) => {
          pendingBySession.delete(sessionId);
        }),
      );

      disposers.push(ports.events.onUserPreStep((cue) => handleUserPreStep(cue)));
      disposers.push(ports.events.onToolPreExecute((cue) => handleToolPreExecute(cue)));
      disposers.push(ports.events.onToolResult((cue) => handleToolResult(cue)));

      disposers.push(
        ports.events.onJobFinished((job) => {
          runCueEvaluationAndPark(
            {
              now: nowFn(),
              reason: 'event',
              eventKind: 'job_finished',
              ...(job.label ? { targetText: job.label } : {}),
              ...(job.ownerSessionId ? { cwd: ports.sessions.getSessionCwd(job.ownerSessionId) } : {}),
            },
            job.ownerSessionId,
          );
        }),
      );

      timer = setInterval(() => {
        if (stopped) return;
        runCueEvaluationAndPark({
          now: nowFn(),
          reason: 'tick',
        });
      }, tickIntervalMs);
      timer.unref?.();

      notifyAll();
    },

    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      retractAllParkedBuckets();
      for (const off of disposers.splice(0).reverse()) {
        try {
          off();
        } catch {
          // ignore
        }
      }
      pendingBySession.clear();
      sessionFlashbackHistory.clear();
      transientFailures.clear();
      await saveChain.catch(() => undefined);
    },

    panelModel(): IntuitionPanelModel {
      const now = nowFn();
      const sup = isSuppressed();
      const { view } = evaluateIntuitionDrive({
        intentions,
        activeScarCount: state.scars.length,
        suppressed: sup.suppressed,
        ...(sup.reason ? { suppressionReason: sup.reason } : {}),
      });
      const counts = computeCounts();
      const sortedIntentions = sortIntentionsForDisplay(intentions).map((i) => ({
        ...i,
        triggerSummary: formatTriggerSummary(i.trigger, now),
      }));
      return {
        now,
        autoIntuitionPaused: state.autoIntuitionPaused,
        drive: view,
        pendingCount: counts.pendingCount,
        surfacedCount: counts.surfacedCount,
        fulfilledCount: counts.fulfilledCount,
        mutedSourceCount: counts.mutedSourceCount,
        intentions: structuredClone(sortedIntentions),
        recentFlashbacks: structuredClone(state.recentFlashbacks),
      };
    },

    serviceSnapshot(): IntuitionSnapshot {
      const now = nowFn();
      const sup = isSuppressed();
      const counts = computeCounts();
      const sorted = sortIntentionsForDisplay(intentions).map((i) =>
        toIntentionSummary({
          ...i,
          triggerSummary: formatTriggerSummary(i.trigger, now),
        }),
      );
      return {
        now,
        autoIntuitionPaused: state.autoIntuitionPaused,
        suppressed: sup.suppressed,
        ...(sup.reason ? { suppressionReason: sup.reason } : {}),
        pendingCount: counts.pendingCount,
        surfacedCount: counts.surfacedCount,
        fulfilledCount: counts.fulfilledCount,
        recentFlashbackCount: state.recentFlashbacks.length,
        intentions: sorted,
      };
    },

    scanFlashbacks(cueText: string, scanOpts?: IntuitionScanOptions): FlashbackHitSummary[] {
      const clean = typeof cueText === 'string' ? cueText.trim() : '';
      if (!clean) return [];
      const matches = matcher.scan({
        cueText: clean,
        ...(scanOpts?.cwd ? { cwd: scanOpts.cwd } : {}),
        ...(scanOpts?.toolName ? { toolName: scanOpts.toolName } : {}),
        memories: listEligibleMemories(),
        scars: state.scars,
        feedbackBySourceId: state.feedbackBySourceId,
        minScore: scanOpts?.minScore ?? 0.52,
        limit: scanOpts?.limit ?? 5,
      });
      return matches.map((m) => ({
        sourceId: m.sourceId,
        sourceKind: m.sourceKind,
        title: m.title,
        caution: m.caution,
        score: m.score,
        matchedCues: [...m.matchedCues],
        retention: m.retention,
      }));
    },

    listIntentionSummaries(listOpts?: {
      statuses?: readonly ProspectiveStatus[];
      limit?: number;
    }): ProspectiveIntentionSummary[] {
      const now = nowFn();
      const allowed = listOpts?.statuses ? new Set(listOpts.statuses) : null;
      const cap = Math.max(1, Math.min(200, Math.trunc(listOpts?.limit ?? 50)));
      return sortIntentionsForDisplay(intentions)
        .filter((i) => (allowed ? allowed.has(i.status) : true))
        .slice(0, cap)
        .map((i) =>
          toIntentionSummary({
            ...i,
            triggerSummary: formatTriggerSummary(i.trigger, now),
          }),
        );
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
