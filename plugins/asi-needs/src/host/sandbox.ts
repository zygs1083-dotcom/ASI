/**
 * Tier 2: Safe Sandboxed Self-Maintenance Effectors.
 * - `cleanSafeCaches`: Strictly restricted to plugin-owned `tmp`/`cache` dirs.
 *   Zero user paths accepted; uses `lstat` (never follows symlinks) + `realpath`
 *   prefix containment so symlink escape or path traversal is impossible.
 * - `stopStuckJobs`: Cancels ONLY DSH-managed jobs that are stuck beyond the
 *   configured duration or whose owning session no longer exists. Never touches
 *   external OS processes or active normal user jobs.
 * - `compactIdleContexts`: Compacts ONLY idle sessions via DSH `compaction`.
 * - `fileHelpCard`: Deduplicates and sanitizes model-proposed Help Cards.
 */

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rm, unlink } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { type HelpActionKind, type HelpCard, type NeedKey, sanitizeForModel } from '@asi/sense-types';

export const DEFAULT_STUCK_JOB_MS = 15 * 60_000;

export interface ManagedJobInfo {
  id: string;
  owner?: string;
  label?: string;
  status: string;
  startedAt?: number;
}

export interface JobsPort {
  listActiveJobs(): ManagedJobInfo[];
  hasLiveOwner(sessionId: string): boolean;
  killJob(id: string, owner: string | undefined, reason: string): 'requested' | 'already-finished';
}

export interface CompactionPort {
  listIdleSessionIds(excludeIds: ReadonlySet<string>): string[];
  compactIdleSession(sessionId: string, signal: AbortSignal): Promise<{ compacted: boolean; tokensSaved?: number }>;
}

export interface CacheCleanResult {
  deletedEntries: number;
  freedBytes: number;
  skippedSymlinks: number;
  rootsChecked: number;
}

function isStrictlyInside(parentReal: string, candidateReal: string): boolean {
  const prefix = parentReal.endsWith(sep) ? parentReal : `${parentReal}${sep}`;
  return candidateReal.startsWith(prefix) && candidateReal.length > prefix.length;
}

async function measureAndCleanDir(
  rootReal: string,
  currentDir: string,
  minAgeMs: number,
  now: number,
  isTopRoot: boolean,
): Promise<{ deletedEntries: number; freedBytes: number; skippedSymlinks: number }> {
  let deletedEntries = 0;
  let freedBytes = 0;
  let skippedSymlinks = 0;

  const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(currentDir, entry.name);
    const st = await lstat(full).catch(() => undefined);
    if (!st) continue;
    if (st.isSymbolicLink()) {
      skippedSymlinks += 1;
      continue;
    }
    const real = await realpath(full).catch(() => undefined);
    if (!real || !isStrictlyInside(rootReal, real)) {
      skippedSymlinks += 1;
      continue;
    }
    if (st.isDirectory()) {
      const sub = await measureAndCleanDir(rootReal, real, minAgeMs, now, false);
      deletedEntries += sub.deletedEntries;
      freedBytes += sub.freedBytes;
      skippedSymlinks += sub.skippedSymlinks;
      if (minAgeMs <= 0 || now - st.mtimeMs >= minAgeMs) {
        const remaining = await readdir(real).catch(() => ['keep']);
        if (remaining.length === 0) {
          await rm(real, { recursive: false }).catch(() => undefined);
        }
      }
    } else if (st.isFile()) {
      if (minAgeMs > 0 && now - st.mtimeMs < minAgeMs) continue;
      try {
        await unlink(real);
        deletedEntries += 1;
        freedBytes += st.size;
      } catch {
        // Ignore concurrent removal
      }
    }
  }

  if (!isTopRoot && (minAgeMs <= 0 || entries.length === 0)) {
    const left = await readdir(currentDir).catch(() => ['keep']);
    if (left.length === 0) {
      await rm(currentDir, { recursive: false }).catch(() => undefined);
    }
  }
  return { deletedEntries, freedBytes, skippedSymlinks };
}

export interface CacheInspectResult {
  totalBytes: number;
  reclaimableBytes: number;
  entryCount: number;
  rootsChecked: number;
}

