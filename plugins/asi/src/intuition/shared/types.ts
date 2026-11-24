/**
 * Shared serializable data structures for `src/intuition` (Prefrontal Cortex:
 * Gut-Feeling Somatic Markers & Prospective Memory).
 *
 * Kept strictly JSON-safe and TypeRT-compatible for `AsiRemote` streaming.
 */

import type { NeedZone, SleepMemoryKind } from '@asi/sense-types';

export type ProspectiveTriggerKind = 'time' | 'context' | 'event';

export const PROSPECTIVE_TRIGGER_KINDS: readonly ProspectiveTriggerKind[] = ['time', 'context', 'event'];

export const PROSPECTIVE_TRIGGER_LABELS: Record<ProspectiveTriggerKind, string> = {
  time: '定时提醒',
  context: '情境触发',
  event: '事件触发',
};

export type ProspectiveEventKind = 'next_session' | 'tool_call' | 'sleep_completed' | 'job_finished' | 'network_online';

export const PROSPECTIVE_EVENT_KINDS: readonly ProspectiveEventKind[] = [
  'next_session',
  'tool_call',
  'sleep_completed',
  'job_finished',
  'network_online',
];

export const PROSPECTIVE_EVENT_LABELS: Record<ProspectiveEventKind, string> = {
  next_session: '下次开启会话',
  tool_call: '特定工具执行',
  sleep_completed: '睡眠整合完成',
  job_finished: '后台任务结束',
  network_online: '网络恢复连通',
};

export type ProspectiveStatus = 'pending' | 'surfaced' | 'fulfilled' | 'snoozed' | 'canceled' | 'expired';

export type ProspectivePriority = 'normal' | 'high';

export type FlashbackFeedback = 'helpful' | 'dismissed' | 'muted';

export interface ProspectiveTriggerSpec {
  kind: ProspectiveTriggerKind;
  /** Target wall-clock timestamp (ms) when `kind === 'time'`. */
  dueAt?: number;
  /** Substring or workspace basename matched against session/tool `cwd` when `kind === 'context'`. */
  workspaceMatch?: string;
  /** Space/comma-separated keywords matched against user prompt or allowed window title when `kind === 'context'`. */
  keywordMatch?: string;
  /** Foreground app name or bundleId matched when `kind === 'context'`. */
  appMatch?: string;
  /** Lifecycle or tool event matched when `kind === 'event'`. */
  eventKind?: ProspectiveEventKind;
  /** Optional tool name filter when `eventKind === 'tool_call'`. */
  toolName?: string;
  /** Optional command/file/job substring filter for `'tool_call'` or `'job_finished'`. */
  targetPattern?: string;
}

export interface ProspectiveIntention {
  id: string;
  title: string;
  instruction: string;
  trigger: ProspectiveTriggerSpec;
  triggerSummary: string;
  priority: ProspectivePriority;
  status: ProspectiveStatus;
  sourceSessionId?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  snoozedUntil?: number;
  surfacedCount: number;
  lastSurfacedAt?: number;
  fulfilledAt?: number;
  resolutionNote?: string;
}

export interface ProspectiveCreateInput {
  title: string;
  instruction: string;
  triggerKind: ProspectiveTriggerKind;
  priority?: ProspectivePriority;
  /** Minutes from `now` when `triggerKind === 'time'` (convenience alternative to `dueAt`). */
  delayMinutes?: number;
  dueAt?: number;
  workspaceMatch?: string;
  keywordMatch?: string;
  appMatch?: string;
  eventKind?: ProspectiveEventKind;
  toolName?: string;
  targetPattern?: string;
  expiresInHours?: number;
}

export type ProspectiveResolveAction = 'fulfill' | 'snooze' | 'cancel';

export interface ProspectiveResolveInput {
  id: string;
  action: ProspectiveResolveAction;
  snoozeMinutes?: number;
  note?: string;
}

export interface SomaticScar {
  id: string;
  toolName: string;
  signature: string;
  title: string;
  caution: string;
  tags: string[];
  workspaceHint?: string;
  failureCount: number;
  firstSeenAt: number;
  updatedAt: number;
}

export type FlashbackSourceKind = SleepMemoryKind | 'scar';

export interface FlashbackMatch {
  sourceId: string;
  sourceKind: FlashbackSourceKind;
  title: string;
  caution: string;
  score: number;
  retention: number;
  matchedCues: string[];
  feedback?: FlashbackFeedback;
}

export interface FlashbackRecord {
  id: string;
  at: number;
  channel: 'pre-step' | 'tool-guard' | 'next-step' | 'next-turn' | 'manual';
  sourceId: string;
  sourceKind: FlashbackSourceKind;
  title: string;
  caution: string;
  score: number;
  matchedCues: string[];
  sessionId?: string;
  feedback?: FlashbackFeedback;
}

export interface IntuitionDriveView {
  satisfaction: number;
  urgency: number;
  zone: NeedZone;
  suppressed: boolean;
  suppressionReason?: string;
  pendingCount: number;
  surfacedCount: number;
  overdueHighCount: number;
  activeScarCount: number;
  summary: string;
}

export interface IntuitionPanelModel {
  now: number;
  stale?: boolean;
  autoIntuitionPaused: boolean;
  drive: IntuitionDriveView;
  pendingCount: number;
  surfacedCount: number;
  fulfilledCount: number;
  mutedSourceCount: number;
  intentions: ProspectiveIntention[];
  recentFlashbacks: FlashbackRecord[];
}
