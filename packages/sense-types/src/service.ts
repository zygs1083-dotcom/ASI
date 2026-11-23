/**
 * Public Cordis service contract exposed by `asi-sense` (`ctx.asiSense`) and
 * consumed by `asi-needs`.
 */

import type { BodyHistory, MetricKey } from './history.js';
import type { SenseState, Signal } from './index.js';

export type PowerMode = 'normal' | 'eco';

export interface SenseSettingsSnapshot {
  paused: boolean;
  sendTitles: boolean;
  powerMode: PowerMode;
  powerModeReason?: string;
}

export interface SenseSnapshot {
  /** Wall-clock timestamp (ms). */
  now: number;
  /** Monotonic clock timestamp (ms). */
  mono: number;
  /** Currently active foreground user conversation (excludes internal daemon sessions). */
  activeSessionId?: string;
  /** Complete sensory fact table with TTL statuses projected at `now`. */
  state: SenseState;
  /** Short-term 5-minute vitals trend ring. */
  history: BodyHistory;
  /** Sensory privacy & power mode settings. */
  settings: SenseSettingsSnapshot;
  /** Effective sampling intervals per metric (ms). */
  sampleIntervalsMs: Partial<Record<MetricKey, number>>;
}

export interface AsiSenseServiceApi {
  /** Optional storage root owned by `asi-sense` (for safe `tmp/` cleanup). */
  readonly storageRoot?: string;
  /** Read an isolated sensory snapshot (optionally projecting session-specific facts for `sessionId`). */
  snapshot(sessionId?: string): SenseSnapshot;
  /** Subscribe to sensory snapshot updates; returns an unsubscribe callback. */
  subscribe(listener: (snapshot: SenseSnapshot) => void): () => void;
  /** Read current sensory settings (`paused`, `sendTitles`, `powerMode`). */
  getSettings(): SenseSettingsSnapshot;
  /** Pause or resume sensory collection. */
  setPaused(paused: boolean): Promise<void>;
  /** Enable or disable sharing window titles with models. */
  setSendTitles(enabled: boolean): Promise<void>;
  /** Switch sensory sampling cadence between `'normal'` and `'eco'` (zero-token instinct throttling). */
  setPowerMode(mode: PowerMode, reason?: string): Promise<void>;
  /** Open macOS Accessibility permission settings (no-op on other platforms). */
  openPermissionSettings(): Promise<void>;
  /** Mark a session ID as an internal background session so its steps do not hijack foreground observation. */
  registerInternalSession(sessionId: string): () => void;
  /** Return recent in-memory foreground signals (bounded, never persisted). */
  recentSignals(): Signal[];
  /** Force an immediate refresh of DSH and active-session token facts (e.g. after background maintenance). */
  refresh?(): Promise<void>;
  /** Return remaining monotonic freshness (ms) for a fact path (e.g. `/self/body/cpu`), or `undefined` when untracked. */
  factStaleInMs?(path: string): number | undefined;
}
