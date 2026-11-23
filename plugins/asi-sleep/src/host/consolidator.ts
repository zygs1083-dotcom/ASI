/**
 * Two-Phase Biological NREM + REM Sleep Consolidation Engine (`asi-sleep`).
 *
 * Open-Source MIT Attribution:
 * - Two-phase Dream Consolidation architecture (NREM slow-wave clustering &
 *   abstraction + REM cross-session deduplication, belief/stance conflict
 *   resolution, associative graph linking, and synaptic pruning) adapted from
 *   `Fozikio/cortex-engine` (MIT License, Copyright (c) Fozikio).
 * - Synaptic decay & reinforcement backed by `open-spaced-repetition/ts-fsrs` (MIT).
 * - Lexical/BM25 similarity backed by `lucaong/minisearch` (MIT).
 */

import { randomUUID } from 'node:crypto';
import { tokenizeCjkAndLatin } from '../shared/search.js';
import {
  MEMORY_KINDS,
  type MemoryEntry,
  type MemoryKind,
  type SleepConsolidationRecord,
  type SleepConsolidationTrigger,
} from '../shared/types.js';
import { computeMemoryRetention, createInitialFsrsState, shouldPruneMemory, strengthenFsrsState } from './fsrs.js';
import { sanitizeMemoryEntry, sanitizeSleepText } from './vault.js';

const MAX_UNPINNED_VAULT_CAPACITY = 450;

export interface ConversationTurnInput {
  turnId: string;
  sessionId: string;
  sessionTitle?: string;
  cwd?: string;
  at: number;
  userText: string;
  assistantText: string;
  toolNames?: string[];
}

export interface NremCandidate {
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string[];
  topicKey?: string;
  supersedes?: boolean;
  confidence: number;
  sourceSessionIds: string[];
  evidenceCount: number;
}

export interface ConsolidationEngineInput {
  turns: readonly ConversationTurnInput[];
  existingMemories: readonly MemoryEntry[] | (() => readonly MemoryEntry[]);
  now: number;
  trigger: SleepConsolidationTrigger;
  signal: AbortSignal;
  homeDir?: string;
  llmExtract?: (prompt: string, signal: AbortSignal) => Promise<string | undefined>;
}

export interface ConsolidationEngineOutput {
  memories: MemoryEntry[];
  record: SleepConsolidationRecord;
}

const PREFERENCE_RE =
  /(?:偏好|习惯|喜欢用|倾向于|统一用|统一使用|优先使用|优先用|默认使用|默认用|请始终|以后都用|不要用|禁止用|严禁使用|\b(?:i\s+prefer|always\s+use|prefer\s+using|never\s+use|do\s+not\s+use|please\s+use)\b)/i;
const DECISION_RE =
  /(?:决定采用|决定使用|最终定稿|架构决策|技术方案定为|约定使用|方案选择|确认采用|敲定|\b(?:we\s+decided|decision:|architectural\s+decision|agreed\s+to\s+use|settled\s+on|chosen\s+approach)\b)/i;
const PITFALL_RE =
  /(?:踩坑|坑点|根因是|报错原因|故障原因|注意避坑|切勿|导致崩溃|修复方案是|排查发现|\b(?:pitfall|gotcha|root\s+cause|bug\s+was\s+caused|workaround:|lesson\s+learned)\b)/i;
const STANCE_REPLACEMENT_RE =
  /(?:改用|换成|不再用|不再使用|取代|替换为|切换为|切到|放弃|废弃|不要再用|\b(?:instead\s+of|switched\s+from|migrated\s+from|replaced\s+with|no\s+longer\s+use|stop\s+using|rather\s+than)\b)/i;
const NEGATION_RE = /(?:不要|禁止|严禁|不用|禁用|避免|\b(?:never|do\s+not|don't|avoid|forbid)\b)/i;

const STOP_TOKENS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'use',
  'using',
  'prefer',
  'always',
  'never',
  'decided',
  '使用',
  '采用',
  '我们',
  '可以',
  '需要',
  '这个',
  '那个',
  '进行',
  '已经',
  '问题',
  '现在',
  '以后',
  '默认',
  '优先',
  '统一',
]);

