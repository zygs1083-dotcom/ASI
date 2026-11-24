/**
 * Shared data structures for `asi-sleep` (L2 Sleep & Memory Consolidation,
 * FSRS spaced retention, and the 「记忆库」 sidebar panel).
 */

import type { NeedZone } from '@asi/sense-types';

export type MemoryKind = 'preference' | 'decision' | 'pitfall' | 'episode';

export const MEMORY_KINDS: readonly MemoryKind[] = ['preference', 'decision', 'pitfall', 'episode'];

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  preference: '偏好',
  decision: '决策',
  pitfall: '踩坑',
  episode: '近期进展',
};

export interface FsrsCardState {
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  state: number;
  due: number;
  lastReview: number;
}

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string[];
  topicKey?: string;
  pinned: boolean;
  confidence: number;
  sourceSessionIds: string[];
  evidenceCount: number;
  recallCount: number;
  createdAt: number;
  updatedAt: number;
  lastRecalledAt?: number;
  links?: string[];
  fsrs: FsrsCardState;
}

export interface MemoryViewItem extends MemoryEntry {
  /** Current FSRS retrievability in `[0, 1]` (`1` when `pinned === true`). */
  retention: number;
}

export interface MemoryCreateInput {
  kind: MemoryKind;
  title: string;
  content: string;
  tags?: string[];
  topicKey?: string;
  pinned?: boolean;
}

export interface MemoryUpdateInput {
  kind?: MemoryKind;
  title?: string;
  content?: string;
  tags?: string[];
  topicKey?: string;
  pinned?: boolean;
}

export type SleepConsolidationTrigger = 'auto' | 'manual' | 'sandbox';

export interface SleepConsolidationRecord {
  id: string;
  at: number;
  trigger: SleepConsolidationTrigger;
  turnsProcessed: number;
  nremCandidates: number;
  createdCount: number;
  mergedCount: number;
  conflictsResolved: number;
  prunedCount: number;
  linksUpdated: number;
  durationMs: number;
  summary: string;
}

export interface SleepDriveView {
  satisfaction: number;
  urgency: number;
  zone: NeedZone;
  sleepy: boolean;
  suppressed: boolean;
  suppressionReason?: string;
  unconsolidatedTurns: number;
  turnThreshold: number;
  elapsedSinceSleepMs: number | null;
  timeThresholdMs: number;
  quietWindow: boolean;
  screenLocked: boolean;
  idleDurationMs: number;
  idleThresholdMs: number;
  autoRunsToday: number;
  dailyAutoQuota: number;
  lastSleepAt: number | null;
  summary: string;
}

export interface SleepPanelModel {
  now: number;
  stale?: boolean;
  autoSleepPaused: boolean;
  consolidating: boolean;
  drive: SleepDriveView;
  countsByKind: Record<MemoryKind, number>;
  totalMemories: number;
  pinnedCount: number;
  memories: MemoryViewItem[];
  recentConsolidations: SleepConsolidationRecord[];
}
