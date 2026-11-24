/**
 * Standard `SKILL.md` parser, serializer, and specification validator.
 *
 * Adapted from the open-source `agentskills/agentskills` specification &
 * validator (MIT License, Copyright (c) Agent Skills Contributors / Anthropic):
 * - Required YAML frontmatter (`name` kebab-case `1..64` chars without `--`,
 *   `description` `10..1024` chars) + plain-text procedural Markdown body.
 * - Enforces ASI safety guardrails: zero executable `.sh`/`.mjs` script bundle
 *   references, full-chain `sanitizeForModel` credential redaction, and `~`
 *   home-directory normalization.
 */

import { containsCredential, normalizeForModel, sanitizeForModel } from '@asi/sense-types';

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SKILL_NAME_LENGTH = 64;
export const MIN_SKILL_DESCRIPTION_LENGTH = 10;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1_024;
export const MAX_WHEN_TO_USE_LENGTH = 500;
export const MAX_COMPATIBILITY_LENGTH = 500;
export const MAX_SKILL_BODY_LENGTH = 16_000;

const BUNDLED_EXECUTABLE_REF_RE = /(?:^|[\s"'`(])(?:\.\/)?scripts\/[A-Za-z0-9_.-]+\.(?:sh|mjs|cjs|js|py|rb|pl)\b/i;

const CJK_SLUG_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/对比度|配色|深色|浅色|主题/, 'contrast-theme'],
  [/无障碍|可读性/, 'a11y'],
  [/测试|单测|验收/, 'testing'],
  [/构建|编译|打包/, 'build-pack'],
  [/缓存/, 'cache'],
  [/数据库|迁移|事务/, 'database'],
  [/权限|鉴权|认证/, 'auth'],
  [/端口|进程|监听/, 'runtime-port'],
  [/内存|泄漏/, 'memory'],
  [/配置|环境变量/, 'config'],
  [/部署|发布/, 'release'],
  [/类型|接口/, 'typecheck'],
  [/路由|网关|流式/, 'routing'],
  [/工作树|分支|冲突/, 'git-worktree'],
  [/技能|工坊/, 'skill-workflow'],
  [/脱敏|隐私|密钥/, 'redaction-safety'],
];

export interface ParsedSkillDocument {
  name: string;
  description: string;
  whenToUse?: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string;
  metadata?: Record<string, string>;
  body: string;
}

export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
  document?: ParsedSkillDocument;
}