const KNOWN_TOPIC_FAMILIES: ReadonlyArray<{ topic: string; pattern: RegExp }> = [
  { topic: 'package-manager', pattern: /\b(?:pnpm|npm|yarn|bun)\b/i },
  { topic: 'formatter-linter', pattern: /\b(?:biome|eslint|prettier|oxlint)\b/i },
  { topic: 'test-runner', pattern: /\b(?:vitest|jest|playwright|mocha)\b/i },
  { topic: 'bundler', pattern: /\b(?:esbuild|vite|webpack|rollup|tsdown)\b/i },
  { topic: 'database', pattern: /\b(?:sqlite|postgres|postgresql|mysql|duckdb|jsonl)\b/i },
  {
    topic: 'language-style',
    pattern: /(?:中文回复|英文回复|简体中文|quoteStyle|单引号|双引号|single\s+quote|double\s+quote)/i,
  },
  { topic: 'memory-search', pattern: /\b(?:minisearch|bm25|fsrs|ts-fsrs)\b/i },
];

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const err = new Error('Sleep consolidation aborted');
    err.name = 'AbortError';
    throw err;
  }
}

function significantTokenSet(text: string): Set<string> {
  const raw = tokenizeCjkAndLatin(text);
  const out = new Set<string>();
  for (const tok of raw) {
    if ([...tok].length < 2) continue;
    if (STOP_TOKENS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const item of smaller) {
    if (larger.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function inferTopicKey(kind: MemoryKind, text: string, explicitTopic?: string): string | undefined {
  if (explicitTopic?.trim()) {
    return explicitTopic
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\p{Script=Han}_-]+/gu, '-')
      .replace(/^-+|-+$/g, '');
  }
  for (const fam of KNOWN_TOPIC_FAMILIES) {
    if (fam.pattern.test(text)) {
      return `${kind}:${fam.topic}`;
    }
  }
  return undefined;
}

function extractTagsFromText(text: string, cwd?: string): string[] {
  const tags: string[] = [];
  const techMatches = text.match(
    /\b(?:typescript|javascript|react|vitest|playwright|pnpm|npm|yarn|bun|biome|esbuild|vite|swift|macos|cordis|dsh|minisearch|fsrs|jsonl|markdown|css|axe)\b/gi,
  );
  if (techMatches) {
    for (const m of techMatches) {
      const low = m.toLowerCase();
      if (!tags.includes(low)) tags.push(low);
    }
  }
  if (cwd) {
    const base = cwd.split(/[\\/]/).filter(Boolean).at(-1);
    if (base && base !== '~' && !tags.includes(base.toLowerCase())) {
      tags.push(base.toLowerCase());
    }
  }
  return tags.slice(0, 8);
}

function splitMeaningfulSentences(text: string): string[] {
  return text
    .split(/(?:[\n\r]+|(?<=[。！？!?；;])\s*)/)
    .map((s) => s.trim())
    .filter((s) => [...s].length >= 8);
}

/**
 * Deterministic NREM heuristic extractor: extracts explicit preferences, decisions,
 * pitfalls, and per-session episode summaries even when no LLM call is made.
 */
export function extractDeterministicNremCandidates(
  turns: readonly ConversationTurnInput[],
  homeDir?: string,
): NremCandidate[] {
  const candidates: NremCandidate[] = [];
  const bySession = new Map<string, ConversationTurnInput[]>();

  for (const turn of turns) {
    const safeSession = sanitizeSleepText(turn.sessionId, 64, homeDir);
    const list = bySession.get(safeSession) ?? [];
    list.push(turn);
    bySession.set(safeSession, list);

    const safeUser = sanitizeSleepText(turn.userText, 900, homeDir);
    const safeAssistant = sanitizeSleepText(turn.assistantText, 900, homeDir);
    const sentences = [
      ...splitMeaningfulSentences(safeUser).map((s) => ({ s, fromUser: true })),
      ...splitMeaningfulSentences(safeAssistant).map((s) => ({ s, fromUser: false })),
    ];

    for (const { s, fromUser } of sentences) {
      let matchedKind: MemoryKind | undefined;
      if (PITFALL_RE.test(s)) {
        matchedKind = 'pitfall';
      } else if (DECISION_RE.test(s)) {
        matchedKind = 'decision';
      } else if (PREFERENCE_RE.test(s) && (fromUser || s.length <= 220)) {
        matchedKind = 'preference';
      }
      if (!matchedKind) continue;

      const title = sanitizeSleepText(s.replace(/^[-*•\d.)\s]+/, ''), 96, homeDir);
      const contextDetail =
        matchedKind === 'pitfall' && safeAssistant && !safeAssistant.includes(s)
          ? sanitizeSleepText(`${s}（上下文：${safeAssistant.slice(0, 240)}）`, 600, homeDir)
          : sanitizeSleepText(s, 600, homeDir);
      const topicKey = inferTopicKey(matchedKind, `${title} ${contextDetail}`);
      const supersedes = STANCE_REPLACEMENT_RE.test(s);

      candidates.push({
        kind: matchedKind,
        title,
        content: contextDetail,
        tags: extractTagsFromText(`${title} ${contextDetail}`, turn.cwd),
        ...(topicKey ? { topicKey } : {}),
        ...(supersedes ? { supersedes: true } : {}),
        confidence: fromUser ? 0.88 : 0.8,
        sourceSessionIds: [safeSession],
        evidenceCount: 1,
      });
    }
  }

  // Generate 1 concise `episode` candidate per session that had meaningful work
  for (const [sessionId, sessionTurns] of bySession) {
    if (sessionTurns.length === 0) continue;
    const firstTurn = sessionTurns[0];
    const lastTurn = sessionTurns[sessionTurns.length - 1];
    if (!firstTurn || !lastTurn) continue;
    const firstUser = sanitizeSleepText(firstTurn.userText, 120, homeDir);
    const lastAssistant = sanitizeSleepText(lastTurn.assistantText, 240, homeDir);
    if ([...firstUser].length < 4 && [...lastAssistant].length < 4) continue;

    const headTitle = firstTurn.sessionTitle
      ? sanitizeSleepText(firstTurn.sessionTitle, 64, homeDir)
      : sanitizeSleepText(firstUser, 64, homeDir);
    const title = headTitle ? `会话进展：${headTitle}` : `近期对话进展 (${sessionTurns.length} 轮)`;
    const toolSummary = [
      ...new Set(sessionTurns.flatMap((t) => t.toolNames ?? []).map((n) => sanitizeSleepText(n, 32, homeDir))),
    ].slice(0, 6);
    const contentParts = [
      `共完成 ${sessionTurns.length} 轮对话。`,
      firstUser ? `起因/目标：${firstUser}` : '',
      lastAssistant ? `最新结论：${lastAssistant}` : '',
      toolSummary.length > 0 ? `涉及工具：${toolSummary.join(', ')}` : '',
    ].filter(Boolean);

    candidates.push({
      kind: 'episode',
      title,
      content: sanitizeSleepText(contentParts.join(' '), 700, homeDir),
      tags: extractTagsFromText(`${firstUser} ${lastAssistant}`, firstTurn.cwd),
      topicKey: `episode:session-${sessionId}`,
      confidence: 0.78,
      sourceSessionIds: [sessionId],
      evidenceCount: sessionTurns.length,
    });
  }

  return candidates;
}

function buildLlmConsolidationPrompt(turns: readonly ConversationTurnInput[], homeDir?: string): string {
  const snippets = turns.slice(-24).map((t, idx) => {
    const u = sanitizeSleepText(t.userText, 360, homeDir);
    const a = sanitizeSleepText(t.assistantText, 360, homeDir);
    const sid = sanitizeSleepText(t.sessionId, 40, homeDir);
    return `[Turn ${idx + 1} | session=${sid}]\nUser: ${u}\nAssistant: ${a}`;
  });
  return [
    'You are the ASI NREM/REM sleep memory consolidation extractor.',
    'Extract high-value long-term memories from the sanitized conversation turns below into a JSON array.',
    'Allowed kinds: "preference" (user habits/preferences), "decision" (architectural/product choices), "pitfall" (bugs/root-causes/gotchas), "episode" (concise session milestone).',
    'Return ONLY a valid JSON array of objects: [{"kind":"preference|decision|pitfall|episode","title":"<=80 chars","content":"<=400 chars","tags":["tag1"],"topicKey":"optional-canonical-topic","supersedes":false,"confidence":0.9}].',
    'Never invent facts and never echo secrets.',
    '',
    ...snippets,
  ].join('\n\n');
}

export function parseLlmCandidatesJson(
  rawText: string,
  defaultSessionIds: readonly string[],
  homeDir?: string,
): NremCandidate[] {
  const trimmed = rawText.trim();
  if (!trimmed) return [];
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: NremCandidate[] = [];
  for (const item of parsed.slice(0, 24)) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const kind = rec.kind;
    if (typeof kind !== 'string' || !(MEMORY_KINDS as readonly string[]).includes(kind)) continue;
    const title = typeof rec.title === 'string' ? sanitizeSleepText(rec.title, 110, homeDir) : '';
    const content = typeof rec.content === 'string' ? sanitizeSleepText(rec.content, 800, homeDir) : '';
    if (!title || !content) continue;
    const tags = Array.isArray(rec.tags)
      ? rec.tags
          .filter((t): t is string => typeof t === 'string')
          .map((t) => sanitizeSleepText(t, 36, homeDir).toLowerCase())
          .filter(Boolean)
          .slice(0, 8)
      : [];
    const rawTopic = typeof rec.topicKey === 'string' ? sanitizeSleepText(rec.topicKey, 64, homeDir) : undefined;
    const topicKey = inferTopicKey(kind as MemoryKind, `${title} ${content}`, rawTopic);
    out.push({
      kind: kind as MemoryKind,
      title,
      content,
      tags,
      ...(topicKey ? { topicKey } : {}),
      ...(rec.supersedes === true || STANCE_REPLACEMENT_RE.test(`${title} ${content}`) ? { supersedes: true } : {}),
      confidence:
        typeof rec.confidence === 'number' && Number.isFinite(rec.confidence)
          ? Math.max(0.4, Math.min(1, rec.confidence))
          : 0.85,
      sourceSessionIds: [...defaultSessionIds].slice(0, 8),
      evidenceCount: 1,
    });
  }
  return out;
}

