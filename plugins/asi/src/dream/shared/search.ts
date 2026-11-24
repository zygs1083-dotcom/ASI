/**
 * Bilingual CJK + English BM25 & Fuzzy Search over DMN Cross-Repo Insights (`asi-dream`).
 */

import MiniSearch from 'minisearch';
import { tokenizeCjkAndLatin, tokenizeSearchQuery } from '../../sleep/shared/search.js';
import type { DreamInsightKind, DreamInsightStatus, DreamInsightViewItem } from './types.js';

export interface DreamInsightSearchOptions {
  kind?: DreamInsightKind;
  statuses?: readonly DreamInsightStatus[];
  repoFilter?: string;
  limit?: number;
}

interface IndexedInsightDoc {
  id: string;
  title: string;
  summary: string;
  bridgeMechanism: string;
  actionableHypothesis: string;
  tagsText: string;
  reposText: string;
  topicKey: string;
}

const STATUS_RANK: Record<DreamInsightStatus, number> = {
  open: 0,
  adopted: 1,
  promoted: 2,
  dismissed: 3,
};

export function sortDreamInsights<T extends Pick<DreamInsightViewItem, 'id' | 'status' | 'confidence' | 'updatedAt'>>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => {
    const sr = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (sr !== 0) return sr;
    const confDiff = b.confidence - a.confidence;
    if (Math.abs(confDiff) > 1e-6) return confDiff;
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    return a.id.localeCompare(b.id);
  });
}

export function searchDreamInsights<T extends DreamInsightViewItem>(
  items: readonly T[],
  query: string,
  options?: DreamInsightSearchOptions,
): T[] {
  const limit = Math.max(1, Math.min(200, Math.trunc(options?.limit ?? 50)));
  const statusSet = options?.statuses && options.statuses.length > 0 ? new Set(options.statuses) : undefined;
  const repoNorm = options?.repoFilter?.trim().toLowerCase();

  const candidates = items.filter((item) => {
    if (options?.kind && item.kind !== options.kind) return false;
    if (statusSet && !statusSet.has(item.status)) return false;
    if (repoNorm) {
      const hitRepo =
        item.repoKeys.some((rk) => rk.toLowerCase().includes(repoNorm)) ||
        item.sourceRepos.some((sr) => sr.toLowerCase().includes(repoNorm)) ||
        (item.targetRepo ? item.targetRepo.toLowerCase().includes(repoNorm) : false);
      if (!hitRepo) return false;
    }
    return true;
  });

  const trimmed = query.trim();
  if (!trimmed) {
    return sortDreamInsights(candidates).slice(0, limit);
  }

  const mini = new MiniSearch<IndexedInsightDoc>({
    fields: ['title', 'summary', 'bridgeMechanism', 'actionableHypothesis', 'tagsText', 'reposText', 'topicKey'],
    storeFields: ['id'],
    tokenize: tokenizeCjkAndLatin,
    searchOptions: {
      tokenize: tokenizeSearchQuery,
      boost: {
        title: 2.6,
        tagsText: 2.0,
        reposText: 1.8,
        topicKey: 1.8,
        bridgeMechanism: 1.5,
        summary: 1.3,
        actionableHypothesis: 1.1,
      },
      prefix: true,
      fuzzy: 0.2,
      combineWith: 'OR',
    },
  });

  const byId = new Map<string, T>();
  const docs: IndexedInsightDoc[] = [];
  for (const item of candidates) {
    byId.set(item.id, item);
    docs.push({
      id: item.id,
      title: item.title,
      summary: item.summary,
      bridgeMechanism: item.bridgeMechanism,
      actionableHypothesis: item.actionableHypothesis,
      tagsText: item.tags.join(' '),
      reposText: [...item.sourceRepos, item.targetRepo ?? ''].join(' '),
      topicKey: item.topicKey,
    });
  }
  mini.addAll(docs);

  const rawHits = mini.search(trimmed);
  if (rawHits.length === 0) {
    const lower = trimmed.toLowerCase();
    return sortDreamInsights(
      candidates.filter(
        (c) =>
          c.title.toLowerCase().includes(lower) ||
          c.summary.toLowerCase().includes(lower) ||
          c.bridgeMechanism.toLowerCase().includes(lower) ||
          c.actionableHypothesis.toLowerCase().includes(lower) ||
          c.sourceRepos.some((r) => r.toLowerCase().includes(lower)),
      ),
    ).slice(0, limit);
  }

  const maxScore = Math.max(...rawHits.map((h) => h.score), 1);
  const ranked = rawHits
    .map((hit) => {
      const item = byId.get(String(hit.id));
      if (!item) return undefined;
      const lexNorm = hit.score / maxScore;
      const statusBoost = item.status === 'open' ? 0.12 : item.status === 'dismissed' ? -0.15 : 0.04;
      const composite = lexNorm * 0.68 + item.confidence * 0.2 + item.noveltyScore * 0.12 + statusBoost;
      return { item, composite };
    })
    .filter((entry): entry is { item: T; integration?: never; composite: number } => Boolean(entry))
    .sort((a, b) => b.composite - a.composite || b.item.updatedAt - a.item.updatedAt);

  return ranked.slice(0, limit).map((r) => r.item);
}
