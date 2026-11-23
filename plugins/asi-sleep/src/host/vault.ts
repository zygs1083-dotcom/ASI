/**
 * Local Human-Readable Structured Markdown + JSONL Memory Vault (`asi-sleep`).
 *
 * Persists consolidated memories to `<storageRoot>/vault/`:
 * - `memories.jsonl`: canonical structured store (one sanitized JSON object per line)
 * - `MEMORY.md`: human-readable & bidirectionally human-editable Markdown vault
 * - `sleep-journal.jsonl`: bounded history of NREM/REM sleep consolidation runs
 *
 * Supports external human edits to `MEMORY.md` (detected on startup `load()` and
 * before reads, mutations, and flushes), reconciling manual title/content/tag/pin/kind
 * edits, deletions, and hand-added Markdown sections back into `memories.jsonl` while
 * preserving existing FSRS state for matched IDs.
 *
 * Enforces `sanitizeForModel` + home-directory `~` redaction BOTH before writing
 * to disk AND after reading from disk.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitizeForModel } from '@asi/sense-types';
import {
  type FsrsCardState,
  MEMORY_KIND_LABELS,
  MEMORY_KINDS,
  type MemoryEntry,
  type MemoryKind,
  type SleepConsolidationRecord,
} from '../shared/types.js';
import { computeMemoryRetention, createInitialFsrsState } from './fsrs.js';

const MAX_JOURNAL_RECORDS = 100;
const MAX_TITLE_CHARS = 140;
const MAX_CONTENT_CHARS = 1_600;
const MAX_TAG_CHARS = 40;
const MAX_TAGS = 12;

const MAX_SNAPSHOT_HISTORY = 16;

const VAULT_SYNC_FOOTER_RE = /\n?<!--\s*asi-sleep-vault\s+md=([0-9a-f]+)(?:\s+jsonl=([0-9a-f]+))?\s*-->\s*$/;
const PLACEHOLDER_LINE_RE = /^(?:_暂无(?:未置顶)?条目_|\*暂无(?:未置顶)?条目\*)\s*$/;
const HTML_COMMENT_LINE_RE = /^<!--.*-->\s*$/;
const OPEN_CODE_FENCE_RE = /^\s*(`{3,}(?=[^`]*$)|~{3,})/;

function sha256Short(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 24);
}

function wasTextRedacted(raw: string, homeDir?: string): boolean {
  if (!raw) return false;
  const preMasked = maskHomePath(raw, homeDir);
  if (preMasked !== raw) return true;
  const redacted = sanitizeForModel(preMasked);
  if (redacted !== preMasked) return true;
  const postMasked = maskHomePath(redacted, homeDir);
  return postMasked !== redacted;
}

function sliceChars(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length > maxChars ? chars.slice(0, maxChars).join('') : text;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function maskHomePath(input: string, homeDir?: string): string {
  if (!input || !homeDir) return input;
  const cleanHome = homeDir.replace(/[\\/]+$/, '');
  if (!cleanHome || cleanHome === '/') return input;
  const pattern = new RegExp(`${escapeRegExp(cleanHome)}(?=$|[\\\\/\\s"'\`),;:!?\\]}])`, 'g');
  return input.replace(pattern, '~');
}

export function sanitizeSleepText(input: string, maxChars: number, homeDir?: string): string {
  const preMasked = maskHomePath(input, homeDir);
  const redacted = sanitizeForModel(preMasked).trim();
  const postMasked = maskHomePath(redacted, homeDir).trim();
  return sliceChars(postMasked, maxChars);
}

function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
}

function sanitizeFsrsState(raw: unknown, kind: MemoryKind, fallbackNow: number): FsrsCardState {
  if (!raw || typeof raw !== 'object') {
    return createInitialFsrsState(kind, fallbackNow);
  }
  const r = raw as Partial<FsrsCardState>;
  const num = (v: unknown, def: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : def;
  const fallback = createInitialFsrsState(kind, fallbackNow);
  const lastReview = num(r.lastReview, fallbackNow, 0, Number.MAX_SAFE_INTEGER);
  const stability = Number(num(r.stability, fallback.stability, 0.1, 3_650).toFixed(4));
  return {
    stability,
    difficulty: Number(num(r.difficulty, fallback.difficulty, 1, 10).toFixed(4)),
    elapsedDays: Math.trunc(num(r.elapsedDays, 0, 0, 100_000)),
    scheduledDays: Math.trunc(num(r.scheduledDays, Math.round(stability), 0, 100_000)),
    learningSteps: Math.trunc(num(r.learningSteps, 0, 0, 100)),
    reps: Math.trunc(num(r.reps, 1, 0, 100_000)),
    lapses: Math.trunc(num(r.lapses, 0, 0, 100_000)),
    state: Math.trunc(num(r.state, fallback.state, 0, 3)),
    due: Math.trunc(num(r.due, lastReview + Math.round(stability * 86_400_000), 0, Number.MAX_SAFE_INTEGER)),
    lastReview: Math.trunc(lastReview),
  };
}

export function sanitizeMemoryEntry(entry: MemoryEntry, homeDir?: string): MemoryEntry {
  const now = Number.isFinite(entry.updatedAt) && entry.updatedAt > 0 ? Math.trunc(entry.updatedAt) : Date.now();
  const createdAt = Number.isFinite(entry.createdAt) && entry.createdAt > 0 ? Math.trunc(entry.createdAt) : now;
  const kind: MemoryKind = isMemoryKind(entry.kind) ? entry.kind : 'episode';
  const id = sanitizeSleepText(entry.id || `mem_${randomUUID().slice(0, 12)}`, 64, homeDir).replace(/\s+/g, '_');
  const title = sanitizeSleepText(entry.title || '未命名记忆', MAX_TITLE_CHARS, homeDir) || '未命名记忆';
  const content = sanitizeSleepText(entry.content || title, MAX_CONTENT_CHARS, homeDir) || title;

  const seenTags = new Set<string>();
  const tags: string[] = [];
  for (const rawTag of Array.isArray(entry.tags) ? entry.tags : []) {
    if (typeof rawTag !== 'string') continue;
    const cleaned = sanitizeSleepText(rawTag, MAX_TAG_CHARS, homeDir).toLowerCase();
    if (!cleaned || seenTags.has(cleaned)) continue;
    seenTags.add(cleaned);
    tags.push(cleaned);
    if (tags.length >= MAX_TAGS) break;
  }

  const topicKey =
    typeof entry.topicKey === 'string' && entry.topicKey.trim()
      ? sanitizeSleepText(entry.topicKey, 80, homeDir).toLowerCase().replace(/\s+/g, '-')
      : undefined;

  const sourceSessionIds = [
    ...new Set(
      (Array.isArray(entry.sourceSessionIds) ? entry.sourceSessionIds : [])
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map((s) => sanitizeSleepText(s, 80, homeDir))
        .filter(Boolean),
    ),
  ].slice(0, 20);

  const links = [
    ...new Set(
      (Array.isArray(entry.links) ? entry.links : [])
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0 && s !== id)
        .map((s) => sanitizeSleepText(s, 64, homeDir))
        .filter(Boolean),
    ),
  ].slice(0, 6);

  return {
    id,
    kind,
    title,
    content,
    tags,
    ...(topicKey ? { topicKey } : {}),
    pinned: Boolean(entry.pinned),
    confidence:
      typeof entry.confidence === 'number' && Number.isFinite(entry.confidence)
        ? Number(Math.max(0, Math.min(1, entry.confidence)).toFixed(3))
        : 0.85,
    sourceSessionIds,
    evidenceCount:
      typeof entry.evidenceCount === 'number' && Number.isFinite(entry.evidenceCount)
        ? Math.max(1, Math.trunc(entry.evidenceCount))
        : 1,
    recallCount:
      typeof entry.recallCount === 'number' && Number.isFinite(entry.recallCount)
        ? Math.max(0, Math.trunc(entry.recallCount))
        : 0,
    createdAt,
    updatedAt: now,
    ...(typeof entry.lastRecalledAt === 'number' && Number.isFinite(entry.lastRecalledAt)
      ? { lastRecalledAt: Math.trunc(entry.lastRecalledAt) }
      : {}),
    ...(links.length > 0 ? { links } : {}),
    fsrs: sanitizeFsrsState(entry.fsrs, kind, now),
  };
}

export function sanitizeConsolidationRecord(
  record: SleepConsolidationRecord,
  homeDir?: string,
): SleepConsolidationRecord {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0);
  const trigger = record.trigger === 'manual' || record.trigger === 'sandbox' ? record.trigger : 'auto';
  return {
    id: sanitizeSleepText(record.id || `sleep_${randomUUID().slice(0, 10)}`, 64, homeDir),
    at: num(record.at) || Date.now(),
    trigger,
    turnsProcessed: num(record.turnsProcessed),
    nremCandidates: num(record.nremCandidates),
    createdCount: num(record.createdCount),
    mergedCount: num(record.mergedCount),
    conflictsResolved: num(record.conflictsResolved),
    prunedCount: num(record.prunedCount),
    linksUpdated: num(record.linksUpdated),
    durationMs: num(record.durationMs),
    summary: sanitizeSleepText(record.summary || '睡眠整合已完成', 240, homeDir),
  };
}

export interface ParsedMarkdownMemory {
  id?: string;
  kind?: MemoryKind;
  bracketKind?: MemoryKind;
  sectionKind?: MemoryKind;
  pinned?: boolean;
  rawHeading?: string;
  title: string;
  content: string;
  tags?: string[];
  topicKey?: string;
  links?: string[];
}

function parseKindToken(raw: string): MemoryKind | undefined {
  const token = raw.trim().toLowerCase();
  if (token === 'preference' || token === '偏好') return 'preference';
  if (token === 'decision' || token === '决策') return 'decision';
  if (token === 'pitfall' || token === '踩坑') return 'pitfall';
  if (token === 'episode' || token === '近期进展' || token === '进展') return 'episode';
  return undefined;
}

function parsePinToken(raw: string): boolean | undefined {
  const token = raw.trim().toLowerCase();
  if (
    token === 'pinned' ||
    token === '置顶' ||
    token === '已置顶' ||
    token === 'true' ||
    token === 'yes' ||
    token === '是' ||
    token === '1'
  ) {
    return true;
  }
  if (
    token === 'unpinned' ||
    token === '未置顶' ||
    token === '取消置顶' ||
    token === 'false' ||
    token === 'no' ||
    token === '否' ||
    token === '0'
  ) {
    return false;
  }
  return undefined;
}

function stripSurroundingCodeTicks(value: string): string {
  return value
    .trim()
    .replace(/^`+|`+$/g, '')
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

function parseCommaOrTickList(raw: string, stripHashPrefix = false): string[] {
  const trimmed = raw.trim();
  if (!trimmed || /^(?:none|nil|empty|无|空|-|—)$/i.test(trimmed)) return [];
  const items: string[] = [];
  for (const part of trimmed.split(/[,，、;；]+/)) {
    let cleaned = stripSurroundingCodeTicks(part);
    if (stripHashPrefix) {
      cleaned = cleaned.replace(/^#+/, '').trim();
    }
    if (cleaned) items.push(cleaned);
  }
  return items;
}

function parseSectionHeader(heading: string): { isPinnedSection: boolean; kind?: MemoryKind } {
  const text = heading.trim();
  if (text.includes('已置顶') || /\bpinned\b/i.test(text)) {
    return { isPinnedSection: true };
  }
  if (/\bpreference\b/i.test(text) || text.includes('偏好')) {
    return { isPinnedSection: false, kind: 'preference' };
  }
  if (/\bdecision\b/i.test(text) || text.includes('决策')) {
    return { isPinnedSection: false, kind: 'decision' };
  }
  if (/\bpitfall\b/i.test(text) || text.includes('踩坑')) {
    return { isPinnedSection: false, kind: 'pitfall' };
  }
  if (/\bepisode\b/i.test(text) || text.includes('近期进展') || text.includes('进展')) {
    return { isPinnedSection: false, kind: 'episode' };
  }
  return { isPinnedSection: false };
}

function parseBracketPinToken(raw: string): boolean | undefined {
  const token = raw.trim().toLowerCase();
  if (token === 'pinned' || token === '置顶' || token === '已置顶') {
    return true;
  }
  if (token === 'unpinned' || token === '未置顶' || token === '取消置顶') {
    return false;
  }
  return undefined;
}

function parseEntryHeading(rawHeading: string): {
  rawHeading: string;
  title: string;
  bracketKind?: MemoryKind;
  bracketPinned?: boolean;
} {
  const trimmedHeading = rawHeading.trim();
  let rest = trimmedHeading;
  let bracketKind: MemoryKind | undefined;
  let bracketPinned: boolean | undefined;

  while (rest.startsWith('[')) {
    const closeIdx = rest.indexOf(']');
    if (closeIdx <= 0) break;
    const inside = rest.slice(1, closeIdx).trim();
    const maybeKind = bracketKind === undefined ? parseKindToken(inside) : undefined;
    const maybePin = bracketPinned === undefined ? parseBracketPinToken(inside) : undefined;
    if (maybeKind === undefined && maybePin === undefined) {
      break;
    }
    if (maybeKind !== undefined) bracketKind = maybeKind;
    if (maybePin !== undefined) bracketPinned = maybePin;
    rest = rest.slice(closeIdx + 1).trim();
  }

  return {
    rawHeading: trimmedHeading,
    title: rest || trimmedHeading,
    ...(bracketKind !== undefined ? { bracketKind } : {}),
    ...(bracketPinned !== undefined ? { bracketPinned } : {}),
  };
}

export function parseVaultMarkdown(rawMarkdown: string): ParsedMarkdownMemory[] {
  const normalized = rawMarkdown.replace(/\r\n/g, '\n').replace(VAULT_SYNC_FOOTER_RE, '');
  const lines = normalized.split('\n');
  const parsed: ParsedMarkdownMemory[] = [];

  let currentSection: { isPinnedSection: boolean; kind?: MemoryKind; sawH3: boolean } = {
    isPinnedSection: false,
    sawH3: false,
  };

  interface EntryDraft {
    rawHeading?: string;
    title: string;
    sectionPinned: boolean;
    sectionKind?: MemoryKind;
    bracketKind?: MemoryKind;
    bracketPinned?: boolean;
    explicitKind?: MemoryKind;
    explicitPinned?: boolean;
    id?: string;
    tags?: string[];
    topicKey?: string;
    links?: string[];
    inContentMode: boolean;
    usedContentPrefix: boolean;
    fenceChar?: '`' | '~';
    fenceLen?: number;
    contentLines: string[];
  }

  let draft: EntryDraft | undefined;

  const finalizeDraft = () => {
    if (!draft) return;
    while (draft.contentLines.length > 0) {
      const last = draft.contentLines[draft.contentLines.length - 1] ?? '';
      if (!last.trim() || PLACEHOLDER_LINE_RE.test(last.trim())) {
        draft.contentLines.pop();
      } else {
        break;
      }
    }
    const contentText = draft.contentLines.join('\n').trim();
    const resolvedPinned =
      draft.explicitPinned !== undefined
        ? draft.explicitPinned
        : draft.bracketPinned !== undefined
          ? draft.bracketPinned
          : draft.sectionPinned
            ? true
            : draft.sectionKind !== undefined
              ? false
              : undefined;

    let resolvedKind: MemoryKind | undefined;
    if (draft.explicitKind !== undefined) {
      resolvedKind = draft.explicitKind;
    } else if (draft.bracketKind !== undefined) {
      resolvedKind = draft.bracketKind;
    } else if (draft.sectionKind !== undefined) {
      resolvedKind = draft.sectionKind;
    }

    parsed.push({
      ...(draft.id ? { id: draft.id } : {}),
      ...(resolvedKind ? { kind: resolvedKind } : {}),
      ...(draft.bracketKind ? { bracketKind: draft.bracketKind } : {}),
      ...(draft.sectionKind ? { sectionKind: draft.sectionKind } : {}),
      ...(resolvedPinned !== undefined ? { pinned: resolvedPinned } : {}),
      ...(draft.rawHeading ? { rawHeading: draft.rawHeading } : {}),
      title: draft.title,
      content: contentText || draft.title,
      ...(draft.tags !== undefined ? { tags: draft.tags } : {}),
      ...(draft.topicKey !== undefined ? { topicKey: draft.topicKey } : {}),
      ...(draft.links !== undefined ? { links: draft.links } : {}),
    });
    draft = undefined;
  };

  const tryApplyMetadataLine = (target: EntryDraft, rawLine: string, allowBarePrefix: boolean): boolean => {
    const check = allowBarePrefix ? rawLine.trim() : rawLine;
    const prefixRe = allowBarePrefix ? '^(?:[-*]\\s+)?' : '^[-*]\\s+';

    const idMetaMatch = new RegExp(`${prefixRe}ID\\s*[:：]\\s*(.+)$`, 'i').exec(check);
    if (idMetaMatch) {
      const segments = (idMetaMatch[1] ?? '').split(/\s*(?:·|\|)\s*/);
      const rawId = stripSurroundingCodeTicks(segments[0] ?? '');
      if (rawId && !/^(?:new|auto|none|todo|待生成)$/i.test(rawId)) {
        target.id = rawId;
      }
      if (target.tags === undefined) target.tags = [];
      if (target.links === undefined) target.links = [];
      for (const seg of segments.slice(1)) {
        const tagSeg = /^(?:标签|tags?)\s*[:：]\s*(.*)$/i.exec(seg);
        if (tagSeg) {
          target.tags = parseCommaOrTickList(tagSeg[1] ?? '', true);
          continue;
        }
        const linkSeg = /^(?:关联|links?)\s*[:：]\s*(.*)$/i.exec(seg);
        if (linkSeg) {
          target.links = parseCommaOrTickList(linkSeg[1] ?? '', false);
          continue;
        }
        const topicSeg = /^(?:话题|topic(?:\s*key)?)\s*[:：]\s*(.*)$/i.exec(seg);
        if (topicSeg) {
          target.topicKey = stripSurroundingCodeTicks(topicSeg[1] ?? '');
          continue;
        }
        const pinSeg = /^(?:置顶|pinned)\s*[:：]\s*(.*)$/i.exec(seg);
        if (pinSeg) {
          const p = parsePinToken(stripSurroundingCodeTicks(pinSeg[1] ?? ''));
          if (p !== undefined) target.explicitPinned = p;
          continue;
        }
        const kindSeg = /^(?:类型|分类|kind)\s*[:：]\s*(.*)$/i.exec(seg);
        if (kindSeg) {
          const k = parseKindToken(stripSurroundingCodeTicks(kindSeg[1] ?? ''));
          if (k !== undefined) target.explicitKind = k;
          continue;
        }
        if (/保留率.*\(\s*(?:未置顶|取消置顶|unpinned)\s*\)/i.test(seg)) {
          target.explicitPinned = false;
        }
      }
      return true;
    }

    const standaloneTags = new RegExp(`${prefixRe}(?:标签|tags?)\\s*[:：]\\s*(.*)$`, 'i').exec(check);
    if (standaloneTags) {
      target.tags = parseCommaOrTickList(standaloneTags[1] ?? '', true);
      return true;
    }
    const standaloneLinks = new RegExp(`${prefixRe}(?:关联|links?)\\s*[:：]\\s*(.*)$`, 'i').exec(check);
    if (standaloneLinks) {
      target.links = parseCommaOrTickList(standaloneLinks[1] ?? '', false);
      return true;
    }
    const standaloneTopic = new RegExp(`${prefixRe}(?:话题|topic(?:\\s*key)?)\\s*[:：]\\s*(.*)$`, 'i').exec(check);
    if (standaloneTopic) {
      target.topicKey = stripSurroundingCodeTicks(standaloneTopic[1] ?? '');
      return true;
    }
    const standalonePin = new RegExp(`${prefixRe}(?:置顶|pinned)\\s*[:：]\\s*(.*)$`, 'i').exec(check);
    if (standalonePin) {
      const p = parsePinToken(stripSurroundingCodeTicks(standalonePin[1] ?? ''));
      if (p !== undefined) {
        target.explicitPinned = p;
        return true;
      }
    }
    const standaloneKind = new RegExp(`${prefixRe}(?:类型|分类|kind)\\s*[:：]\\s*(.*)$`, 'i').exec(check);
    if (standaloneKind) {
      const k = parseKindToken(stripSurroundingCodeTicks(standaloneKind[1] ?? ''));
      if (k !== undefined) {
        target.explicitKind = k;
        return true;
      }
    }
    return false;
  };

  const hasNextStructuralBoundary = (fromIndex: number): boolean => {
    for (let j = fromIndex + 1; j < lines.length; j += 1) {
      const nextTrimmed = (lines[j] ?? '').trim();
      if (!nextTrimmed) continue;
      return /^(?:[-*]\s+)?ID\s*[:：]\s*\S+/i.test(nextTrimmed) || PLACEHOLDER_LINE_RE.test(nextTrimmed);
    }
    return false;
  };

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx] ?? '';
    if (draft) {
      if (draft.fenceChar && /^(?:##|###)\s+\S/.test(line) && hasNextStructuralBoundary(lineIdx)) {
        draft.fenceChar = undefined;
        draft.fenceLen = undefined;
      } else {
        const unindentedLine = draft.usedContentPrefix && line.startsWith('  ') ? line.slice(2) : line;
        if (!draft.fenceChar) {
          const openFenceMatch = OPEN_CODE_FENCE_RE.exec(unindentedLine);
          if (openFenceMatch) {
            const marker = openFenceMatch[1] ?? '```';
            draft.fenceChar = marker[0] as '`' | '~';
            draft.fenceLen = marker.length;
            draft.inContentMode = true;
            draft.contentLines.push(unindentedLine);
            continue;
          }
        } else {
          const closeFenceMatch = /^\s*(`{3,}|~{3,})\s*$/.exec(unindentedLine);
          if (closeFenceMatch) {
            const marker = closeFenceMatch[1] ?? '```';
            const ch = marker[0] as '`' | '~';
            if (draft.fenceChar === ch && marker.length >= (draft.fenceLen ?? 3)) {
              draft.fenceChar = undefined;
              draft.fenceLen = undefined;
              draft.contentLines.push(unindentedLine);
              continue;
            }
          }
          draft.contentLines.push(unindentedLine);
          continue;
        }
      }
    }

    if (/^#\s+/.test(line)) {
      finalizeDraft();
      continue;
    }
    const h2Match = /^##\s+(.+?)\s*$/.exec(line);
    if (h2Match) {
      finalizeDraft();
      const sec = parseSectionHeader(h2Match[1] ?? '');
      currentSection = { ...sec, sawH3: false };
      continue;
    }
    const h3Match = /^###\s+(.+?)\s*$/.exec(line);
    if (h3Match) {
      finalizeDraft();
      currentSection.sawH3 = true;
      const head = parseEntryHeading(h3Match[1] ?? '');
      draft = {
        rawHeading: head.rawHeading,
        title: head.title,
        sectionPinned: currentSection.isPinnedSection,
        ...(currentSection.kind ? { sectionKind: currentSection.kind } : {}),
        ...(head.bracketKind ? { bracketKind: head.bracketKind } : {}),
        ...(head.bracketPinned !== undefined ? { bracketPinned: head.bracketPinned } : {}),
        inContentMode: false,
        usedContentPrefix: false,
        contentLines: [],
      };
      continue;
    }

    const trimmed = line.trim();
    if (PLACEHOLDER_LINE_RE.test(trimmed) || HTML_COMMENT_LINE_RE.test(trimmed)) {
      continue;
    }

    if (!draft) {
      // Allow top-level `- title: content` or `- note` bullets directly inside recognized H2 sections
      if (!currentSection.sawH3 && (currentSection.isPinnedSection || currentSection.kind !== undefined)) {
        const bulletMatch = /^[-*]\s+(.+?)\s*$/.exec(line);
        if (bulletMatch) {
          const body = (bulletMatch[1] ?? '').trim();
          if (body && !/^(?:ID|内容|content|标签|tags?)\s*[:：]/i.test(body)) {
            const head = parseEntryHeading(body);
            const colonIdx = head.title.search(/[:：]\s+/);
            const shortTitle =
              colonIdx > 0 && colonIdx <= 60 ? head.title.slice(0, colonIdx).trim() : sliceChars(head.title, 80);
            const fullContent =
              colonIdx > 0 && colonIdx <= 60 ? head.title.slice(colonIdx + 1).trim() || head.title : head.title;
            parsed.push({
              ...(head.bracketKind
                ? { kind: head.bracketKind, bracketKind: head.bracketKind }
                : currentSection.kind
                  ? { kind: currentSection.kind, sectionKind: currentSection.kind }
                  : {}),
              pinned: head.bracketPinned ?? currentSection.isPinnedSection,
              rawHeading: head.rawHeading,
              title: shortTitle,
              content: fullContent,
            });
          }
        }
      }
      continue;
    }

    if (draft.inContentMode) {
      // Support column-0 metadata bullets (`- 标签:`, `- 置顶:`, etc.) placed after `- 内容:` by humans
      if (!/^\s/.test(line) && tryApplyMetadataLine(draft, line, false)) {
        continue;
      }
      draft.contentLines.push(draft.usedContentPrefix && line.startsWith('  ') ? line.slice(2) : line);
      continue;
    }

    if (!trimmed) {
      continue;
    }

    if (tryApplyMetadataLine(draft, line, true)) {
      continue;
    }

    const contentPrefixMatch = /^(?:[-*]\s+)?(?:内容|content)\s*[:：]\s?(.*)$/i.exec(line);
    if (contentPrefixMatch) {
      const firstLine = contentPrefixMatch[1] ?? '';
      draft.inContentMode = true;
      draft.usedContentPrefix = true;
      const inlineOpenFence = OPEN_CODE_FENCE_RE.exec(firstLine);
      if (inlineOpenFence) {
        const marker = inlineOpenFence[1] ?? '```';
        draft.fenceChar = marker[0] as '`' | '~';
        draft.fenceLen = marker.length;
      }
      draft.contentLines.push(firstLine);
      continue;
    }

    draft.inContentMode = true;
    draft.usedContentPrefix = false;
    draft.contentLines.push(line);
  }

  finalizeDraft();
  return parsed;
}

