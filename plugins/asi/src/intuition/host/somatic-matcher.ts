/**
 * Prefrontal vmPFC Somatic Marker & Gut-Feeling Matcher (`somatic-matcher.ts`).
 *
 * - Pure local, <10ms, zero-LLM cue-driven retrieval over consolidated L2
 *   memories (`pitfall`, `decision`, `preference`) and short-term tool failure
 *   scars (`SomaticScar`).
 * - Maintains an incremental fingerprinted `MiniSearch` index so turn/tool
 *   pre-flight checks run in <1ms without re-indexing unchanged vaults.
 */

import { type SleepMemoryKind, type SleepMemorySummary, sanitizeForModel } from '@asi/sense-types';
import MiniSearch from 'minisearch';
import { tokenizeCjkAndLatin, tokenizeSearchQuery } from '../../sleep/shared/search.js';
import type { FlashbackFeedback, FlashbackMatch, FlashbackSourceKind, SomaticScar } from '../shared/types.js';

const GENERIC_CUE_STOPWORDS = new Set([
  'ok',
  'yes',
  'no',
  'run',
  'fix',
  'add',
  'set',
  'get',
  'use',
  'new',
  'all',
  'now',
  'try',
  'let',
  'can',
  'you',
  'help',
  'make',
  'file',
  'code',
  'read',
  'edit',
  'test',
  'bash',
  'tool',
  'work',
  'data',
  'true',
  'false',
  'null',
  '帮我',
  '帮忙',
  '继续',
  '好的',
  '可以',
  '现在',
  '一下',
  '一个',
  '这个',
  '那个',
  '怎么',
  '什么',
  '需要',
  '查看',
  '看看',
  '执行',
  '运行',
  '修改',
  '文件',
  '代码',
  '问题',
  '当前',
  '请先',
]);

const KIND_SOMATIC_WEIGHT: Record<FlashbackSourceKind, number> = {
  scar: 1.0,
  pitfall: 1.0,
  decision: 0.82,
  preference: 0.68,
  episode: 0.45,
};

interface IndexedSomaticDoc {
  id: string;
  sourceKind: FlashbackSourceKind;
  title: string;
  caution: string;
  tagsText: string;
  topicText: string;
  retention: number;
  confidence: number;
  evidenceCount: number;
  pinned: boolean;
  workspaceHint?: string;
  tokenSet: ReadonlySet<string>;
  tagSet: ReadonlySet<string>;
}

export interface SomaticScanInput {
  cueText: string;
  cwd?: string;
  toolName?: string;
  memories: readonly SleepMemorySummary[];
  scars: readonly SomaticScar[];
  allowedKinds?: readonly FlashbackSourceKind[];
  feedbackBySourceId?: Readonly<Record<string, FlashbackFeedback>>;
  minScore?: number;
  limit?: number;
}

function isConcreteCueToken(token: string): boolean {
  const clean = token.trim().toLowerCase();
  if (!clean || GENERIC_CUE_STOPWORDS.has(clean)) return false;
  if (/^[a-z0-9_.-]+$/.test(clean)) {
    return clean.length >= 3;
  }
  return [...clean].length >= 2;
}

export function extractConcreteCues(rawText: string): string[] {
  if (!rawText?.trim()) return [];
  const rawTokens = tokenizeSearchQuery(rawText);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of rawTokens) {
    const norm = tok.toLowerCase();
    if (!isConcreteCueToken(norm) || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= 32) break;
  }
  return out;
}

function pathTailTokens(cwd: string | undefined): string[] {
  if (!cwd) return [];
  const parts = cwd
    .split(/[\\/]+/)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length >= 2 && p !== '~' && p !== 'work' && p !== 'src' && p !== 'tmp');
  return parts.slice(-2);
}

