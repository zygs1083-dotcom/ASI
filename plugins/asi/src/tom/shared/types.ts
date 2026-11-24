/**
 * Shared data structures for `asi` Theory of Mind (`src/tom/`):
 * Partner State inference, Collaborative Tact prescriptions, and sidebar UI wire types.
 */

import type { NeedZone } from '@asi/sense-types';

export type PartnerStateKind =
  | 'deep_focus'
  | 'rapid_sprint'
  | 'stuck_debugging'
  | 'exploring'
  | 'steady_flow'
  | 'away_resting';

export const PARTNER_STATE_KINDS: readonly PartnerStateKind[] = [
  'deep_focus',
  'rapid_sprint',
  'stuck_debugging',
  'exploring',
  'steady_flow',
  'away_resting',
];

export const PARTNER_STATE_LABELS: Record<PartnerStateKind, string> = {
  deep_focus: '深度心流',
  rapid_sprint: '快节奏冲刺',
  stuck_debugging: '排障攻坚',
  exploring: '探索发散',
  steady_flow: '平稳协作',
  away_resting: '离开休息',
};

export const PARTNER_STATE_SHORT_LABELS: Record<PartnerStateKind, string> = {
  deep_focus: '心流',
  rapid_sprint: '冲刺',
  stuck_debugging: '攻坚',
  exploring: '探索',
  steady_flow: '平稳',
  away_resting: '离开',
};

export type PartnerStateSource = 'inferred' | 'manual_override' | 'paused';

export interface PartnerDimensions {
  focus: number;
  friction: number;
  pace: number;
  presence: number;
}

export type TactVerbosity = 'ultra_concise' | 'concise' | 'balanced' | 'structured' | 'thorough' | 'handoff_summary';

export type TactAutonomy =
  | 'proactive_execute'
  | 'balanced'
  | 'verify_first'
  | 'collaborative_options'
  | 'safe_autonomous';

export const TACT_VERBOSITY_LABELS: Record<TactVerbosity, string> = {
  ultra_concise: '极简直给',
  concise: '精炼少扰',
  balanced: '均衡清晰',
  structured: '根因结构化',
  thorough: '展开权衡',
  handoff_summary: '归来交接摘要',
};

export const TACT_AUTONOMY_LABELS: Record<TactAutonomy, string> = {
  proactive_execute: '直接落地验证',
  balanced: '常规协同',
  verify_first: '实测证据先行',
  collaborative_options: '多方案对齐',
  safe_autonomous: '护栏内独立收尾',
};

export interface TactGuidance {
  verbosity: TactVerbosity;
  autonomy: TactAutonomy;
  questionBudget: 0 | 1 | 2;
  deferNonCriticalInterruptions: boolean;
  headline: string;
  directives: string[];
  silentAdaptationRule: string;
}

export interface PartnerManualOverride {
  state: PartnerStateKind;
  setAt: number;
  expiresAt: number;
}

export interface PartnerBaselineSummary {
  sampleCount: number;
  avgCadenceSec: number;
  avgPromptChars: number;
  avgSwitchesPer5m: number;
  calibrationCount: number;
}

export interface PartnerOverrideInput {
  /** Pass a state to lock manual override, or `null` to return to automatic inference. */
  state: PartnerStateKind | null;
  /** Optional override TTL in minutes (5..480, default 60). */
  durationMinutes?: number;
}

export interface TomPanelModel {
  now: number;
  stale?: boolean;
  enabled: boolean;
  sensePaused: boolean;
  state: PartnerStateKind;
  source: PartnerStateSource;
  confidence: number;
  dimensions: PartnerDimensions;
  guidance: TactGuidance;
  reasons: string[];
  manualOverride: PartnerManualOverride | null;
  baseline: PartnerBaselineSummary;
  driveSatisfaction: number;
  driveZone: NeedZone;
  suppressed: boolean;
}
