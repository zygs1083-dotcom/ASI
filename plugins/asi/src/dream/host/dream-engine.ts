/**
 * Default Mode Network (DMN) Cross-Repo Bridge Sampler & Insight Synthesizer (`asi-dream`).
 *
 * Biomimetic Cognitive Architecture:
 * - Unlike L2 Sleep Consolidation (which compresses turns and deduplicates high-overlap
 *   memories) or L4 Growth (which requires >=3 memories on the exact same topic),
 *   the Default Mode Network wakes during deep cognitive rest to sample *distant
 *   cross-repository structural analogies*:
 *     1. `preventive-warning`: Repo A hit a pitfall (`pitfall`) on a shared mechanism/stack
 *        that Repo B actively uses or struggles with, before Repo B repeats the mistake.
 *     2. `structural-analogy`: Repo A validated an architectural `decision` that maps
 *        isomorphically onto an active problem or episode in Repo B.
 *     3. `pattern-unification`: >=2 independent repos converged on homologous solutions
 *        or pitfalls, revealing a cross-repo reusable engineering pattern.
 *     4. `decision-tension`: >=2 repos hold divergent global conventions on the same
 *        tooling/architectural family without workspace scope isolation.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { SleepMemorySummary } from '@asi/sense-types';
import { tokenizeCjkAndLatin } from '../../sleep/shared/search.js';
import {
  DREAM_INSIGHT_KINDS,
  type DreamCycleRecord,
  type DreamCycleTrigger,
  type DreamInsightEntry,
  type DreamInsightKind,
} from '../shared/types.js';
import type { DreamTurnTrajectoryInput } from './ports.js';
import {
  extractMechanismSignals,
  mechanismLabelOf,
  type RepoStructuralProfile,
  sanitizeDreamText,
} from './repo-profiler.js';

const MAX_BRIDGES_PER_CYCLE = 3;

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'when',
  'use',
  'using',
  'used',
  'prefer',
  'always',
  'never',
  'should',
  'must',
  'project',
  'repo',
  'workspace',
  '使用',
  '采用',
  '项目',
  '仓库',
  '工作区',
  '我们',
  '需要',
  '可以',
  '已经',
  '问题',
  '方案',
  '默认',
  '统一',
  '优先',
]);

const CONVENTION_FAMILIES: ReadonlyArray<{
  family: string;
  label: string;
  tools: readonly string[];
  re: RegExp;
}> = [
  {
    family: 'package-manager',
    label: '包管理器规范',
    tools: ['pnpm', 'npm', 'yarn', 'bun'],
    re: /\b(?:pnpm|npm|yarn|bun)\b/i,
  },
  {
    family: 'formatter-linter',
    label: '代码检查与格式化工具',
    tools: ['biome', 'eslint', 'prettier', 'oxlint'],
    re: /\b(?:biome|eslint|prettier|oxlint)\b/i,
  },
  {
    family: 'test-runner',
    label: '测试运行器选型',
    tools: ['vitest', 'jest', 'playwright', 'mocha', 'pytest'],
    re: /\b(?:vitest|jest|playwright|mocha|pytest)\b/i,
  },
  {
    family: 'bundler-build',
    label: '构建打包器选型',
    tools: ['esbuild', 'vite', 'webpack', 'rollup', 'tsdown'],
    re: /\b(?:esbuild|vite|webpack|rollup|tsdown)\b/i,
  },
  {
    family: 'storage-engine',
    label: '本地持久化存储模型',
    tools: ['sqlite', 'postgres', 'mysql', 'duckdb', 'jsonl'],
    re: /\b(?:sqlite|postgres|mysql|duckdb|jsonl)\b/i,
  },
];

const NEGATION_RE =
  /(?:不要|禁止|严禁|不用|禁用|弃用|放弃|改用|\b(?:never|do\s+not|don't|avoid|forbid|stop\s+using)\b)/i;
const TROUBLESHOOT_HINT_RE =
  /(?:报错|失败|异常|死锁|超时|崩溃|泄漏|冲突|排查|修复|\b(?:error|failed|bug|deadlock|timeout|leak|crash|fix|workaround)\b)/i;

export interface RepoBoundMemory {
  memory: SleepMemorySummary;
  repoKeys: string[];
  tokens: Set<string>;
  mechanisms: string[];
  stackTags: string[];
  conventionFamily?: string;
  positiveTools: string[];
}

export interface RepoStruggleSummary {
  repoKey: string;
  sessionIds: string[];
  mechanisms: string[];
  tokens: Set<string>;
  sampleSnippet: string;
  turnCount: number;
}

export interface CandidateDreamBridge {
  pairSignature: string;
  evidenceFingerprint: string;
  kind: DreamInsightKind;
  topicKey: string;
  repoKeys: string[];
  sourceRepos: string[];
  targetRepo?: string;
  sourceMemoryIds: string[];
  sourceSessionIds: string[];
  tags: string[];
  mechanisms: string[];
  sharedStacks: string[];
  noveltyScore: number;
  structuralSimilarity: number;
  confidence: number;
  salience: number;
  deterministicTitle: string;
  deterministicSummary: string;
  deterministicMechanism: string;
  deterministicHypothesis: string;
}

export interface DreamDiscoverySnapshot {
  repoProfiles: RepoStructuralProfile[];
  candidateBridges: CandidateDreamBridge[];
}

export interface RunDreamCycleInput {
  now: number;
  trigger: DreamCycleTrigger;
  signal: AbortSignal;
  homeDir?: string;
  repoProfiles: readonly RepoStructuralProfile[];
  cwdToRepoKey: ReadonlyMap<string, string>;
  sessionWorkspaces: ReadonlyMap<string, string>;
  memories: readonly SleepMemorySummary[];
  turns: readonly DreamTurnTrajectoryInput[];
  existingInsights: readonly DreamInsightEntry[];
  dreamedPairSignatures: Readonly<Record<string, string>>;
  dismissedPairPenalties: Readonly<Record<string, number>>;
  llmDream?: (prompt: string, signal: AbortSignal) => Promise<string | undefined>;
}

export interface RunDreamCycleOutput {
  insights: DreamInsightEntry[];
  record: DreamCycleRecord;
  updatedDreamedSignatures: Record<string, string>;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const err = new Error('DMN dream cycle aborted');
    err.name = 'AbortError';
    throw err;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function significantTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of tokenizeCjkAndLatin(text)) {
    if (tok.length >= 2 && !STOP_WORDS.has(tok)) {
      out.add(tok);
    }
  }
  return out;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter += 1;
  }
  if (inter === 0) return 0;
  return inter / (a.size + b.size - inter);
}

/**
 * DMN Goldilocks Novelty Curve:
 * Peaks around `lexSim ~ 0.22` (distant conceptual bridge, not verbatim copy-paste),
 * while tapering down if `lexSim > 0.65` (near-duplicate) or `lexSim === 0`.
 */
