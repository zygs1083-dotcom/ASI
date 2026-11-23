/**
 * Pure TypeScript BM25 + Fuzzy/Prefix + CJK/Latin Memory Search Engine.
 *
 * Open-Source MIT Attribution:
 * - Powered by `lucaong/minisearch` (MIT License, Copyright (c) Luca Ongaro).
 * - Augmented with mixed CJK bigram/unigram + camelCase/identifier tokenization
 *   and FSRS retention-weighted ranking for `asi-sleep`.
 */

import MiniSearch from 'minisearch';
import type { MemoryKind } from './types.js';

const MAX_TOKENIZE_CHARS = 4_096;
const HAN_RUN_RE = /\p{Script=Han}+/gu;
const KANA_HANGUL_RUN_RE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const IDENT_RUN_RE = /[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*/g;
const CAMEL_BOUNDARY_RE = /([a-z0-9])([A-Z])/g;
const PURE_ASCII_TERM_RE = /^[a-z0-9_.-]+$/;

export function tokenizeCjkAndLatin(raw: string): string[] {
  if (!raw) return [];
  const bounded = raw.length > MAX_TOKENIZE_CHARS ? raw.slice(0, MAX_TOKENIZE_CHARS) : raw;
  const normalized = bounded.normalize('NFKC');
  const tokens: string[] = [];

  for (const match of normalized.matchAll(IDENT_RUN_RE)) {
    const full = match[0];
    const lowerFull = full.toLowerCase();
    tokens.push(lowerFull);
    const expanded = full.replace(CAMEL_BOUNDARY_RE, '$1 $2').toLowerCase();
    const parts = expanded.split(/[\s._-]+/).filter((part) => part.length >= 2);
    if (parts.length > 1) {
      for (const part of parts) {
        if (part !== lowerFull) tokens.push(part);
      }
    }
  }

  for (const match of normalized.matchAll(HAN_RUN_RE)) {
    const chars = [...match[0]];
    if (chars.length === 1) {
      tokens.push(chars[0] ?? '');
      continue;
    }
    for (let i = 0; i < chars.length - 1; i += 1) {
      tokens.push(`${chars[i]}${chars[i + 1]}`);
    }
    for (const ch of chars) {
      tokens.push(ch);
    }
  }

  for (const match of normalized.matchAll(KANA_HANGUL_RUN_RE)) {
    const chars = [...match[0]];
    if (chars.length === 1) {
      tokens.push(chars[0] ?? '');
    } else {
      for (let i = 0; i < chars.length - 1; i += 1) {
        tokens.push(`${chars[i]}${chars[i + 1]}`);
      }
    }
  }

  return tokens.filter(Boolean);
}

export interface SearchableMemoryLike {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string[];
  topicKey?: string;
  pinned: boolean;
  retention: number;
  updatedAt: number;
}

export interface MemorySearchOptions {
  kind?: MemoryKind;
  limit?: number;
  includeLowRetention?: boolean;
  minRetention?: number;
}

interface IndexedDoc {
  id: string;
  title: string;
  content: string;
  tagsText: string;
  topicKey: string;
}

export function searchMemoryItems<T extends SearchableMemoryLike>(
  items: readonly T[],
  query: string,
  options?: MemorySearchOptions,
): Array<T & { score: number }> {
  const minRetention = options?.minRetention ?? 0.2;
  const includeLow = options?.includeLowRetention ?? false;
  const limit = Math.max(1, Math.min(200, Math.trunc(options?.limit ?? 50)));

  const eligible = items.filter((item) => {
    if (options?.kind && item.kind !== options.kind) return false;
    if (!item.pinned && !includeLow && item.retention < minRetention) return false;
    return true;
  });

  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [...eligible]
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (Math.abs(b.retention - a.retention) > 1e-6) return b.retention - a.retention;
        return b.updatedAt - a.updatedAt;
      })
      .slice(0, limit)
      .map((item) => ({ ...item, score: item.pinned ? 1.15 : item.retention }));
  }

  if (eligible.length === 0) return [];

  const byId = new Map<string, T>();
  const docs: IndexedDoc[] = [];
  for (const item of eligible) {
    byId.set(item.id, item);
    docs.push({
      id: item.id,
      title: item.title,
      content: item.content,
      tagsText: item.tags.join(' '),
      topicKey: item.topicKey ?? '',
    });
  }

  const mini = new MiniSearch<IndexedDoc>({
    fields: ['title', 'content', 'tagsText', 'topicKey'],
    storeFields: ['id'],
    tokenize: tokenizeCjkAndLatin,
    searchOptions: {
      boost: { title: 3, tagsText: 2.5, topicKey: 2, content: 1 },
      combineWith: 'OR',
      prefix: (term) => [...term].length >= 2,
      fuzzy: (term) => (PURE_ASCII_TERM_RE.test(term) && term.length >= 4 ? 0.2 : false),
    },
  });
  mini.addAll(docs);

  const rawHits = mini.search(trimmedQuery);
  const normNeedle = trimmedQuery.normalize('NFKC').toLowerCase();
  const hitScores = new Map<string, number>();
  let maxRawScore = 0;

  for (const hit of rawHits) {
    const id = String(hit.id);
    hitScores.set(id, hit.score);
    if (hit.score > maxRawScore) maxRawScore = hit.score;
  }

  // Ensure literal substring matches on short symbols/phrases are never missed.
  for (const item of eligible) {
    if (hitScores.has(item.id)) continue;
    const hay = `${item.title} ${item.tags.join(' ')} ${item.topicKey ?? ''} ${item.content}`
      .normalize('NFKC')
      .toLowerCase();
    if (hay.includes(normNeedle)) {
      const fallbackScore = maxRawScore > 0 ? maxRawScore * 0.65 : 1;
      hitScores.set(item.id, fallbackScore);
      if (fallbackScore > maxRawScore) maxRawScore = fallbackScore;
    }
  }

  const denom = maxRawScore > 0 ? maxRawScore : 1;
  const ranked: Array<T & { score: number }> = [];

  for (const [id, rawScore] of hitScores) {
    const item = byId.get(id);
    if (!item) continue;
    const lowerTitle = item.title.normalize('NFKC').toLowerCase();
    const exactBoost = lowerTitle.includes(normNeedle) ? 1.2 : 1.0;
    const bm25Norm = rawScore / denom;
    const retentionFactor = 0.7 + 0.3 * Math.max(0, Math.min(1, item.retention));
    const pinBoost = item.pinned ? 1.15 : 1.0;
    const finalScore = Number((bm25Norm * retentionFactor * pinBoost * exactBoost).toFixed(4));
    ranked.push({ ...item, score: finalScore });
  }

  ranked.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
  return ranked.slice(0, limit);
}
