import type { EnvUpdate, SourceObservation, WatchRule } from '@asi/sense-types';
import type { StateStore } from '../state/store.ts';
import type { ToolWindow } from './selfcause.ts';

/** Per-session delivery context supplied by the host. */
export interface SessionContext {
  id: string;
  busy: boolean;
  /** True when the active turn was initiated by the user. */
  userInitiated: boolean;
  /** Agent tool-execution windows used for self-cause classification. */
  toolWindows?: ToolWindow[];
}

/**
 * A delivery instruction for the host adapter (M3 implements the transports).
 * `sessionId` routes the intent back to the session that produced it.
 * `deliveryId` is the stable SHA-256 idempotency key the host dedups
 * at-least-once deliveries by (README).
 */
export type DeliveryIntent =
  | { kind: 'inject'; sessionId: string; update: EnvUpdate; deliveryId?: string }
  | { kind: 'followup'; sessionId: string; update: EnvUpdate; deliveryId?: string }
  | {
      kind: 'send';
      sessionId: string;
      target: 'next-step';
      wakeup: true;
      update: EnvUpdate;
      deliveryId?: string;
    };

/**
 * Sink for delivery intents. The returned promise is awaited before any
 * bucket is dropped or the wake budget charged; a rejection retains the
 * queued input and propagates to the caller. While a delivery is in flight
 * every `flush`/`preStep` call inside its async context rejects with
 * {@link ReentrantDeliveryError}; work it schedules for later runs free.
 */
export interface Deliverer {
  deliver(intent: DeliveryIntent): Promise<void>;
}

/** Options for {@link AttentionPipeline}. */
export interface AttentionPipelineOptions {
  store: StateStore;
  deliverer: Deliverer;
  isCurrent?: () => (sessionId: string) => boolean;
  isTarget?: (sessionId: string) => boolean;
  isDeliveryProtected?: (sessionId: string, deliveryId: string) => boolean;
  isWakeOwner?: (sessionId: string) => boolean;
  isPendingTarget?: (sessionId: string) => boolean;
  /** Injected MONOTONIC time for merge deadlines and the wake budget. */
  clock?: () => number;
  /**
   * Wall clock used only for rule expiry and `EnvUpdate.at` display.
   * `Signal.at` and `ToolWindow` bounds remain event wall timestamps.
   */
  wallClock?: () => number;
  rules?: WatchRule[];
  /** Initial merge window for non-file signals. @default 2000 */
  mergeWindowMs?: number;
  /** Initial merge window for `file.changed`. @default 5000 */
  fileMergeWindowMs?: number;
}

export interface SessionState {
  context: SessionContext;
  seenIds: Set<string>;
  seenOrder: string[];
  /** Charged wake deliveries as monotonic timestamps. */
  wakeTimes: number[];
  /** Per-session last source-health mark: `source.id` → observation. */
  srcStatus: Map<string, SourceObservation>;
  srcSequence: Map<string, number>;
}