function attachVaultSyncFooter(mdCore: string, jsonlBody: string): string {
  const cleanCore = `${mdCore.replace(VAULT_SYNC_FOOTER_RE, '').trimEnd()}\n`;
  const mdHash = sha256Short(cleanCore);
  const jsonlHash = sha256Short(jsonlBody);
  return `${cleanCore}\n<!-- asi-sleep-vault md=${mdHash} jsonl=${jsonlHash} -->\n`;
}

function inspectVaultMarkdownSync(
  rawMd: string,
  rawJsonl?: string,
): {
  hasFooter: boolean;
  mdMatchesFooter: boolean;
  jsonlMatchesFooter: boolean;
} {
  const normalized = rawMd.replace(/\r\n/g, '\n');
  const match = VAULT_SYNC_FOOTER_RE.exec(normalized);
  if (!match) {
    return { hasFooter: false, mdMatchesFooter: false, jsonlMatchesFooter: false };
  }
  const cleanCore = `${normalized.slice(0, match.index).trimEnd()}\n`;
  const mdMatchesFooter = sha256Short(cleanCore) === match[1];
  const jsonlMatchesFooter =
    rawJsonl !== undefined && match[2] !== undefined ? sha256Short(rawJsonl) === match[2] : false;
  return { hasFooter: true, mdMatchesFooter, jsonlMatchesFooter };
}

