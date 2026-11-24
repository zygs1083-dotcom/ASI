/**
 * Shared types for the ASI sensory state model (`asi-sense`), survival needs
 * model (`asi-needs`), and model-output credential redaction.
 */

import type { Body } from './body.js';
import { ttlStatusAt } from './freshness.js';

export type { Body } from './body.js';
export {
  type CredentialSpan,
  containsCredential,
  normalizeForModel,
  redactCredentials,
  sanitizeForModel,
  sanitizeModelId,
  sanitizeSignalId,
  scanCredentials,
} from './credential-scan.js';
export type { DisksFact, DiskVolume } from './disks.js';
export { disksStatusAt, diskVolumeAt, effectiveDisks } from './disks.js';
export type {
  AsiDrivesServiceApi,
  AsiDrivesSnapshot,
  DriveAbortSignal,
  DriveEvaluation,
  DriveHelpActionInput,
  DriveHelpActionResult,
  DriveHelpCardProposal,
  DriveSandboxToolResult,
  DriveSandboxToolSpec,
  DriveSourceRegistration,
  DriveTier,
  DriveToolParameterSpec,
  ExternalDriveReading,
  HigherOrderDriveTier,
} from './drives.js';
export { ttlStatusAt } from './freshness.js';
export {
  type BodyHistory,
  type MetricKey,
  type MetricPoint,
  THERMAL_ORDINAL,
  type ThermalState,
} from './history.js';
export type {
  AsiIntuitionServiceApi,
  FlashbackHitSummary,
  IntuitionScanOptions,
  IntuitionSnapshot,
  ProspectiveEventKind,
  ProspectiveIntentionSummary,
  ProspectivePriority,
  ProspectiveStatus,
  ProspectiveTriggerKind,
} from './intuition.js';
export {
  type ActionMeasurement,
  type ActionOutcomeLedgerEntry,
  type CacheRiskLevel,
  type HelpActionKind,
  type HelpCard,
  type HelpCardStatus,
  type InstinctState,
  type MaintenanceActor,
  type MaintenanceOutcome,
  type MaintenanceRecord,
  type MaintenanceSessionStatus,
  type ModelConnectivity,
  NEED_KEYS,
  type NeedEvaluation,
  type NeedKey,
  type NeedsSnapshot,
  type NeedZone,
} from './needs.js';
export type {
  AsiSenseServiceApi,
  PowerMode,
  SenseSettingsSnapshot,
  SenseSnapshot,
} from './service.js';
export type {
  AsiSleepServiceApi,
  SleepMemoryKind,
  SleepMemoryQueryOptions,
  SleepMemorySummary,
} from './sleep.js';

/** Identifies a signal/fact producer: which source, via which API, on which host. */
export interface SourceRef {
  id: string;
  api: string;
  host: string;
}

/** Freshness/availability of a fact. `stale` is computed at read time from TTL. */
export type FactStatus = 'ok' | 'stale' | 'denied' | 'unsupported' | 'unavailable' | 'unknown';

/** A single observed fact with provenance and TTL. */
export interface Fact<T> {
  value: T | null;
  status: FactStatus;
  source: SourceRef;
  observedAt: number;
  ttlMs: number;
  reason?: string;
}

/**
 * Computes the effective status of a fact at `now`.
 * `ok` facts become stale at `now >= observedAt + ttlMs`.
 * Disk facts use `disksStatusAt` instead.
 */
export function factStatusAt(fact: Fact<unknown> & { kind?: never }, now: number): FactStatus {
  return ttlStatusAt(fact, now);
}

/** Who caused a signal. */
export type SignalCause = 'agent' | 'user' | 'unknown';

/** A normalized observation event. */
export interface Signal {
  id: string;
  kind: string;
  at: number;
  source: SourceRef;
  subject: string;
  data: Record<string, unknown> & {
    pid?: number;
    ppid?: number;
    ancestors?: number[];
  };
  cause?: SignalCause;
}

/** Summary of a tracked job/process. */
export interface JobSummary {
  id: string;
  owner?: string;
  startedAt: number;
  command?: string;
  pid?: number;
  status: 'running' | 'exited';
  exitCode?: number;
}

/** The agent's own state. */
export interface SelfState {
  activity: Fact<'idle' | 'thinking' | 'tool' | 'waiting-user'>;
  pending: Fact<{ inbox: number; jobs: number }>;
  tools: Fact<string[]>;
  permissions: Fact<Record<string, 'granted' | 'denied' | 'unknown'>>;
  body: Body;
}

/** The four distinct "where" answers; each carries its own source. */
export interface EnvWhere {
  model: Fact<{ provider: string; endpoint: string; local: boolean }>;
  harness: Fact<{ host: string; os: string; pid: number }>;
  observed: Fact<{ host: string; userSession: string }>;
  toolExec: Fact<{ host: string; cwd: string }>;
}

/** System power/lock state tracked in `env.system`. */
export interface SystemStateValue {
  locked: boolean;
  lastSleepAt?: number;
  lastWakeAt?: number;
}

/** Data payload for normalized system/screen/session lifecycle signals. */
export interface SystemEventData {
  at: number;
  durationMs?: number;
}

/** Observed environment state (pure sensory snapshot). */
export interface EnvState {
  where: EnvWhere;
  frontApp: Fact<{ name: string; bundleId: string; pid?: number; windowCount?: number }>;
  focusedWindow: Fact<{ title: string }>;
  activeJobs: Fact<JobSummary[]>;
  system?: Fact<SystemStateValue>;
}

/** Per-source health bookkeeping. */
export interface SourceObservation {
  status: FactStatus;
  lastSignalAt: number;
  error?: string;
}

/** Observation pipeline status. */
export interface ObservationState {
  sources: Record<string, SourceObservation>;
}

/** Full sensory state model. */
export interface SenseState {
  self: SelfState;
  env: EnvState;
  observation: ObservationState;
}
