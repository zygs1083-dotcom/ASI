/**
 * Cross-plugin read-only Default Mode Network (DMN) Cross-Repo Insight contract (`ctx.asiDream`),
 * exposed by the `dream` module so tools and sibling modules can inspect synthesized
 * cross-project insights without mutating internal dream state or breaking Prompt Cache.
 */

export type DreamInsightKind = 'preventive-warning' | 'structural-analogy' | 'pattern-unification' | 'decision-tension';

export type DreamInsightStatus = 'open' | 'adopted' | 'promoted' | 'dismissed';

export interface DreamInsightSummary {
  id: string;
  kind: DreamInsightKind;
  status: DreamInsightStatus;
  title: string;
  summary: string;
  bridgeMechanism: string;
  actionableHypothesis: string;
  sourceRepos: string[];
  targetRepo?: string;
  sourceMemoryIds: string[];
  sourceSessionIds: string[];
  tags: string[];
  topicKey: string;
  noveltyScore: number;
  structuralSimilarity: number;
  confidence: number;
  adoptedMemoryId?: string;
  promotedDraftId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DreamInsightQueryOptions {
  statuses?: readonly DreamInsightStatus[];
  kinds?: readonly DreamInsightKind[];
  workspacePath?: string;
  minConfidence?: number;
  limit?: number;
}

export interface AsiDreamServiceApi {
  /** Return sanitized, isolated read-only cross-repo insights ordered by status, confidence, and recency. */
  listInsights(options?: DreamInsightQueryOptions): DreamInsightSummary[];
  /** Subscribe to insight vault or DMN dream cycle state changes; returns an unsubscribe callback. */
  subscribe(listener: () => void): () => void;
}
