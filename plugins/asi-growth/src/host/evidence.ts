/**
 * High-Evidence Topic & Trajectory Clustering for `asi-growth` (L4).
 *
 * Combines two read-only evidence streams (strictly excluding ASI internal
 * sandboxes/vaults and subagent sessions):
 * 1. High-retention (`retention >= 0.5` or `pinned`) `asi-sleep` memories of
 *    kinds `pitfall`, `decision`, and `preference` (`episode` never triggers).
 * 2. Completed ordinary multi-step troubleshooting trajectories (`>= 2` tool
 *    calls or steps resolving an error/failure diagnosis).
 *
 * Discomfort / auto-drafting triggers ONLY when:
 * - Brand-new topic: `>= 3` high-retention `pitfall` + `decision`/`preference`
 *   memories (with at least `1` `pitfall`) OR `>= 2` recurring troubleshooting
 *   trajectories on the same topic/project;
 * - Existing skill revision (`v2+`): `>= 1` new unprocessed high-retention
 *   `pitfall` memory OR `>= 2` new recurring trajectories (or `>= 1` new
 *   trajectory when the existing skill already tracks trajectories) for an
 *   existing skill's topic.
 */

import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { type SleepMemorySummary, sanitizeForModel } from '@asi/sense-types';
import { MAX_SKILL_NAME_LENGTH, sanitizeSkillText, toValidSkillSlug } from '../shared/skill-spec.js';
import type { SkillScope } from '../shared/types.js';

export const HIGH_RETENTION_THRESHOLD = 0.5;
export const MEMORY_EVIDENCE_THRESHOLD = 3;
export const TRAJECTORY_RECURRENCE_THRESHOLD = 2;

const GENERIC_TAGS = new Set([
  'general',
  'note',
  'notes',
  'chat',
  'misc',
  'other',
  'todo',
  'work',
  'dev',
  'code',
  'project',
]);

const TROUBLESHOOT_CUE_RE =
  /\b(?:error|err|fail(?:ed|ure)?|bug|fix(?:ed)?|crash(?:ed)?|timeout|exception|typeerror|referenceerror|syntaxerror|enoent|eacces|eaddrinuse|workaround|pitfall|regress(?:ion)?|debug(?:ged)?|resolv(?:e|ed))\b|报错|失败|异常|崩溃|超时|踩坑|排查|修复|解决|死锁|冲突|不生效|挂了/i;

export interface OrdinaryTurnTrajectoryInput {
  turnId: string;
  sessionId: string;
  seq?: number;
  cwd?: string;
  sessionTitle?: string;
  at: number;
  stepCount: number;
  toolNames: string[];
  hadToolError?: boolean;
  userText: string;
  assistantText: string;
}

export interface TroubleshootingTrajectory {
  id: string;
  sessionId: string;
  turnId: string;
  cwd?: string;
  at: number;
  topicKey: string;
  title: string;
  problemSummary: string;
  resolutionSummary: string;
  toolNames: string[];
  stepCount: number;
}

export interface ExistingSkillTopicRef {
  name: string;
  version: number;
  topicKey: string;
  markdown: string;
  scope: SkillScope;
  workspacePath?: string;
  evidenceIds: readonly string[];
}

export interface ExistingDraftTopicRef {
  id: string;
  name: string;
  topicKey: string;
  revisesSkillName?: string;
  evidenceIds: readonly string[];
}

export interface ReadySkillCluster {
  topicKey: string;
  suggestedName: string;
  isRevision: boolean;
  existingSkill?: ExistingSkillTopicRef;
  targetVersion: number;
  recommendedScope: SkillScope;
  recommendedWorkspace?: string;
  memories: SleepMemorySummary[];
  trajectories: TroubleshootingTrajectory[];
  allEvidenceIds: string[];
  newEvidenceIds: string[];
  evidenceSignature: string;
  evidenceSummary: string;
}

export interface EvidenceEvaluationSummary {
  highRetentionMemoryCount: number;
  recurringTrajectoryCount: number;
  totalTrajectoriesExtracted: number;
  readyClusters: ReadySkillCluster[];
}

