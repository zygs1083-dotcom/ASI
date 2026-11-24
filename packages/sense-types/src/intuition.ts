/**
 * Cross-module Prefrontal Intuition & Prospective Memory contract (`ctx.asiIntuition`),
 * providing pure-local (<10ms, zero-LLM) vmPFC somatic-marker flashbacks and
 * BA10 prospective memory intention queries without mutating system prompts.
 */

import type { SleepMemoryKind } from './sleep.js';

export type ProspectiveTriggerKind = 'time' | 'context' | 'event';

export type ProspectiveEventKind = 'next_session' | 'tool_call' | 'sleep_completed' | 'job_finished' | 'network_online';

export type ProspectiveStatus = 'pending' | 'surfaced' | 'fulfilled' | 'snoozed' | 'canceled' | 'expired';

export type ProspectivePriority = 'normal' | 'high';

export interface ProspectiveIntentionSummary {
  id: string;
  title: string;
  instruction: string;
  triggerKind: ProspectiveTriggerKind;
  triggerSummary: string;
  priority: ProspectivePriority;
  status: ProspectiveStatus;
  dueAt?: number;
  workspaceMatch?: string;
  surfacedCount: number;
  lastSurfacedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface FlashbackHitSummary {
  sourceId: string;
  sourceKind: SleepMemoryKind | 'scar';
  title: string;
  caution: string;
  score: number;
  matchedCues: string[];
  retention: number;
}

export interface IntuitionScanOptions {
  cwd?: string;
  toolName?: string;
  limit?: number;
  minScore?: number;
}

export interface IntuitionSnapshot {
  now: number;
  autoIntuitionPaused: boolean;
  suppressed: boolean;
  suppressionReason?: string;
  pendingCount: number;
  surfacedCount: number;
  fulfilledCount: number;
  recentFlashbackCount: number;
  intentions: ProspectiveIntentionSummary[];
}

export interface AsiIntuitionServiceApi {
  /** Return a sanitized, isolated read-only snapshot of prospective intentions and intuition state. */
  snapshot(): IntuitionSnapshot;
  /** Run an immediate, side-effect-free (<10ms, zero-LLM) somatic flashback scan against consolidated memories and live scars. */
  scanFlashbacks(cueText: string, options?: IntuitionScanOptions): FlashbackHitSummary[];
  /** List sanitized prospective intentions filtered by status. */
  listIntentions(options?: { statuses?: readonly ProspectiveStatus[]; limit?: number }): ProspectiveIntentionSummary[];
  /** Subscribe to intuition state, flashback, or prospective memory changes; returns an unsubscribe callback. */
  subscribe(listener: () => void): () => void;
}