function computeDmnNovelty(lexSim: number, crossKindBonus = 0): number {
  let base: number;
  if (lexSim <= 0.03) {
    base = 0.58;
  } else if (lexSim <= 0.28) {
    base = 0.72 + ((lexSim - 0.03) / 0.25) * 0.22;
  } else if (lexSim <= 0.58) {
    base = 0.94 - ((lexSim - 0.28) / 0.3) * 0.28;
  } else {
    base = Math.max(0.25, 0.66 - (lexSim - 0.58) * 0.9);
  }
  return clamp01(base + crossKindBonus);
}

function detectConventionStance(text: string): { family?: string; label?: string; positiveTools: string[] } {
  for (const fam of CONVENTION_FAMILIES) {
    if (!fam.re.test(text)) continue;
    const positive: string[] = [];
    for (const tool of fam.tools) {
      const toolRe = new RegExp(`\\b${tool}\\b`, 'i');
      const m = toolRe.exec(text);
      if (!m) continue;
      const prefix = text.slice(Math.max(0, m.index - 22), m.index);
      if (!NEGATION_RE.test(prefix)) {
        positive.push(tool);
      }
    }
    return { family: fam.family, label: fam.label, positiveTools: positive };
  }
  return { positiveTools: [] };
}

function detectStackMentions(text: string, knownStacks: ReadonlySet<string>): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const tag of knownStacks) {
    const base = tag.split('-')[0] ?? tag;
    if (base.length >= 2 && lower.includes(base.toLowerCase())) {
      hits.push(tag);
    }
  }
  return [...new Set(hits)];
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

function bindMemoriesToRepos(
  memories: readonly SleepMemorySummary[],
  profilesByKey: ReadonlyMap<string, RepoStructuralProfile>,
  cwdToRepoKey: ReadonlyMap<string, string>,
  sessionWorkspaces: ReadonlyMap<string, string>,
): RepoBoundMemory[] {
  const allStackTags = new Set<string>();
  for (const p of profilesByKey.values()) {
    for (const st of p.stackTags) allStackTags.add(st);
  }
  for (const extra of [
    'sqlite',
    'postgres',
    'typescript',
    'react',
    'vitest',
    'playwright',
    'esbuild',
    'pnpm-monorepo',
  ]) {
    allStackTags.add(extra);
  }

  const profilesList = [...profilesByKey.values()];
  const bound: RepoBoundMemory[] = [];

  for (const mem of memories) {
    if (mem.retention < 0.3 && !mem.pinned) continue;
    const matchedRepos = new Set<string>();

    for (const sid of mem.sourceSessionIds) {
      const cwd = sessionWorkspaces.get(sid);
      if (!cwd) continue;
      const rk = cwdToRepoKey.get(cwd);
      if (rk && profilesByKey.has(rk)) {
        matchedRepos.add(rk);
      }
    }

    if (matchedRepos.size === 0 && profilesList.length > 0) {
      const textLower = `${mem.title} ${mem.tags.join(' ')} ${mem.topicKey ?? ''}`.toLowerCase();
      const nameHits = profilesList.filter(
        (p) =>
          p.repoName.length >= 3 &&
          (mem.tags.some((t) => t.toLowerCase() === p.repoName.toLowerCase()) ||
            new RegExp(`(?:^|[^a-z0-9])${p.repoName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`, 'i').test(
              textLower,
            )),
      );
      if (nameHits.length === 1 && nameHits[0]) {
        matchedRepos.add(nameHits[0].repoKey);
      }
    }

    if (matchedRepos.size === 0) continue;

    const corpus = `${mem.title} ${mem.content} ${mem.tags.join(' ')} ${mem.topicKey ?? ''}`;
    const stance = detectConventionStance(corpus);
    bound.push({
      memory: mem,
      repoKeys: [...matchedRepos].sort(),
      tokens: significantTokens(corpus),
      mechanisms: extractMechanismSignals(corpus),
      stackTags: detectStackMentions(corpus, allStackTags),
      ...(stance.family ? { conventionFamily: stance.family } : {}),
      positiveTools: stance.positiveTools,
    });
  }

  return bound;
}