function sliceChars(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length > maxChars ? chars.slice(0, maxChars).join('') : text;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function maskHomeDir(input: string, homeDir?: string): string {
  if (!input || !homeDir) return input;
  const cleanHome = homeDir.replace(/[\\/]+$/, '');
  if (!cleanHome || cleanHome === '/') return input;
  const pattern = new RegExp(`${escapeRegExp(cleanHome)}(?=$|[\\\\/\\s"'\`),;:!?\\]}])`, 'g');
  return input.replace(pattern, '~');
}

export function sanitizeSkillText(input: string, maxChars: number, homeDir?: string): string {
  if (!input) return '';
  const preMasked = maskHomeDir(input, homeDir);
  const redacted = sanitizeForModel(preMasked).trim();
  const postMasked = maskHomeDir(redacted, homeDir).trim();
  return sliceChars(postMasked, maxChars);
}

export function sanitizeSkillMarkdownBody(input: string, maxChars = MAX_SKILL_BODY_LENGTH, homeDir?: string): string {
  if (!input) return '';
  const normalizedNewlines = maskHomeDir(input.replace(/\r\n?/g, '\n'), homeDir);
  const rawLines = normalizedNewlines.split('\n');
  const sanitizedLines: string[] = [];

  for (const rawLine of rawLines) {
    const indentMatch = /^([ ]{0,6})(.*)$/.exec(rawLine);
    const indent = indentMatch?.[1] ?? '';
    const content = indentMatch?.[2] ?? rawLine;
    if (!content.trim()) {
      sanitizedLines.push('');
      continue;
    }
    const cleanLine = maskHomeDir(sanitizeForModel(content), homeDir).trimEnd();
    sanitizedLines.push(`${indent}${cleanLine}`);
  }

  // Catch cross-line credential pairs (e.g. `Authorization:` on line N + secret on line N+1)
  for (let i = 0; i + 1 < sanitizedLines.length; i += 1) {
    const pair = `${sanitizedLines[i]}\n${sanitizedLines[i + 1]}`;
    if (containsCredential(normalizeForModel(pair))) {
      const merged = maskHomeDir(sanitizeForModel(pair), homeDir);
      sanitizedLines[i] = merged;
      sanitizedLines[i + 1] = '';
    }
  }

  const collapsed = sanitizedLines
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  return sliceChars(collapsed, maxChars);
}

function deterministicHash6(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(6, '0').slice(0, 6);
}

export function isValidSkillName(name: string): boolean {
  return (
    typeof name === 'string' && name.length >= 1 && name.length <= MAX_SKILL_NAME_LENGTH && SKILL_NAME_RE.test(name)
  );
}

export function toValidSkillSlug(raw: string, fallbackPrefix = 'skill'): string {
  const cleanSource = sanitizeForModel(raw || '').toLowerCase();
  const asciiParts = cleanSource
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .filter((seg) => seg.length >= 2 && !/^\d+$/.test(seg));

  const mappedHints: string[] = [];
  for (const [pattern, slug] of CJK_SLUG_HINTS) {
    if (pattern.test(raw)) {
      mappedHints.push(slug);
      if (mappedHints.length >= 2) break;
    }
  }

  const combined = [...asciiParts.slice(0, 5), ...mappedHints]
    .join('-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  let candidate = combined;
  if (candidate.length < 3) {
    const safePrefix =
      fallbackPrefix
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'skill';
    candidate = `${safePrefix}-${deterministicHash6(raw || safePrefix)}`;
  }

  if (candidate.length > MAX_SKILL_NAME_LENGTH) {
    candidate = candidate.slice(0, MAX_SKILL_NAME_LENGTH).replace(/-+$/g, '');
  }
  if (!isValidSkillName(candidate)) {
    return `skill-${deterministicHash6(raw || 'fallback')}`;
  }
  return candidate;
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function quoteYamlScalarIfNeeded(value: string): string {
  if (!value) return '""';
  if (
    /^[\w./~ -]+$/.test(value) &&
    !/^(?:true|false|null|yes|no|\d+(?:\.\d+)?)$/i.test(value) &&
    value === value.trim()
  ) {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * Parse a `SKILL.md` document (YAML frontmatter + Markdown instruction body).
 */
export function parseSkillMarkdown(rawMarkdown: string, homeDir?: string): SkillValidationResult {
  if (typeof rawMarkdown !== 'string' || !rawMarkdown.trim()) {
    return { valid: false, errors: ['SKILL.md content cannot be empty'] };
  }

  const normalized = rawMarkdown.replace(/\r\n?/g, '\n').trim();
  const fmMatch = /^---\n([\s\S]*?)\n---\s*(?:\n([\s\S]*))?$/.exec(normalized);
  if (!fmMatch) {
    return {
      valid: false,
      errors: ['SKILL.md must start with YAML frontmatter delimited by ---'],
    };
  }

  const fmText = fmMatch[1] ?? '';
  const rawBody = fmMatch[2] ?? '';

  const fields = new Map<string, string>();
  const metadata: Record<string, string> = {};
  const fmLines = fmText.split('\n');

  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i] ?? '';
    if (!line.trim() || line.trimStart().startsWith('#')) {
      i += 1;
      continue;
    }
    const topMatch = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!topMatch) {
      return { valid: false, errors: [`Invalid YAML frontmatter line: ${sanitizeSkillText(line, 80, homeDir)}`] };
    }
    const key = (topMatch[1] ?? '').trim();
    const rest = (topMatch[2] ?? '').trim();

    if (key === 'metadata' && !rest) {
      i += 1;
      while (i < fmLines.length) {
        const sub = fmLines[i] ?? '';
        if (!sub.trim() || sub.trimStart().startsWith('#')) {
          i += 1;
          continue;
        }
        const subMatch = /^[ ]{2,}([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(sub);
        if (!subMatch) break;
        const mk = sanitizeSkillText(subMatch[1] ?? '', 48, homeDir);
        const mv = sanitizeSkillText(unquoteYamlScalar(subMatch[2] ?? ''), 200, homeDir);
        if (mk) metadata[mk] = mv;
        i += 1;
      }
      continue;
    }

    if (rest === '|' || rest === '>') {
      const blockLines: string[] = [];
      i += 1;
      while (i < fmLines.length) {
        const sub = fmLines[i] ?? '';
        if (!sub.trim()) {
          blockLines.push('');
          i += 1;
          continue;
        }
        if (!/^[ ]{2,}/.test(sub)) break;
        blockLines.push(sub.replace(/^[ ]{2}/, '').trimEnd());
        i += 1;
      }
      const joined =
        rest === '>'
          ? blockLines
              .map((s) => s.trim())
              .filter(Boolean)
              .join(' ')
          : blockLines.join('\n');
      fields.set(key, joined.trim());
      continue;
    }

    fields.set(key, unquoteYamlScalar(rest));
    i += 1;
  }

  const rawName = (fields.get('name') ?? '').trim();
  const rawDescription = fields.get('description') ?? '';
  const rawWhenToUse = fields.get('when-to-use') ?? fields.get('whenToUse');
  const rawLicense = fields.get('license');
  const rawCompatibility = fields.get('compatibility') ?? fields.get('compatible-with');
  const rawAllowedTools = fields.get('allowed-tools') ?? fields.get('allowedTools');

  const doc: ParsedSkillDocument = {
    name: sanitizeSkillText(rawName, MAX_SKILL_NAME_LENGTH + 16, homeDir),
    description: sanitizeSkillText(rawDescription, MAX_SKILL_DESCRIPTION_LENGTH + 32, homeDir),
    ...(rawWhenToUse?.trim() ? { whenToUse: sanitizeSkillText(rawWhenToUse, MAX_WHEN_TO_USE_LENGTH, homeDir) } : {}),
    ...(rawLicense?.trim() ? { license: sanitizeSkillText(rawLicense, 64, homeDir) } : {}),
    ...(rawCompatibility?.trim()
      ? { compatibility: sanitizeSkillText(rawCompatibility, MAX_COMPATIBILITY_LENGTH, homeDir) }
      : {}),
    ...(rawAllowedTools?.trim() ? { allowedTools: sanitizeSkillText(rawAllowedTools, 240, homeDir) } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    body: sanitizeSkillMarkdownBody(rawBody, MAX_SKILL_BODY_LENGTH, homeDir),
  };

  return validateSkillDocument(doc, { expectedName: rawName !== doc.name ? '__redacted_invalid__' : undefined });
}

/**
 * Validate a parsed `SKILL.md` document against the `agentskills` spec + ASI safety guardrails.
 */
export function validateSkillDocument(
  doc: ParsedSkillDocument,
  options?: { expectedName?: string; expectedDirName?: string },
): SkillValidationResult {
  const errors: string[] = [];

  if (options?.expectedName === '__redacted_invalid__') {
    errors.push('name contains disallowed or redacted characters');
  }

  if (!doc.name) {
    errors.push('frontmatter field "name" is required');
  } else {
    if (doc.name.length > MAX_SKILL_NAME_LENGTH) {
      errors.push(`skill name must be <= ${MAX_SKILL_NAME_LENGTH} characters`);
    }
    if (!SKILL_NAME_RE.test(doc.name)) {
      errors.push(
        'skill name must contain only lowercase alphanumeric characters and single hyphens (no leading/trailing hyphen or --)',
      );
    }
    if (options?.expectedDirName && doc.name !== options.expectedDirName) {
      errors.push(`skill name "${doc.name}" must match directory name "${options.expectedDirName}"`);
    }
  }

  if (!doc.description) {
    errors.push('frontmatter field "description" is required');
  } else {
    const descLen = [...doc.description].length;
    if (descLen < MIN_SKILL_DESCRIPTION_LENGTH) {
      errors.push(`description must be at least ${MIN_SKILL_DESCRIPTION_LENGTH} characters`);
    }
    if (descLen > MAX_SKILL_DESCRIPTION_LENGTH) {
      errors.push(`description must be at most ${MAX_SKILL_DESCRIPTION_LENGTH} characters`);
    }
  }

  if (doc.whenToUse !== undefined && [...doc.whenToUse].length > MAX_WHEN_TO_USE_LENGTH) {
    errors.push(`when-to-use must be at most ${MAX_WHEN_TO_USE_LENGTH} characters`);
  }

  if (!doc.body || !doc.body.trim()) {
    errors.push('SKILL.md instruction body cannot be empty');
  } else if (BUNDLED_EXECUTABLE_REF_RE.test(doc.body)) {
    errors.push('SKILL.md must remain plain-text procedural guidance without bundled scripts/* executables');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, errors: [], document: doc };
}

/**
 * Render a validated & sanitized `ParsedSkillDocument` into canonical standard `SKILL.md` text.
 */
export function renderSkillMarkdown(doc: ParsedSkillDocument, homeDir?: string): string {
  const cleanName = sanitizeSkillText(doc.name, MAX_SKILL_NAME_LENGTH, homeDir);
  const cleanDesc = sanitizeSkillText(doc.description, MAX_SKILL_DESCRIPTION_LENGTH, homeDir);
  const cleanWhen = doc.whenToUse ? sanitizeSkillText(doc.whenToUse, MAX_WHEN_TO_USE_LENGTH, homeDir) : undefined;
  const cleanLicense = doc.license ? sanitizeSkillText(doc.license, 64, homeDir) : undefined;
  const cleanCompat = doc.compatibility
    ? sanitizeSkillText(doc.compatibility, MAX_COMPATIBILITY_LENGTH, homeDir)
    : undefined;
  const cleanAllowedTools = doc.allowedTools ? sanitizeSkillText(doc.allowedTools, 240, homeDir) : undefined;
  const cleanBody = sanitizeSkillMarkdownBody(doc.body, MAX_SKILL_BODY_LENGTH, homeDir);

  const fmLines: string[] = ['---', `name: ${cleanName}`, `description: ${quoteYamlScalarIfNeeded(cleanDesc)}`];

  if (cleanWhen) {
    fmLines.push(`when-to-use: ${quoteYamlScalarIfNeeded(cleanWhen)}`);
  }
  if (cleanLicense) {
    fmLines.push(`license: ${quoteYamlScalarIfNeeded(cleanLicense)}`);
  }
  if (cleanCompat) {
    fmLines.push(`compatibility: ${quoteYamlScalarIfNeeded(cleanCompat)}`);
  }
  if (cleanAllowedTools) {
    fmLines.push(`allowed-tools: ${quoteYamlScalarIfNeeded(cleanAllowedTools)}`);
  }
  if (doc.metadata && Object.keys(doc.metadata).length > 0) {
    const entries = Object.entries(doc.metadata)
      .map(([k, v]) => [sanitizeSkillText(k, 48, homeDir), sanitizeSkillText(v, 200, homeDir)] as const)
      .filter(([k, v]) => Boolean(k && v));
    if (entries.length > 0) {
      fmLines.push('metadata:');
      for (const [k, v] of entries) {
        fmLines.push(`  ${k}: ${quoteYamlScalarIfNeeded(v)}`);
      }
    }
  }
  fmLines.push('---', '', cleanBody, '');
  return fmLines.join('\n');
}
