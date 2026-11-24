/**
 * Zero-Config Workspace & Git Sibling Worktree Discovery + 2-Hour Active Exemption.
 *
 * - Automatically aggregates DSH `workspaceRegistry` paths, active/known user
 *   session `cwd`s, and optional `extraRoots`, filtering out `ignorePaths`,
 *   ASI internal storage directories, and sensitive directories (`~/.secrets`, `~/.Trash`, etc.).
 * - For every Git-backed directory, runs `git worktree list --porcelain` once per
 *   common Git repository to expand all sibling linked worktrees (and detect
 *   dangling `prunable` worktree metadata).
 * - Computes the 2-hour active exemption (`activeExempt`): any worktree with a
 *   running/active DSH session or job, or with filesystem modifications within
 *   the last 2 hours, is exempted from homeostatic deductions and cleanup actions.
 */

import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { CareExecFn } from './command.js';
import {
  formatHomePath,
  isForbiddenCarePath,
  isSameOrInside,
  isStrictlyInside,
  tryRealpath,
  unquoteGitCPath,
} from './safety.js';

export const ACTIVE_EXEMPTION_MS = 2 * 3_600_000; // 2 hours
const MAX_SEED_PATHS = 48;
const MAX_SOURCE_ACTIVITY_DEPTH = 5;
const MAX_SOURCE_ACTIVITY_ENTRIES = 2_000;
const ACTIVITY_YIELD_EVERY = 250;

const SKIP_ACTIVITY_STAT_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.venv',
  'venv',
  '.cache',
  'node_modules',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.vite',
  '.angular',
  '.gradle',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '__pycache__',
]);

export interface CareSessionBrief {
  id: string;
  cwd?: string;
  /** True when the session is actively thinking/running tools/waiting-user or owns a live DSH job. */
  active: boolean;
  internal?: boolean;
}

export interface RawWorktreeEntry {
  worktreePath: string;
  headSha?: string;
  branchRef?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
  prunableReason?: string;
}

export interface DiscoveredWorktree {
  /** Canonical realpath of the worktree or plain workspace directory. */
  path: string;
  displayPath: string;
  name: string;
  kind: 'git-worktree' | 'plain-workspace';
  /** Canonical `.git` common dir shared across sibling worktrees (present for `git-worktree`). */
  repoCommonGitDir?: string;
  /** Canonical `.git` dir specific to this worktree (e.g. `.git/worktrees/<name>`). */
  worktreeGitDir?: string;
  /** Canonical path of the main worktree for this repo (used for `git worktree prune/remove`). */
  mainWorktreePath?: string;
  isMainWorktree: boolean;
  branch?: string;
  headSha?: string;
  detached: boolean;
  locked: boolean;
  /** Latest observed activity timestamp (ms) from gitdir/worktree files. */
  latestActivityAt: number;
  idleMs: number;
  /** True when exempted by active DSH session/job or <2h file modification. */
  activeExempt: boolean;
  exemptReason?: 'active-dsh-session' | 'recent-file-activity';
  activeSessionIds: string[];
}

export interface DiscoveredRepo {
  commonGitDir: string;
  mainWorktreePath: string;
  displayMainPath: string;
  worktrees: DiscoveredWorktree[];
  prunablePaths: string[];
}

export interface DiscoveryReport {
  scannedAt: number;
  repos: DiscoveredRepo[];
  worktrees: DiscoveredWorktree[];
}

/**
 * Pure parser for `git worktree list --porcelain` (adapted from `simple-git` MIT).
 */