function balanceMarkdownFences(text: string): string {
  let fenceChar: '`' | '~' | undefined;
  let fenceLen = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    if (!fenceChar) {
      const m = OPEN_CODE_FENCE_RE.exec(rawLine);
      if (m) {
        const marker = m[1] ?? '```';
        fenceChar = marker[0] as '`' | '~';
        fenceLen = marker.length;
      }
    } else {
      const m = /^\s*(`{3,}|~{3,})\s*$/.exec(rawLine);
      if (m) {
        const marker = m[1] ?? '```';
        if (marker[0] === fenceChar && marker.length >= fenceLen) {
          fenceChar = undefined;
          fenceLen = 0;
        }
      }
    }
  }
  return fenceChar ? `${text}\n${fenceChar.repeat(fenceLen)}` : text;
}

export function renderVaultMarkdown(entries: readonly MemoryEntry[], now: number, homeDir?: string): string {
  const lines: string[] = [
    '# ASI 记忆库 (Memory Vault)',
    '',
    `> 本地结构化长期记忆（由 \`asi-sleep\` 自动维护并经 \`sanitizeForModel\` 脱敏，可直接编辑本文件增删改记忆） · 共 ${entries.length} 条`,
    '',
  ];

  const pinned = entries.filter((e) => e.pinned);
  if (pinned.length > 0) {
    lines.push('## 已置顶记忆 (Pinned · 永不衰减)', '');
    for (const item of pinned) {
      const safeTitle = sanitizeSleepText(item.title, MAX_TITLE_CHARS, homeDir);
      const safeContent = balanceMarkdownFences(sanitizeSleepText(item.content, MAX_CONTENT_CHARS, homeDir)).replace(
        /\r?\n/g,
        '\n  ',
      );
      const tagText = item.tags.length > 0 ? ` · 标签: ${item.tags.map((t) => `\`${t}\``).join(', ')}` : '';
      const linkText =
        item.links && item.links.length > 0 ? ` · 关联: ${item.links.map((l) => `\`${l}\``).join(', ')}` : '';
      lines.push(`### [${MEMORY_KIND_LABELS[item.kind]}] ${safeTitle}`);
      lines.push(`- ID: \`${item.id}\` · 保留率: **100% (已置顶)** · 回忆 ${item.recallCount} 次${tagText}${linkText}`);
      lines.push(`- 内容: ${safeContent}`, '');
    }
  }

  for (const kind of MEMORY_KINDS) {
    const group = entries.filter((e) => e.kind === kind && !e.pinned);
    lines.push(`## ${MEMORY_KIND_LABELS[kind]} (${kind})`, '');
    if (group.length === 0) {
      lines.push('_暂无未置顶条目_', '');
      continue;
    }
    for (const item of group) {
      const retentionPct = Math.round(computeMemoryRetention(item.fsrs, false, now) * 100);
      const safeTitle = sanitizeSleepText(item.title, MAX_TITLE_CHARS, homeDir);
      const safeContent = balanceMarkdownFences(sanitizeSleepText(item.content, MAX_CONTENT_CHARS, homeDir)).replace(
        /\r?\n/g,
        '\n  ',
      );
      const tagText = item.tags.length > 0 ? ` · 标签: ${item.tags.map((t) => `\`${t}\``).join(', ')}` : '';
      const linkText =
        item.links && item.links.length > 0 ? ` · 关联: ${item.links.map((l) => `\`${l}\``).join(', ')}` : '';
      lines.push(`### ${safeTitle}`);
      lines.push(
        `- ID: \`${item.id}\` · FSRS 保留率: **${retentionPct}%** (S=${item.fsrs.stability.toFixed(1)}d) · 证据 ${item.evidenceCount} · 回忆 ${item.recallCount}${tagText}${linkText}`,
      );
      lines.push(`- 内容: ${safeContent}`, '');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