function summarizeRepoStruggles(
  turns: readonly DreamTurnTrajectoryInput[],
  profilesByKey: ReadonlyMap<string, RepoStructuralProfile>,
  cwdToRepoKey: ReadonlyMap<string, string>,
  sessionWorkspaces: ReadonlyMap<string, string>,
  homeDir?: string,
): Map<string, RepoStruggleSummary> {
  const byRepo = new Map<
    string,
    {
      sessionIds: Set<string>;
      mechanisms: Set<string>;
      tokens: Set<string>;
      snippets: string[];
      turnCount: number;
    }
  >();

  for (const t of turns) {
    const rawCwd = t.cwd ?? sessionWorkspaces.get(t.sessionId);
    if (!rawCwd) continue;
    const rk = cwdToRepoKey.get(rawCwd);
    if (!rk || !profilesByKey.has(rk)) continue;

    const combined = `${t.userText}\n${t.assistantText}`;
    const mechs = extractMechanismSignals(combined);
    const isStruggle = t.failedToolCount > 0 || TROUBLESHOOT_HINT_RE.test(combined) || mechs.length > 0;
    if (!isStruggle) continue;

    let bucket = byRepo.get(rk);
    if (!bucket) {
      bucket = {
        sessionIds: new Set<string>(),
        mechanisms: new Set<string>(),
        tokens: new Set<string>(),
        snippets: [],
        turnCount: 0,
      };
      byRepo.set(rk, bucket);
    }
    bucket.turnCount += 1;
    bucket.sessionIds.add(t.sessionId);
    for (const m of mechs) bucket.mechanisms.add(m);
    for (const tok of significantTokens(combined)) {
      if (bucket.tokens.size < 120) bucket.tokens.add(tok);
    }
    if (bucket.snippets.length < 3) {
      bucket.snippets.push(sanitizeDreamText(t.userText, 96, homeDir));
    }
  }

  const out = new Map<string, RepoStruggleSummary>();
  for (const [rk, b] of byRepo) {
    out.set(rk, {
      repoKey: rk,
      sessionIds: [...b.sessionIds],
      mechanisms: [...b.mechanisms].sort(),
      tokens: b.tokens,
      sampleSnippet: b.snippets[0] ?? '',
      turnCount: b.turnCount,
    });
  }
  return out;
}

/**
 * Deterministically discover & rank cross-repository DMN candidate bridges.
 */
