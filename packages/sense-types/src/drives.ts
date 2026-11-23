/**
 * Cross-plugin Maslow multi-tier drive arbitration contract (`ctx.asiDrives`),
 * exposed by `asi-needs` (`0.3.0+`) for coordinating L1 physiological survival
 * needs with higher-order plugins (e.g. L2 `asi-sleep`, L3 `asi-care`).
 */

import type { HelpCard, NeedZone } from './needs.js';
import type { PowerMode, SenseSnapshot } from './service.js';

/** Maslow hierarchy tier: 1 = physiological survival (built-in), 2..4 = higher-order drives. */
export type DriveTier = 1 | 2 | 3 | 4;

export type HigherOrderDriveTier = 2 | 3 | 4;

export interface DriveEvaluation {
  /** Globally unique drive key (`NeedKey` for L1, or `${sourceId}:${key}` for L2..L4). */
  key: string;
  /** Owning plugin/source identifier (e.g. `'asi-needs'`, `'asi-sleep'`, `'asi-care'`). */
  sourceId: string;
  /** Maslow hierarchy level (`1` = physiological survival, `2..4` = higher-order). */
  tier: DriveTier;
  label: string;
  /** 0..100 integer: 100 = fully satisfied, 0 = depleted. */
  satisfaction: number;
  /** 0..100 integer: 100 - satisfaction. */
  urgency: number;
  zone: NeedZone;
  driveActive: boolean;
  /** When false, discomfort is visible in arbitration/UI while autonomous wakeup in `asi-needs` is deferred. */
  autoMaintain?: boolean;
  /** True when suspended because L1 physiological survival is distressed or `eco` mode is active. */
  suppressed: boolean;
  suppressionReason?: string;
  summary: string;
  evidence: Record<string, string | number | boolean | null>;
  updatedAt: number;
}

export interface DriveToolParameterSpec {
  type: 'string' | 'number' | 'boolean';
  description?: string;
  required?: boolean;
  enum?: readonly string[];
}

export interface DriveSandboxToolResult {
  summary: string;
  freedBytes?: number;
  stoppedJobs?: number;
  tokensSaved?: number;
  data?: Record<string, string | number | boolean | null>;
}

export interface DriveAbortSignal {
  readonly aborted: boolean;
}

export interface DriveSandboxToolSpec {
  /** Whitelisted tool name (`^[a-z][a-z0-9_]{2,63}$`), mounted ONLY in background self-maintenance session. */
  name: string;
  description: string;
  parameters?: Record<string, DriveToolParameterSpec>;
  /** Optional drive key (`key` or `${sourceId}:${key}`) for Action-Outcome Memory Δ tracking. */
  driveKey?: string;
  execute: (args: Record<string, unknown>, context: { signal: DriveAbortSignal }) => Promise<DriveSandboxToolResult>;
}

export interface ExternalDriveReading {
  key: string;
  label: string;
  /** Raw 0..100 satisfaction score; host applies Schmitt-trigger hysteresis consistently. */
  satisfaction: number;
  summary: string;
  evidence?: Record<string, string | number | boolean | null>;
  /**
   * When `false`, discomfort is still tracked and displayed in `ctx.asiDrives`,
   * while autonomous wakeup of `asi-needs` maintainer session is deferred (e.g.
   * `asi-sleep` gating on its quiet window and running its own sleep cycle).
   */
  autoMaintain?: boolean;
}

export interface DriveHelpActionInput {
  cardId: string;
  driveKey: string;
  actionTarget?: string;
  now: number;
  signal: DriveAbortSignal;
}

export interface DriveHelpActionResult {
  /** Action key recorded into Action-Outcome Memory ledger (defaults to `actionTarget` or `'run-drive-action'`). */
  ledgerAction?: string;
  summary: string;
  freedBytes?: number;
  stoppedJobs?: number;
  tokensSaved?: number;
}

export interface DriveHelpCardProposal {
  /** Drive key owned by this source (raw or `${sourceId}:${key}`). */
  driveKey: string;
  severity?: 'uncomfortable' | 'critical';
  title: string;
  summary: string;
  proposedAction?: string;
  /** `'run-drive-action'` invokes `executeHelpAction` upon user approval; `'acknowledge'` is read-only confirmation. */
  actionKind?: 'acknowledge' | 'run-drive-action';
  /** Controlled non-path target identifier validated by the owning drive source. */
  actionTarget?: string;
  /** Optional custom button label for `'run-drive-action'`. */
  approveLabel?: string;
}

export interface DriveSourceRegistration {
  id: string;
  /** Higher-order Maslow tier (`2 | 3 | 4`); tier `1` is reserved for `asi-needs` physiological drives. */
  tier: HigherOrderDriveTier;
  label: string;
  evaluate: (snapshot: SenseSnapshot) => readonly ExternalDriveReading[];
  sandboxTools?: readonly DriveSandboxToolSpec[];
  /** Optional controlled callback invoked when the user clicks Approve on a `'run-drive-action'` HelpCard for this source. */
  executeHelpAction?: (input: DriveHelpActionInput) => Promise<DriveHelpActionResult>;
  /** Optional callback invoked when the user clicks Acknowledge ("我已处理") on an `'acknowledge'` HelpCard for this source. */
  onHelpAcknowledged?: (input: {
    cardId: string;
    driveKey: string;
    actionTarget?: string;
    now: number;
  }) => void | Promise<void>;
  /** Optional callback notified when the user dismisses an open HelpCard owned by this source. */
  onHelpDismissed?: (input: { cardId: string; driveKey: string; actionTarget?: string; now: number }) => void;
}

export interface AsiDrivesSnapshot {
  now: number;
  powerMode: PowerMode;
  higherOrderSuppressed: boolean;
  suppressionReason?: string;
  /** Lowest active non-suppressed Maslow tier (`1..4`), or `null` when all drives are comfortable. */
  activeTier: DriveTier | null;
  drives: DriveEvaluation[];
}

export interface AsiDrivesServiceApi {
  /** Return an isolated snapshot of all L1..L4 drives and suppression state. */
  snapshot(): AsiDrivesSnapshot;
  /** Subscribe to arbitrated drive updates; returns an unsubscribe callback. */
  subscribe(listener: (snapshot: AsiDrivesSnapshot) => void): () => void;
  /** Register an external higher-order drive source (`tier: 2..4`) and optional sandbox tools; returns unregister disposer. */
  registerSource(registration: DriveSourceRegistration): () => void;
  /** Notify `asi-needs` that a registered source's state changed so arbitration reconciles immediately. */
  notifySourceChanged(sourceId?: string): void;
  /** Propose or update a silent sidebar-only HelpCard for a registered higher-order drive (never sends `<asi-cry>`). */
  proposeHelpCard?(sourceId: string, proposal: DriveHelpCardProposal): Promise<HelpCard>;
  /** Resolve open HelpCards owned by `sourceId` (optionally scoped by `driveKey`, `actionTarget`, or `exceptActionTargets`). */
  resolveHelpCards?(
    sourceId: string,
    filter?: { driveKey?: string; actionTarget?: string; exceptActionTargets?: readonly string[] },
  ): Promise<number>;
}