async function atomicWriteText(targetPath: string, content: string): Promise<void> {
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, targetPath);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

export class MemoryVault {
  readonly vaultDir: string;
  readonly memoriesJsonlPath: string;
  readonly markdownPath: string;
  readonly journalJsonlPath: string;

  private entries = new Map<string, MemoryEntry>();
  private journal: SleepConsolidationRecord[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private lastFlushedMarkdown: string | undefined;
  private lastObservedDiskMarkdown: string | undefined;
  private pendingFlushMarkdown: string | undefined;
  private lastFlushedSnapshot: Map<string, MemoryEntry> | undefined;
  private snapshotsByMdHash = new Map<string, Map<string, MemoryEntry>>();
  private needsFlushFromExternalMarkdown = false;

  constructor(
    readonly storageRoot: string,
    private readonly homeDir?: string,
  ) {
    this.vaultDir = join(storageRoot, 'vault');
    this.memoriesJsonlPath = join(this.vaultDir, 'memories.jsonl');
    this.markdownPath = join(this.vaultDir, 'MEMORY.md');
    this.journalJsonlPath = join(this.vaultDir, 'sleep-journal.jsonl');
  }

  private recordFlushedSnapshot(mdBody: string, items: Iterable<MemoryEntry>): void {
    const snap = new Map<string, MemoryEntry>();
    for (const entry of items) {
      snap.set(entry.id, structuredClone(entry));
    }
    this.lastFlushedSnapshot = snap;
    const footerMatch = VAULT_SYNC_FOOTER_RE.exec(mdBody.replace(/\r\n/g, '\n'));
    const mdHash = footerMatch?.[1];
    if (mdHash) {
      this.snapshotsByMdHash.delete(mdHash);
      this.snapshotsByMdHash.set(mdHash, snap);
      while (this.snapshotsByMdHash.size > MAX_SNAPSHOT_HISTORY) {
        const oldest = this.snapshotsByMdHash.keys().next().value;
        if (!oldest) break;
        this.snapshotsByMdHash.delete(oldest);
      }
    }
  }

  private resolveAgainstRef(item: ParsedMarkdownMemory, ref: MemoryEntry): MemoryEntry {
    let nextKind = item.kind ?? ref.kind;
    let rawTitle = item.title;

    // If user dragged a previously pinned `[旧分类] Title` block into a different unpinned H2 kind section,
    // the old `[旧分类]` prefix came from the pinned section badge while `sectionKind` reflects the target section.
    if (
      ref.pinned &&
      item.pinned === false &&
      item.bracketKind === ref.kind &&
      item.sectionKind &&
      item.sectionKind !== ref.kind
    ) {
      nextKind = item.sectionKind;
    } else if (
      !ref.pinned &&
      item.pinned === false &&
      item.sectionKind === ref.kind &&
      item.rawHeading &&
      sanitizeSleepText(item.rawHeading, MAX_TITLE_CHARS, this.homeDir) === ref.title
    ) {
      // Unpinned entry whose literal title already started with `[分类] ...` inside its own section
      nextKind = ref.kind;
      rawTitle = item.rawHeading;
    }

    const nextPinned = item.pinned ?? ref.pinned;
    const nextTitle = sanitizeSleepText(rawTitle, MAX_TITLE_CHARS, this.homeDir) || ref.title;
    const nextContent = sanitizeSleepText(item.content || nextTitle, MAX_CONTENT_CHARS, this.homeDir) || nextTitle;

    return sanitizeMemoryEntry(
      {
        ...ref,
        kind: nextKind,
        pinned: nextPinned,
        title: nextTitle,
        content: nextContent,
        tags: item.tags !== undefined ? item.tags : ref.tags,
        ...(item.topicKey !== undefined
          ? item.topicKey.trim()
            ? { topicKey: item.topicKey }
            : {}
          : ref.topicKey
            ? { topicKey: ref.topicKey }
            : {}),
        updatedAt: ref.updatedAt,
        fsrs: structuredClone(ref.fsrs),
      },
      this.homeDir,
    );
  }

  private reconcileMarkdownIntoEntries(rawMarkdown: string, now: number): { redacted: boolean } {
    const footerMatch = VAULT_SYNC_FOOTER_RE.exec(rawMarkdown.replace(/\r\n/g, '\n'));
    const footerMdHash = footerMatch?.[1];
    const baseSnapshot =
      footerMdHash && this.snapshotsByMdHash.has(footerMdHash)
        ? this.snapshotsByMdHash.get(footerMdHash)
        : this.lastFlushedSnapshot;

    const parsedItems = parseVaultMarkdown(rawMarkdown);
    const nextMap = new Map<string, MemoryEntry>();
    const claimedExistingIds = new Set<string>();
    const rawLinksById = new Map<string, string[] | undefined>();
    let redacted = false;

    const normalizedIds = parsedItems.map((item) =>
      item.id ? sanitizeSleepText(item.id, 64, this.homeDir).replace(/\s+/g, '_') : undefined,
    );

    // Disambiguate copy-pasted duplicate IDs so an unmodified original block keeps its ID & FSRS
    // even when a user pastes a duplicate block above it.
    const idIndices = new Map<string, number[]>();
    for (let idx = 0; idx < normalizedIds.length; idx += 1) {
      const cid = normalizedIds[idx];
      if (!cid) continue;
      const list = idIndices.get(cid) ?? [];
      list.push(idx);
      idIndices.set(cid, list);
    }
    const preferredOwnerIdxById = new Map<string, number>();
    for (const [cid, indices] of idIndices) {
      if (indices.length === 0) continue;
      if (indices.length === 1) {
        preferredOwnerIdxById.set(cid, indices[0] ?? 0);
        continue;
      }
      const ref = this.entries.get(cid) ?? baseSnapshot?.get(cid);
      if (!ref) {
        preferredOwnerIdxById.set(cid, indices[0] ?? 0);
        continue;
      }
      let bestIdx = indices[0] ?? 0;
      let bestScore = -1;
      for (const candidateIdx of indices) {
        const parsedItem = parsedItems[candidateIdx];
        if (!parsedItem) continue;
        const resolved = this.resolveAgainstRef(parsedItem, ref);
        const score =
          (resolved.title === ref.title ? 2 : 0) +
          (resolved.content === ref.content ? 2 : 0) +
          (resolved.kind === ref.kind ? 1 : 0);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = candidateIdx;
        }
      }
      preferredOwnerIdxById.set(cid, bestIdx);
    }

    // Inspect parsed items for credential/home-path redaction and perform 3-way reconciliation
    for (let idx = 0; idx < parsedItems.length; idx += 1) {
      const item = parsedItems[idx];
      if (!item) continue;
      if (
        (item.id && wasTextRedacted(item.id, this.homeDir)) ||
        wasTextRedacted(item.title, this.homeDir) ||
        wasTextRedacted(item.content, this.homeDir) ||
        (item.topicKey && wasTextRedacted(item.topicKey, this.homeDir)) ||
        (item.tags?.some((t) => wasTextRedacted(t, this.homeDir)) ?? false) ||
        (item.links?.some((l) => wasTextRedacted(l, this.homeDir)) ?? false)
      ) {
        redacted = true;
      }

      const candidateRawId = normalizedIds[idx];
      const isPreferredOwner =
        candidateRawId !== undefined &&
        !claimedExistingIds.has(candidateRawId) &&
        preferredOwnerIdxById.get(candidateRawId) === idx;
      const liveExisting = isPreferredOwner && candidateRawId ? this.entries.get(candidateRawId) : undefined;
      const baseExisting = isPreferredOwner && candidateRawId ? baseSnapshot?.get(candidateRawId) : undefined;

      if (candidateRawId && isPreferredOwner && (liveExisting || baseExisting)) {
        if (!liveExisting && baseExisting) {
          // Deleted or REM-pruned in RAM since baseSnapshot: keep only if human explicitly modified it in MEMORY.md
          const againstBase = this.resolveAgainstRef(item, baseExisting);
          const normalizedBaseLinks = baseExisting.links ?? [];
          const normalizedItemLinks =
            item.links !== undefined
              ? [...new Set(item.links.map((l) => sanitizeSleepText(l, 64, this.homeDir)).filter(Boolean))]
              : normalizedBaseLinks;
          const humanEditedDeleted =
            againstBase.kind !== baseExisting.kind ||
            againstBase.pinned !== baseExisting.pinned ||
            againstBase.title !== baseExisting.title ||
            againstBase.content !== baseExisting.content ||
            againstBase.topicKey !== baseExisting.topicKey ||
            JSON.stringify(againstBase.tags) !== JSON.stringify(baseExisting.tags) ||
            JSON.stringify(normalizedItemLinks) !== JSON.stringify(normalizedBaseLinks);
          if (!humanEditedDeleted) {
            claimedExistingIds.add(candidateRawId);
            continue;
          }
          claimedExistingIds.add(candidateRawId);
          const resurrected: MemoryEntry = {
            ...againstBase,
            updatedAt: now,
            fsrs: structuredClone(baseExisting.fsrs),
          };
          nextMap.set(resurrected.id, resurrected);
          rawLinksById.set(resurrected.id, item.links !== undefined ? item.links : baseExisting.links);
          continue;
        }

        const existing = liveExisting ?? baseExisting;
        if (!existing) continue;
        claimedExistingIds.add(candidateRawId);

        if (liveExisting && baseExisting) {
          const againstBase = this.resolveAgainstRef(item, baseExisting);
          const changedKind = againstBase.kind !== baseExisting.kind;
          const changedPinned = againstBase.pinned !== baseExisting.pinned;
          const changedTitle = againstBase.title !== baseExisting.title;
          const changedContent = againstBase.content !== baseExisting.content;
          const changedTopic = againstBase.topicKey !== baseExisting.topicKey;
          const changedTags = JSON.stringify(againstBase.tags) !== JSON.stringify(baseExisting.tags);
          const changedAny =
            changedKind || changedPinned || changedTitle || changedContent || changedTopic || changedTags;

          const effectiveTopic = changedTopic ? againstBase.topicKey : liveExisting.topicKey;
          const mergedProvisional = sanitizeMemoryEntry(
            {
              ...liveExisting,
              kind: changedKind ? againstBase.kind : liveExisting.kind,
              pinned: changedPinned ? againstBase.pinned : liveExisting.pinned,
              title: changedTitle ? againstBase.title : liveExisting.title,
              content: changedContent ? againstBase.content : liveExisting.content,
              tags: changedTags ? againstBase.tags : liveExisting.tags,
              ...(effectiveTopic ? { topicKey: effectiveTopic } : {}),
              updatedAt: changedAny ? Math.max(now, liveExisting.updatedAt) : liveExisting.updatedAt,
              fsrs: structuredClone(liveExisting.fsrs),
            },
            this.homeDir,
          );
          if (!effectiveTopic) {
            delete mergedProvisional.topicKey;
          }
          const mergedEntry: MemoryEntry = {
            ...mergedProvisional,
            updatedAt: changedAny ? Math.max(now, liveExisting.updatedAt) : liveExisting.updatedAt,
            fsrs: structuredClone(liveExisting.fsrs),
          };
          const baseLinks = baseExisting.links ?? [];
          const parsedLinksNorm =
            item.links !== undefined
              ? [...new Set(item.links.map((l) => sanitizeSleepText(l, 64, this.homeDir)).filter(Boolean))]
              : undefined;
          const changedLinks =
            parsedLinksNorm !== undefined && JSON.stringify(parsedLinksNorm) !== JSON.stringify(baseLinks);
          nextMap.set(mergedEntry.id, mergedEntry);
          rawLinksById.set(mergedEntry.id, changedLinks ? item.links : liveExisting.links);
        } else {
          const provisional = this.resolveAgainstRef(item, existing);
          const changed =
            provisional.kind !== existing.kind ||
            provisional.pinned !== existing.pinned ||
            provisional.title !== existing.title ||
            provisional.content !== existing.content ||
            provisional.topicKey !== existing.topicKey ||
            JSON.stringify(provisional.tags) !== JSON.stringify(existing.tags);

          const mergedEntry: MemoryEntry = {
            ...provisional,
            updatedAt: changed ? now : existing.updatedAt,
            fsrs: structuredClone(existing.fsrs),
          };
          nextMap.set(mergedEntry.id, mergedEntry);
          rawLinksById.set(mergedEntry.id, item.links !== undefined ? item.links : existing.links);
        }
      } else {
        const assignedId =
          candidateRawId &&
          !nextMap.has(candidateRawId) &&
          !claimedExistingIds.has(candidateRawId) &&
          !this.entries.has(candidateRawId) &&
          !baseSnapshot?.has(candidateRawId)
            ? candidateRawId
            : `mem_${randomUUID().slice(0, 12)}`;
        const nextKind: MemoryKind = item.kind ?? 'episode';
        const nextPinned = Boolean(item.pinned);
        const created = sanitizeMemoryEntry(
          {
            id: assignedId,
            kind: nextKind,
            title: item.title || '未命名记忆',
            content: item.content || item.title || '未命名记忆',
            tags: item.tags ?? [],
            ...(item.topicKey?.trim() ? { topicKey: item.topicKey } : {}),
            pinned: nextPinned,
            confidence: 1,
            sourceSessionIds: ['manual'],
            evidenceCount: 1,
            recallCount: 0,
            createdAt: now,
            updatedAt: now,
            fsrs: createInitialFsrsState(nextKind, now),
          },
          this.homeDir,
        );
        nextMap.set(created.id, created);
        rawLinksById.set(created.id, item.links);
      }
    }

    // Preserve concurrent in-RAM / background-consolidated entries that did not exist in baseSnapshot
    if (baseSnapshot !== undefined) {
      for (const [liveId, liveEntry] of this.entries) {
        if (!baseSnapshot.has(liveId) && !nextMap.has(liveId)) {
          const preserved = structuredClone(liveEntry);
          nextMap.set(liveId, preserved);
          rawLinksById.set(liveId, preserved.links);
        }
      }
    }

    // Filter associative links so deleted entries leave zero dangling references
    const survivingIds = new Set(nextMap.keys());
    for (const [entryId, entry] of nextMap) {
      const candidateLinks = rawLinksById.get(entryId);
      const validLinks = (candidateLinks ?? [])
        .map((l) => sanitizeSleepText(l, 64, this.homeDir))
        .filter((l) => Boolean(l) && l !== entryId && survivingIds.has(l));
      const deduped = [...new Set(validLinks)].slice(0, 6);
      const { links: _prev, ...rest } = entry;
      nextMap.set(entryId, deduped.length > 0 ? { ...rest, links: deduped } : rest);
    }

    this.entries = nextMap;
    return { redacted };
  }

