/**
 * Public Cordis service contract exposed by ASI Theory of Mind (`ctx.asiTom`):
 * zero-token, local-only partner cognitive state inference & collaborative tact.
 */

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

export type PartnerStateSource = 'inferred' | 'manual_override' | 'paused';

/** Continuous 0..100 cognitive & interaction dimensions. */
export interface PartnerDimensions {
  /** Deep immersion & low context-switching entropy (0..100). */
  focus: number;
  /** Interaction friction from interruptions, failed commands, or rapid retries (0..100). */
  friction: number;
  /** Tempo relative to the partner's individualized EWMA cadence baseline (0..100). */
  pace: number;
  /** Foreground availability accounting for lock screen, sleep, and idle decay (0..100). */
  presence: number;
}

export type TactVerbosity = 'ultra_concise' | 'concise' | 'balanced' | 'structured' | 'thorough' | 'handoff_summary';

export type TactAutonomy =
  | 'proactive_execute'
  | 'balanced'
  | 'verify_first'
  | 'collaborative_options'
  | 'safe_autonomous';

export interface TactGuidance {
  verbosity: TactVerbosity;
  autonomy: TactAutonomy;
  /** Maximum clarifying questions appropriate in a single turn (0 = avoid interrupting unless destructive). */
  questionBudget: 0 | 1 | 2;
  /** True when non-critical background nudges or proactive interruptions should step aside. */
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

export interface PartnerStateSnapshot {
  now: number;
  enabled: boolean;
  paused: boolean;
  state: PartnerStateKind;
  source: PartnerStateSource;
  /** Posterior confidence in `[0, 1]`. */
  confidence: number;
  dimensions: PartnerDimensions;
  guidance: TactGuidance;
  reasons: string[];
  manualOverride: PartnerManualOverride | null;
  baseline: PartnerBaselineSummary;
  updatedAt: number;
}

export interface AsiTomServiceApi {
  /** Return an isolated, sanitized snapshot of the current partner state and tact prescription. */
  snapshot(): PartnerStateSnapshot;
  /** Return the active collaborative tact guidance for model/agent coordination. */
  tactGuidance(): TactGuidance;
  /** Return true when the partner is in deep focus or rapid sprint and should not be interrupted by non-urgent work. */
  shouldDeferProactiveWork(): boolean;
  /** Subscribe to partner state updates; returns an unsubscribe disposer. */
  subscribe(listener: (snapshot: PartnerStateSnapshot) => void): () => void;
}
