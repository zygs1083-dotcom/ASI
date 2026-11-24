/**
 * Local Atomic Vault for DMN Cross-Repo Insights (`asi-dream`).
 *
 * Persists under `<storageRoot>/vault/`:
 * - `insights.jsonl`: canonical structured `DreamInsightEntry` items
 * - `INSIGHTS.md`: human-readable Markdown mirror grouped by status & kind
 * - `dream-journal.jsonl`: bounded log of recent DMN dream cycles
 *
 * All reads and writes enforce `lstat` non-symlink checks, atomic tmp+rename writes,
 * and `sanitizeDreamText` (`sanitizeForModel` + home-path `~` masking).
 */

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sortDreamInsights } from '../shared/search.js';
import {
  DREAM_INSIGHT_KIND_LABELS,
  type DreamCycleRecord,
  type DreamCycleTrigger,
  type DreamInsightEntry,
  type DreamInsightStatus,
} from '../shared/types.js';
import { isDreamInsightKind } from './dream-engine.js';
import { sanitizeDreamText } from './repo-profiler.js';

const MAX_JOURNAL_RECORDS = 40;

const VALID_STATUSES = new Set<DreamInsightStatus>(['open', 'adopted', 'promoted', 'dismissed']);
const VALID_TRIGGERS = new Set<DreamCycleTrigger>(['auto', 'manual', 'sandbox']);

function isInsightStatus(value: unknown): value is DreamInsightStatus {
  return typeof value === 'string' && VALID_STATUSES.has(value as DreamInsightStatus);
}

function clampScore(value: unknown, fallback = 0.7): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

export function sanitizeInsightEntry(raw: DreamInsightEntry, homeDir?: string): DreamInsightEntry {
  const repoKeys = Array.isArray(raw.repoKeys)
    ? [...new Set(raw.repoKeys.map((r) => sanitizeDreamText(String(r), 80, homeDir)).filter(Boolean))]
    : [];
  const sourceRepos = Array.isArray(raw.sourceRepos)
    ? [...new Set(raw.sourceRepos.map((r) => sanitizeDreamText(String(r), 96, homeDir)).filter(Boolean))]
    : [];
  const tags = Array.isArray(raw.tags)
    ? [...new Set(raw.tags.map((t) => sanitizeDreamText(String(t), 40, homeDir)).filter(Boolean))].slice(0, 10)
    : [];
  const sourceMemoryIds = Array.isArray(raw.sourceMemoryIds)
    ? [...new Set(raw.sourceMemoryIds.map((m) => sanitizeDreamText(String(m), 64, homeDir)).filter(Boolean))]
    : [];
  const sourceSessionIds = Array.isArray(raw.sourceSessionIds)
    ? [...new Set(raw.sourceSessionIds.map((s) => sanitizeDreamText(String(s), 64, homeDir)).filter(Boolean))]
    : [];

  return {
    id: sanitizeDreamText(raw.id || `ins_${randomUUID().slice(0, 12)}`, 64, homeDir),
    kind: isDreamInsightKind(raw.kind) ? raw.kind : 'structural-analogy',
    status: isInsightStatus(raw.status) ? raw.status : 'open',
    title: sanitizeDreamText(raw.title || '跨项目顿悟', 120, homeDir),
    summary: sanitizeDreamText(raw.summary || '', 280, homeDir),
    bridgeMechanism: sanitizeDreamText(raw.bridgeMechanism || '', 220, homeDir),
    actionableHypothesis: sanitizeDreamText(raw.actionableHypothesis || '', 280, homeDir),
    repoKeys,
    sourceRepos,
    ...(raw.targetRepo ? { targetRepo: sanitizeDreamText(raw.targetRepo, 96, homeDir) } : {}),
    sourceMemoryIds,
    sourceSessionIds,
    tags,
    topicKey: sanitizeDreamText(raw.topicKey || 'dmn:general', 80, homeDir),
    pairSignature: sanitizeDreamText(raw.pairSignature || '', 180, homeDir),
    noveltyScore: clampScore(raw.noveltyScore, 0.75),
    structuralSimilarity: clampScore(raw.structuralSimilarity, 0.7),
    confidence: clampScore(raw.confidence, 0.7),
    ...(raw.adoptedMemoryId ? { adoptedMemoryId: sanitizeDreamText(raw.adoptedMemoryId, 64, homeDir) } : {}),
    ...(raw.promotedDraftId ? { promotedDraftId: sanitizeDreamText(raw.promotedDraftId, 64, homeDir) } : {}),
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  };
}

