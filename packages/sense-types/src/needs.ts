/**
 * Shared types for `asi-needs`: infant-stage survival needs, continuous
 * homeostatic tension model, instinct reflexes, background self-maintenance,
 * and on-demand help requests ("啼哭求助").
 */

import type { DriveEvaluation } from './drives.js';
import type { PowerMode } from './service.js';

export const NEED_KEYS = ['energy', 'space', 'memory', 'mind', 'thermals'] as const;

export type NeedKey = (typeof NEED_KEYS)[number];

export type NeedZone = 'comfortable' | 'uncomfortable' | 'critical';

export type ModelConnectivity = 'online' | 'degraded' | 'offline';

export interface NeedEvaluation {
  key: NeedKey;
  label: string;
  /** 0..100 integer: 100 = fully satisfied, 0 = depleted. */
  satisfaction: number;
  /** 0..100 integer: homeostatic tension / drive intensity. */
  urgency: number;
  /** Zone after hysteresis (`comfortable` >= 70 recovery, `<60` uncomfortable, `<25` critical). */
  zone: NeedZone;
  /** True from entering `uncomfortable`/`critical` until recovering back into `comfortable` (>= 70). */
  driveActive: boolean;
  /** Concise human/model summary of current status. */
  summary: string;
  /** Structured factual readings backing this evaluation. */
  evidence: Record<string, string | number | boolean | null>;
  updatedAt: number;
}

export interface InstinctState {
  powerMode: PowerMode;
  powerReason?: string;
  modelConnectivity: ModelConnectivity;
  probeCount: number;
  lastProbeAt?: number;
  nextProbeAt?: number;
  lastProbeError?: string;
}

export type CacheRiskLevel = 'safe' | 'caution' | 'risky';

export type HelpActionKind =
  | 'acknowledge'
  | 'clean-cache'
  | 'clean-external-cache'
  | 'stop-stuck-jobs'
  | 'compact-context'
  | 'enable-eco'
  | 'open-permissions';

export type HelpCardStatus = 'open' | 'approved' | 'dismissed' | 'resolved';

export interface HelpCard {
  id: string;
  need: NeedKey;
  severity: 'uncomfortable' | 'critical';
  title: string;
  summary: string;
  proposedAction?: string;
  actionKind: HelpActionKind;
  actionTarget?: string;
  status: HelpCardStatus;
  createdAt: number;
  updatedAt: number;
}

export type MaintenanceActor = 'instinct' | 'maintainer' | 'user';

export type MaintenanceOutcome = 'relieved' | 'partial' | 'escalated' | 'info' | 'failed';

export interface ActionMeasurement {
  freedBytes?: number;
  stoppedJobs?: number;
  tokensSaved?: number;
  satisfactionBefore?: number;
  satisfactionAfter?: number;
  satisfactionDelta?: number;
  effective: boolean;
}

export interface ActionOutcomeLedgerEntry {
  need: string;
  action: string;
  attempts: number;
  effectiveCount: number;
  /** 0..1 ratio (`effectiveCount / attempts`). */
  successRate: number;
  totalFreedBytes: number;
  totalStoppedJobs: number;
  totalTokensSaved: number;
  totalSatisfactionDelta: number;
  lastAttemptAt: number;
  lastEffective: boolean;
}

export interface MaintenanceRecord {
  id: string;
  at: number;
  actor: MaintenanceActor;
  need?: NeedKey;
  driveKey?: string;
  action: string;
  summary: string;
  outcome: MaintenanceOutcome;
  gain?: ActionMeasurement;
}

export interface MaintenanceSessionStatus {
  sessionId?: string;
  title: string;
  status: 'not-created' | 'idle' | 'running' | 'unavailable';
  turnCount: number;
  lastRunAt?: number;
  circuitBrokenNeeds?: string[];
}

export interface NeedsSnapshot {
  now: number;
  paused: boolean;
  sendTitles: boolean;
  overallSatisfaction: number;
  overallUrgency: number;
  overallZone: NeedZone;
  activeDrives: NeedKey[];
  needs: Record<NeedKey, NeedEvaluation>;
  instinct: InstinctState;
  helpCards: HelpCard[];
  maintenanceSession: MaintenanceSessionStatus;
  records: MaintenanceRecord[];
  actionLedger?: ActionOutcomeLedgerEntry[];
  higherOrderDrives?: DriveEvaluation[];
  higherOrderSuppressed?: boolean;
  higherOrderSuppressionReason?: string;
}
