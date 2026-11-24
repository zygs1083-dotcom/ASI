/**
 * Shared data structures for `asi-growth` (L4 Procedural Skill Synthesis,
 * `agentskills` `SKILL.md` studio, `ctx.skills` hot mounting, and metabolism).
 */

import type { NeedZone } from '@asi/sense-types';

export type SkillScope = 'global' | 'workspace';

export type SkillInstalledStatus = 'active' | 'disabled';

export type SkillTabView = 'drafts' | 'active' | 'archived';

export type GrowthSynthesisTrigger = 'auto' | 'manual' | 'sandbox';

export interface WorkspaceChoice {
  path: string;
  display: string;
}

export interface SkillDraftViewItem {
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
  markdown: string;
  scope: SkillScope;
  workspacePath?: string;
  workspaceDisplay?: string;
  targetVersion: number;
  isRevision: boolean;
  revisesSkillName?: string;
  baseVersion?: number;
  baseMarkdown?: string;
  topicKey: string;
  evidenceIds: string[];
  memoryCount: number;
  trajectoryCount: number;
  evidenceSummary: string;
  createdAt: number;
  updatedAt: number;
  trigger: GrowthSynthesisTrigger;
}

export interface SkillViewItem {
  name: string;
  version: number;
  status: SkillInstalledStatus;
  scope: SkillScope;
  workspacePath?: string;
  workspaceDisplay?: string;
  description: string;
  whenToUse?: string;
  markdown: string;
  topicKey: string;
  evidenceIds: string[];
  approvedAt: number;
  updatedAt: number;
  invocationCount: number;
  lastInvokedAt: number | null;
  evaluatedTurns: number;
  completedTurns: number;
  turnCompletionRate: number | null;
  stale: boolean;
  daysSinceLastUse: number;
  exportedWorkspaces: string[];
}

export interface ArchivedSkillViewItem {
  name: string;
  version: number;
  scope: SkillScope;
  workspacePath?: string;
  workspaceDisplay?: string;
  description: string;
  whenToUse?: string;
  markdown: string;
  topicKey: string;
  approvedAt: number;
  archivedAt: number;
  invocationCount: number;
  lastInvokedAt: number | null;
  turnCompletionRate: number | null;
}

export interface SkillCreateDraftInput {
  name: string;
  description: string;
  whenToUse?: string;
  body: string;
  scope?: SkillScope;
  workspacePath?: string;
}

export interface SkillUpdateMarkdownInput {
  markdown: string;
  scope?: SkillScope;
  workspacePath?: string;
}

export interface SkillScopeUpdateInput {
  scope: SkillScope;
  workspacePath?: string;
}

export interface SkillExportResult {
  name: string;
  exportedPath: string;
  displayPath: string;
  at: number;
}

export interface GrowthSynthesisRecord {
  id: string;
  at: number;
  trigger: GrowthSynthesisTrigger;
  clustersInspected: number;
  draftsCreated: number;
  revisionsCreated: number;
  durationMs: number;
  summary: string;
}

export interface GrowthDriveView {
  satisfaction: number;
  urgency: number;
  zone: NeedZone;
  readyToSynthesize: boolean;
  suppressed: boolean;
  suppressionReason?: string;
  lowerTierBlocked: boolean;
  lowerTierReason?: string;
  readyClusters: number;
  highRetentionMemoryCount: number;
  recurringTrajectoryCount: number;
  deepQuietWindow: boolean;
  screenLocked: boolean;
  idleDurationMs: number;
  idleThresholdMs: number;
  autoDraftsToday: number;
  dailyAutoQuota: number;
  lastSynthesisAt: number | null;
  summary: string;
}

export interface GrowthPanelModel {
  now: number;
  stale?: boolean;
  autoGrowthPaused: boolean;
  synthesizing: boolean;
  drive: GrowthDriveView;
  draftCount: number;
  activeCount: number;
  disabledCount: number;
  archivedCount: number;
  staleCount: number;
  knownWorkspaces: WorkspaceChoice[];
  drafts: SkillDraftViewItem[];
  skills: SkillViewItem[];
  archivedSkills: ArchivedSkillViewItem[];
  recentSyntheses: GrowthSynthesisRecord[];
}