export function discoverCandidateCrossRepoBridges(input: {
  repoProfiles: readonly RepoStructuralProfile[];
  cwdToRepoKey: ReadonlyMap<string, string>;
  sessionWorkspaces: ReadonlyMap<string, string>;
  memories: readonly SleepMemorySummary[];
  turns: readonly DreamTurnTrajectoryInput[];
  dreamedPairSignatures?: Readonly<Record<string, string>>;
  dismissedPairPenalties?: Readonly<Record<string, number>>;
  homeDir?: string;
}): CandidateDreamBridge[] {
  const profilesByKey = new Map<string, RepoStructuralProfile>();
  for (const p of input.repoProfiles) {
    profilesByKey.set(p.repoKey, p);
  }
  if (profilesByKey.size < 2) return [];

  const boundMemories = bindMemoriesToRepos(input.memories, profilesByKey, input.cwdToRepoKey, input.sessionWorkspaces);
  const strugglesByRepo = summarizeRepoStruggles(
    input.turns,
    profilesByKey,
    input.cwdToRepoKey,
    input.sessionWorkspaces,
    input.homeDir,
  );

  const dreamedSigs = input.dreamedPairSignatures ?? {};
  const dismissedPenalties = input.dismissedPairPenalties ?? {};
  const candidatesBySig = new Map<string, CandidateDreamBridge>();

  const registerCandidate = (cand: CandidateDreamBridge) => {
    const penaltyCount = dismissedPenalties[cand.pairSignature] ?? 0;
    if (penaltyCount >= 2) return;
    if (penaltyCount === 1) {
      cand.confidence = clamp01(cand.confidence - 0.18);
      cand.salience = clamp01(cand.salience - 0.2);
      if (cand.confidence < 0.55) return;
    }
    const prevFp = dreamedSigs[cand.pairSignature];
    if (prevFp && prevFp === cand.evidenceFingerprint) return;

    const existing = candidatesBySig.get(cand.pairSignature);
    if (!existing || cand.salience > existing.salience) {
      candidatesBySig.set(cand.pairSignature, cand);
    }
  };

  // 1. Cross-Repo Memory <-> Memory Bridges (`decision-tension`, `pattern-unification`, `structural-analogy`, `preventive-warning`)
  for (let i = 0; i < boundMemories.length; i += 1) {
    const a = boundMemories[i];
    if (!a) continue;
    for (let j = i + 1; j < boundMemories.length; j += 1) {
      const b = boundMemories[j];
      if (!b) continue;

      const repoAKey = a.repoKeys[0];
      const repoBKey = b.repoKeys.find((rk) => !a.repoKeys.includes(rk));
      if (!repoAKey || !repoBKey || repoAKey === repoBKey) continue;
      if (b.repoKeys.some((rk) => a.repoKeys.includes(rk))) continue;

      const profA = profilesByKey.get(repoAKey);
      const profB = profilesByKey.get(repoBKey);
      if (!profA || !profB) continue;

      const sortedRepoKeys = [repoAKey, repoBKey].sort();
      const sourceRepos = sortedRepoKeys.map((rk) => profilesByKey.get(rk)?.displayPath ?? rk);
      const lexSim = jaccard(a.tokens, b.tokens);
      const sharedMechanisms = a.mechanisms.filter((m) => b.mechanisms.includes(m));
      const sharedStacks = profA.stackTags.filter((st) => profB.stackTags.includes(st));
      const sharedMemStacks = a.stackTags.filter((st) => b.stackTags.includes(st) || profB.stackTags.includes(st));

      // 1A. Convention / Tooling Divergence (`decision-tension`)
      if (
        a.conventionFamily &&
        a.conventionFamily === b.conventionFamily &&
        a.positiveTools.length > 0 &&
        b.positiveTools.length > 0 &&
        !a.positiveTools.some((t) => b.positiveTools.includes(t)) &&
        (a.memory.kind === 'preference' || a.memory.kind === 'decision') &&
        (b.memory.kind === 'preference' || b.memory.kind === 'decision')
      ) {
        const famLabel = CONVENTION_FAMILIES.find((f) => f.family === a.conventionFamily)?.label ?? a.conventionFamily;
        const topicKey = `tension:${a.conventionFamily}`;
        const pairSignature = `${sortedRepoKeys.join('|')}::decision-tension::${topicKey}`;
        const evidenceFingerprint = shortHash(
          `${a.memory.id}:${a.memory.updatedAt}|${b.memory.id}:${b.memory.updatedAt}`,
        );
        const structSim = clamp01(0.68 + Math.min(0.24, sharedStacks.length * 0.06));
        const novelty = computeDmnNovelty(lexSim, 0.08);
        const confidence = clamp01(
          0.66 + (a.memory.retention + b.memory.retention) * 0.12 + (a.memory.pinned || b.memory.pinned ? 0.06 : 0),
        );
        const salience = clamp01(confidence * 0.52 + novelty * 0.26 + structSim * 0.22);

        registerCandidate({
          pairSignature,
          evidenceFingerprint,
          kind: 'decision-tension',
          topicKey,
          repoKeys: sortedRepoKeys,
          sourceRepos,
          sourceMemoryIds: [a.memory.id, b.memory.id],
          sourceSessionIds: [...new Set([...a.memory.sourceSessionIds, ...b.memory.sourceSessionIds])],
          tags: [...new Set([a.conventionFamily, ...a.positiveTools, ...b.positiveTools, 'cross-repo'])].slice(0, 8),
          mechanisms: sharedMechanisms,
          sharedStacks,
          noveltyScore: novelty,
          structuralSimilarity: structSim,
          confidence,
          salience,
          deterministicTitle: `${profA.repoName} 与 ${profB.repoName} 在「${famLabel}」存在跨仓规范分叉`,
          deterministicSummary: `${profA.displayPath} 倾向采用 ${a.positiveTools.join('/')}（${a.memory.title}），而 ${profB.displayPath} 采用 ${b.positiveTools.join('/')}（${b.memory.title}）。`,
          deterministicMechanism: `两套独立项目围绕同一工程维度（${famLabel}）沉淀了互斥的全局偏好/决策记忆，若不隔离工作区作用域易引发跨项目召回串味。`,
          deterministicHypothesis: `建议将各自工具链约定明确标注适用仓库边界，或提取为绑定对应工作区作用域（workspace）的专属技能。`,
        });
        continue;
      }

      // 1B. Shared Mechanism / Structural Analogy or Pattern Unification
      const hasMechanismBridge = sharedMechanisms.length > 0;
      const hasTopicBridge =
        Boolean(a.memory.topicKey && a.memory.topicKey === b.memory.topicKey) ||
        (lexSim >= 0.16 && (sharedStacks.length > 0 || sharedMemStacks.length > 0));

      if (!hasMechanismBridge && !hasTopicBridge) continue;
      if (lexSim < 0.06 && sharedMechanisms.length === 0) continue;

      const mechKey =
        sharedMechanisms[0] ??
        a.memory.topicKey ??
        b.memory.topicKey ??
        ([...a.tokens].find((t) => b.tokens.has(t)) || 'architecture');
      const mechReadable = sharedMechanisms[0] ? mechanismLabelOf(sharedMechanisms[0]) : mechKey;

      const aIsLesson = a.memory.kind === 'pitfall' || a.memory.kind === 'decision';
      const bIsLesson = b.memory.kind === 'pitfall' || b.memory.kind === 'decision';
      const aIsEpisode = a.memory.kind === 'episode';
      const bIsEpisode = b.memory.kind === 'episode';
      if (aIsEpisode && bIsEpisode && (sharedMechanisms.length === 0 || lexSim < 0.22)) {
        continue;
      }

      let kind: DreamInsightKind;
      let targetRepo: string | undefined;
      let title: string;
      let summary: string;
      let hypothesis: string;

      if ((a.memory.kind === 'pitfall' && bIsEpisode) || (b.memory.kind === 'pitfall' && aIsEpisode)) {
        kind = 'preventive-warning';
        const donor = a.memory.kind === 'pitfall' ? { m: a, prof: profA } : { m: b, prof: profB };
        const receiver = a.memory.kind === 'pitfall' ? { m: b, prof: profB } : { m: a, prof: profA };
        targetRepo = receiver.prof.displayPath;
        title = `前车之鉴：将 ${donor.prof.repoName} 的「${mechReadable}」避坑经验预警至 ${receiver.prof.repoName}`;
        summary = `${donor.prof.displayPath} 曾记录踩坑「${donor.m.memory.title}」，而 ${receiver.prof.displayPath} 近期进展「${receiver.m.memory.title}」触及相同底层机制。`;
        hypothesis = `在推进 ${receiver.prof.repoName} 相关改动时，优先复用 ${donor.prof.repoName} 的防护检查点：${sanitizeDreamText(donor.m.memory.content, 120, input.homeDir)}`;
      } else if ((aIsLesson && bIsEpisode) || (bIsLesson && aIsEpisode)) {
        kind = 'structural-analogy';
        const donor = aIsLesson ? { m: a, prof: profA } : { m: b, prof: profB };
        const receiver = aIsLesson ? { m: b, prof: profB } : { m: a, prof: profA };
        targetRepo = receiver.prof.displayPath;
        title = `同构迁移：${donor.prof.repoName} 的「${mechReadable}」架构决策可迁移至 ${receiver.prof.repoName}`;
        summary = `${donor.prof.displayPath} 已验证方案「${donor.m.memory.title}」，与 ${receiver.prof.displayPath} 的「${receiver.m.memory.title}」存在结构同构。`;
        hypothesis = `可将 ${donor.prof.repoName} 的成熟范式平滑移植至 ${receiver.prof.repoName}，避免重复试错：${sanitizeDreamText(donor.m.memory.content, 120, input.homeDir)}`;
      } else {
        kind = 'pattern-unification';
        title = `跨仓范式收敛：${profA.repoName} 与 ${profB.repoName} 共现「${mechReadable}」工程规律`;
        summary = `${profA.displayPath}（「${a.memory.title}」）与 ${profB.displayPath}（「${b.memory.title}」）独立演化出高度同构的经验模式。`;
        hypothesis = `建议将该跨项目共性经验提炼为全局可复用的标准检查清单或 L4 技能草案（SKILL.md），统一守护所有同类仓库。`;
      }

      const structSim = clamp01(
        0.48 +
          Math.min(0.28, sharedMechanisms.length * 0.16) +
          Math.min(0.16, sharedStacks.length * 0.05) +
          Math.min(0.12, lexSim * 0.3),
      );
      const novelty = computeDmnNovelty(lexSim, a.memory.kind !== b.memory.kind ? 0.06 : 0.02);
      const lessonBonus = (aIsLesson ? 0.05 : 0) + (bIsLesson ? 0.05 : 0) - (aIsEpisode && bIsEpisode ? 0.08 : 0);
      const confidence = clamp01(
        0.58 +
          lessonBonus +
          ((a.memory.retention + b.memory.retention) / 2) * 0.18 +
          Math.min(0.14, sharedMechanisms.length * 0.08) +
          Math.min(0.08, sharedStacks.length * 0.03),
      );
      if (confidence < 0.62) continue;

      const topicKey = `dmn:${mechKey}`
        .toLowerCase()
        .replace(/[^a-z0-9:_-]+/g, '-')
        .slice(0, 64);
      const pairSignature = `${sortedRepoKeys.join('|')}::${kind}::${topicKey}`;
      const evidenceFingerprint = shortHash(
        `${a.memory.id}:${a.memory.updatedAt}|${b.memory.id}:${b.memory.updatedAt}`,
      );
      const salience = clamp01(confidence * 0.54 + novelty * 0.24 + structSim * 0.22);

      registerCandidate({
        pairSignature,
        evidenceFingerprint,
        kind,
        topicKey,
        repoKeys: sortedRepoKeys,
        sourceRepos,
        ...(targetRepo ? { targetRepo } : {}),
        sourceMemoryIds: [a.memory.id, b.memory.id],
        sourceSessionIds: [...new Set([...a.memory.sourceSessionIds, ...b.memory.sourceSessionIds])],
        tags: [
          ...new Set([
            ...sharedMechanisms,
            ...sharedStacks.slice(0, 3),
            ...a.memory.tags.slice(0, 2),
            ...b.memory.tags.slice(0, 2),
            'cross-repo',
          ]),
        ].slice(0, 8),
        mechanisms: sharedMechanisms,
        sharedStacks,
        noveltyScore: novelty,
        structuralSimilarity: structSim,
        confidence,
        salience,
        deterministicTitle: sanitizeDreamText(title, 110, input.homeDir),
        deterministicSummary: sanitizeDreamText(summary, 240, input.homeDir),
        deterministicMechanism: sanitizeDreamText(
          `跨仓库共享机制「${mechReadable}」${sharedStacks.length > 0 ? `（共现技术栈：${sharedStacks.slice(0, 4).join(', ')}）` : ''}。`,
          180,
          input.homeDir,
        ),
        deterministicHypothesis: sanitizeDreamText(hypothesis, 240, input.homeDir),
      });
    }
  }

  // 2. Donor Memory (Repo A) <-> Structural Stack + Trajectory Vulnerability (Repo B without that memory yet)
  for (const donor of boundMemories) {
    if (donor.memory.kind !== 'pitfall' && donor.memory.kind !== 'decision') continue;
    if (donor.mechanisms.length === 0) continue;
    const donorRepoKey = donor.repoKeys[0];
    if (!donorRepoKey) continue;
    const donorProf = profilesByKey.get(donorRepoKey);
    if (!donorProf) continue;

    for (const targetProf of profilesByKey.values()) {
      if (donor.repoKeys.includes(targetProf.repoKey)) continue;

      // Skip if target repo already holds a consolidated memory covering the same mechanism & high overlap
      const alreadyCovered = boundMemories.some(
        (m) =>
          m.repoKeys.includes(targetProf.repoKey) &&
          (m.mechanisms.some((mc) => donor.mechanisms.includes(mc)) || jaccard(m.tokens, donor.tokens) >= 0.35),
      );
      if (alreadyCovered) continue;

      const struggle = strugglesByRepo.get(targetProf.repoKey);
      const struggleMechOverlap = donor.mechanisms.filter((m) => struggle?.mechanisms.includes(m));
      const profileMechOverlap = donor.mechanisms.filter((m) => targetProf.mechanismHints.includes(m));
      const sharedStacks = donorProf.stackTags.filter((st) => targetProf.stackTags.includes(st));
      const donorStackInTarget = donor.stackTags.filter((st) => targetProf.stackTags.includes(st));

      const effectiveMechs = [...new Set([...struggleMechOverlap, ...profileMechOverlap])];
      const hasStrongStruggle = struggleMechOverlap.length > 0;
      const hasStrongStructural =
        effectiveMechs.length > 0 && (donorStackInTarget.length > 0 || sharedStacks.length >= 2);

      if (!hasStrongStruggle && !hasStrongStructural) continue;

      const primaryMech = effectiveMechs[0] ?? donor.mechanisms[0] ?? 'architecture';
      const mechReadable = mechanismLabelOf(primaryMech);
      const kind: DreamInsightKind = donor.memory.kind === 'pitfall' ? 'preventive-warning' : 'structural-analogy';
      const sortedRepoKeys = [donorRepoKey, targetProf.repoKey].sort();
      const sourceRepos = sortedRepoKeys.map((rk) => profilesByKey.get(rk)?.displayPath ?? rk);
      const topicKey = `bridge:${primaryMech}:${targetProf.repoName}`
        .toLowerCase()
        .replace(/[^a-z0-9:_-]+/g, '-')
        .slice(0, 64);
      const pairSignature = `${sortedRepoKeys.join('|')}::${kind}::${topicKey}`;
      const evidenceFingerprint = shortHash(
        `${donor.memory.id}:${donor.memory.updatedAt}|${targetProf.repoKey}:${struggle?.turnCount ?? 0}:${targetProf.stackTags.join(',')}`,
      );

      const lexSim = struggle ? jaccard(donor.tokens, struggle.tokens) : 0.14;
      const structSim = clamp01(
        0.52 +
          (hasStrongStruggle ? 0.2 : 0.08) +
          Math.min(0.18, sharedStacks.length * 0.05) +
          Math.min(0.1, donorStackInTarget.length * 0.06),
      );
      const novelty = computeDmnNovelty(lexSim, 0.07);
      const confidence = clamp01(
        0.6 +
          donor.memory.retention * 0.16 +
          (hasStrongStruggle ? 0.12 : 0.04) +
          Math.min(0.1, sharedStacks.length * 0.03),
      );
      if (confidence < 0.63) continue;
      const salience = clamp01(confidence * 0.54 + novelty * 0.24 + structSim * 0.22);

      const contextClause =
        hasStrongStruggle && struggle?.sampleSnippet
          ? `近期会话正在排查相关现象（「${struggle.sampleSnippet}」）`
          : `具备同构技术栈（${[...new Set([...donorStackInTarget, ...sharedStacks])].slice(0, 4).join(', ')}）且尚未沉淀同类防护记忆`;

      registerCandidate({
        pairSignature,
        evidenceFingerprint,
        kind,
        topicKey,
        repoKeys: sortedRepoKeys,
        sourceRepos,
        targetRepo: targetProf.displayPath,
        sourceMemoryIds: [donor.memory.id],
        sourceSessionIds: [...new Set([...donor.memory.sourceSessionIds, ...(struggle ? struggle.sessionIds : [])])],
        tags: [...new Set([primaryMech, ...donorStackInTarget, ...sharedStacks.slice(0, 3), 'cross-repo'])].slice(0, 8),
        mechanisms: effectiveMechs,
        sharedStacks,
        noveltyScore: novelty,
        structuralSimilarity: structSim,
        confidence,
        salience,
        deterministicTitle: sanitizeDreamText(
          kind === 'preventive-warning'
            ? `跨仓避坑预警：${donorProf.repoName} 的「${mechReadable}」踩坑可提前守护 ${targetProf.repoName}`
            : `跨仓同构启发：${donorProf.repoName} 的「${mechReadable}」方案可赋能 ${targetProf.repoName}`,
          110,
          input.homeDir,
        ),
        deterministicSummary: sanitizeDreamText(
          `${donorProf.displayPath} 已沉淀${donor.memory.kind === 'pitfall' ? '踩坑' : '决策'}「${donor.memory.title}」，而 ${targetProf.displayPath} ${contextClause}。`,
          240,
          input.homeDir,
        ),
        deterministicMechanism: sanitizeDreamText(
          `跨项目结构画像匹配到共性机制面「${mechReadable}」与共享栈特征（${sharedStacks.slice(0, 4).join(', ') || targetProf.stackTags.slice(0, 3).join(', ')}）。`,
          180,
          input.homeDir,
        ),
        deterministicHypothesis: sanitizeDreamText(
          `建议在 ${targetProf.repoName} 检视或引入对应实践：${donor.memory.content}`,
          240,
          input.homeDir,
        ),
      });
    }
  }

  return [...candidatesBySig.values()].sort(
    (a, b) => b.salience - a.salience || b.confidence - a.confidence || a.pairSignature.localeCompare(b.pairSignature),
  );
}

