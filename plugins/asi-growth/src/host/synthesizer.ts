/**
 * Closed-Loop Procedural Skill Synthesizer & Verification Critic (`asi-growth`).
 *
 * Adapted from `MineDojo/Voyager` (MIT License, Copyright (c) 2023 MineDojo Team):
 * - Observes high-evidence clustered pitfalls, decisions, preferences, and
 *   completed multi-step troubleshooting trajectories.
 * - Synthesizes or iteratively refines (`v1 -> v2+`) plain-text standard
 *   `agentskills` `SKILL.md` documents (zero executable `.sh`/`.mjs` scripts).
 * - Runs a strict deterministic Verification Critic (`parseSkillMarkdown` +
 *   `validateSkillDocument` + `sanitizeForModel`) before admitting any draft,
 *   falling back cleanly to deterministic synthesis when LLM is unavailable or
 *   returns malformed output.
 */

import {
  MAX_SKILL_DESCRIPTION_LENGTH,
  MIN_SKILL_DESCRIPTION_LENGTH,
  type ParsedSkillDocument,
  parseSkillMarkdown,
  renderSkillMarkdown,
  sanitizeSkillMarkdownBody,
  sanitizeSkillText,
  toValidSkillSlug,
  validateSkillDocument,
} from '../shared/skill-spec.js';
import type { ReadySkillCluster } from './evidence.js';

export interface SynthesizedSkillDraft {
  name: string;
  description: string;
  whenToUse: string;
  markdown: string;
  targetVersion: number;
  isRevision: boolean;
  revisesSkillName?: string;
  baseVersion?: number;
  baseMarkdown?: string;
}

function allocateUniqueSkillName(baseName: string, takenNames: ReadonlySet<string>): string {
  const cleanBase = toValidSkillSlug(baseName, 'skill');
  if (!takenNames.has(cleanBase)) return cleanBase;
  for (let suffix = 2; suffix <= 99; suffix += 1) {
    const suffixStr = `-${suffix}`;
    const trimmed = cleanBase.slice(0, Math.max(3, 64 - suffixStr.length)).replace(/-+$/g, '');
    const candidate = `${trimmed}${suffixStr}`;
    if (!takenNames.has(candidate)) return candidate;
  }
  return `${cleanBase.slice(0, 56).replace(/-+$/g, '')}-${Date.now().toString(36).slice(-5)}`;
}

function ensureDescriptionBounds(raw: string, topicKey: string, homeDir?: string): string {
  let clean = sanitizeSkillText(raw, MAX_SKILL_DESCRIPTION_LENGTH, homeDir);
  if ([...clean].length < MIN_SKILL_DESCRIPTION_LENGTH) {
    clean = sanitizeSkillText(
      `Procedural workflow and pitfall guardrails for ${topicKey}. Use when handling related tasks or troubleshooting.`,
      MAX_SKILL_DESCRIPTION_LENGTH,
      homeDir,
    );
  }
  return clean;
}

