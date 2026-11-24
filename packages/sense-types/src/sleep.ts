/**
 * Cross-plugin read-only long-term memory vault contract (`ctx.asiSleep`),
 * exposed by `asi-sleep` (`0.5.0+`) so higher-order plugins (such as L4
 * `asi-growth`) can inspect high-retention consolidated memories without
 * touching internal源码 or mutating FSRS recall state.
 */

export type SleepMemoryKind = 'preference' | 'decision' | 'pitfall' | 'episode';

export interface SleepMemorySummary {
  id: string;
  kind: SleepMemoryKind;
  title: string;
  content: string;
  tags: string[];
  topicKey?: string;
  pinned: boolean;
  confidence: number;
  /** Current FSRS retrievability in `[0, 1]` (`1` when `pinned === true`). */
  retention: number;
  evidenceCount: number;
  recallCount: number;
  sourceSessionIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface SleepMemoryQueryOptions {
  kinds?: readonly SleepMemoryKind[];
  minRetention?: number;
  limit?: number;
}

export interface AsiSleepServiceApi {
  /** Return sanitized, isolated read-only memory summaries ordered by retention and recency. */
  listMemories(options?: SleepMemoryQueryOptions): SleepMemorySummary[];
  /** Subscribe to memory vault or sleep consolidation state changes; returns an unsubscribe callback. */
  subscribe(listener: () => void): () => void;
}
