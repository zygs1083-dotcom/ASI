/**
 * Atomic Local Persistence for `src/intuition` (`<storageRoot>/intuition/`).
 *
 * - Stores `state.json` (settings, feedback modulation, scars, recent flashbacks)
 *   and `intentions.json` (prospective memory items) using temp-file + `rename`.
 * - Rejects symlink directories/files (`lstat`) and applies `sanitizeForModel`
 *   on both load and save.
 */

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { sanitizeForModel } from '@asi/sense-types';
import {
  type FlashbackFeedback,
  type FlashbackRecord,
  type FlashbackSourceKind,
  PROSPECTIVE_EVENT_KINDS,
  PROSPECTIVE_TRIGGER_KINDS,
  type ProspectiveEventKind,
  type ProspectiveIntention,
  type ProspectiveStatus,
  type ProspectiveTriggerKind,
  type ProspectiveTriggerSpec,
  type SomaticScar,
} from '../shared/types.js';

export const MAX_STORED_INTENTIONS = 200;
export const MAX_STORED_SCARS = 80;
export const MAX_STORED_FLASHBACKS = 60;
export const MAX_STORED_FEEDBACK = 500;

const VALID_INTENTION_STATUSES: ReadonlySet<ProspectiveStatus> = new Set([
  'pending',
  'surfaced',
  'fulfilled',
  'snoozed',
  'canceled',
  'expired',
]);
const VALID_FLASHBACK_CHANNELS: ReadonlySet<FlashbackRecord['channel']> = new Set([
  'pre-step',
  'tool-guard',
  'next-step',
  'next-turn',
  'manual',
]);
const VALID_SOURCE_KINDS: ReadonlySet<FlashbackSourceKind> = new Set([
  'scar',
  'pitfall',
  'decision',
  'preference',
  'episode',
]);
const VALID_FEEDBACK: ReadonlySet<FlashbackFeedback> = new Set(['helpful', 'dismissed', 'muted']);

function trimFeedbackRecord(raw: Readonly<Record<string, FlashbackFeedback>>): Record<string, FlashbackFeedback> {
  const entries = Object.entries(raw).filter(([k, v]) => Boolean(k.trim()) && VALID_FEEDBACK.has(v));
  const sliced = entries.length > MAX_STORED_FEEDBACK ? entries.slice(entries.length - MAX_STORED_FEEDBACK) : entries;
  const out: Record<string, FlashbackFeedback> = {};
  for (const [k, v] of sliced) {
    out[sanitizeForModel(k).slice(0, 120)] = v;
  }
  return out;
}

export interface PersistedIntuitionState {
  version: 1;
  autoIntuitionPaused: boolean;
  feedbackBySourceId: Record<string, FlashbackFeedback>;
  scars: SomaticScar[];
  recentFlashbacks: FlashbackRecord[];
}

interface PersistedIntentionsEnvelope {
  version: 1;
  intentions: ProspectiveIntention[];
}

