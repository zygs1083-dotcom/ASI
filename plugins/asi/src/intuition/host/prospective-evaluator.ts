/**
 * Prefrontal BA10 Prospective Memory Evaluator (`prospective-evaluator.ts`).
 *
 * - Pure local, <2ms deterministic cue matching for `time`, `context`, and
 *   `event` prospective intentions.
 * - Computes Maslow `tier: 3` drive readings (`prospective_sentinel`) for `ctx.asiDrives`.
 */

import { type ExternalDriveReading, type NeedZone, sanitizeForModel } from '@asi/sense-types';
import {
  type IntuitionDriveView,
  PROSPECTIVE_EVENT_LABELS,
  type ProspectiveEventKind,
  type ProspectiveIntention,
  type ProspectiveTriggerSpec,
} from '../shared/types.js';

export interface ProspectiveCueContext {
  now: number;
  /** Which cue channel initiated this evaluation. */
  reason: 'tick' | 'pre-step' | 'tool' | 'sense' | 'event';
  cwd?: string;
  promptText?: string;
  /** Foreground window title ONLY when `sendTitles === true`. */
  windowTitle?: string;
  frontAppName?: string;
  frontAppBundleId?: string;
  eventKind?: ProspectiveEventKind;
  toolName?: string;
  targetText?: string;
}

function splitMatchTerms(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[\s,，;；|]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 2);
}

function formatDurationShort(deltaMs: number): string {
  const absMins = Math.max(1, Math.round(Math.abs(deltaMs) / 60_000));
  if (absMins < 60) return `${absMins}m`;
  const hrs = Math.round((absMins / 60) * 10) / 10;
  return `${hrs}h`;
}

export function formatTriggerSummary(trigger: ProspectiveTriggerSpec, now: number): string {
  if (trigger.kind === 'time') {
    if (typeof trigger.dueAt === 'number' && Number.isFinite(trigger.dueAt)) {
      const diff = trigger.dueAt - now;
      if (diff <= 0) return sanitizeForModel(`定时 · 已到期（${formatDurationShort(diff)}前）`);
      return sanitizeForModel(`定时 · ${formatDurationShort(diff)}后到期`);
    }
    return '定时提醒';
  }

  if (trigger.kind === 'context') {
    const parts: string[] = [];
    if (trigger.workspaceMatch?.trim()) parts.push(`工作区含「${trigger.workspaceMatch.trim()}」`);
    if (trigger.keywordMatch?.trim()) parts.push(`关键词「${trigger.keywordMatch.trim()}」`);
    if (trigger.appMatch?.trim()) parts.push(`前台应用「${trigger.appMatch.trim()}」`);
    return sanitizeForModel(`情境 · ${parts.join(' + ') || '上下文匹配'}`);
  }

  const evLabel = trigger.eventKind ? PROSPECTIVE_EVENT_LABELS[trigger.eventKind] : '特定事件';
  const details: string[] = [evLabel];
  if (trigger.toolName?.trim()) details.push(`工具 ${trigger.toolName.trim()}`);
  if (trigger.targetPattern?.trim()) details.push(`目标含「${trigger.targetPattern.trim()}」`);
  return sanitizeForModel(`事件 · ${details.join(' · ')}`);
}

/**
 * Reconciles snoozed wakeups and expiration deadlines in-place on cloned items.
 * Returns `{ updated, changed }`.
 */
export function reconcileProspectiveLifecycle(
  intentions: readonly ProspectiveIntention[],
  now: number,
): { updated: ProspectiveIntention[]; changed: boolean } {
  let changed = false;
  const updated = intentions.map((item) => {
    if (
      (item.status === 'pending' || item.status === 'snoozed' || item.status === 'surfaced') &&
      typeof item.expiresAt === 'number' &&
      now >= item.expiresAt
    ) {
      changed = true;
      return {
        ...item,
        status: 'expired' as const,
        updatedAt: now,
      };
    }

    if (item.status === 'snoozed' && typeof item.snoozedUntil === 'number' && now >= item.snoozedUntil) {
      changed = true;
      const next: ProspectiveIntention = {
        ...item,
        status: 'pending',
        updatedAt: now,
      };
      delete next.snoozedUntil;
      if (next.trigger.kind === 'time') {
        next.trigger = { ...next.trigger, dueAt: item.snoozedUntil };
      }
      next.triggerSummary = formatTriggerSummary(next.trigger, now);
      return next;
    }

    return item;
  });

  return { updated, changed };
}

function matchesWorkspace(pattern: string | undefined, cwd: string | undefined): boolean {
  if (!pattern?.trim()) return true;
  if (!cwd?.trim()) return false;
  const hay = cwd.toLowerCase();
  const terms = splitMatchTerms(pattern);
  if (terms.length === 0) return false;
  return terms.some((t) => hay.includes(t));
}

function matchesKeywords(pattern: string | undefined, textSources: readonly (string | undefined)[]): boolean {
  if (!pattern?.trim()) return true;
  const terms = splitMatchTerms(pattern);
  if (terms.length === 0) return false;
  const combined = textSources
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .join('\n')
    .toLowerCase();
  if (!combined) return false;
  return terms.some((term) => combined.includes(term));
}

