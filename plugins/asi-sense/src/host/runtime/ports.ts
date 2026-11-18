import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { BodyProbe } from '@asi/body-probe';
import type { Body, JobSummary, TuningValue, WatchRule } from '@asi/sense-types';
import type { DeliveryIntent } from '../attention/pipeline.ts';
import type {
  DailyDirectoryStats,
  DailySummary,
  DailySystemStats,
  HistoryQuery,
  HistoryQueryResult,
  HistoryStoragePort,
  HistoryUnsafeEntry,
  MonthlySummary,
  PersistedEventEntry,
  SummaryQuery,
  SummaryQueryResult,
} from './history/index.ts';

export type {
  DailyDirectoryStats,
  DailySummary,
  DailySystemStats,
  HistoryQuery,
  HistoryQueryResult,
  HistoryStoragePort,
  HistoryUnsafeEntry,
  MonthlySummary,
  PersistedEventEntry,
  SummaryQuery,
  SummaryQueryResult,
};

export type Unsubscribe = () => void;
export interface Clock {
  wall(): number;
  mono(): number;
}
export interface AgentEvent {
  type: 'created' | 'disposed' | 'pre-step' | 'post-step';
  sessionId: string;
  userInitiated?: boolean;
}
export interface ToolEvent {
  type: 'pre-execute' | 'post-execute';
  sessionId: string;
  toolCallId: string;
  pid?: number;
  ppid?: number;
  ancestors?: number[];
  cwd?: string;
  exitCode?: number;
  command?: string;
  at?: number;
}
export interface JobEvent {
  type: 'started' | 'exited';
  id: string;
  sessionId?: string;
  command?: string;
  pid?: number;
  ppid?: number;
  ancestors?: number[];
  cwd?: string;
  exitCode?: number;
  at?: number;
}
export type TokenSnapshot = NonNullable<Body['tokens']['value']> & {
  contextWindowSource?: 'configured' | 'catalog' | 'fallback';
};
export interface SessionRow {
  id: string;
  title: string;
  updatedAt: number;
  running: boolean;
}
export interface DshPort {
  listSessions?(): Promise<SessionRow[]>;
  ensureSession?(id: string): Promise<void>;
  onSessionsChanged?(cb: (closed?: string) => void): Unsubscribe;
  selectDeliveryTarget?(id: string | undefined): void;
  isDeliveryProtected?(sessionId: string, deliveryId: string): boolean;
  onStepDiscarded?(cb: () => void): Unsubscribe;
  onAgentEvent(cb: (event: AgentEvent) => Promise<void>): Unsubscribe;
  onTool(cb: (event: ToolEvent) => Promise<void>): Unsubscribe;
  onJob(cb: (event: JobEvent) => Promise<void>): Unsubscribe;
  deliver(sessionId: string, intent: DeliveryIntent, isCurrent?: () => boolean): Promise<void>;
  tokenSnapshot(sessionId: string): Promise<TokenSnapshot | undefined>;
  modelJobs?(sessionId: string): JobSummary[];
  openPermissionSettings?(): Promise<void>;
}
export interface StoragePort {
  load(key: string): Promise<string | undefined>;
  save(key: string, json: string): Promise<void>;
  backup?(key: string, original: string): Promise<string>;
  reportBackupFailure?(code: string): void;
}
export interface HelperSpawner {
  spawn(path: string): ChildProcessWithoutNullStreams | undefined;
}
export interface ProbeFactory {
  create(): Pick<BodyProbe, 'onSample' | 'start' | 'stop'>;
}
export interface FileChange {
  path: string;
  change: 'add' | 'modify' | 'delete';
  at?: number;
  watchError?: boolean;
  errorCode?: string;
  errorPath?: string;
}
export interface FileWatcher {
  /**
   * `recursive: false` limits delivery to the watch root's direct children —
   * single-level glob rules must not observe deeper unapproved subtrees.
   * Absent/`true`, the platform watcher decides (recursive whenever the
   * watched target is or becomes a directory).
   */
  watch(
    path: string,
    cb: (event: FileChange) => void,
    opts?: { recursive?: boolean },
  ): { close(): void | Promise<void> };
}
export interface SensePorts {
  dsh: DshPort;
  storage: StoragePort;
  helper: HelperSpawner;
  probe: ProbeFactory;
  files: FileWatcher;
  clock: Clock;
  history?: HistoryStoragePort;
}
export interface GlobalFileWatchOptions {
  root?: string;
  windowMs?: number;
  dataDirs?: readonly string[];
  homedir?: string;
  budgetPerSec?: number;
  budgetSustainMs?: number;
  degradedWindowMs?: number;
  recoveryWindowMs?: number;
  allowNonDarwinRoot?: boolean;
  disableInTests?: boolean;
  protectedDirs?: readonly string[];
  probeAccess?: (dir: string) => boolean | undefined;
}
export interface SenseOptions {
  platform?: string;
  helperPath?: string;
  intervalMs?: number;
  rules?: WatchRule[];
  selfCauseGraceMs?: number;
  targetStorageKey?: string;
  globalFileWatch?: GlobalFileWatchOptions;
  timeZone?: string;
}
export interface SenseActions {
  selectTarget?(id: string | undefined): Promise<void>;
  dismissTargetNotice?(): Promise<void>;
  toggleRule(id: string, enabled: boolean): Promise<void>;
  confirmRule(id: string): Promise<void>;
  deleteRule(id: string): Promise<void>;
  pause(paused: boolean): Promise<void>;
  setSendTitles(enabled: boolean): Promise<void>;
  setGlobalFileWatch?(enabled: boolean): Promise<void>;
  retryGlobalFileWatch?(): Promise<void>;
  addFileExclusion?(pattern: string): Promise<void>;
  removeFileExclusion?(pattern: string): Promise<void>;
  openPermissionSettings(): Promise<void>;
  revertTuning(id: string): Promise<unknown>;
  lockParam(param: string, locked: boolean): Promise<unknown>;
  feedback(id: string, verdict: 'useful' | 'noise'): Promise<unknown>;
  acceptRebaseline(id: string): Promise<unknown>;
  resumeTuning(): Promise<void>;
  resetTuning(): Promise<void>;
  retryTuningBackup(): Promise<void>;
  dismissTuningBackup(): Promise<void>;
}
export type TuneRequest =
  | { param: string; to: TuningValue; reason?: string }
  | { action: 'feedback'; alertId: string; verdict: 'useful' | 'noise' };