  private checkAndReconcileDiskMarkdownRaw(rawMd: string, now: number): { reconciled: boolean; redacted: boolean } {
    if (
      rawMd === this.lastObservedDiskMarkdown ||
      rawMd === this.lastFlushedMarkdown ||
      rawMd === this.pendingFlushMarkdown
    ) {
      return { reconciled: false, redacted: false };
    }
    const { redacted } = this.reconcileMarkdownIntoEntries(rawMd, now);
    this.lastObservedDiskMarkdown = rawMd;
    this.needsFlushFromExternalMarkdown = true;
    return { reconciled: true, redacted };
  }

  private reconcileFromDiskMarkdownSync(now: number = Date.now()): boolean {
    let rawMd: string;
    try {
      rawMd = readFileSync(this.markdownPath, 'utf8');
    } catch {
      return false;
    }
    return this.checkAndReconcileDiskMarkdownRaw(rawMd, now).reconciled;
  }

  hasPendingExternalFlush(): boolean {
    return this.needsFlushFromExternalMarkdown;
  }

  async syncExternalChanges(now: number = Date.now()): Promise<boolean> {
    let rawMd: string | undefined;
    try {
      rawMd = await readFile(this.markdownPath, 'utf8');
    } catch {
      rawMd = undefined;
    }
    let reconciled = false;
    if (rawMd !== undefined) {
      reconciled = this.checkAndReconcileDiskMarkdownRaw(rawMd, now).reconciled;
    }
    if (reconciled || this.needsFlushFromExternalMarkdown) {
      await this.flush(now);
      return true;
    }
    return false;
  }