async function inspectDirBytes(
  rootReal: string,
  currentDir: string,
): Promise<{ totalBytes: number; entryCount: number }> {
  let totalBytes = 0;
  let entryCount = 0;
  const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(currentDir, entry.name);
    const st = await lstat(full).catch(() => undefined);
    if (!st || st.isSymbolicLink()) continue;
    const real = await realpath(full).catch(() => undefined);
    if (!real || !isStrictlyInside(rootReal, real)) continue;
    if (st.isDirectory()) {
      const sub = await inspectDirBytes(rootReal, real);
      totalBytes += sub.totalBytes;
      entryCount += sub.entryCount;
    } else if (st.isFile()) {
      totalBytes += st.size;
      entryCount += 1;
    }
  }
  return { totalBytes, entryCount };
}

export async function inspectSafeCaches(options: {
  needsStorageRoot: string;
  senseStorageRoot?: string;
}): Promise<CacheInspectResult> {
  const candidateRoots = [
    join(options.needsStorageRoot, 'tmp'),
    join(options.needsStorageRoot, 'cache'),
    ...(options.senseStorageRoot ? [join(options.senseStorageRoot, 'tmp')] : []),
  ];
  let totalBytes = 0;
  let entryCount = 0;
  let rootsChecked = 0;
  for (const dir of candidateRoots) {
    const st = await lstat(dir).catch(() => undefined);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) continue;
    const rootReal = await realpath(dir).catch(() => undefined);
    if (!rootReal) continue;
    rootsChecked += 1;
    const sub = await inspectDirBytes(rootReal, rootReal);
    totalBytes += sub.totalBytes;
    entryCount += sub.entryCount;
  }
  return { totalBytes, reclaimableBytes: totalBytes, entryCount, rootsChecked };
}

export async function cleanSafeCaches(options: {
  needsStorageRoot: string;
  senseStorageRoot?: string;
  now: number;
  minAgeMs?: number;
}): Promise<CacheCleanResult> {
  const minAgeMs = options.minAgeMs ?? 0;
  const candidateRoots = [
    join(options.needsStorageRoot, 'tmp'),
    join(options.needsStorageRoot, 'cache'),
    ...(options.senseStorageRoot ? [join(options.senseStorageRoot, 'tmp')] : []),
  ];

  let deletedEntries = 0;
  let freedBytes = 0;
  let skippedSymlinks = 0;
  let rootsChecked = 0;

  for (const dir of candidateRoots) {
    await mkdir(dir, { recursive: true }).catch(() => undefined);
    const st = await lstat(dir).catch(() => undefined);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) continue;
    const rootReal = await realpath(dir).catch(() => undefined);
    if (!rootReal) continue;
    rootsChecked += 1;
    const cleaned = await measureAndCleanDir(rootReal, rootReal, minAgeMs, options.now, true);
    deletedEntries += cleaned.deletedEntries;
    freedBytes += cleaned.freedBytes;
    skippedSymlinks += cleaned.skippedSymlinks;
  }

  return { deletedEntries, freedBytes, skippedSymlinks, rootsChecked };
}

export function findStuckJobs(
  jobsPort: JobsPort,
  now: number,
  stuckThresholdMs = DEFAULT_STUCK_JOB_MS,
): ManagedJobInfo[] {
  return jobsPort.listActiveJobs().filter((job) => {
    if (job.status !== 'running') return false;
    const orphaned = job.owner !== undefined && !jobsPort.hasLiveOwner(job.owner);
    const timedOut =
      job.startedAt !== undefined && Number.isFinite(job.startedAt) && now - job.startedAt >= stuckThresholdMs;
    return orphaned || timedOut;
  });
}

export interface StopJobsResult {
  stoppedIds: string[];
  refusedActiveIds: string[];
}