function computeCorpusFingerprint(memories: readonly SleepMemorySummary[], scars: readonly SomaticScar[]): string {
  const memHead = memories[0];
  const memTail = memories.at(-1);
  const scarHead = scars[0];
  let hashAcc = 0;
  for (const m of memories) {
    const retPct = Math.round(m.retention * 100);
    const pinBit = m.pinned ? 1 : 0;
    hashAcc =
      (hashAcc * 31 + Math.trunc(m.updatedAt) + retPct * 97 + pinBit * 389 + m.content.length * 17) % 1_000_000_007;
  }
  for (const s of scars) {
    hashAcc = (hashAcc * 31 + Math.trunc(s.updatedAt) + s.failureCount * 31 + s.caution.length * 13) % 1_000_000_007;
  }
  return `${memories.length}:${memHead?.id ?? ''}:${memTail?.id ?? ''}:${scars.length}:${scarHead?.id ?? ''}:${hashAcc}`;
}

export class SomaticMatcher {
  private cachedFingerprint = '';
  private mini: MiniSearch<IndexedSomaticDoc> | null = null;
  private docsById = new Map<string, IndexedSomaticDoc>();

  private ensureIndex(memories: readonly SleepMemorySummary[], scars: readonly SomaticScar[]): void {
    const fp = computeCorpusFingerprint(memories, scars);
    if (this.mini && fp === this.cachedFingerprint) {
      return;
    }

    const mini = new MiniSearch<IndexedSomaticDoc>({
      idField: 'id',
      fields: ['title', 'caution', 'tagsText', 'topicText'],
      tokenize: tokenizeCjkAndLatin,
      searchOptions: {
        boost: { title: 2.6, tagsText: 2.4, topicText: 1.8, caution: 1.2 },
        prefix: (term) => term.length >= 3,
        fuzzy: (term) => (/^[a-z0-9_.-]+$/.test(term) && term.length >= 5 ? 0.18 : false),
      },
    });

    const docsById = new Map<string, IndexedSomaticDoc>();
    const docs: IndexedSomaticDoc[] = [];

    const allowedKinds: ReadonlySet<SleepMemoryKind> = new Set(['pitfall', 'decision', 'preference']);
    for (const mem of memories) {
      if (!allowedKinds.has(mem.kind)) continue;
      const retention = mem.pinned ? 1 : Math.max(0, Math.min(1, mem.retention));
      if (!mem.pinned && retention < 0.25) continue;

      const tagsLower = mem.tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
      const docText = `${mem.title} ${mem.content} ${tagsLower.join(' ')} ${mem.topicKey ?? ''}`;
      const concreteDocTokens = new Set(tokenizeCjkAndLatin(docText).filter(isConcreteCueToken));

      const doc: IndexedSomaticDoc = {
        id: mem.id,
        sourceKind: mem.kind,
        title: sanitizeForModel(mem.title),
        caution: sanitizeForModel(mem.content),
        tagsText: tagsLower.join(' '),
        topicText: mem.topicKey ?? '',
        retention,
        confidence: Math.max(0.3, Math.min(1, mem.confidence)),
        evidenceCount: Math.max(1, mem.evidenceCount),
        pinned: mem.pinned,
        tokenSet: concreteDocTokens,
        tagSet: new Set(tagsLower),
      };
      docs.push(doc);
      docsById.set(doc.id, doc);
    }

    for (const scar of scars) {
      const tagsLower = [scar.toolName.toLowerCase(), ...scar.tags.map((t) => t.trim().toLowerCase())].filter(Boolean);
      const docText = `${scar.title} ${scar.caution} ${scar.signature} ${tagsLower.join(' ')}`;
      const concreteDocTokens = new Set(tokenizeCjkAndLatin(docText).filter(isConcreteCueToken));
      const doc: IndexedSomaticDoc = {
        id: scar.id,
        sourceKind: 'scar',
        title: sanitizeForModel(scar.title),
        caution: sanitizeForModel(scar.caution),
        tagsText: tagsLower.join(' '),
        topicText: scar.signature,
        retention: 1,
        confidence: Math.min(1, 0.72 + Math.min(4, scar.failureCount) * 0.07),
        evidenceCount: scar.failureCount,
        pinned: false,
        ...(scar.workspaceHint ? { workspaceHint: scar.workspaceHint } : {}),
        tokenSet: concreteDocTokens,
        tagSet: new Set(tagsLower),
      };
      docs.push(doc);
      docsById.set(doc.id, doc);
    }

    mini.addAll(docs);
    this.mini = mini;
    this.docsById = docsById;
    this.cachedFingerprint = fp;
  }