export function doesIntentionMatchCue(item: ProspectiveIntention, cue: ProspectiveCueContext): boolean {
  if (item.status !== 'pending') return false;
  if (typeof item.expiresAt === 'number' && cue.now >= item.expiresAt) return false;

  const trig = item.trigger;
  if (trig.kind === 'time') {
    return typeof trig.dueAt === 'number' && Number.isFinite(trig.dueAt) && cue.now >= trig.dueAt;
  }

  if (trig.kind === 'context') {
    const hasWs = Boolean(trig.workspaceMatch?.trim());
    const hasKw = Boolean(trig.keywordMatch?.trim());
    const hasApp = Boolean(trig.appMatch?.trim());
    if (!hasWs && !hasKw && !hasApp) return false;

    if (hasWs && !matchesWorkspace(trig.workspaceMatch, cue.cwd)) return false;
    if (hasKw && !matchesKeywords(trig.keywordMatch, [cue.promptText, cue.windowTitle, cue.targetText])) {
      return false;
    }
    if (hasApp && !matchesKeywords(trig.appMatch, [cue.frontAppName, cue.frontAppBundleId])) {
      return false;
    }
    return true;
  }

  // trig.kind === 'event'
  if (!trig.eventKind || cue.eventKind !== trig.eventKind) return false;
  if (trig.workspaceMatch?.trim() && !matchesWorkspace(trig.workspaceMatch, cue.cwd)) return false;

  if (trig.eventKind === 'tool_call') {
    if (trig.toolName?.trim()) {
      const expected = trig.toolName.trim().toLowerCase();
      if ((cue.toolName ?? '').trim().toLowerCase() !== expected) return false;
    }
    if (trig.targetPattern?.trim() && !matchesKeywords(trig.targetPattern, [cue.targetText, cue.cwd])) {
      return false;
    }
  } else if (trig.targetPattern?.trim()) {
    if (!matchesKeywords(trig.targetPattern, [cue.targetText, cue.promptText, cue.cwd])) {
      return false;
    }
  }

  return true;
}

export function evaluateProspectiveCues(
  intentions: readonly ProspectiveIntention[],
  cue: ProspectiveCueContext,
): ProspectiveIntention[] {
  return intentions.filter((item) => doesIntentionMatchCue(item, cue));
}

function zoneFromSatisfaction(satisfaction: number): NeedZone {
  if (satisfaction < 25) return 'critical';
  if (satisfaction < 60) return 'uncomfortable';
  return 'comfortable';
}

export function evaluateIntuitionDrive(input: {
  intentions: readonly ProspectiveIntention[];
  activeScarCount: number;
  suppressed: boolean;
  suppressionReason?: string;
}): { view: IntuitionDriveView; externalReading: ExternalDriveReading } {
  let pendingCount = 0;
  let surfacedCount = 0;
  let overdueHighCount = 0;

  for (const item of input.intentions) {
    if (item.status === 'pending' || item.status === 'snoozed') {
      pendingCount += 1;
    } else if (item.status === 'surfaced') {
      surfacedCount += 1;
      if (item.priority === 'high') overdueHighCount += 1;
    }
  }

  // Raw homeostasis satisfaction: 100 when zero unacknowledged surfaced cues; drops smoothly as surfaced/high-priority items accumulate.
  let satisfaction = 100;
  if (surfacedCount > 0) {
    satisfaction -= surfacedCount * 16 + overdueHighCount * 18;
  }
  if (input.activeScarCount > 0) {
    satisfaction -= Math.min(12, input.activeScarCount * 4);
  }
  satisfaction = Math.max(30, Math.min(100, Math.round(satisfaction)));
  const urgency = 100 - satisfaction;
  const zone = zoneFromSatisfaction(satisfaction);

  let summary: string;
  if (input.suppressed && input.suppressionReason) {
    summary = input.suppressionReason;
  } else if (surfacedCount > 0) {
    summary = `已触发 ${surfacedCount} 项前瞻提醒待确认（高优 ${overdueHighCount} 项） · 另有 ${pendingCount} 项守候中`;
  } else if (pendingCount > 0) {
    summary = `${pendingCount} 项前瞻记忆静默守候中 · 躯体标记前哨就绪（零 Token）`;
  } else {
    summary = '前额叶直觉与前瞻处于稳态舒适（本地 <10ms 零 Token 守候）';
  }

  const view: IntuitionDriveView = {
    satisfaction,
    urgency,
    zone,
    suppressed: input.suppressed,
    ...(input.suppressionReason ? { suppressionReason: input.suppressionReason } : {}),
    pendingCount,
    surfacedCount,
    overdueHighCount,
    activeScarCount: input.activeScarCount,
    summary,
  };

  const externalReading: ExternalDriveReading = {
    key: 'prospective_sentinel',
    label: '前瞻记忆与直觉前哨',
    satisfaction,
    summary,
    autoMaintain: false,
    evidence: {
      pendingCount,
      surfacedCount,
      overdueHighCount,
      activeScarCount: input.activeScarCount,
    },
  };

  return { view, externalReading };
}
