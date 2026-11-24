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
import { basename } from 'node:path';
import type { SleepMemorySummary } from '@asi/sense-types';
import { sanitizeSkillText, toValidSkillSlug } from '../shared/skill-spec.js';
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

export function normalizeTopicAnchor(rawTopicKey?: string, tags?: readonly string[], title?: string): string {
  if (rawTopicKey && rawTopicKey.trim()) {
    const root = rawTopicKey.trim().toLowerCase().split(/[:/]/)[0]?.trim() ?? '';
    if (root.length >= 2) {
      return toValidSkillSlug(root, 'topic');
    }
  }
  if (tags && tags.length > 0) {
    for (const tag of tags) {
      const cleanTag = tag.trim().toLowerCase().replace(/^#+/, '');
      if (cleanTag.length >= 2 && !GENERIC_TAGS.has(cleanTag)) {
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
  hasExplicitTopic: boolean;
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
}): EvidenceEvaluationSummary {
  const eligibleMemories = input.memories.filter(
    (m) =>
      (m.kind === 'pitfall' || m.kind === 'decision' || m.kind === 'preference') &&
      (m.pinned || m.retention >= HIGH_RETENTION_THRESHOLD),
  );

  const buckets: RawTopicBucket[] = [];

  const findOrCreateBucket = (
    explicitTopicKey: string | undefined,
    rawTags: readonly string[],
    textForTokens: string,
    fallbackAnchor: string,
  ): RawTopicBucket => {
    const cleanTags = rawTags
      .map((t) => t.trim().toLowerCase().replace(/^#+/, ''))
      .filter((t) => t.length >= 2 && !GENERIC_TAGS.has(t));
    const itemTokens = tokenizeTopicText(`${textForTokens} ${cleanTags.join(' ')}`);
    const explicitSlug =
      explicitTopicKey && explicitTopicKey.trim()
        ? toValidSkillSlug(explicitTopicKey.trim().split(/[:/]/)[0] ?? explicitTopicKey, 'topic')
        : undefined;

    // 1. Exact explicit topic match always wins before any fuzzy/tag fallback
    if (explicitSlug) {
      const exactBucket = buckets.find((b) => b.anchor === explicitSlug);
      if (exactBucket) return exactBucket;
    }

    // 2. Tag / similarity matching only when explicit topic keys do not conflict
    for (const b of buckets) {
      if (explicitSlug && b.hasExplicitTopic) continue;
      if (cleanTags.some((t) => b.tags.has(t) || b.anchor === toValidSkillSlug(t, 'topic'))) return b;
      if (!explicitSlug && (b.anchor === fallbackAnchor || jaccardSimilarity(b.tokens, itemTokens) >= 0.28)) return b;
    }

    // 3. Align anchor with an existing skill if tokens/tags match that skill's topicKey
    let resolvedAnchor = explicitSlug ?? fallbackAnchor;
    for (const skill of input.existingSkills) {
      if (explicitSlug && skill.topicKey !== explicitSlug) continue;
      if (
        skill.topicKey === resolvedAnchor ||
        cleanTags.some((t) => toValidSkillSlug(t, 'topic') === skill.topicKey) ||
        (!explicitSlug && jaccardSimilarity(tokenizeTopicText(`${skill.name} ${skill.topicKey}`), itemTokens) >= 0.34)
      ) {
        resolvedAnchor = skill.topicKey;
        const existingBucket = buckets.find((b) => b.anchor === resolvedAnchor);
        if (existingBucket) {
          for (const t of cleanTags) existingBucket.tags.add(t);
          for (const tok of itemTokens) existingBucket.tokens.add(tok);
          return existingBucket;
        }
        break;
      }
    }

    const created: RawTopicBucket = {
      anchor: resolvedAnchor,
      hasExplicitTopic: Boolean(explicitSlug),
      tokens: new Set(itemTokens),
      tags: new Set(cleanTags),
      memories: [],
      trajectories: [],
    };
    buckets.push(created);
    return created;
  };

  for (const mem of eligibleMemories) {
    const fallback = normalizeTopicAnchor(mem.topicKey, mem.tags, mem.title);
    const bucket = findOrCreateBucket(mem.topicKey, mem.tags, `${mem.title} ${mem.content}`, fallback);
    for (const tag of mem.tags) {
      const ct = tag.trim().toLowerCase();
      if (ct && !GENERIC_TAGS.has(ct)) bucket.tags.add(ct);
    }
    for (const tok of tokenizeTopicText(mem.title)) bucket.tokens.add(tok);
    bucket.memories.push(mem);
  }

  for (const traj of input.trajectories) {
    // Never pass generic toolNames (read_file, shell, etc.) as semantic topic tags
    const bucket = findOrCreateBucket(undefined, [], `${traj.title} ${traj.problemSummary}`, traj.topicKey);
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
    skillsByTopic.set(s.topicKey, s);
  }

  const readyClusters: ReadySkillCluster[] = [];

  for (const bucket of buckets) {
    const existingSkill = skillsByTopic.get(bucket.anchor);
    const hasOpenDraft = input.existingDrafts.some(
      (d) => d.topicKey === bucket.anchor || (existingSkill && d.revisesSkillName === existingSkill.name),
    );
    if (hasOpenDraft) continue;

    const allEvidenceIds = [...bucket.memories.map((m) => m.id), ...bucket.trajectories.map((t) => t.id)];

    const distinctCwds = [
      ...new Set(bucket.trajectories.map((t) => t.cwd?.trim()).filter((c): c is string => Boolean(c))),
    ];

    if (!existingSkill) {
      const pitfallCount = bucket.memories.filter((m) => m.kind === 'pitfall').length;
      const meetsMemoryGate = bucket.memories.length >= MEMORY_EVIDENCE_THRESHOLD && pitfallCount >= 1;
      const meetsTrajectoryGate = bucket.trajectories.length >= TRAJECTORY_RECURRENCE_THRESHOLD;
      if (!meetsMemoryGate && !meetsTrajectoryGate) continue;

      const sig = computeEvidenceSignature(bucket.anchor, allEvidenceIds);
      if (input.rejectedSignatures.has(sig)) continue;

      const scope: SkillScope = distinctCwds.length === 1 && bucket.memories.length === 0 ? 'workspace' : 'global';
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