function sanitizeDreamRecord(raw: DreamCycleRecord, homeDir?: string): DreamCycleRecord {
  return {
    id: sanitizeDreamText(raw.id || `drm_${randomUUID().slice(0, 12)}`, 64, homeDir),
    at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : Date.now(),
    trigger: VALID_TRIGGERS.has(raw.trigger) ? raw.trigger : 'auto',
    reposScanned: Math.max(0, Math.trunc(Number(raw.reposScanned) || 0)),
    bridgesEvaluated: Math.max(0, Math.trunc(Number(raw.bridgesEvaluated) || 0)),
    insightsCreated: Math.max(0, Math.trunc(Number(raw.insightsCreated) || 0)),
    insightsReinforced: Math.max(0, Math.trunc(Number(raw.insightsReinforced) || 0)),
    durationMs: Math.max(1, Math.trunc(Number(raw.durationMs) || 1)),
    summary: sanitizeDreamText(raw.summary || '', 220, homeDir),
  };
}

export function renderInsightsMarkdown(entries: readonly DreamInsightEntry[]): string {
  const ordered = sortDreamInsights(entries);
  const lines: string[] = [
    '# ASI DMN Cross-Repo Insights (`INSIGHTS.md`)',
    '',
    '> 由 ASI 默认模式网络（DMN）在深静默期间跨仓库联想生成，仅保存在本机。',
    '',
  ];

  if (ordered.length === 0) {
    lines.push('_暂无跨项目顿悟记录。_', '');
    return lines.join('\n');
  }

  for (const item of ordered) {
    const kindLabel = DREAM_INSIGHT_KIND_LABELS[item.kind];
    lines.push(`## [${item.status.toUpperCase()}] ${kindLabel} · ${item.title}`);
    lines.push(
      `- **ID**: \`${item.id}\` · **置信度**: ${Math.round(item.confidence * 100)}% · **新颖度**: ${Math.round(item.noveltyScore * 100)}%`,
    );
    lines.push(
      `- **关联仓库**: ${item.sourceRepos.join(' ↔ ') || '未知'}${item.targetRepo ? `（目标：${item.targetRepo}）` : ''}`,
    );
    lines.push(`- **现象摘要**: ${item.summary}`);
    lines.push(`- **同构机制**: ${item.bridgeMechanism}`);
    lines.push(`- **行动假说**: ${item.actionableHypothesis}`);
    if (item.tags.length > 0) {
      lines.push(`- **标签**: ${item.tags.map((t) => `\`${t}\``).join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  try {
    const existing = await lstat(filePath).catch(() => undefined);
    if (existing?.isSymbolicLink()) {
      throw new Error('Refusing to overwrite symlink in dream vault');
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('symlink')) throw err;
  }
  const tmp = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function readNonSymlinkText(filePath: string): Promise<string | undefined> {
  try {
    const st = await lstat(filePath);
    if (!st.isFile() || st.isSymbolicLink()) return undefined;
    return await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

export class DreamVault {
  private readonly vaultDir: string;
  private readonly insightsPath: string;
  private readonly markdownPath: string;
  private readonly journalPath: string;
  private entries = new Map<string, DreamInsightEntry>();
  private journal: DreamCycleRecord[] = [];
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    storageRoot: string,
    private readonly homeDir?: string,
  ) {
    this.vaultDir = join(storageRoot, 'vault');
    this.insightsPath = join(this.vaultDir, 'insights.jsonl');
    this.markdownPath = join(this.vaultDir, 'INSIGHTS.md');
    this.journalPath = join(this.vaultDir, 'dream-journal.jsonl');
  }

  async load(): Promise<void> {
    await mkdir(this.vaultDir, { recursive: true });
    const dirStat = await lstat(this.vaultDir);
    if (dirStat.isSymbolicLink()) {
      throw new Error('Dream vault directory must not be a symlink');
    }

    this.entries.clear();
    const rawInsights = await readNonSymlinkText(this.insightsPath);
    if (rawInsights) {
      for (const line of rawInsights.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as DreamInsightEntry;
          if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') {
            const clean = sanitizeInsightEntry(parsed, this.homeDir);
            if (clean.repoKeys.length >= 2 || clean.sourceRepos.length >= 2) {
              this.entries.set(clean.id, clean);
            }
          }
        } catch {
          // Skip malformed JSONL line
        }
      }
    }

    this.journal = [];
    const rawJournal = await readNonSymlinkText(this.journalPath);
    if (rawJournal) {
      for (const line of rawJournal.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as DreamCycleRecord;
          if (parsed && typeof parsed === 'object') {
            this.journal.push(sanitizeDreamRecord(parsed, this.homeDir));
          }
        } catch {
          // Skip malformed journal line
        }
      }
      this.journal.sort((a, b) => b.at - a.at);
      this.journal = this.journal.slice(0, MAX_JOURNAL_RECORDS);
    }
  }

  list(): DreamInsightEntry[] {
    return sortDreamInsights([...this.entries.values()]).map((e) => structuredClone(e));
  }

  get(id: string): DreamInsightEntry | undefined {
    const found = this.entries.get(id);
    return found ? structuredClone(found) : undefined;
  }

  recentJournal(limit = 15): DreamCycleRecord[] {
    return this.journal.slice(0, limit).map((r) => structuredClone(r));
  }

  replaceAll(nextEntries: readonly DreamInsightEntry[]): void {
    this.entries.clear();
    for (const raw of nextEntries) {
      const clean = sanitizeInsightEntry(raw, this.homeDir);
      if (clean.repoKeys.length >= 2 || clean.sourceRepos.length >= 2) {
        this.entries.set(clean.id, clean);
      }
    }
  }

  upsert(entry: DreamInsightEntry): DreamInsightEntry {
    const clean = sanitizeInsightEntry(entry, this.homeDir);
    this.entries.set(clean.id, clean);
    return structuredClone(clean);
  }

  appendJournal(record: DreamCycleRecord): DreamCycleRecord {
    const clean = sanitizeDreamRecord(record, this.homeDir);
    this.journal = [clean, ...this.journal.filter((r) => r.id !== clean.id)].slice(0, MAX_JOURNAL_RECORDS);
    return structuredClone(clean);
  }

  flush(): Promise<void> {
    const run = async () => {
      await mkdir(this.vaultDir, { recursive: true });
      const ordered = sortDreamInsights([...this.entries.values()]);
      const jsonl = ordered.map((e) => JSON.stringify(e)).join('\n');
      const md = renderInsightsMarkdown(ordered);
      const journalJsonl = this.journal.map((r) => JSON.stringify(r)).join('\n');

      await Promise.all([
        atomicWriteFile(this.insightsPath, jsonl ? `${jsonl}\n` : ''),
        atomicWriteFile(this.markdownPath, md),
        atomicWriteFile(this.journalPath, journalJsonl ? `${journalJsonl}\n` : ''),
      ]);
    };
    const next = this.writeChain.then(run, run);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  waitForIdle(): Promise<void> {
    return this.writeChain;
  }
}