function buildDreamLlmPrompt(bridges: readonly CandidateDreamBridge[], homeDir?: string): string {
  const items = bridges.map((b, index) => ({
    index,
    kind: b.kind,
    sourceRepos: b.sourceRepos,
    targetRepo: b.targetRepo ?? null,
    mechanisms: b.mechanisms,
    sharedStacks: b.sharedStacks,
    draftTitle: sanitizeDreamText(b.deterministicTitle, 110, homeDir),
    draftSummary: sanitizeDreamText(b.deterministicSummary, 220, homeDir),
    draftMechanism: sanitizeDreamText(b.deterministicMechanism, 160, homeDir),
    draftHypothesis: sanitizeDreamText(b.deterministicHypothesis, 220, homeDir),
  }));

  return [
    '你是 ASI 默认模式网络（DMN）跨项目睡眠做梦合成器。',
    '请基于以下跨 Git 仓库结构同构候选桥接，精炼出简洁、具体、可落地的中文顿悟卡片 JSON 数组。',
    '严禁编造不存在的仓库名或密钥，严禁输出代码块脚本，只输出严格合法的 JSON 数组：',
    '[{"index":0,"title":"...","summary":"...","bridgeMechanism":"...","actionableHypothesis":"..."}]',
    JSON.stringify(items),
  ].join('\n');
}