function tokenizeTopicText(text: string): Set<string> {
  const clean = text.toLowerCase();
  const out = new Set<string>();
  for (const m of clean.matchAll(/[a-z][a-z0-9_-]{2,30}/g)) {
    const tok = m[0];
    if (tok && !GENERIC_TAGS.has(tok)) out.add(tok);
  }
  const cjkRuns = clean.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 2) {
      out.add(run);
    } else {
      for (let i = 0; i + 1 < Math.min(run.length, 10); i += 1) {
        out.add(run.slice(i, i + 2));
      }
    }
  }
  return out;
}

function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const item of a) {
    if (b.has(item)) inter += 1;
  }
  if (inter === 0) return 0;
  return inter / (a.size + b.size - inter);
}

const MEMORY_KIND_TOPIC_PREFIX_RE = /^(?:preference|decision|pitfall|episode)\s*[:/]+\s*/i;
const BARE_MEMORY_KINDS = new Set(['preference', 'decision', 'pitfall', 'episode']);
const EXPLICIT_WORKSPACE_TAG_RE = /^(?:workspace|cwd|repo):(.+)$/i;

const COMMON_TECH_TAGS = new Set([
  'typescript',
  'javascript',
  'react',
  'vitest',
  'playwright',
  'pnpm',
  'npm',
  'yarn',
  'bun',
  'biome',
  'eslint',
  'prettier',
  'oxlint',
  'esbuild',
  'vite',
  'webpack',
  'rollup',
  'tsdown',
  'swift',
  'macos',
  'cordis',
  'dsh',
  'minisearch',
  'fsrs',
  'jsonl',
  'markdown',
  'css',
  'axe',
  'sqlite',
  'postgres',
  'postgresql',
  'mysql',
  'duckdb',
  'git',
  'docker',
  'node',
  'python',
  'rust',
  'go',
]);

const KNOWN_SLEEP_TOPIC_FAMILIES: ReadonlyArray<{ topic: string; pattern: RegExp }> = [
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

function inferUnambiguousSleepTopicFamily(text: string): string | undefined {
  let matched: string | undefined;
  for (const fam of KNOWN_SLEEP_TOPIC_FAMILIES) {
    if (fam.pattern.test(text)) {
      if (matched && matched !== fam.topic) return undefined;
      matched = fam.topic;
    }
  }
  return matched;
}

function sharesMultiSegmentAnchorPrefix(a: string, b: string): boolean {
  if (!a || !b || a.startsWith('topic-') || b.startsWith('topic-')) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 6 && shorter.includes('-') && (longer === shorter || longer.startsWith(`${shorter}-`));
}

function normalizeWorkspacePath(raw: string, homeDir?: string, knownAbsoluteWorkspaces?: ReadonlySet<string>): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed === '~') {
    return homeDir?.trim() ? resolve(homeDir.trim()) : '~';
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    const rel = trimmed.slice(2).replace(/^[\\/]+|[\\/]+$/g, '');
    if (!rel) return homeDir?.trim() ? resolve(homeDir.trim()) : '~';
    if (homeDir?.trim()) {
      return resolve(join(homeDir.trim(), rel));
    }
    if (knownAbsoluteWorkspaces && knownAbsoluteWorkspaces.size > 0) {
      const suffix = `/${rel.replace(/\\/g, '/')}`;
      const matches = [...knownAbsoluteWorkspaces].filter((ws) => ws.replace(/\\/g, '/').endsWith(suffix));
      if (matches.length === 1 && matches[0]) return matches[0];
    }
    return `~/${rel.replace(/\\/g, '/')}`;
  }
  return isAbsolute(trimmed) ? resolve(trimmed) : trimmed.replace(/[\\/]+$/, '');
}