/**
 * NREM Phase: Slow-wave intra-batch clustering to strip redundancy among extracted observations.
 */
export function clusterNremCandidates(candidates: readonly NremCandidate[]): NremCandidate[] {
  const clusters: Array<{ candidate: NremCandidate; tokens: Set<string> }> = [];

  for (const cand of candidates) {
    const candTokens = significantTokenSet(`${cand.title} ${cand.content} ${cand.tags.join(' ')}`);
    let merged = false;
    for (const cluster of clusters) {
      if (cluster.candidate.kind !== cand.kind) continue;
      const sameTopic =
        Boolean(cand.topicKey) &&
        cluster.candidate.topicKey === cand.topicKey &&
        !cand.supersedes &&
        !cluster.candidate.supersedes;
      const sim = jaccardSimilarity(cluster.tokens, candTokens);
      if (sameTopic || sim >= 0.62) {
        const cur = cluster.candidate;
        const nextContent = cand.content.length > cur.content.length ? cand.content : cur.content;
        const nextTitle = cand.confidence > cur.confidence ? cand.title : cur.title;
        cluster.candidate = {
          ...cur,
          title: nextTitle,
          content: nextContent,
          tags: [...new Set([...cur.tags, ...cand.tags])].slice(0, 10),
          ...(cand.supersedes || cur.supersedes ? { supersedes: true } : {}),
          confidence: Math.max(cur.confidence, cand.confidence),
          sourceSessionIds: [...new Set([...cur.sourceSessionIds, ...cand.sourceSessionIds])].slice(0, 16),
          evidenceCount: cur.evidenceCount + cand.evidenceCount,
        };
        for (const t of candTokens) cluster.tokens.add(t);
        merged = true;
        break;
      }
    }
    if (!merged) {
      clusters.push({ candidate: { ...cand }, tokens: candTokens });
    }
  }

  return clusters.map((c) => c.candidate);
}