function extractBalancedJsonArray(raw: string): string | undefined {
  const start = raw.indexOf('[');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

interface LlmRefinedBridgeFields {
  title: string;
  summary: string;
  bridgeMechanism: string;
  actionableHypothesis: string;
}

function parseDreamLlmResponse(raw: string, count: number, homeDir?: string): Map<number, LlmRefinedBridgeFields> {
  const refined = new Map<number, LlmRefinedBridgeFields>();
  const slice = extractBalancedJsonArray(raw);
  if (!slice) return refined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return refined;
  }
  if (!Array.isArray(parsed)) return refined;

  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const idx = typeof rec.index === 'number' ? Math.trunc(rec.index) : -1;
    if (idx < 0 || idx >= count) continue;

    const title = typeof rec.title === 'string' ? sanitizeDreamText(rec.title, 110, homeDir) : '';
    const summary = typeof rec.summary === 'string' ? sanitizeDreamText(rec.summary, 240, homeDir) : '';
    const bridgeMechanism =
      typeof rec.bridgeMechanism === 'string' ? sanitizeDreamText(rec.bridgeMechanism, 180, homeDir) : '';
    const actionableHypothesis =
      typeof rec.actionableHypothesis === 'string' ? sanitizeDreamText(rec.actionableHypothesis, 240, homeDir) : '';

    if (
      title.length >= 6 &&
      summary.length >= 12 &&
      bridgeMechanism.length >= 8 &&
      actionableHypothesis.length >= 10 &&
      ![title, summary, bridgeMechanism, actionableHypothesis].some((s) => s.toLowerCase().includes('[redacted]'))
    ) {
      refined.set(idx, { title, summary, bridgeMechanism, actionableHypothesis });
    }
  }
  return refined;
}

