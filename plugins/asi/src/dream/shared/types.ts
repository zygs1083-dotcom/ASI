/**
 * Shared data structures for `asi-dream` (Default Mode Network Sleep Dreaming &
 * Cross-Repo Insight synthesis, lifecycle actions, and sidebar sub-view).
 */

import type { NeedZone } from '@asi/sense-types';

export type DreamInsightKind = 'preventive-warning' | 'structural-analogy' | 'pattern-unification' | 'decision-tension';

export const DREAM_INSIGHT_KINDS: readonly DreamInsightKind[] = [
  'preventive-warning',
  'structural-analogy',
  'pattern-unification',
  'decision-tension',
];

export const DREAM_INSIGHT_KIND_LABELS: Record<DreamInsightKind, string> = {
  'preventive-warning': '跨仓避坑预警',
  'structural-analogy': '同构架构迁移',
  'pattern-unification': '跨项目范式收敛',
  'decision-tension': '跨项目约定张力',
};

export type DreamInsightStatus = 'open' | 'adopted' | 'promoted' | 'dismissed';

export type DreamSubTabFilter = 'open' | 'resolved' | 'dismissed' | 'all';

export type DreamCycleTrigger = 'auto' | 'manual' | 'sandbox';

export interface DreamInsightEntry {
  id: string;
  kind: DreamInsightKind;
  status: DreamInsightStatus;
  title: string;
  summary: string;
  bridgeMechanism: string;
  actionableHypothesis: string;
  /** Canonical normalized repo keys participating in this bridge (always >= 2 distinct repos). */
  repoKeys: string[];
  /** Home-masked display labels for participating repositories. */
  sourceRepos: string[];
  /** Optional home-masked target repository most directly benefiting from this insight. */
  targetRepo?: string;
  sourceMemoryIds: string[];
  sourceSessionIds: string[];
  tags: string[];
  topicKey: string;
  pairSignature: string;
  noveltyScore: number;
  structuralSimilarity: number;
  confidence: number;
  adoptedMemoryId?: string;
  promotedDraftId?: string;
  createdAt: number;
  updatedAt: number;
}

export type DreamInsightViewItem = DreamInsightEntry;

export interface DreamAdoptMemoryInput {
  insightId: string;
  pinned?: boolean;
}

export interface DreamAdoptResult {
  insight: DreamInsightViewItem;
  memoryId: string;
}

export interface DreamPromoteResult {
  insight: DreamInsightViewItem;
  draftId: string;
  skillName: string;
}

export interface DreamCycleRecord {
  id: string;
  at: number;
  trigger: DreamCycleTrigger;
  reposScanned: number;
  bridgesEvaluated: number;
  insightsCreated: number;
  insightsReinforced: number;
  durationMs: number;
  summary: string;
}

export interface DreamDriveView {
  satisfaction: number;
  urgency: number;
  zone: NeedZone;
  readyToDream: boolean;
  suppressed: boolean;
  suppressionReason?: string;
  lowerTierBlocked: boolean;
  lowerTierReason?: string;
  discoveredRepoCount: number;
  candidateBridgeCount: number;
  openInsightCount: number;
  deepQuietWindow: boolean;
  screenLocked: boolean;
  idleDurationMs: number;
  idleThresholdMs: number;
  autoDreamsToday: number;
  dailyAutoQuota: number;
  lastDreamAt: number | null;
  summary: string;
}

export interface DreamPanelModel {
  now: number;
  stale?: boolean;
  autoDreamPaused: boolean;
  dreaming: boolean;
  drive: DreamDriveView;
  openCount: number;
  adoptedCount: number;
  promotedCount: number;
  dismissedCount: number;
  totalInsights: number;
  insights: DreamInsightViewItem[];
  recentDreams: DreamCycleRecord[];
}