function isConflictingStance(existing: MemoryEntry, candidate: NremCandidate): boolean {
  if (existing.kind !== 'preference' && existing.kind !== 'decision') return false;
  if (candidate.kind !== existing.kind) return false;

  const sameTopic = Boolean(existing.topicKey && candidate.topicKey && existing.topicKey === candidate.topicKey);
  const existingText = `${existing.title} ${existing.content}`;
  const candidateText = `${candidate.title} ${candidate.content}`;

  if (sameTopic) {
    if (candidate.supersedes || STANCE_REPLACEMENT_RE.test(candidateText)) return true;

    const toolChoices = [
      'pnpm',
      'npm',
      'yarn',
      'bun',
      'biome',
      'eslint',
      'prettier',
      'vitest',
      'jest',
      'esbuild',
      'webpack',
      'rollup',
      'vite',
    ];
    const isNegatedTool = (txt: string, tool: string) =>
      new RegExp(
        `(?:不要|禁止|严禁|不用|禁用|避免|never|do\\s+not|don't|avoid)[^，。,.;；]{0,16}\\b${tool}\\b`,
        'i',
      ).test(txt);
    const oldPosTools = toolChoices.filter(
      (t) => new RegExp(`\\b${t}\\b`, 'i').test(existingText) && !isNegatedTool(existingText, t),
    );
    const newPosTools = toolChoices.filter(
      (t) => new RegExp(`\\b${t}\\b`, 'i').test(candidateText) && !isNegatedTool(candidateText, t),
    );
    if (oldPosTools.length === 1 && newPosTools.length === 1) {
      return oldPosTools[0] !== newPosTools[0];
    }
    for (const tool of oldPosTools) {
      if (isNegatedTool(candidateText, tool)) return true;
    }
    for (const tool of newPosTools) {
      if (isNegatedTool(existingText, tool)) return true;
    }

    const oldPrimaryClause = existing.title.split(/[，,；;。]/)[0] ?? existing.title;
    const newPrimaryClause = candidate.title.split(/[，,；;。]/)[0] ?? candidate.title;
    if (oldPosTools.length === 0 && newPosTools.length === 0) {
      const oldNeg = NEGATION_RE.test(oldPrimaryClause);
      const newNeg = NEGATION_RE.test(newPrimaryClause);
      if (oldNeg !== newNeg) return true;
    }
  }

  const sim = jaccardSimilarity(significantTokenSet(existingText), significantTokenSet(candidateText));
  if (sim >= 0.45 && (candidate.supersedes || STANCE_REPLACEMENT_RE.test(candidateText))) {
    return true;
  }
  return false;
}