  waitForIdle(): Promise<void> {
    return this.writeChain;
  }

  async load(now: number = Date.now()): Promise<{ redactedOnLoad: boolean }> {
    await mkdir(this.vaultDir, { recursive: true });
    this.entries.clear();
    this.journal = [];
    this.lastFlushedMarkdown = undefined;
    this.lastObservedDiskMarkdown = undefined;
    this.lastFlushedSnapshot = undefined;
    this.snapshotsByMdHash.clear();
    this.needsFlushFromExternalMarkdown = false;
    let redactedOnLoad = false;
    let rawJsonl = '';
    let hasJsonlFile = false;

    try {
      rawJsonl = await readFile(this.memoriesJsonlPath, 'utf8');
      hasJsonlFile = true;
      for (const line of rawJsonl.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as MemoryEntry;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
          const sanitized = sanitizeMemoryEntry(parsed, this.homeDir);
          if (
            sanitized.id !== parsed.id ||
            sanitized.title !== parsed.title ||
            sanitized.content !== parsed.content ||
            sanitized.topicKey !== parsed.topicKey ||
            JSON.stringify(sanitized.tags) !== JSON.stringify(parsed.tags ?? []) ||
            JSON.stringify(sanitized.sourceSessionIds) !== JSON.stringify(parsed.sourceSessionIds ?? []) ||
            JSON.stringify(sanitized.links ?? []) !== JSON.stringify(parsed.links ?? [])
          ) {
            redactedOnLoad = true;
          }
          this.entries.set(sanitized.id, sanitized);
        } catch {
          // Skip malformed line without failing vault startup
        }
      }
    } catch {
      // Vault JSONL does not exist yet
    }