export function isDreamInsightKind(value: unknown): value is DreamInsightKind {
  return typeof value === 'string' && (DREAM_INSIGHT_KINDS as readonly string[]).includes(value);
}

/**
 * Execute a full DMN Cross-Repo Dream synthesis cycle.
 */
export async function runDmnDreamCycle(input: RunDreamCycleInput): Promise<RunDreamCycleOutput> {
  const startedAt = Date.now();
  throwIfAborted(input.signal);

  const candidates = discoverCandidateCrossRepoBridges({
    repoProfiles: input.repoProfiles,
    cwdToRepoKey: input.cwdToRepoKey,
    sessionWorkspaces: input.sessionWorkspaces,
    memories: input.memories,
    turns: input.turns,
    dreamedPairSignatures: input.dreamedPairSignatures,
    dismissedPairPenalties: input.dismissedPairPenalties,
    homeDir: input.homeDir,
  });

  throwIfAborted(input.signal);

  const selected = candidates.slice(0, MAX_BRIDGES_PER_CYCLE);
  let llmRefinements = new Map<number, LlmRefinedBridgeFields>();

  if (selected.length > 0 && input.llmDream) {
    try {
      const prompt = buildDreamLlmPrompt(selected, input.homeDir);
      const raw = await input.llmDream(prompt, input.signal);
      throwIfAborted(input.signal);
      if (raw) {
        llmRefinements = parseDreamLlmResponse(raw, selected.length, input.homeDir);
      }
    } catch (err) {
      if (input.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw err;
      }
      // Offline / transient LLM error falls back deterministically
    }
  }

  const working: DreamInsightEntry[] = input.existingInsights.map((e) => structuredClone(e));
  const updatedDreamedSignatures: Record<string, string> = { ...input.dreamedPairSignatures };
  let insightsCreated = 0;
  let insightsReinforced = 0;

  for (const [index, bridge] of selected.entries()) {
    throwIfAborted(input.signal);
    const refined = llmRefinements.get(index);
    const title = refined?.title ?? bridge.deterministicTitle;
    const summary = refined?.summary ?? bridge.deterministicSummary;
    const bridgeMechanism = refined?.bridgeMechanism ?? bridge.deterministicMechanism;
    const actionableHypothesis = refined?.actionableHypothesis ?? bridge.deterministicHypothesis;

    updatedDreamedSignatures[bridge.pairSignature] = bridge.evidenceFingerprint;

    const existingIdx = working.findIndex((item) => item.pairSignature === bridge.pairSignature);
    if (existingIdx >= 0) {
      const prev = working[existingIdx];
      if (prev && prev.status !== 'dismissed') {
        working[existingIdx] = {
          ...prev,
          title,
          summary,
          bridgeMechanism,
          actionableHypothesis,
          sourceMemoryIds: [...new Set([...prev.sourceMemoryIds, ...bridge.sourceMemoryIds])],
          sourceSessionIds: [...new Set([...prev.sourceSessionIds, ...bridge.sourceSessionIds])],
          tags: [...new Set([...prev.tags, ...bridge.tags])].slice(0, 10),
          confidence: Math.max(prev.confidence, bridge.confidence),
          noveltyScore: bridge.noveltyScore,
          structuralSimilarity: bridge.structuralSimilarity,
          updatedAt: input.now,
        };
        insightsReinforced += 1;
      }
      continue;
    }

    working.push({
      id: `ins_${randomUUID().slice(0, 12)}`,
      kind: bridge.kind,
      status: 'open',
      title,
      summary,
      bridgeMechanism,
      actionableHypothesis,
      repoKeys: bridge.repoKeys,
      sourceRepos: bridge.sourceRepos,
      ...(bridge.targetRepo ? { targetRepo: bridge.targetRepo } : {}),
      sourceMemoryIds: bridge.sourceMemoryIds,
      sourceSessionIds: bridge.sourceSessionIds,
      tags: bridge.tags,
      topicKey: bridge.topicKey,
      pairSignature: bridge.pairSignature,
      noveltyScore: bridge.noveltyScore,
      structuralSimilarity: bridge.structuralSimilarity,
      confidence: bridge.confidence,
      createdAt: input.now,
      updatedAt: input.now,
    });
    insightsCreated += 1;
  }

  // Cap total retained insights at 160 (evicting oldest dismissed first, then oldest resolved)
  if (working.length > 160) {
    working.sort((a, b) => {
      const rank = (s: DreamInsightEntry['status']) => (s === 'dismissed' ? 0 : s === 'open' ? 2 : 1);
      return rank(a.status) - rank(b.status) || a.updatedAt - b.updatedAt;
    });
    working.splice(0, working.length - 160);
  }

  const durationMs = Math.max(1, Date.now() - startedAt);
  const summary =
    insightsCreated > 0 || insightsReinforced > 0
      ? `扫描 ${input.repoProfiles.length} 个仓库、评估 ${candidates.length} 条远距桥接，新生成 ${insightsCreated} 条顿悟${insightsReinforced > 0 ? `，强化 ${insightsReinforced} 条` : ''}`
      : input.repoProfiles.length < 2
        ? `当前仅发现 ${input.repoProfiles.length} 个独立仓库，暂不触发跨项目做梦联想`
        : `扫描 ${input.repoProfiles.length} 个仓库，暂无新的未探索跨仓结构桥接`;

  const record: DreamCycleRecord = {
    id: `drm_${randomUUID().slice(0, 12)}`,
    at: input.now,
    trigger: input.trigger,
    reposScanned: input.repoProfiles.length,
    bridgesEvaluated: candidates.length,
    insightsCreated,
    insightsReinforced,
    durationMs,
    summary,
  };

  return {
    insights: working,
    record,
    updatedDreamedSignatures,
  };
}