export function stopStuckJobs(options: {
  jobsPort: JobsPort;
  now: number;
  targetJobId?: string;
  stuckThresholdMs?: number;
}): StopJobsResult {
  const stuck = findStuckJobs(options.jobsPort, options.now, options.stuckThresholdMs);
  const stuckMap = new Map(stuck.map((j) => [j.id, j]));
  const stoppedIds: string[] = [];
  const refusedActiveIds: string[] = [];

  if (options.targetJobId) {
    const eligible = stuckMap.get(options.targetJobId);
    if (!eligible) {
      refusedActiveIds.push(options.targetJobId);
      return { stoppedIds, refusedActiveIds };
    }
    const res = options.jobsPort.killJob(eligible.id, eligible.owner, 'ASI 自维护清理超时/无主任务');
    if (res === 'requested') stoppedIds.push(eligible.id);
    return { stoppedIds, refusedActiveIds };
  }

  for (const job of stuck) {
    const res = options.jobsPort.killJob(job.id, job.owner, 'ASI 自维护清理超时/无主任务');
    if (res === 'requested') stoppedIds.push(job.id);
  }
  return { stoppedIds, refusedActiveIds };
}

export interface CompactContextResult {
  compactedSessions: number;
  tokensSaved: number;
  rotatedMaintainer: boolean;
}

export async function compactIdleContexts(options: {
  compactionPort: CompactionPort;
  excludeSessionIds: ReadonlySet<string>;
  signal: AbortSignal;
  rotateMaintainer?: () => Promise<boolean>;
}): Promise<CompactContextResult> {
  const idleIds = options.compactionPort.listIdleSessionIds(options.excludeSessionIds);
  let compactedSessions = 0;
  let tokensSaved = 0;

  for (const id of idleIds) {
    if (options.signal.aborted) break;
    try {
      const res = await options.compactionPort.compactIdleSession(id, options.signal);
      if (res.compacted) {
        compactedSessions += 1;
        tokensSaved += res.tokensSaved ?? 0;
      }
    } catch {
      // Skip sessions that became busy or had no compactable span
    }
  }

  const rotatedMaintainer = options.rotateMaintainer ? await options.rotateMaintainer() : false;
  return { compactedSessions, tokensSaved, rotatedMaintainer };
}

function cleanText(raw: string, maxLen: number): string {
  const sanitized = sanitizeForModel(raw.trim());
  const text = typeof sanitized === 'string' ? sanitized : '';
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

export function upsertHelpCard(
  existing: HelpCard[],
  input: {
    need: NeedKey;
    severity: 'uncomfortable' | 'critical';
    title: string;
    summary: string;
    proposedAction?: string;
    actionKind?: HelpActionKind;
    actionTarget?: string;
    now: number;
  },
): { cards: HelpCard[]; card: HelpCard; created: boolean } {
  const actionKind: HelpActionKind = input.actionKind ?? 'acknowledge';
  const title = cleanText(input.title, 80) || '需要用户协助恢复运行环境';
  const summary = cleanText(input.summary, 280) || '自维护已触及安全或物理边界，请查看侧栏处理。';
  const proposedAction = input.proposedAction ? cleanText(input.proposedAction, 200) : undefined;

  const normalizedTarget = input.actionTarget ? cleanText(input.actionTarget, 64) : undefined;
  const matchIdx = existing.findIndex(
    (c) =>
      c.status === 'open' &&
      c.need === input.need &&
      c.actionKind === actionKind &&
      (c.actionTarget ?? '') === (normalizedTarget ?? ''),
  );
  const prev = matchIdx >= 0 ? existing[matchIdx] : undefined;
  if (prev) {
    const updated: HelpCard = {
      ...prev,
      severity: input.severity === 'critical' || prev.severity === 'critical' ? 'critical' : 'uncomfortable',
      title,
      summary,
      ...(proposedAction ? { proposedAction } : {}),
      ...(normalizedTarget ? { actionTarget: normalizedTarget } : {}),
      updatedAt: input.now,
    };
    const next = [...existing];
    next[matchIdx] = updated;
    return { cards: next, card: updated, created: false };
  }

  const card: HelpCard = {
    id: `help-${randomUUID().slice(0, 8)}`,
    need: input.need,
    severity: input.severity,
    title,
    summary,
    ...(proposedAction ? { proposedAction } : {}),
    actionKind,
    ...(normalizedTarget ? { actionTarget: normalizedTarget } : {}),
    status: 'open',
    createdAt: input.now,
    updatedAt: input.now,
  };
  return { cards: [card, ...existing].slice(0, 30), card, created: true };
}