/**
 * REM Phase: Cross-session associative linking across consolidated memories.
 */
function buildAssociativeLinks(entries: MemoryEntry[]): number {
  const tokenMap = new Map<string, Set<string>>();
  for (const e of entries) {
    tokenMap.set(e.id, significantTokenSet(`${e.title} ${e.tags.join(' ')} ${e.topicKey ?? ''} ${e.content}`));
  }

  let updatedCount = 0;
  for (const entry of entries) {
    const aTokens = tokenMap.get(entry.id) ?? new Set<string>();
    const scored: Array<{ id: string; weight: number }> = [];

    for (const peer of entries) {
      if (peer.id === entry.id) continue;
      const bTokens = tokenMap.get(peer.id) ?? new Set<string>();
      const lexSim = jaccardSimilarity(aTokens, bTokens);
      const sharedTags = entry.tags.filter((t) => peer.tags.includes(t)).length;
      const crossSession =
        entry.sourceSessionIds.length > 0 &&
        peer.sourceSessionIds.length > 0 &&
        peer.sourceSessionIds.some((s) => !entry.sourceSessionIds.includes(s));
      const weight = lexSim + sharedTags * 0.14 + (crossSession && (lexSim >= 0.18 || sharedTags > 0) ? 0.08 : 0);
      if (weight >= 0.24) {
        scored.push({ id: peer.id, weight });
      }
    }

    scored.sort((x, y) => y.weight - x.weight || x.id.localeCompare(y.id));
    const nextLinks = scored.slice(0, 3).map((s) => s.id);
    const prevLinks = entry.links ?? [];
    if (nextLinks.join(',') !== prevLinks.join(',')) {
      updatedCount += 1;
      if (nextLinks.length > 0) {
        entry.links = nextLinks;
      } else {
        delete entry.links;
      }
    }
  }
  return updatedCount;
}