  scan(input: SomaticScanInput): FlashbackMatch[] {
    const combinedCueParts = [input.cueText];
    if (input.toolName && isConcreteCueToken(input.toolName)) {
      combinedCueParts.push(input.toolName);
    }
    const wsTails = pathTailTokens(input.cwd);
    const cueTokens = extractConcreteCues(combinedCueParts.join(' '));
    if (cueTokens.length === 0) return [];

    this.ensureIndex(input.memories, input.scars);
    if (!this.mini || this.docsById.size === 0) return [];

    const searchQuery = [...cueTokens, ...wsTails].join(' ');
    const rawHits = this.mini.search(searchQuery, {
      combineWith: 'OR',
      tokenize: () => [...cueTokens, ...wsTails],
    });
    if (rawHits.length === 0) return [];

    const maxRaw = Math.max(...rawHits.map((h) => h.score), 1e-6);
    const minScore = Math.max(0.25, Math.min(0.95, input.minScore ?? 0.58));
    const maxItems = Math.max(1, Math.min(10, Math.trunc(input.limit ?? 3)));
    const feedbackMap = input.feedbackBySourceId ?? {};
    const allowedKindsSet = input.allowedKinds ? new Set<FlashbackSourceKind>(input.allowedKinds) : null;

    const scored: FlashbackMatch[] = [];
    for (const hit of rawHits) {
      const doc = this.docsById.get(String(hit.id));
      if (!doc) continue;
      if (allowedKindsSet && !allowedKindsSet.has(doc.sourceKind)) continue;

      const feedback = feedbackMap[doc.id];
      if (feedback === 'muted') continue;

      const matchedCues: string[] = [];
      let exactTagMatches = 0;
      for (const cue of cueTokens) {
        if (doc.tokenSet.has(cue) || doc.tagSet.has(cue)) {
          matchedCues.push(cue);
          if (doc.tagSet.has(cue)) exactTagMatches += 1;
        }
      }
      // Require at least one concrete non-workspace cue token overlap to avoid pure directory-name noise.
      if (matchedCues.length === 0) continue;

      let wsBonus = 0;
      for (const wsTok of wsTails) {
        if (doc.tagSet.has(wsTok) || doc.tokenSet.has(wsTok) || doc.workspaceHint?.toLowerCase().includes(wsTok)) {
          wsBonus = 0.06;
          break;
        }
      }

      const normBm25 = Math.min(1, hit.score / maxRaw);
      const cueCoverage = Math.min(1, matchedCues.length / Math.min(3, Math.max(1, cueTokens.length)));
      const kindWeight = KIND_SOMATIC_WEIGHT[doc.sourceKind];
      const retentionFactor = doc.pinned ? 1 : 0.55 + 0.45 * doc.retention;
      const evidenceBonus = Math.min(0.08, (doc.evidenceCount - 1) * 0.025);
      const tagBonus = Math.min(0.1, exactTagMatches * 0.05);
      const feedbackDelta = feedback === 'helpful' ? 0.08 : feedback === 'dismissed' ? -0.18 : 0;

      const rawComposite =
        (0.44 * normBm25 + 0.34 * cueCoverage + 0.22 * kindWeight) * retentionFactor * (0.82 + 0.18 * doc.confidence) +
        evidenceBonus +
        tagBonus +
        wsBonus +
        feedbackDelta;

      const score = Math.round(Math.max(0, Math.min(1, rawComposite)) * 1000) / 1000;
      if (score < minScore) continue;

      scored.push({
        sourceId: doc.id,
        sourceKind: doc.sourceKind,
        title: doc.title,
        caution: doc.caution,
        score,
        retention: Math.round(doc.retention * 1000) / 1000,
        matchedCues: matchedCues.slice(0, 6),
        ...(feedback ? { feedback } : {}),
      });
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const kwDiff = KIND_SOMATIC_WEIGHT[b.sourceKind] - KIND_SOMATIC_WEIGHT[a.sourceKind];
      if (kwDiff !== 0) return kwDiff;
      return b.retention - a.retention;
    });

    return scored.slice(0, maxItems);
  }
}