async function assertNotSymlink(targetPath: string): Promise<void> {
  const st = await lstat(targetPath).catch(() => undefined);
  if (st?.isSymbolicLink()) {
    throw new Error('Refusing to read or write through symbolic link in intuition storage');
  }
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const dir = dirname(filePath);
  await assertNotSymlink(dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await assertNotSymlink(filePath);

  const tmp = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  try {
    await writeFile(tmp, payload, { mode: 0o600 });
    await rename(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

function sanitizeTrigger(trig: ProspectiveTriggerSpec): ProspectiveTriggerSpec {
  const kind: ProspectiveTriggerKind = (PROSPECTIVE_TRIGGER_KINDS as readonly string[]).includes(trig.kind)
    ? trig.kind
    : 'context';
  const clean: ProspectiveTriggerSpec = { kind };
  if (typeof trig.dueAt === 'number' && Number.isFinite(trig.dueAt)) clean.dueAt = Math.trunc(trig.dueAt);
  if (typeof trig.workspaceMatch === 'string' && trig.workspaceMatch.trim()) {
    clean.workspaceMatch = sanitizeForModel(trig.workspaceMatch.trim()).slice(0, 240);
  }
  if (typeof trig.keywordMatch === 'string' && trig.keywordMatch.trim()) {
    clean.keywordMatch = sanitizeForModel(trig.keywordMatch.trim()).slice(0, 240);
  }
  if (typeof trig.appMatch === 'string' && trig.appMatch.trim()) {
    clean.appMatch = sanitizeForModel(trig.appMatch.trim()).slice(0, 160);
  }
  if (trig.eventKind && (PROSPECTIVE_EVENT_KINDS as readonly string[]).includes(trig.eventKind)) {
    clean.eventKind = trig.eventKind as ProspectiveEventKind;
  }
  if (typeof trig.toolName === 'string' && trig.toolName.trim()) {
    clean.toolName = sanitizeForModel(trig.toolName.trim()).slice(0, 80);
  }
  if (typeof trig.targetPattern === 'string' && trig.targetPattern.trim()) {
    clean.targetPattern = sanitizeForModel(trig.targetPattern.trim()).slice(0, 240);
  }
  return clean;
}

export function sanitizeIntention(item: ProspectiveIntention): ProspectiveIntention {
  const status: ProspectiveStatus = VALID_INTENTION_STATUSES.has(item.status) ? item.status : 'pending';
  const out: ProspectiveIntention = {
    id: sanitizeForModel(String(item.id ?? '')).slice(0, 80),
    title: sanitizeForModel(String(item.title ?? '').trim()).slice(0, 160),
    instruction: sanitizeForModel(String(item.instruction ?? '').trim()).slice(0, 1_000),
    trigger: sanitizeTrigger(item.trigger ?? { kind: 'context' }),
    triggerSummary: sanitizeForModel(String(item.triggerSummary ?? '').trim()).slice(0, 240),
    priority: item.priority === 'high' ? 'high' : 'normal',
    status,
    createdAt: Math.trunc(Number(item.createdAt) || 0),
    updatedAt: Math.trunc(Number(item.updatedAt) || 0),
    surfacedCount: Math.max(0, Math.trunc(Number(item.surfacedCount) || 0)),
  };
  if (item.sourceSessionId) out.sourceSessionId = sanitizeForModel(item.sourceSessionId).slice(0, 120);
  if (typeof item.expiresAt === 'number' && Number.isFinite(item.expiresAt)) out.expiresAt = Math.trunc(item.expiresAt);
  if (typeof item.snoozedUntil === 'number' && Number.isFinite(item.snoozedUntil)) {
    out.snoozedUntil = Math.trunc(item.snoozedUntil);
  }
  if (typeof item.lastSurfacedAt === 'number' && Number.isFinite(item.lastSurfacedAt)) {
    out.lastSurfacedAt = Math.trunc(item.lastSurfacedAt);
  }
  if (typeof item.fulfilledAt === 'number' && Number.isFinite(item.fulfilledAt)) {
    out.fulfilledAt = Math.trunc(item.fulfilledAt);
  }
  if (typeof item.resolutionNote === 'string' && item.resolutionNote.trim()) {
    out.resolutionNote = sanitizeForModel(item.resolutionNote.trim()).slice(0, 300);
  }
  return out;
}

export function sanitizeScar(scar: SomaticScar): SomaticScar {
  const out: SomaticScar = {
    id: sanitizeForModel(scar.id).slice(0, 80),
    toolName: sanitizeForModel(scar.toolName.trim()).slice(0, 80),
    signature: sanitizeForModel(scar.signature.trim()).slice(0, 200),
    title: sanitizeForModel(scar.title.trim()).slice(0, 160),
    caution: sanitizeForModel(scar.caution.trim()).slice(0, 600),
    tags: scar.tags
      .map((t) => sanitizeForModel(String(t).trim()).slice(0, 48))
      .filter(Boolean)
      .slice(0, 12),
    failureCount: Math.max(1, Math.trunc(scar.failureCount)),
    firstSeenAt: Math.trunc(scar.firstSeenAt),
    updatedAt: Math.trunc(scar.updatedAt),
  };
  if (scar.workspaceHint?.trim()) {
    out.workspaceHint = sanitizeForModel(scar.workspaceHint.trim()).slice(0, 200);
  }
  return out;
}

export function sanitizeFlashbackRecord(rec: FlashbackRecord): FlashbackRecord {
  const channel: FlashbackRecord['channel'] = VALID_FLASHBACK_CHANNELS.has(rec.channel) ? rec.channel : 'pre-step';
  const sourceKind: FlashbackSourceKind = VALID_SOURCE_KINDS.has(rec.sourceKind) ? rec.sourceKind : 'pitfall';
  const out: FlashbackRecord = {
    id: sanitizeForModel(String(rec.id ?? '')).slice(0, 80),
    at: Math.trunc(Number(rec.at) || 0),
    channel,
    sourceId: sanitizeForModel(String(rec.sourceId ?? '')).slice(0, 120),
    sourceKind,
    title: sanitizeForModel(String(rec.title ?? '').trim()).slice(0, 160),
    caution: sanitizeForModel(String(rec.caution ?? '').trim()).slice(0, 600),
    score: Math.round(Math.max(0, Math.min(1, Number(rec.score) || 0)) * 1000) / 1000,
    matchedCues: Array.isArray(rec.matchedCues)
      ? rec.matchedCues
          .map((c) => sanitizeForModel(String(c).trim()).slice(0, 48))
          .filter(Boolean)
          .slice(0, 8)
      : [],
  };
  if (typeof rec.sessionId === 'string' && rec.sessionId.trim()) {
    out.sessionId = sanitizeForModel(rec.sessionId).slice(0, 120);
  }
  if (rec.feedback && VALID_FEEDBACK.has(rec.feedback)) out.feedback = rec.feedback;
  return out;
}

function capIntentions(items: readonly ProspectiveIntention[]): ProspectiveIntention[] {
  const sanitized = items.map(sanitizeIntention);
  if (sanitized.length <= MAX_STORED_INTENTIONS) return sanitized;

  const active = sanitized.filter((i) => i.status === 'surfaced' || i.status === 'pending' || i.status === 'snoozed');
  const terminal = sanitized
    .filter((i) => i.status === 'fulfilled' || i.status === 'canceled' || i.status === 'expired')
    .sort((a, b) => b.updatedAt - a.updatedAt);

  if (active.length >= MAX_STORED_INTENTIONS) {
    return active.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_STORED_INTENTIONS);
  }
  return [...active, ...terminal.slice(0, MAX_STORED_INTENTIONS - active.length)];
}

export class IntuitionStore {
  readonly rootDir: string;
  private readonly statePath: string;
  private readonly intentionsPath: string;

  constructor(storageRoot: string) {
    if (!isAbsolute(storageRoot)) {
      throw new TypeError('IntuitionStore storageRoot must be an absolute path');
    }
    this.rootDir = resolve(storageRoot);
    this.statePath = join(this.rootDir, 'state.json');
    this.intentionsPath = join(this.rootDir, 'intentions.json');
  }

  async load(): Promise<{
    state: PersistedIntuitionState;
    intentions: ProspectiveIntention[];
  }> {
    await assertNotSymlink(this.rootDir);

    let state: PersistedIntuitionState = {
      version: 1,
      autoIntuitionPaused: false,
      feedbackBySourceId: {},
      scars: [],
      recentFlashbacks: [],
    };

    try {
      await assertNotSymlink(this.statePath);
      const rawState = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<PersistedIntuitionState>;
      if (rawState && typeof rawState === 'object') {
        const cleanFeedback =
          rawState.feedbackBySourceId && typeof rawState.feedbackBySourceId === 'object'
            ? trimFeedbackRecord(rawState.feedbackBySourceId as Record<string, FlashbackFeedback>)
            : {};
        state = {
          version: 1,
          autoIntuitionPaused: Boolean(rawState.autoIntuitionPaused),
          feedbackBySourceId: cleanFeedback,
          scars: Array.isArray(rawState.scars) ? rawState.scars.slice(0, MAX_STORED_SCARS).map(sanitizeScar) : [],
          recentFlashbacks: Array.isArray(rawState.recentFlashbacks)
            ? rawState.recentFlashbacks.slice(0, MAX_STORED_FLASHBACKS).map(sanitizeFlashbackRecord)
            : [],
        };
      }
    } catch {
      // Missing or corrupted state defaults cleanly.
    }

    let intentions: ProspectiveIntention[] = [];
    try {
      await assertNotSymlink(this.intentionsPath);
      const rawEnv = JSON.parse(await readFile(this.intentionsPath, 'utf8')) as Partial<PersistedIntentionsEnvelope>;
      if (rawEnv && Array.isArray(rawEnv.intentions)) {
        intentions = capIntentions(rawEnv.intentions);
      }
    } catch {
      // Missing or corrupted intentions default cleanly.
    }

    return { state, intentions };
  }

  async saveState(state: PersistedIntuitionState): Promise<void> {
    const clean: PersistedIntuitionState = {
      version: 1,
      autoIntuitionPaused: Boolean(state.autoIntuitionPaused),
      feedbackBySourceId: trimFeedbackRecord(state.feedbackBySourceId),
      scars: state.scars.slice(0, MAX_STORED_SCARS).map(sanitizeScar),
      recentFlashbacks: state.recentFlashbacks.slice(0, MAX_STORED_FLASHBACKS).map(sanitizeFlashbackRecord),
    };
    await atomicWriteJson(this.statePath, clean);
  }

  async saveIntentions(intentions: readonly ProspectiveIntention[]): Promise<void> {
    const envelope: PersistedIntentionsEnvelope = {
      version: 1,
      intentions: capIntentions(intentions),
    };
    await atomicWriteJson(this.intentionsPath, envelope);
  }
}