export function parseGitWorktreePorcelain(stdout: string): RawWorktreeEntry[] {
  const entries: RawWorktreeEntry[] = [];
  const blocks = stdout.trim().split(/\r?\n\r?\n+/);
  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    let worktreePath = '';
    let headSha: string | undefined;
    let branchRef: string | undefined;
    let detached = false;
    let bare = false;
    let locked = false;
    let lockReason: string | undefined;
    let prunable = false;
    let prunableReason: string | undefined;

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        worktreePath = unquoteGitCPath(line.slice('worktree '.length));
      } else if (line.startsWith('HEAD ')) {
        headSha = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ')) {
        branchRef = line.slice('branch '.length).trim();
      } else if (line === 'detached') {
        detached = true;
      } else if (line === 'bare') {
        bare = true;
      } else if (line === 'locked' || line.startsWith('locked ')) {
        locked = true;
        const r = line.slice('locked'.length).trim();
        if (r) lockReason = r;
      } else if (line === 'prunable' || line.startsWith('prunable ')) {
        prunable = true;
        const r = line.slice('prunable'.length).trim();
        if (r) prunableReason = r;
      }
    }

    if (!worktreePath) continue;
    const headsPrefix = 'refs/heads/';
    const branch = branchRef?.startsWith(headsPrefix) ? branchRef.slice(headsPrefix.length) : branchRef;
    entries.push({
      worktreePath,
      ...(headSha ? { headSha } : {}),
      ...(branchRef ? { branchRef } : {}),
      ...(branch ? { branch } : {}),
      detached,
      bare,
      locked,
      ...(lockReason ? { lockReason } : {}),
      prunable,
      ...(prunableReason ? { prunableReason } : {}),
    });
  }
  return entries;
}

export async function resolveWorktreeGitDir(worktreeReal: string): Promise<string | undefined> {
  const dotGit = join(worktreeReal, '.git');
  const st = await lstat(dotGit).catch(() => undefined);
  if (!st || st.isSymbolicLink()) return undefined;
  if (st.isDirectory()) {
    return (await tryRealpath(dotGit)) ?? dotGit;
  }
  if (st.isFile()) {
    const raw = await readFile(dotGit, 'utf8').catch(() => '');
    const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? '';
    if (firstLine.startsWith('gitdir:')) {
      const target = firstLine.slice('gitdir:'.length).trim();
      const resolved = isAbsolute(target) ? target : resolve(worktreeReal, target);
      return (await tryRealpath(resolved)) ?? resolved;
    }
  }
  return undefined;
}

export async function measureDirectoryLatestActivity(
  worktreeReal: string,
  worktreeGitDir?: string,
  signal?: AbortSignal,
): Promise<number> {
  let latest = 0;
  const rootStat = await lstat(worktreeReal).catch(() => undefined);
  if (rootStat) {
    latest = Math.max(latest, rootStat.mtimeMs);
  }

  const effectiveGitDir = worktreeGitDir ?? (await resolveWorktreeGitDir(worktreeReal));
  if (effectiveGitDir) {
    for (const marker of [
      'index',
      'HEAD',
      'ORIG_HEAD',
      'MERGE_HEAD',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'rebase-merge',
      'rebase-apply',
    ]) {
      const st = await lstat(join(effectiveGitDir, marker)).catch(() => undefined);
      if (st && !st.isSymbolicLink()) {
        latest = Math.max(latest, st.mtimeMs);
      }
    }
  }

  let visited = 0;
  let sinceYield = 0;

  async function walkSourceTree(dirReal: string, depth: number): Promise<void> {
    if (signal?.aborted || visited >= MAX_SOURCE_ACTIVITY_ENTRIES) return;
    const entries = await readdir(dirReal, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (signal?.aborted || visited >= MAX_SOURCE_ACTIVITY_ENTRIES) return;
      if (SKIP_ACTIVITY_STAT_NAMES.has(entry.name)) continue;

      visited += 1;
      sinceYield += 1;
      if (sinceYield >= ACTIVITY_YIELD_EVERY) {
        sinceYield = 0;
        await new Promise<void>((r) => setImmediate(r));
        if (signal?.aborted) return;
      }

      const full = join(dirReal, entry.name);
      const st = await lstat(full).catch(() => undefined);
      if (!st || st.isSymbolicLink()) continue;
      latest = Math.max(latest, st.mtimeMs);

      if (st.isDirectory() && depth < MAX_SOURCE_ACTIVITY_DEPTH) {
        const childReal = await tryRealpath(full);
        if (childReal && isStrictlyInside(worktreeReal, childReal)) {
          await walkSourceTree(childReal, depth + 1);
        }
      }
    }
  }

  await walkSourceTree(worktreeReal, 0);
  return latest;
}

