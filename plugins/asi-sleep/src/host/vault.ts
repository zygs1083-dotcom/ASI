/**
 * Local Human-Readable Structured Markdown + JSONL Memory Vault (`asi-sleep`).
 *
 * Persists consolidated memories to `<storageRoot>/vault/`:
 * - `memories.jsonl`: canonical structured store (one sanitized JSON object per line)
 * - `MEMORY.md`: human-readable Markdown digest grouped by pinned & memory kinds
 * - `sleep-journal.jsonl`: bounded history of NREM/REM sleep consolidation runs
 *
 * Enforces `sanitizeForModel` + home-directory `~` redaction BOTH before writing
 * to disk AND after reading from disk.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

function sliceChars(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length > maxChars ? chars.slice(0, maxChars).join('') : text;
}

export function maskHomePath(input: string, homeDir?: string): string {
  if (!input || !homeDir) return input;
  const cleanHome = homeDir.endsWith('/') && homeDir.length > 1 ? homeDir.slice(0, -1) : homeDir;
  if (!cleanHome || cleanHome === '/') return input;
  return input.split(cleanHome).join('~');
}

export function sanitizeSleepText(input: string, maxChars: number, homeDir?: string): string {
  const homeMasked = maskHomePath(input, homeDir);
  const redacted = sanitizeForModel(homeMasked).trim();
  return sliceChars(redacted, maxChars);
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

export function renderVaultMarkdown(entries: readonly MemoryEntry[], now: number, homeDir?: string): string {
  const lines: string[] = [
    '# ASI 记忆库 (Memory Vault)',
    '',
    `> 本地结构化长期记忆（由 \`asi-sleep\` 自动维护并经 \`sanitizeForModel\` 脱敏） · 共 ${entries.length} 条`,
    '',
  ];

  const pinned = entries.filter((e) => e.pinned);
  if (pinned.length > 0) {
    lines.push('## 已置顶记忆 (Pinned · 永不衰减)', '');
    for (const item of pinned) {
      const safeTitle = sanitizeSleepText(item.title, MAX_TITLE_CHARS, homeDir);
      const safeContent = sanitizeSleepText(item.content, MAX_CONTENT_CHARS, homeDir);
      const tagText = item.tags.length > 0 ? ` · 标签: ${item.tags.map((t) => `\`${t}\``).join(', ')}` : '';
      lines.push(`### [${MEMORY_KIND_LABELS[item.kind]}] ${safeTitle}`);
      lines.push(`- ID: \`${item.id}\` · 保留率: **100% (已置顶)** · 回忆 ${item.recallCount} 次${tagText}`);
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
      const safeContent = sanitizeSleepText(item.content, MAX_CONTENT_CHARS, homeDir);
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

  constructor(
    readonly storageRoot: string,
    private readonly homeDir?: string,
  ) {
    this.vaultDir = join(storageRoot, 'vault');
    this.memoriesJsonlPath = join(this.vaultDir, 'memories.jsonl');
    this.markdownPath = join(this.vaultDir, 'MEMORY.md');
    this.journalJsonlPath = join(this.vaultDir, 'sleep-journal.jsonl');
  }

  async load(now: number = Date.now()): Promise<{ redactedOnLoad: boolean }> {
    await mkdir(this.vaultDir, { recursive: true });
    this.entries.clear();
    this.journal = [];
    let redactedOnLoad = false;

    try {
      const rawJsonl = await readFile(this.memoriesJsonlPath, 'utf8');
      for (const line of rawJsonl.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as MemoryEntry;
          if (!parsed || typeof parsed !== 'object') continue;
          const sanitized = sanitizeMemoryEntry(parsed, this.homeDir);
          if (sanitized.title !== parsed.title || sanitized.content !== parsed.content) {
            redactedOnLoad = true;
          }
          this.entries.set(sanitized.id, sanitized);
        } catch {
          // Skip malformed line without failing vault startup
        }
      }
    } catch {
      // Vault does not exist yet
    }

    try {
      const rawJournal = await readFile(this.journalJsonlPath, 'utf8');
      for (const line of rawJournal.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as SleepConsolidationRecord;
          if (!parsed || typeof parsed !== 'object') continue;
          this.journal.push(sanitizeConsolidationRecord(parsed, this.homeDir));
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

    if (redactedOnLoad) {
      await this.flush(now);
    }
    return { redactedOnLoad };
  }

  list(): MemoryEntry[] {
    return [...this.entries.values()]
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
      })
      .map((e) => structuredClone(e));
  }

  get(id: string): MemoryEntry | undefined {
    const found = this.entries.get(id);
    return found ? structuredClone(found) : undefined;
  }

  size(): number {
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
    const clean = sanitizeMemoryEntry(entry, this.homeDir);
    this.entries.set(clean.id, clean);
    return structuredClone(clean);
  }

  delete(id: string): boolean {
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
      const sorted = [...this.entries.values()].map((e) => sanitizeMemoryEntry(e, this.homeDir));
      sorted.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
      });
      const jsonlBody = sorted.length > 0 ? `${sorted.map((item) => JSON.stringify(item)).join('\n')}\n` : '';
      const mdBody = renderVaultMarkdown(sorted, now, this.homeDir);
      const journalBody =
        this.journal.length > 0
          ? `${this.journal.map((r) => JSON.stringify(sanitizeConsolidationRecord(r, this.homeDir))).join('\n')}\n`
          : '';

      await Promise.all([
        atomicWriteText(this.memoriesJsonlPath, jsonlBody),
        atomicWriteText(this.markdownPath, mdBody),
        atomicWriteText(this.journalJsonlPath, journalBody),
      ]);
    };
    const next = this.writeChain.then(run, run);
    this.writeChain = next.catch(() => undefined);
    return next;
  }
}