export async function runTwoPhaseSleepConsolidation(
  input: ConsolidationEngineInput,
): Promise<ConsolidationEngineOutput> {
  const startedAt = Date.now();
  const { turns, existingMemories, now, trigger, signal, homeDir, llmExtract } = input;
  throwIfAborted(signal);

  const sessionIds = [...new Set(turns.map((t) => sanitizeSleepText(t.sessionId, 64, homeDir)).filter(Boolean))];

  // Phase 1: NREM extraction + intra-batch clustering
  let rawCandidates: NremCandidate[] = [];
  if (turns.length > 0) {
    const deterministic = extractDeterministicNremCandidates(turns, homeDir);
    let llmCandidates: NremCandidate[] = [];
    if (llmExtract) {
      try {
        const prompt = buildLlmConsolidationPrompt(turns, homeDir);
        const rawLlm = await llmExtract(prompt, signal);
        throwIfAborted(signal);
        if (rawLlm) {
          llmCandidates = parseLlmCandidatesJson(rawLlm, sessionIds, homeDir);
        }
      } catch (err) {
        if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
          throw err;
        }
        // Gracefully fall back to deterministic NREM extraction if LLM is offline/unavailable
      }
    }
    rawCandidates = [...llmCandidates, ...deterministic];
  }

  const nremClustered = clusterNremCandidates(rawCandidates);
  throwIfAborted(signal);

  // Phase 2: REM cross-session deduplication, conflict resolution, associative linking & FSRS pruning
  const snapshotExisting = typeof existingMemories === 'function' ? existingMemories() : existingMemories;
  const working: MemoryEntry[] = snapshotExisting.map((e) => sanitizeMemoryEntry(structuredClone(e), homeDir));
  let createdCount = 0;
  let mergedCount = 0;
  let conflictsResolved = 0;

  for (const cand of nremClustered) {
    throwIfAborted(signal);
    const candTokens = significantTokenSet(`${cand.title} ${cand.content} ${cand.tags.join(' ')}`);

    // 2a. Check belief/preference conflict against existing entries first
    const conflictIdx = working.findIndex((existing) => isConflictingStance(existing, cand));
    if (conflictIdx >= 0) {
      const superseded = working[conflictIdx];
      if (superseded && !superseded.pinned) {
        working.splice(conflictIdx, 1);
        conflictsResolved += 1;
        const replacement = sanitizeMemoryEntry(
          {
            id: `mem_${randomUUID().slice(0, 12)}`,
            kind: cand.kind,
            title: cand.title,
            content: cand.content,
            tags: [...new Set([...superseded.tags, ...cand.tags])].slice(0, 10),
            ...((cand.topicKey ?? superseded.topicKey) ? { topicKey: cand.topicKey ?? superseded.topicKey } : {}),
            pinned: false,
            confidence: cand.confidence,
            sourceSessionIds: [...new Set([...superseded.sourceSessionIds, ...cand.sourceSessionIds])],
            evidenceCount: cand.evidenceCount,
            recallCount: 0,
            createdAt: now,
            updatedAt: now,
            fsrs: createInitialFsrsState(cand.kind, now),
          },
          homeDir,
        );
        working.push(replacement);
        createdCount += 1;
        continue;
      }
    }

    // 2b. Check cross-session deduplication / reinforcement
    let bestIdx = -1;
    let bestSim = 0;
    for (let i = 0; i < working.length; i += 1) {
      const existing = working[i];
      if (!existing || existing.kind !== cand.kind) continue;
      if (cand.topicKey && existing.topicKey === cand.topicKey) {
        bestIdx = i;
        bestSim = 1;
        break;
      }
      const exTokens = significantTokenSet(`${existing.title} ${existing.content} ${existing.tags.join(' ')}`);
      const sim = jaccardSimilarity(exTokens, candTokens);
      if (sim >= 0.58 && sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      const existing = working[bestIdx];
      if (existing) {
        const richerContent =
          cand.kind === 'episode' || cand.content.length > existing.content.length ? cand.content : existing.content;
        working[bestIdx] = sanitizeMemoryEntry(
          {
            ...existing,
            title: cand.kind === 'episode' ? cand.title : existing.title,
            content: richerContent,
            tags: [...new Set([...existing.tags, ...cand.tags])].slice(0, 10),
            confidence: Math.max(existing.confidence, cand.confidence),
            sourceSessionIds: [...new Set([...existing.sourceSessionIds, ...cand.sourceSessionIds])],
            evidenceCount: existing.evidenceCount + cand.evidenceCount,
            updatedAt: now,
            fsrs: existing.pinned ? existing.fsrs : strengthenFsrsState(existing.fsrs, now, 'consolidate'),
          },
          homeDir,
        );
        mergedCount += 1;
        continue;
      }
    }

    // 2c. Novel memory creation
    working.push(
      sanitizeMemoryEntry(
        {
          id: `mem_${randomUUID().slice(0, 12)}`,
          kind: cand.kind,
          title: cand.title,
          content: cand.content,
          tags: cand.tags,
          ...(cand.topicKey ? { topicKey: cand.topicKey } : {}),
          pinned: false,
          confidence: cand.confidence,
          sourceSessionIds: cand.sourceSessionIds,
          evidenceCount: cand.evidenceCount,
          recallCount: 0,
          createdAt: now,
          updatedAt: now,
          fsrs: createInitialFsrsState(cand.kind, now),
        },
        homeDir,
      ),
    );
    createdCount += 1;
  }

  // 2d. Synaptic pruning via FSRS forgetting curve (pinned items are immune)
  let prunedCount = 0;
  const retained: MemoryEntry[] = [];
  for (const item of working) {
    if (shouldPruneMemory(item.fsrs, item.kind, item.pinned, now)) {
      prunedCount += 1;
    } else {
      retained.push(item);
    }
  }

  // Enforce bounded unpinned vault size so memory never grows unboundedly
  const unpinned = retained.filter((item) => !item.pinned);
  if (unpinned.length > MAX_UNPINNED_VAULT_CAPACITY) {
    unpinned.sort(
      (a, b) =>
        computeMemoryRetention(a.fsrs, false, now) - computeMemoryRetention(b.fsrs, false, now) ||
        a.updatedAt - b.updatedAt,
    );
    const dropIds = new Set(unpinned.slice(0, unpinned.length - MAX_UNPINNED_VAULT_CAPACITY).map((u) => u.id));
    for (let i = retained.length - 1; i >= 0; i -= 1) {
      const entry = retained[i];
      if (entry && dropIds.has(entry.id)) {
        retained.splice(i, 1);
        prunedCount += 1;
      }
    }
  }

  // Purge dangling links and recompute REM associative links
  const activeIds = new Set(retained.map((r) => r.id));
  for (const item of retained) {
    if (item.links) {
      item.links = item.links.filter((id) => activeIds.has(id));
      if (item.links.length === 0) delete item.links;
    }
  }
  const linksUpdated = buildAssociativeLinks(retained);
  const finalMemories = retained.map((item) => sanitizeMemoryEntry(item, homeDir));

  const durationMs = Math.max(1, Date.now() - startedAt);
  const summary =
    turns.length === 0 && createdCount === 0 && mergedCount === 0 && prunedCount === 0
      ? '睡眠巡检完成：当前无新对话轮次，记忆库保持稳态'
      : `整合 ${turns.length} 轮对话 · NREM 聚类 ${nremClustered.length} 项 · 新增 ${createdCount} / 强化 ${mergedCount} / 消解冲突 ${conflictsResolved} / 遗忘修剪 ${prunedCount}`;

  return {
    memories: finalMemories,
    record: {
      id: `sleep_${randomUUID().slice(0, 10)}`,
      at: now,
      trigger,
      turnsProcessed: turns.length,
      nremCandidates: nremClustered.length,
      createdCount,
      mergedCount,
      conflictsResolved,
      prunedCount,
      linksUpdated,
      durationMs,
      summary: sanitizeSleepText(summary, 240, homeDir),
    },
  };
}