export async function discoverWorkspacesAndWorktrees(options: {
  now: number;
  homeDir: string;
  workspacePaths: readonly string[];
  sessions: readonly CareSessionBrief[];
  extraRoots?: readonly string[];
  ignorePaths?: readonly string[];
  internalRoots?: readonly string[];
  activeExemptionMs?: number;
  exec: CareExecFn;
  signal?: AbortSignal;
}): Promise<DiscoveryReport> {
  const { now, homeDir, exec, signal } = options;
  const activeExemptionMs = options.activeExemptionMs ?? ACTIVE_EXEMPTION_MS;
  const homeReal = (await tryRealpath(homeDir)) ?? resolve(homeDir);

  const excludedReals: string[] = [];
  for (const raw of [...(options.ignorePaths ?? []), ...(options.internalRoots ?? [])]) {
    if (!raw?.trim()) continue;
    const expanded = raw.startsWith('~/') ? join(homeDir, raw.slice(2)) : raw === '~' ? homeDir : raw;
    const real = (await tryRealpath(expanded)) ?? resolve(expanded);
    excludedReals.push(real);
  }

  // Canonicalize active user sessions
  const activeSessions: { id: string; cwdReal: string }[] = [];
  const sessionCwds: string[] = [];
  for (const sess of options.sessions) {
    if (sess.internal || !sess.cwd?.trim()) continue;
    const cwdReal = await tryRealpath(sess.cwd);
    if (!cwdReal || isForbiddenCarePath(cwdReal, homeReal, excludedReals)) continue;
    sessionCwds.push(cwdReal);
    if (sess.active) {
      activeSessions.push({ id: sess.id, cwdReal });
    }
  }

  const rawSeeds = [
    ...options.workspacePaths,
    ...sessionCwds,
    ...(options.extraRoots ?? []).map((p) => (p.startsWith('~/') ? join(homeDir, p.slice(2)) : p)),
  ];

  const uniqueSeeds: string[] = [];
  const seenSeed = new Set<string>();
  for (const raw of rawSeeds) {
    if (!raw?.trim() || uniqueSeeds.length >= MAX_SEED_PATHS) continue;
    const st = await lstat(raw).catch(() => undefined);
    if (!st) continue;
    const real = await tryRealpath(raw);
    if (!real || seenSeed.has(real)) continue;
    const realStat = await lstat(real).catch(() => undefined);
    if (!realStat?.isDirectory()) continue;
    if (isForbiddenCarePath(real, homeReal, excludedReals)) continue;
    seenSeed.add(real);
    uniqueSeeds.push(real);
  }

  const reposByCommonDir = new Map<string, DiscoveredRepo>();
  const worktreesByPath = new Map<string, DiscoveredWorktree>();

  const computeExemption = async (
    wtReal: string,
    worktreeGitDir?: string,
  ): Promise<{
    latestActivityAt: number;
    idleMs: number;
    activeExempt: boolean;
    exemptReason?: 'active-dsh-session' | 'recent-file-activity';
    activeSessionIds: string[];
  }> => {
    const matchingActiveIds = activeSessions.filter((s) => isSameOrInside(wtReal, s.cwdReal)).map((s) => s.id);
    const latestActivityAt = await measureDirectoryLatestActivity(wtReal, worktreeGitDir, signal);
    const idleMs = latestActivityAt > 0 ? Math.max(0, now - latestActivityAt) : Number.POSITIVE_INFINITY;

    if (matchingActiveIds.length > 0) {
      return {
        latestActivityAt,
        idleMs,
        activeExempt: true,
        exemptReason: 'active-dsh-session',
        activeSessionIds: matchingActiveIds,
      };
    }
    if (idleMs < activeExemptionMs) {
      return {
        latestActivityAt,
        idleMs,
        activeExempt: true,
        exemptReason: 'recent-file-activity',
        activeSessionIds: [],
      };
    }
    return {
      latestActivityAt,
      idleMs: Number.isFinite(idleMs) ? idleMs : 0,
      activeExempt: false,
      activeSessionIds: [],
    };
  };

  for (const seedReal of uniqueSeeds) {
    if (signal?.aborted) break;
    if (worktreesByPath.has(seedReal)) continue;

    const revRes = await exec(
      'git',
      ['-c', 'core.quotePath=false', '-C', seedReal, 'rev-parse', '--show-toplevel', '--git-common-dir'],
      {
        readOnlyGit: true,
        timeoutMs: 2_500,
        signal,
      },
    );

    if (revRes.ok) {
      const lines = revRes.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const rawTop = lines[0];
      const rawCommon = lines[1];
      if (rawTop && rawCommon) {
        const topReal = (await tryRealpath(rawTop)) ?? resolve(seedReal, rawTop);
        const commonResolved = isAbsolute(rawCommon) ? rawCommon : resolve(seedReal, rawCommon);
        const commonReal = (await tryRealpath(commonResolved)) ?? commonResolved;

        if (!reposByCommonDir.has(commonReal)) {
          const wtListRes = await exec(
            'git',
            ['-c', 'core.quotePath=false', '-C', topReal, 'worktree', 'list', '--porcelain'],
            {
              readOnlyGit: true,
              timeoutMs: 3_000,
              signal,
            },
          );
          const parsedList = wtListRes.ok
            ? parseGitWorktreePorcelain(wtListRes.stdout)
            : [{ worktreePath: topReal, detached: false, bare: false, locked: false, prunable: false }];

          const prunablePaths: string[] = [];
          const repoWorktrees: DiscoveredWorktree[] = [];
          let mainWorktreePath = parsedList[0]?.bare ? commonReal : topReal;

          for (let idx = 0; idx < parsedList.length; idx += 1) {
            const entry = parsedList[idx];
            if (!entry || entry.bare) continue;

            const wtReal = await tryRealpath(entry.worktreePath);
            if (!wtReal || entry.prunable) {
              prunablePaths.push(formatHomePath(entry.worktreePath, homeDir, homeReal));
              continue;
            }
            if (idx === 0) {
              mainWorktreePath = wtReal;
            }
            if (isForbiddenCarePath(wtReal, homeReal, excludedReals)) continue;
            const existing = worktreesByPath.get(wtReal);
            if (existing) {
              repoWorktrees.push(existing);
              continue;
            }

            const worktreeGitDir = await resolveWorktreeGitDir(wtReal);
            const activity = await computeExemption(wtReal, worktreeGitDir);
            const discovered: DiscoveredWorktree = {
              path: wtReal,
              displayPath: formatHomePath(wtReal, homeDir, homeReal),
              name: basename(wtReal) || basename(dirname(wtReal)) || 'worktree',
              kind: 'git-worktree',
              repoCommonGitDir: commonReal,
              ...(worktreeGitDir ? { worktreeGitDir } : {}),
              mainWorktreePath,
              isMainWorktree: idx === 0,
              ...(entry.branch ? { branch: entry.branch } : {}),
              ...(entry.headSha ? { headSha: entry.headSha } : {}),
              detached: entry.detached,
              locked: entry.locked,
              latestActivityAt: activity.latestActivityAt,
              idleMs: activity.idleMs,
              activeExempt: activity.activeExempt,
              ...(activity.exemptReason ? { exemptReason: activity.exemptReason } : {}),
              activeSessionIds: activity.activeSessionIds,
            };
            worktreesByPath.set(wtReal, discovered);
            repoWorktrees.push(discovered);
          }

          if (repoWorktrees.length > 0 || prunablePaths.length > 0) {
            reposByCommonDir.set(commonReal, {
              commonGitDir: commonReal,
              mainWorktreePath,
              displayMainPath: formatHomePath(mainWorktreePath, homeDir, homeReal),
              worktrees: repoWorktrees,
              prunablePaths,
            });
          }
        }
        continue;
      }
    }

    // Non-Git plain local workspace directory
    const activity = await computeExemption(seedReal);
    const plain: DiscoveredWorktree = {
      path: seedReal,
      displayPath: formatHomePath(seedReal, homeDir, homeReal),
      name: basename(seedReal) || 'workspace',
      kind: 'plain-workspace',
      isMainWorktree: true,
      detached: false,
      locked: false,
      latestActivityAt: activity.latestActivityAt,
      idleMs: activity.idleMs,
      activeExempt: activity.activeExempt,
      ...(activity.exemptReason ? { exemptReason: activity.exemptReason } : {}),
      activeSessionIds: activity.activeSessionIds,
    };
    worktreesByPath.set(seedReal, plain);
  }

  return {
    scannedAt: now,
    repos: [...reposByCommonDir.values()],
    worktrees: [...worktreesByPath.values()],
  };
}