    try {
      const rawJournal = await readFile(this.journalJsonlPath, 'utf8');
      for (const line of rawJournal.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as SleepConsolidationRecord;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
          const sanitizedRec = sanitizeConsolidationRecord(parsed, this.homeDir);
          if (sanitizedRec.id !== parsed.id || sanitizedRec.summary !== parsed.summary) {
            redactedOnLoad = true;
          }
          this.journal.push(sanitizedRec);
        } catch {
          // Ignore malformed journal entry
        }
      }
      if (this.journal.length > MAX_JOURNAL_RECORDS) {
        this.journal = this.journal.slice(-MAX_JOURNAL_RECORDS);
      }
    } catch {
      // Journal does not exist yet
    }

    let rawMd: string | undefined;
    try {
      rawMd = await readFile(this.markdownPath, 'utf8');
    } catch {
      rawMd = undefined;
    }

    let shouldFlush = redactedOnLoad;

    if (rawMd !== undefined) {
      const syncInfo = inspectVaultMarkdownSync(rawMd, hasJsonlFile ? rawJsonl : undefined);
      if (!syncInfo.hasFooter || !syncInfo.mdMatchesFooter) {
        // Human created or edited MEMORY.md externally -> reconcile into entries while preserving FSRS for matched IDs
        const rec = this.reconcileMarkdownIntoEntries(rawMd, now);
        if (rec.redacted) redactedOnLoad = true;
        this.lastObservedDiskMarkdown = rawMd;
        shouldFlush = true;
      } else if (syncInfo.jsonlMatchesFooter) {
        this.lastFlushedMarkdown = rawMd;
        this.lastObservedDiskMarkdown = rawMd;
        this.recordFlushedSnapshot(rawMd, this.entries.values());
      } else {
        // MEMORY.md matches its own asi-sleep footer, while memories.jsonl differs (or does not exist).
        // Check if MEMORY.md was explicitly replaced at or after memories.jsonl, or if memories.jsonl is absent.
        let mdNewerThanJsonl = !hasJsonlFile;
        if (hasJsonlFile) {
          const [mdStat, jsonlStat] = await Promise.all([
            stat(this.markdownPath).catch(() => undefined),
            stat(this.memoriesJsonlPath).catch(() => undefined),
          ]);
          if (mdStat && jsonlStat && mdStat.mtimeMs >= jsonlStat.mtimeMs) {
            mdNewerThanJsonl = true;
          }
        }
        if (mdNewerThanJsonl) {
          const rec = this.reconcileMarkdownIntoEntries(rawMd, now);
          if (rec.redacted) redactedOnLoad = true;
          this.lastObservedDiskMarkdown = rawMd;
        } else {
          // memories.jsonl was edited externally; mark lastObservedDiskMarkdown = rawMd so flush() won't overwrite jsonl with old md
          this.lastFlushedMarkdown = rawMd;
          this.lastObservedDiskMarkdown = rawMd;
        }
        shouldFlush = true;
      }
    } else if (hasJsonlFile && this.entries.size > 0) {
      shouldFlush = true;
    }

    if (shouldFlush) {
      await this.flush(now);
    } else if (this.lastFlushedSnapshot === undefined) {
      this.lastFlushedSnapshot = new Map(
        [...this.entries.entries()].map(([id, entry]) => [id, structuredClone(entry)]),
      );
    }
    return { redactedOnLoad };
  }

  list(now: number = Date.now()): MemoryEntry[] {
    this.reconcileFromDiskMarkdownSync(now);
    return [...this.entries.values()]
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
      })
      .map((e) => structuredClone(e));
  }

  get(id: string, now: number = Date.now()): MemoryEntry | undefined {
    this.reconcileFromDiskMarkdownSync(now);
    const found = this.entries.get(id);
    return found ? structuredClone(found) : undefined;
  }

  size(now: number = Date.now()): number {
    this.reconcileFromDiskMarkdownSync(now);
    return this.entries.size;
  }

  recentJournal(limit = 15): SleepConsolidationRecord[] {
    return this.journal
      .slice(-limit)
      .reverse()
      .map((r) => structuredClone(r));
  }

  replaceAll(nextEntries: readonly MemoryEntry[]): void {
    this.entries.clear();
    for (const item of nextEntries) {
      const clean = sanitizeMemoryEntry(item, this.homeDir);
      this.entries.set(clean.id, clean);
    }
  }

  upsert(entry: MemoryEntry): MemoryEntry {
    this.reconcileFromDiskMarkdownSync(
      Number.isFinite(entry.updatedAt) && entry.updatedAt > 0 ? Math.trunc(entry.updatedAt) : Date.now(),
    );
    const clean = sanitizeMemoryEntry(entry, this.homeDir);
    this.entries.set(clean.id, clean);
    return structuredClone(clean);
  }

  delete(id: string, now: number = Date.now()): boolean {
    this.reconcileFromDiskMarkdownSync(now);
    const existed = this.entries.delete(id);
    if (existed) {
      for (const [entryId, item] of this.entries) {
        if (item.links?.includes(id)) {
          const filteredLinks = item.links.filter((l) => l !== id);
          const { links: _old, ...rest } = item;
          this.entries.set(entryId, filteredLinks.length > 0 ? { ...rest, links: filteredLinks } : rest);
        }
      }
    }
    return existed;
  }

  appendJournal(record: SleepConsolidationRecord): SleepConsolidationRecord {
    const clean = sanitizeConsolidationRecord(record, this.homeDir);
    this.journal.push(clean);
    if (this.journal.length > MAX_JOURNAL_RECORDS) {
      this.journal = this.journal.slice(-MAX_JOURNAL_RECORDS);
    }
    return structuredClone(clean);
  }

  flush(now: number = Date.now()): Promise<void> {
    const run = async () => {
      await mkdir(this.vaultDir, { recursive: true });
      const diskMd = await readFile(this.markdownPath, 'utf8').catch(() => undefined);
      if (diskMd !== undefined) {
        this.checkAndReconcileDiskMarkdownRaw(diskMd, now);
      }

      const sorted = [...this.entries.values()].map((e) => sanitizeMemoryEntry(e, this.homeDir));
      sorted.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
      });
      const jsonlBody = sorted.length > 0 ? `${sorted.map((item) => JSON.stringify(item)).join('\n')}\n` : '';
      const mdCore = renderVaultMarkdown(sorted, now, this.homeDir);
      const mdBody = attachVaultSyncFooter(mdCore, jsonlBody);
      const journalBody =
        this.journal.length > 0
          ? `${this.journal.map((r) => JSON.stringify(sanitizeConsolidationRecord(r, this.homeDir))).join('\n')}\n`
          : '';

      this.pendingFlushMarkdown = mdBody;
      try {
        await Promise.all([
          atomicWriteText(this.memoriesJsonlPath, jsonlBody),
          atomicWriteText(this.markdownPath, mdBody),
          atomicWriteText(this.journalJsonlPath, journalBody),
        ]);
        this.lastFlushedMarkdown = mdBody;
        this.lastObservedDiskMarkdown = mdBody;
        this.recordFlushedSnapshot(mdBody, sorted);
        this.needsFlushFromExternalMarkdown = false;
      } finally {
        this.pendingFlushMarkdown = undefined;
      }
    };
    const next = this.writeChain.then(run, run);
    this.writeChain = next.catch(() => undefined);
    return next;
  }
}
