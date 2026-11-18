/**
 * Shared types for the asi-sense state model, signals, attention rules and
 * delivery payloads. Consumed by the host plugin, the sidebar client and
 * tests as raw TypeScript source (private workspace package).
 */

import type { Body } from './body.js';
import { ttlStatusAt } from './freshness.js';

export type { Body } from './body.js';
export type { DisksFact, DiskVolume } from './disks.js';
export { disksStatusAt, diskVolumeAt, effectiveDisks } from './disks.js';
export { ttlStatusAt } from './freshness.js';

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

/** Who caused a signal, for self-cause suppression. */
export type SignalCause = 'agent' | 'user' | 'unknown';

/** A normalized observation event (DESIGN §2.1). */
export interface Signal {
  id: string;
  kind: string;
  at: number;
  source: SourceRef;
  subject: string;
  /**
   * Kind-specific payload. Sources that can attribute a process may add:
   * `pid` (the process itself), `ppid` (its parent) and `ancestors` (its
   * ancestor pid chain) — used by self-cause classification to link shell
   * children and grandchildren back to the tool window that spawned them.
   */
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

/** Status of the whole-disk file watcher. */
export type GlobalFileWatchStatus = 'running' | 'degraded' | 'partial-denied' | 'denied' | 'disabled';

/** Summary value for `env.globalFileWatch`. */
export interface GlobalFileWatchValue {
  enabled: boolean;
  status: GlobalFileWatchStatus;
  root: string;
  windowMs: number;
  eventsPerSec: number;
  degraded: boolean;
  countOnly: boolean;
  deniedPaths: string[];
  exclusions: string[];
}

/** Observed environment state. */
export interface EnvState {
  where: EnvWhere;
  frontApp: Fact<{ name: string; bundleId: string; pid?: number; windowCount?: number }>;
  focusedWindow: Fact<{ title: string }>;
  activeJobs: Fact<JobSummary[]>;
  watchedPaths: Fact<Record<string, { lastChange: number; changes: number }>>;
  globalFileWatch?: Fact<GlobalFileWatchValue>;
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

/** Full state model (DESIGN §2.2). */
export interface SenseState {
  self: SelfState;
  env: EnvState;
  observation: ObservationState;
}

/** Attention escalation level. */
export type DeliveryLevel = 'record' | 'context' | 'wake';

/** A merged environment change ready for delivery. */
export interface EnvChange {
  signal: Signal;
  count: number;
  level: DeliveryLevel;
  ruleId?: string;
  note?: string;
  reason?: string;
}

/** An increment to deliver to the agent (DESIGN §2.4). */
export interface EnvUpdate {
  since: number;
  at: number;
  changes: EnvChange[];
  suppressed: number;
  /** Signals already injected this session from a split mixed bucket (sum of `count`s). */
  alreadyInjected?: number;
}

/**
 * A watch rule (DESIGN §2.3). `approved` is required; use `createWatchRule`
 * (host rules module) to apply the default `input.approved ??
 * input.createdBy === 'user'` — user rules default approved, agent-proposed
 * `wake` rules stay pending until confirmed.
 */
export interface WatchRule {
  id: string;
  match: {
    kind: string;
    /** Glob: `*` = any run of non-`/` chars, `**` = across `/`, `?` = one non-`/` char. */
    subject?: string;
    /** Literal equality (`v`) or comparison (`{'!=': 0}`, `{'>': n}`…). */
    where?: Record<string, unknown>;
  };
  level: DeliveryLevel;
  note?: string;
  createdBy: 'user' | 'agent';
  approved: boolean;
  expiresAt?: number;
}

/** Severity carried in `body.threshold` signal data and latch state. */
export type ThresholdSeverity = 'normal' | 'warn' | 'critical';

/** Per-metric latch, carried between samples as `BodyThresholdSample.state`. */
export type BodyThresholdState = Record<string, ThresholdSeverity>;

/**
 * Two body samples to compare. `state` is the latch returned for `prev`.
 * `monotonicAt` is the sample's monotonic-clock stamp (ms), stamped by the
 * host/`BodyMonitor`; rate-of-change windows are measured on it, never on
 * wall `at`. Live callers always carry it — the `at` fallback exists only
 * for direct logical-replay callers and must never be fed live wall time.
 */
export interface BodyThresholdSample {
  body: Body;
  at: number;
  source: SourceRef;
  monotonicAt: number;
  state?: BodyThresholdState;
}

/** Configurable threshold table (ratios; lower is worse) plus hysteresis. */
export interface BodyThresholds {
  disk: { warn: number; critical: number };
  context: { warn: number; critical: number };
  battery: { warn: number; critical: number };
  /** Recovery margin in ratio points (0.05 = 5 percentage points). */
  hysteresis: number;
}

/** Result of a body-metric evaluation step. */
export interface BodyEvaluation {
  signals: Signal[];
  state: BodyThresholdState;
}

/**
 * Extension contract for body evaluators (DESIGN §2.2c). Implementations
 * are pure: the caller owns the latch and feeds it back as `state`.
 */
export interface BodyEvaluator {
  evaluate(prev: BodyThresholdSample, next: BodyThresholdSample, state: BodyThresholdState): BodyEvaluation;
}

/**
 * Rate-of-change metric payload for `body.rate` signals (future evaluator;
 * M1 emits none). `delta` is in metric units, `slope` in units/second, and
 * `timeToFloorMs` is omitted when it cannot be estimated.
 */
export type BodyRateData = {
  metric: string;
  windowMs: number;
  delta: number;
  slope: number;
  timeToFloorMs?: number;
  etaToFloorMs?: number;
  direction: 'up' | 'down';
};

/**
 * Anomaly payload for `body.anomaly` signals (future evaluator; M1 emits
 * none). `deviation` is measured in sigma/MAD units from `baseline`.
 */
export type BodyAnomalyData = {
  metric: string;
  value: number;
  baseline: number;
  deviation: number;
  type?: 'rebaseline-suggestion';
  suggestionId?: string;
};

/**
 * Burst payload for `file.burst` signals (future evaluator; M1 emits none).
 * `agentDeleted` is the subset of `deleted` attributable to the agent.
 */
export type FileBurstData = {
  directory: string;
  windowMs: number;
  created: number;
  modified: number;
  deleted: number;
  agentDeleted: number;
  externalDeleted?: number;
  externalDeletionExceeded?: boolean;
};

/** Aggregated per-directory file activity signal payload (`file.activity`). */
export type FileActivityData = {
  directory: string;
  windowMs: number;
  created: number;
  modified: number;
  deleted: number;
  files: string[];
  degraded?: boolean;
};

/** Typed `data` contracts for signal kinds with a fixed schema. */
export interface KnownSignalData {
  'body.rate': BodyRateData;
  'body.anomaly': BodyAnomalyData;
  'file.burst': FileBurstData;
  'file.activity': FileActivityData;
}

/** A {@link Signal} narrowed to a kind with a known data schema. */
export type TypedSignal<K extends keyof KnownSignalData> = K extends keyof KnownSignalData
  ? Omit<Signal, 'kind' | 'data'> & { kind: K; data: KnownSignalData[K] }
  : never;

export type { TuningChange, TuningValue } from './tuning.ts';