export function normalizeExplicitTopicKey(rawTopicKey?: string): string | undefined {
  if (!rawTopicKey?.trim()) return undefined;
  let body = rawTopicKey.trim();
  while (MEMORY_KIND_TOPIC_PREFIX_RE.test(body)) {
    body = body.replace(MEMORY_KIND_TOPIC_PREFIX_RE, '').trim();
  }
  body = body.replace(/^[:/\s-]+|[:/\s-]+$/g, '');
  if ([...body].length < 2) return undefined;
  const low = body.toLowerCase();
  if (BARE_MEMORY_KINDS.has(low) || GENERIC_TAGS.has(low)) return undefined;

  if (!/[\u4e00-\u9fff]/.test(body)) {
    const asciiSlug = sanitizeForModel(body)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, MAX_SKILL_NAME_LENGTH)
      .replace(/-+$/g, '');
    if (asciiSlug.length >= 2 && !/^\d+(?:-\d+)*$/.test(asciiSlug)) {
      if (BARE_MEMORY_KINDS.has(asciiSlug) || GENERIC_TAGS.has(asciiSlug)) return undefined;
      return asciiSlug;
    }
  }

  return toValidSkillSlug(body, 'topic');
}

export function normalizeTopicAnchor(rawTopicKey?: string, tags?: readonly string[], title?: string): string {
  const explicit = normalizeExplicitTopicKey(rawTopicKey);
  if (explicit) {
    return explicit;
  }
  if (tags && tags.length > 0) {
    for (const tag of tags) {
      const cleanTag = tag.trim().toLowerCase().replace(/^#+/, '');
      if (
        cleanTag.length >= 2 &&
        !GENERIC_TAGS.has(cleanTag) &&
        !BARE_MEMORY_KINDS.has(cleanTag) &&
        !EXPLICIT_WORKSPACE_TAG_RE.test(cleanTag) &&
        !cleanTag.startsWith('/') &&
        !cleanTag.startsWith('~/')
      ) {
        return toValidSkillSlug(cleanTag, 'topic');
      }
    }
  }
  return toValidSkillSlug(title ?? 'general-workflow', 'topic');
}

export function extractTroubleshootingTrajectories(
  turns: readonly OrdinaryTurnTrajectoryInput[],
  homeDir?: string,
): TroubleshootingTrajectory[] {
  const out: TroubleshootingTrajectory[] = [];
  for (const turn of turns) {
    const distinctTools = [...new Set(turn.toolNames.filter((t) => typeof t === 'string' && t.trim().length > 0))];
    const multiStep = turn.stepCount >= 2 || distinctTools.length >= 2;
    if (!multiStep) continue;

    const combinedText = `${turn.userText}\n${turn.assistantText}`;
    const hasTroubleSignal = Boolean(turn.hadToolError) || TROUBLESHOOT_CUE_RE.test(combinedText);
    if (!hasTroubleSignal) continue;

    const cleanUser = sanitizeSkillText(turn.userText, 220, homeDir);
    const cleanAssistant = sanitizeSkillText(turn.assistantText, 320, homeDir);
    if (!cleanUser || !cleanAssistant) continue;

    const titleSeed = turn.sessionTitle?.trim() ? `${turn.sessionTitle}: ${cleanUser}` : cleanUser;
    const cwdBase = turn.cwd?.trim() ? basename(turn.cwd.trim()) : '';
    const baseTopicKey = normalizeTopicAnchor(undefined, undefined, cleanUser);
    const topicKey =
      baseTopicKey.startsWith('topic-') && cwdBase.length >= 2
        ? toValidSkillSlug(`${cwdBase}-${baseTopicKey}`, 'topic')
        : baseTopicKey;

    out.push({
      id: `traj_${turn.sessionId}_${turn.turnId}`,
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      ...(turn.cwd ? { cwd: turn.cwd } : {}),
      at: turn.at,
      topicKey,
      title: sanitizeSkillText(titleSeed, 110, homeDir),
      problemSummary: cleanUser,
      resolutionSummary: cleanAssistant,
      toolNames: distinctTools.slice(0, 8),
      stepCount: Math.max(turn.stepCount, distinctTools.length),
    });
  }
  return out;
}

export function computeEvidenceSignature(topicKey: string, evidenceIds: readonly string[]): string {
  const sorted = [...new Set(evidenceIds)].sort();
  return createHash('sha256')
    .update(`${topicKey}::${sorted.join('|')}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
}

interface RawTopicBucket {
  anchor: string;
  explicitTopic?: string;
  tokens: Set<string>;
  tags: Set<string>;
  memories: SleepMemorySummary[];
  trajectories: TroubleshootingTrajectory[];
}

export function clusterHighEvidenceTopics(input: {
  memories: readonly SleepMemorySummary[];
  trajectories: readonly TroubleshootingTrajectory[];
  existingSkills: readonly ExistingSkillTopicRef[];
  existingDrafts: readonly ExistingDraftTopicRef[];
  rejectedSignatures: ReadonlySet<string>;
  sessionWorkspaces?: ReadonlyMap<string, string>;
  knownWorkspaces?: readonly string[];
  homeDir?: string;
}): EvidenceEvaluationSummary {
  const eligibleMemories = input.memories.filter(
    (m) =>
      (m.kind === 'pitfall' || m.kind === 'decision' || m.kind === 'preference') &&
      (m.pinned || m.retention >= HIGH_RETENTION_THRESHOLD),
  );

  const knownAbsoluteWorkspaces = new Set<string>();
  const collectAbsWorkspace = (rawWs: string | undefined) => {
    const norm = rawWs ? normalizeWorkspacePath(rawWs, input.homeDir) : '';
    if (norm && isAbsolute(norm)) knownAbsoluteWorkspaces.add(norm);
  };
  for (const ws of input.knownWorkspaces ?? []) collectAbsWorkspace(ws);
  if (input.sessionWorkspaces) {
    for (const ws of input.sessionWorkspaces.values()) collectAbsWorkspace(ws);
  }
  for (const traj of input.trajectories) collectAbsWorkspace(traj.cwd);

  const sessionWsMap = new Map<string, string>();
  if (input.sessionWorkspaces) {
    for (const [sid, ws] of input.sessionWorkspaces) {
      const norm = ws ? normalizeWorkspacePath(ws, input.homeDir, knownAbsoluteWorkspaces) : '';
      if (sid && norm) sessionWsMap.set(sid, norm);
    }
  }
  for (const traj of input.trajectories) {
    const norm = traj.cwd ? normalizeWorkspacePath(traj.cwd, input.homeDir, knownAbsoluteWorkspaces) : '';
    if (traj.sessionId && norm && !sessionWsMap.has(traj.sessionId)) {
      sessionWsMap.set(traj.sessionId, norm);
    }
  }

  const knownWsByBasename = new Map<string, string | 'ambiguous'>();
  const registerKnownWorkspace = (rawWs: string | undefined) => {
    const norm = rawWs ? normalizeWorkspacePath(rawWs, input.homeDir, knownAbsoluteWorkspaces) : '';
    if (!norm) return;
    const base = basename(norm).toLowerCase();
    if (!base || base.length < 2 || GENERIC_TAGS.has(base)) return;
    const prev = knownWsByBasename.get(base);
    if (!prev) knownWsByBasename.set(base, norm);
    else if (prev !== norm) knownWsByBasename.set(base, 'ambiguous');
  };
  for (const ws of input.knownWorkspaces ?? []) registerKnownWorkspace(ws);
  for (const ws of sessionWsMap.values()) registerKnownWorkspace(ws);
  for (const traj of input.trajectories) registerKnownWorkspace(traj.cwd);

  const normalizeSkillOrDraftTopic = (rawKey: string): string =>
    normalizeExplicitTopicKey(rawKey) ?? toValidSkillSlug(rawKey, 'topic');

  const buckets: RawTopicBucket[] = [];

  const isSemanticTopicTag = (cleanTag: string): boolean => {
    if (cleanTag.length < 2) return false;
    if (GENERIC_TAGS.has(cleanTag) || BARE_MEMORY_KINDS.has(cleanTag)) return false;
    if (EXPLICIT_WORKSPACE_TAG_RE.test(cleanTag) || cleanTag.startsWith('/') || cleanTag.startsWith('~/')) return false;
    if (knownWsByBasename.has(cleanTag) && !COMMON_TECH_TAGS.has(cleanTag)) return false;
    return true;
  };

  const findOrCreateBucket = (
    explicitTopicKey: string | undefined,
    rawTags: readonly string[],
    textForTokens: string,
    fallbackAnchor: string,
  ): RawTopicBucket => {
    const cleanTags = rawTags.map((t) => t.trim().toLowerCase().replace(/^#+/, '')).filter(isSemanticTopicTag);
    const itemTokens = tokenizeTopicText(`${textForTokens} ${cleanTags.join(' ')}`);
    const explicitSlug = normalizeExplicitTopicKey(explicitTopicKey);
    const unambiguousFamily = explicitSlug ? undefined : inferUnambiguousSleepTopicFamily(textForTokens);

    // 1. Exact explicit topic match always wins before any fuzzy/tag fallback
    if (explicitSlug) {
      const exactBucket = buckets.find(
        (b) => b.explicitTopic === explicitSlug || (!b.explicitTopic && b.anchor === explicitSlug),
      );
      if (exactBucket) {
        if (!exactBucket.explicitTopic) {
          exactBucket.explicitTopic = explicitSlug;
          exactBucket.anchor = explicitSlug;
        }
        return exactBucket;
      }
    }

    // 2. Tag / similarity matching only when explicit topic keys do not conflict
    for (const b of buckets) {
      if (explicitSlug && b.explicitTopic && b.explicitTopic !== explicitSlug) continue;
      if (cleanTags.some((t) => b.tags.has(t) || b.anchor === toValidSkillSlug(t, 'topic'))) {
        if (explicitSlug && !b.explicitTopic) {
          b.explicitTopic = explicitSlug;
          b.anchor = explicitSlug;
        }
        return b;
      }
      if (
        !explicitSlug &&
        (b.anchor === fallbackAnchor ||
          (unambiguousFamily !== undefined && b.anchor === unambiguousFamily) ||
          (!b.explicitTopic && sharesMultiSegmentAnchorPrefix(b.anchor, fallbackAnchor)) ||
          (b.anchor.length >= 4 && !b.anchor.startsWith('topic-') && itemTokens.has(b.anchor)) ||
          jaccardSimilarity(b.tokens, itemTokens) >= 0.28)
      ) {
        return b;
      }
    }

    // 3. Align anchor with an existing skill if tokens/tags/canonical family match that skill's topicKey
    let resolvedAnchor = explicitSlug ?? fallbackAnchor;
    for (const skill of input.existingSkills) {
      const skillTopic = normalizeSkillOrDraftTopic(skill.topicKey);
      if (explicitSlug && skillTopic !== explicitSlug) continue;
      if (
        skillTopic === resolvedAnchor ||
        (!explicitSlug && unambiguousFamily !== undefined && skillTopic === unambiguousFamily) ||
        cleanTags.some((t) => toValidSkillSlug(t, 'topic') === skillTopic) ||
        (!explicitSlug && jaccardSimilarity(tokenizeTopicText(`${skill.name} ${skillTopic}`), itemTokens) >= 0.34)
      ) {
        resolvedAnchor = skillTopic;
        const existingBucket = buckets.find((b) => b.anchor === resolvedAnchor);
        if (existingBucket) {
          if (explicitSlug && !existingBucket.explicitTopic) {
            existingBucket.explicitTopic = explicitSlug;
          }
          for (const t of cleanTags) existingBucket.tags.add(t);
          for (const tok of itemTokens) existingBucket.tokens.add(tok);
          return existingBucket;
        }
        break;
      }
    }

    const created: RawTopicBucket = {
      anchor: resolvedAnchor,
      ...(explicitSlug ? { explicitTopic: explicitSlug } : {}),
      tokens: new Set(itemTokens),
      tags: new Set(cleanTags),
      memories: [],
      trajectories: [],
    };
    buckets.push(created);
    return created;
  };

  // Seed explicit-topic memories first so distinct explicit topics never get bridged via a tag-only memory
  const orderedMemories = [
    ...eligibleMemories.filter((m) => Boolean(normalizeExplicitTopicKey(m.topicKey))),
    ...eligibleMemories.filter((m) => !normalizeExplicitTopicKey(m.topicKey)),
  ];

  for (const mem of orderedMemories) {
    const semanticMemTags = mem.tags.filter((t) => isSemanticTopicTag(t.trim().toLowerCase().replace(/^#+/, '')));
    const fallback = normalizeTopicAnchor(mem.topicKey, semanticMemTags, mem.title);
    const bucket = findOrCreateBucket(mem.topicKey, semanticMemTags, `${mem.title} ${mem.content}`, fallback);
    for (const tag of semanticMemTags) {
      const ct = tag.trim().toLowerCase().replace(/^#+/, '');
      if (ct) bucket.tags.add(ct);
    }
    for (const tok of tokenizeTopicText(mem.title)) bucket.tokens.add(tok);
    bucket.memories.push(mem);
  }

  for (const traj of input.trajectories) {
    // Never pass generic toolNames (read_file, shell, etc.) as semantic topic tags
    const bucket = findOrCreateBucket(
      undefined,
      [],
      `${traj.title} ${traj.problemSummary} ${traj.resolutionSummary}`,
      traj.topicKey,
    );
    for (const tok of tokenizeTopicText(traj.title)) bucket.tokens.add(tok);
    bucket.trajectories.push(traj);
  }

  let recurringTrajectoryCount = 0;
  for (const b of buckets) {
    if (b.trajectories.length >= TRAJECTORY_RECURRENCE_THRESHOLD) {
      recurringTrajectoryCount += b.trajectories.length;
    }
  }

  const skillsByTopic = new Map<string, ExistingSkillTopicRef>();
  for (const s of input.existingSkills) {
    skillsByTopic.set(normalizeSkillOrDraftTopic(s.topicKey), s);
  }

  const readyClusters: ReadySkillCluster[] = [];

  const collectMemoryWorkspaceRefs = (memories: readonly SleepMemorySummary[], singleTrajWs: string): Set<string> => {
    const refs = new Set<string>([singleTrajWs]);
    const singleTrajBase = basename(singleTrajWs).toLowerCase();

    for (const mem of memories) {
      for (const sid of mem.sourceSessionIds) {
        const mappedWs = sessionWsMap.get(sid);
        if (mappedWs) refs.add(mappedWs);
      }
      const allSessionsMapped =
        mem.sourceSessionIds.length > 0 && mem.sourceSessionIds.every((sid) => sessionWsMap.has(sid));

      for (const rawTag of mem.tags) {
        const trimmed = rawTag.trim();
        if (!trimmed) continue;
        const wsTagMatch = EXPLICIT_WORKSPACE_TAG_RE.exec(trimmed);
        if (wsTagMatch?.[1]) {
          const val = wsTagMatch[1].trim();
          if (!val) continue;
          if (isAbsolute(val) || val === '~' || val.startsWith('~/') || val.startsWith('~\\')) {
            const expanded = normalizeWorkspacePath(val, input.homeDir, knownAbsoluteWorkspaces);
            if (expanded) refs.add(expanded);
          } else {
            const lowVal = val.toLowerCase();
            const known = knownWsByBasename.get(lowVal);
            if (known && known !== 'ambiguous') refs.add(known);
            else if (lowVal !== singleTrajBase) refs.add(`tag:${lowVal}`);
          }
          continue;
        }
        if (trimmed.startsWith('/') || trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
          const expanded = normalizeWorkspacePath(trimmed, input.homeDir, knownAbsoluteWorkspaces);
          if (expanded) refs.add(expanded);
          continue;
        }
        if (!allSessionsMapped) {
          const lowTag = trimmed.toLowerCase().replace(/^#+/, '');
          if (!COMMON_TECH_TAGS.has(lowTag)) {
            const known = knownWsByBasename.get(lowTag);
            if (known && known !== 'ambiguous') {
              refs.add(known);
            }
          }
        }
      }
    }
    return refs;
  };

  for (const bucket of buckets) {
    const existingSkill = skillsByTopic.get(bucket.anchor);
    const hasOpenDraft = input.existingDrafts.some(
      (d) =>
        normalizeSkillOrDraftTopic(d.topicKey) === bucket.anchor ||
        (existingSkill && d.revisesSkillName === existingSkill.name),
    );
    if (hasOpenDraft) continue;

    const allEvidenceIds = [...bucket.memories.map((m) => m.id), ...bucket.trajectories.map((t) => t.id)];

    const distinctCwds = [
      ...new Set(
        bucket.trajectories
          .map((t) => (t.cwd ? normalizeWorkspacePath(t.cwd, input.homeDir, knownAbsoluteWorkspaces) : ''))
          .filter(Boolean),
      ),
    ];

    if (!existingSkill) {
      const pitfallCount = bucket.memories.filter((m) => m.kind === 'pitfall').length;
      const meetsMemoryGate = bucket.memories.length >= MEMORY_EVIDENCE_THRESHOLD && pitfallCount >= 1;
      const meetsTrajectoryGate = bucket.trajectories.length >= TRAJECTORY_RECURRENCE_THRESHOLD;
      if (!meetsMemoryGate && !meetsTrajectoryGate) continue;

      const sig = computeEvidenceSignature(bucket.anchor, allEvidenceIds);
      if (input.rejectedSignatures.has(sig)) continue;

      const singleWs = distinctCwds.length === 1 ? distinctCwds[0] : undefined;
      const scope: SkillScope =
        singleWs && collectMemoryWorkspaceRefs(bucket.memories, singleWs).size === 1 ? 'workspace' : 'global';
      const suggestedBase = toValidSkillSlug(bucket.anchor, 'skill');

      readyClusters.push({
        topicKey: bucket.anchor,
        suggestedName: suggestedBase,
        isRevision: false,
        targetVersion: 1,
        recommendedScope: scope,
        ...(scope === 'workspace' && distinctCwds[0] ? { recommendedWorkspace: distinctCwds[0] } : {}),
        memories: bucket.memories,
        trajectories: bucket.trajectories,
        allEvidenceIds,
        newEvidenceIds: allEvidenceIds,
        evidenceSignature: sig,
        evidenceSummary: `聚合 ${bucket.memories.length} 条高保留率记忆（含 ${pitfallCount} 条踩坑）与 ${bucket.trajectories.length} 条多步排障轨迹`,
      });
    } else {
      const knownIds = new Set(existingSkill.evidenceIds);
      const newMemories = bucket.memories.filter((m) => !knownIds.has(m.id));
      const newTrajectories = bucket.trajectories.filter((t) => !knownIds.has(t.id));
      const newPitfalls = newMemories.filter((m) => m.kind === 'pitfall');
      const hadPriorTraj = existingSkill.evidenceIds.some((id) => id.startsWith('traj_'));
      const meetsRevisionGate =
        newPitfalls.length >= 1 ||
        newTrajectories.length >= TRAJECTORY_RECURRENCE_THRESHOLD ||
        (hadPriorTraj && newTrajectories.length >= 1);

      if (!meetsRevisionGate) continue;

      const mergedIds = [...new Set([...existingSkill.evidenceIds, ...allEvidenceIds])];
      const newEvidenceIds = [...newMemories.map((m) => m.id), ...newTrajectories.map((t) => t.id)];
      const sig = computeEvidenceSignature(`${existingSkill.name}@v${existingSkill.version + 1}`, newEvidenceIds);
      if (input.rejectedSignatures.has(sig)) continue;

      readyClusters.push({
        topicKey: bucket.anchor,
        suggestedName: existingSkill.name,
        isRevision: true,
        existingSkill,
        targetVersion: existingSkill.version + 1,
        recommendedScope: existingSkill.scope,
        ...(existingSkill.workspacePath ? { recommendedWorkspace: existingSkill.workspacePath } : {}),
        memories: bucket.memories,
        trajectories: bucket.trajectories,
        allEvidenceIds: mergedIds,
        newEvidenceIds,
        evidenceSignature: sig,
        evidenceSummary: `基于新增 ${newPitfalls.length} 条踩坑记忆与 ${newTrajectories.length} 条排障轨迹提炼 v${existingSkill.version} → v${existingSkill.version + 1} 增量修订`,
      });
    }
  }

  readyClusters.sort((a, b) => {
    const scoreA = a.memories.length * 2 + a.trajectories.length * 3;
    const scoreB = b.memories.length * 2 + b.trajectories.length * 3;
    return scoreB - scoreA || a.topicKey.localeCompare(b.topicKey);
  });

  return {
    highRetentionMemoryCount: eligibleMemories.length,
    recurringTrajectoryCount,
    totalTrajectoriesExtracted: input.trajectories.length,
    readyClusters,
  };
}
