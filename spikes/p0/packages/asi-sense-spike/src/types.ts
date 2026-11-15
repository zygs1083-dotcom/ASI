/** Wire types shared by the asi-sense spike Host Remote and its Client panel. */

/** Session wire identity as a plain string; the Host casts to the branded `SessionId` when resolving. */
export type SessionId = string

/** Result of one explicit Host action invoked from the panel. */
export interface ActionResult {
  readonly ok: boolean
  readonly detail?: string
}

/** Recorded outcome of the most recent explicit action, surfaced in snapshots. */
export interface SpikeAction extends ActionResult {
  readonly kind: string
  readonly at: number
}

/** Explicit token buckets read from the Session's tokenUsage projection. */
export interface SpikeUsageBuckets {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** Context/token facts for the panel-selected Agent; absent fields stayed unavailable. */
export interface SpikeTokens {
  readonly pressureTokens?: number
  readonly contextWindow?: number
  readonly projectedTokens?: number
  readonly modelContext?: number
  readonly usage?: SpikeUsageBuckets
}

/** Agent identity the Host currently reports; never conflated with Client selection. */
export interface SpikeAgent {
  readonly id: string
  readonly status: string
}

/** One validated helper NDJSON event; values arrive already redacted. */
export interface SpikeHelperEvent {
  readonly seq: number
  readonly at: number
  readonly type: string
  readonly fields?: Record<string, string | number | boolean>
}

/** Periodic environment sample pushed to the panel. */
export interface SpikeSnapshot {
  readonly seq: number
  readonly at: number
  readonly hostPid: number
  readonly helperPid?: number
  /** Fraction of CPU time spent non-idle between consecutive samples, 0..1. */
  readonly cpu: number
  readonly memUsed: number
  readonly memTotal: number
  readonly diskFree: number
  readonly agent?: SpikeAgent
  readonly tokens?: SpikeTokens
  readonly helperEvents: readonly SpikeHelperEvent[]
  readonly lastAction?: SpikeAction
}