function neutralizeBundledScriptRef(text: string): string {
  return text.replace(
    /((?:^|[\s"'`([<]))(?:(?:\.\.?\/)+)?scripts\/((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:sh|bash|zsh|fish|mjs|cjs|js|ts|mts|cts|py|rb|pl|ps1|php))\b/gi,
    '$1[script:$2]',
  );
}

function buildDeterministicSkillDocument(
  cluster: ReadySkillCluster,
  resolvedName: string,
  homeDir?: string,
): ParsedSkillDocument {
  const pitfalls = cluster.memories.filter((m) => m.kind === 'pitfall');
  const decisions = cluster.memories.filter((m) => m.kind === 'decision');
  const preferences = cluster.memories.filter((m) => m.kind === 'preference');
  const trajectories = cluster.trajectories;

  const leadHeadline =
    pitfalls[0]?.title ?? decisions[0]?.title ?? preferences[0]?.title ?? trajectories[0]?.title ?? cluster.topicKey;

  const description = ensureDescriptionBounds(
    neutralizeBundledScriptRef(
      `Reusable workflow and pitfall checklist for ${cluster.topicKey} (${leadHeadline}). Use when working on ${cluster.topicKey} tasks or diagnosing related failures.`,
    ),
    cluster.topicKey,
    homeDir,
  );

  const whenToUse = neutralizeBundledScriptRef(
    sanitizeSkillText(
      `Invoke when implementing changes, reviewing code, or troubleshooting issues involving ${cluster.topicKey}.`,
      320,
      homeDir,
    ),
  );

  const sections: string[] = [];
  sections.push(`# ${sanitizeSkillText(leadHeadline, 90, homeDir)}`);
  sections.push('');
  sections.push('## When to Use');
  sections.push(`- Working on tasks, configuration, or reviews involving \`${cluster.topicKey}\`.`);
  if (trajectories.length > 0) {
    const toolsUsed = [...new Set(trajectories.flatMap((t) => t.toolNames))].slice(0, 6);
    if (toolsUsed.length > 0) {
      sections.push(`- Multi-step diagnostics involving tools: ${toolsUsed.join(', ')}.`);
    }
  }

  sections.push('');
  sections.push('## Standard Procedure');
  let stepNum = 1;
  for (const dec of decisions.slice(0, 5)) {
    sections.push(
      `${stepNum}. **${sanitizeSkillText(dec.title, 90, homeDir)}**: ${sanitizeSkillText(dec.content, 280, homeDir)}`,
    );
    stepNum += 1;
  }
  for (const pref of preferences.slice(0, 4)) {
    sections.push(
      `${stepNum}. **${sanitizeSkillText(pref.title, 90, homeDir)}**: ${sanitizeSkillText(pref.content, 280, homeDir)}`,
    );
    stepNum += 1;
  }
  for (const traj of trajectories.slice(0, 4)) {
    sections.push(
      `${stepNum}. **Diagnose & resolve (${sanitizeSkillText(traj.title, 80, homeDir)})**: ${sanitizeSkillText(traj.resolutionSummary, 280, homeDir)}`,
    );
    stepNum += 1;
  }
  if (stepNum === 1) {
    sections.push(
      '1. Inspect current project conventions and reproduce the issue with targeted checks before editing.',
    );
    sections.push('2. Apply minimal, Reversible fixes that satisfy every pitfall guardrail below.');
  }

  if (pitfalls.length > 0) {
    sections.push('');
    sections.push('## Known Pitfalls & Guardrails');
    for (const pit of pitfalls.slice(0, 8)) {
      const isNewInRevision = cluster.isRevision && cluster.newEvidenceIds.includes(pit.id);
      const revTag = isNewInRevision ? `[v${cluster.targetVersion} 新增] ` : '';
      sections.push(
        `- ${revTag}**${sanitizeSkillText(pit.title, 90, homeDir)}**: ${sanitizeSkillText(pit.content, 320, homeDir)}`,
      );
    }
  }

  sections.push('');
  sections.push('## Verification Checklist');
  sections.push('- Run the affected unit, typecheck, lint, or integration suite and confirm zero regressions.');
  sections.push('- Verify every pitfall guardrail above before concluding the task.');

  // If revising an existing custom skill body, preserve custom user notes if any existed outside generated sections
  if (cluster.isRevision && cluster.existingSkill?.markdown) {
    const parsedPrev = parseSkillMarkdown(cluster.existingSkill.markdown, homeDir);
    if (parsedPrev.valid && parsedPrev.document && pitfalls.length === 0 && trajectories.length > 0) {
      const extraSteps = trajectories
        .filter((t) => cluster.newEvidenceIds.includes(t.id))
        .slice(0, 3)
        .map(
          (t) =>
            `- **[v${cluster.targetVersion} 新增排障经验] ${sanitizeSkillText(t.title, 80, homeDir)}**: ${sanitizeSkillText(t.resolutionSummary, 260, homeDir)}`,
        );
      if (extraSteps.length > 0) {
        const mergedBody = neutralizeBundledScriptRef(
          sanitizeSkillMarkdownBody(
            `${parsedPrev.document.body}\n\n### Incremental Updates (v${cluster.targetVersion})\n${extraSteps.join('\n')}`,
            undefined,
            homeDir,
          ),
        );
        return {
          name: resolvedName,
          description: parsedPrev.document.description,
          whenToUse: parsedPrev.document.whenToUse ?? whenToUse,
          license: 'MIT',
          metadata: {
            version: `${cluster.targetVersion}.0.0`,
            'topic-key': cluster.topicKey,
            'synthesized-by': 'asi-growth',
          },
          body: mergedBody,
        };
      }
    }
  }

  return {
    name: resolvedName,
    description,
    whenToUse,
    license: 'MIT',
    metadata: {
      version: `${cluster.targetVersion}.0.0`,
      'topic-key': cluster.topicKey,
      'synthesized-by': 'asi-growth',
    },
    body: neutralizeBundledScriptRef(sanitizeSkillMarkdownBody(sections.join('\n'), undefined, homeDir)),
  };
}

function buildLlmSynthesisPrompt(cluster: ReadySkillCluster, targetName: string, homeDir?: string): string {
  const memBlock = cluster.memories
    .slice(0, 8)
    .map(
      (m, i) =>
        `[M${i + 1} ${m.kind} R=${Math.round(m.retention * 100)}%] ${sanitizeSkillText(m.title, 100, homeDir)}: ${sanitizeSkillText(m.content, 300, homeDir)}`,
    )
    .join('\n');
  const trajBlock = cluster.trajectories
    .slice(0, 5)
    .map(
      (t, i) =>
        `[T${i + 1} tools=${t.toolNames.join(',')}] Problem: ${sanitizeSkillText(t.problemSummary, 160, homeDir)} -> Fix: ${sanitizeSkillText(t.resolutionSummary, 220, homeDir)}`,
    )
    .join('\n');
  const prevBlock =
    cluster.isRevision && cluster.existingSkill
      ? `\nExisting v${cluster.existingSkill.version} SKILL.md to refine into v${cluster.targetVersion}:\n${cluster.existingSkill.markdown.slice(0, 2_500)}\n`
      : '';

  return [
    'Synthesize a concise, reusable plain-text `SKILL.md` following the open Agent Skills specification.',
    'Rules:',
    `- Output JSON ONLY: {"description":"10..300 chars what & when","whenToUse":"concise trigger","body":"Markdown instructions with # Title, ## When to Use, ## Standard Procedure, ## Known Pitfalls & Guardrails, ## Verification Checklist"}`,
    `- Target skill name: "${targetName}" (version v${cluster.targetVersion}).`,
    '- NEVER generate or reference executable scripts (no scripts/*.sh, *.mjs, *.py).',
    '- NEVER include secrets, tokens, emails, or personal identifiers.',
    prevBlock,
    memBlock ? `Consolidated Memories:\n${memBlock}` : '',
    trajBlock ? `Recurring Troubleshooting Trajectories:\n${trajBlock}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function tryParseLlmSkillJson(
  rawText: string | undefined,
  resolvedName: string,
  cluster: ReadySkillCluster,
  homeDir?: string,
): ParsedSkillDocument | undefined {
  if (!rawText) return undefined;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(rawText)?.[1] ?? rawText;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(fenced.slice(start, end + 1)) as {
      description?: unknown;
      whenToUse?: unknown;
      body?: unknown;
    };
    if (typeof parsed.description !== 'string' || typeof parsed.body !== 'string') return undefined;
    const candidate: ParsedSkillDocument = {
      name: resolvedName,
      description: ensureDescriptionBounds(parsed.description, cluster.topicKey, homeDir),
      ...(typeof parsed.whenToUse === 'string' && parsed.whenToUse.trim()
        ? { whenToUse: sanitizeSkillText(parsed.whenToUse, 320, homeDir) }
        : {}),
      license: 'MIT',
      metadata: {
        version: `${cluster.targetVersion}.0.0`,
        'topic-key': cluster.topicKey,
        'synthesized-by': 'asi-growth',
      },
      body: sanitizeSkillMarkdownBody(parsed.body, undefined, homeDir),
    };
    const check = validateSkillDocument(candidate, { expectedDirName: resolvedName });
    return check.valid ? check.document : undefined;
  } catch {
    return undefined;
  }
}

export async function synthesizeSkillDraftForCluster(input: {
  cluster: ReadySkillCluster;
  takenSkillNames: ReadonlySet<string>;
  signal: AbortSignal;
  homeDir?: string;
  llmSynthesize?: (prompt: string, signal: AbortSignal) => Promise<string | undefined>;
}): Promise<SynthesizedSkillDraft> {
  if (input.signal.aborted) {
    const err = new Error('Skill synthesis aborted');
    err.name = 'AbortError';
    throw err;
  }

  const resolvedName = input.cluster.isRevision
    ? input.cluster.suggestedName
    : allocateUniqueSkillName(input.cluster.suggestedName, input.takenSkillNames);

  let doc: ParsedSkillDocument | undefined;

  if (input.llmSynthesize) {
    const prompt = buildLlmSynthesisPrompt(input.cluster, resolvedName, input.homeDir);
    const rawLlm = await input.llmSynthesize(prompt, input.signal).catch(() => undefined);
    if (input.signal.aborted) {
      const err = new Error('Skill synthesis aborted');
      err.name = 'AbortError';
      throw err;
    }
    doc = tryParseLlmSkillJson(rawLlm, resolvedName, input.cluster, input.homeDir);
  }

  if (!doc) {
    doc = buildDeterministicSkillDocument(input.cluster, resolvedName, input.homeDir);
  }

  // Final Voyager-style Verification Critic pass
  const markdown = renderSkillMarkdown(doc, input.homeDir);
  const verified = parseSkillMarkdown(markdown, input.homeDir);
  if (!verified.valid || !verified.document) {
    throw new Error(`Synthesized SKILL.md failed verification critic: ${verified.errors.join('; ')}`);
  }

  return {
    name: verified.document.name,
    description: verified.document.description,
    whenToUse:
      verified.document.whenToUse ??
      `Use when handling tasks or troubleshooting issues related to ${input.cluster.topicKey}.`,
    markdown: renderSkillMarkdown(verified.document, input.homeDir),
    targetVersion: input.cluster.targetVersion,
    isRevision: input.cluster.isRevision,
    ...(input.cluster.isRevision && input.cluster.existingSkill
      ? {
          revisesSkillName: input.cluster.existingSkill.name,
          baseVersion: input.cluster.existingSkill.version,
          baseMarkdown: input.cluster.existingSkill.markdown,
        }
      : {}),
  };
}
