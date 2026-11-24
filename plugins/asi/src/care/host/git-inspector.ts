/**
 * Git Repository & Multi-Worktree Hygiene Inspector and Controlled Effectors.
 *
 * Open-Source MIT Adaptations & Attribution:
 * - Git porcelain status & branch tracking parser adapted from
 *   `steveukx/git-js` (`simple-git`, MIT License, Copyright (c) Steve King).
 * - Merged-branch & clean-worktree safety rules adapted from
 *   `fcsonline/git-cleaner` (MIT License, Copyright (c) Ferran Basora).
 *
 * Three-Tier Guardrail Enforcement:
 * - Level 1 (Unattended zero-loss): `git worktree prune` dangling metadata;
 *   unlink `.git/*.lock` ONLY when regular file, stale, worktree non-active,
 *   AND `lsof` positively confirms zero open process holders (fail-closed).
 * - Level 2 (User one-click approval required): `git worktree remove` (NEVER `--force`)
 *   for linked worktrees that are 100% clean, pushed, merged into trunk, and idle >= 3d.
 * - Level 3 (Strictly read-only): uncommitted changes, unpushed commits, and
 *   merge/rebase conflicts are NEVER mutated (`stash`/`commit`/`reset`/`clean` forbidden).
 */

import { lstat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CareExecFn } from './command.js';
import {
  ACTIVE_EXEMPTION_MS,
  type DiscoveredRepo,
  type DiscoveryReport,
  measureDirectoryLatestActivity,
} from './discovery.js';
import { checkDirectoryProcessHolders } from './port-inspector.js';
import { formatHomePath, isSameOrInside, makeTargetToken, tryRealpath, unquoteGitCPath } from './safety.js';

export const DEAD_LOCK_MIN_AGE_MS = 15 * 60_000; // 15m lock age + non-active worktree (>= 2h)
export const CONFLICT_UNCOMFORTABLE_MS = 2 * 3_600_000; // > 2h
export const DIRTY_UNCOMFORTABLE_MS = 24 * 3_600_000; // > 24h
export const MERGED_WORKTREE_IDLE_MS = 3 * 86_400_000; // >= 3 days

const CONTROLLED_GIT_LOCK_NAMES = ['index.lock', 'HEAD.lock', 'config.lock', 'packed-refs.lock'] as const;
const PROTECTED_BRANCH_NAMES = new Set(['main', 'master', 'develop', 'trunk', 'production', 'release']);
const CONFLICT_CODES = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);

export interface ParsedGitStatus {
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  stagedCount: number;
  modifiedCount: number;
  untrackedCount: number;
  ignoredCount: number;
  hasEnvIgnored: boolean;
  conflictCount: number;
  dirtyTotal: number;
  dirtySamplePaths: string[];
  dirtyPaths?: string[];
  ignoredSamplePaths?: string[];
}

export interface DeadGitLockItem {
  lockPath: string;
  displayLockPath: string;
  lockName: string;
  worktreePath: string;
  displayWorktreePath: string;
  ageMs: number;
  holderState: 'free' | 'held' | 'unknown';
}

export interface CleanMergedWorktreeCandidate {
  targetId: string;
  worktreePath: string;
  displayWorktreePath: string;
  mainWorktreePath: string;
  branch: string;
  baseRef: string;
  idleMs: number;
}

export interface WorktreeHygieneStatus {
  path: string;
  displayPath: string;
  isMainWorktree: boolean;
  branch?: string;
  activeExempt: boolean;
  exemptReason?: string;
  idleMs: number;
  status: ParsedGitStatus;
  conflictKind?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'unmerged';
  conflictIdleMs?: number;
  conflictTargetId?: string;
  dirtyIdleMs?: number;
  dirtyTargetId?: string;
  deadLocks: DeadGitLockItem[];
  cleanMergedCandidate?: CleanMergedWorktreeCandidate;
}

export interface RepoHygieneReport {
  inspectedAt: number;
  prunableRepos: { mainWorktreePath: string; displayMainPath: string; prunablePaths: string[] }[];
  deadLocks: DeadGitLockItem[];
  cleanMergedWorktrees: CleanMergedWorktreeCandidate[];
  conflictWorktrees: WorktreeHygieneStatus[];
  staleDirtyWorktrees: WorktreeHygieneStatus[];
  unpushedWorktrees: WorktreeHygieneStatus[];
  worktrees: WorktreeHygieneStatus[];
}

function decodeSinglePorcelainPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return unquoteGitCPath(trimmed);
  }
  return raw;
}

function extractPorcelainTargetPath(rawRest: string, isRenameOrCopy: boolean): string {
  if (!isRenameOrCopy) {
    return decodeSinglePorcelainPath(rawRest);
  }
  const leadTrimmed = rawRest.trimStart();
  if (leadTrimmed.startsWith('"')) {
    let i = 1;
    while (i < leadTrimmed.length) {
      const ch = leadTrimmed[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') {
        if (leadTrimmed.slice(i + 1, i + 5) === ' -> ') {
          return decodeSinglePorcelainPath(leadTrimmed.slice(i + 5));
        }
        break;
      }
      i += 1;
    }
  }
  const arrowIdx = rawRest.indexOf(' -> ');
  if (arrowIdx >= 0) {
    return decodeSinglePorcelainPath(rawRest.slice(arrowIdx + 4));
  }
  return decodeSinglePorcelainPath(rawRest);
}

function isEnvLikePath(relPath: string): boolean {
  const clean = relPath.replace(/\/+$/, '');
  for (const seg of clean.split(/[\\/]/)) {
    const lower = seg.toLowerCase();
    if (
      lower === '.env' ||
      lower === '.envrc' ||
      lower.startsWith('.env.') ||
      lower.startsWith('.env_') ||
      lower.startsWith('.env-')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Pure parser for `git status --porcelain=v1 --branch` (`simple-git` MIT adaptation).
 */
export function parseGitStatusPorcelainV1(stdout: string): ParsedGitStatus {
  let branch: string | undefined;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  let stagedCount = 0;
  let modifiedCount = 0;
  let untrackedCount = 0;
  let ignoredCount = 0;
  let hasEnvIgnored = false;
  let conflictCount = 0;
  const dirtySamplePaths: string[] = [];
  const dirtyPaths: string[] = [];
  const ignoredSamplePaths: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    if (!rawLine) continue;
    if (rawLine.startsWith('## ')) {
      const headSpec = rawLine.slice(3).trim();
      const bracketIdx = headSpec.indexOf(' [');
      const branchPart = bracketIdx >= 0 ? headSpec.slice(0, bracketIdx).trim() : headSpec;
      const trackingMeta = bracketIdx >= 0 ? headSpec.slice(bracketIdx + 2).replace(/\]$/, '') : '';

      if (branchPart.startsWith('No commits yet on ')) {
        branch = branchPart.slice('No commits yet on '.length).trim();
      } else if (branchPart.startsWith('Initial commit on ')) {
        branch = branchPart.slice('Initial commit on '.length).trim();
      } else if (!branchPart.startsWith('HEAD ')) {
        const dotsIdx = branchPart.indexOf('...');
        if (dotsIdx >= 0) {
          branch = branchPart.slice(0, dotsIdx).trim();
          upstream = branchPart.slice(dotsIdx + 3).trim();
        } else {
          branch = branchPart;
        }
      }

      if (trackingMeta) {
        const aheadMatch = /\bahead\s+(\d+)\b/.exec(trackingMeta);
        const behindMatch = /\bbehind\s+(\d+)\b/.exec(trackingMeta);
        if (aheadMatch?.[1]) ahead = Number(aheadMatch[1]) || 0;
        if (behindMatch?.[1]) behind = Number(behindMatch[1]) || 0;
      }
      continue;
    }

    if (rawLine.length < 3) continue;
    const xy = rawLine.slice(0, 2);
    const x = xy[0] ?? ' ';
    const y = xy[1] ?? ' ';
    const isRenameOrCopy = x === 'R' || y === 'R' || x === 'C' || y === 'C';
    const relPath = extractPorcelainTargetPath(rawLine.slice(3), isRenameOrCopy);

    if (xy === '!!') {
      ignoredCount += 1;
      if (relPath) {
        if (isEnvLikePath(relPath)) {
          hasEnvIgnored = true;
        }
        if (ignoredSamplePaths.length < 25) {
          ignoredSamplePaths.push(relPath);
        }
      }
      continue;
    }

    if (xy === '??') {
      untrackedCount += 1;
    } else if (CONFLICT_CODES.has(xy)) {
      conflictCount += 1;
    } else {
      if (x !== ' ') stagedCount += 1;
      if (y !== ' ') modifiedCount += 1;
    }

    if (relPath) {
      if (dirtySamplePaths.length < 25) {
        dirtySamplePaths.push(relPath);
      }
      if (dirtyPaths.length < 500) {
        dirtyPaths.push(relPath);
      }
    }
  }

  return {
    ...(branch ? { branch } : {}),
    ...(upstream ? { upstream } : {}),
    ahead,
    behind,
    stagedCount,
    modifiedCount,
    untrackedCount,
    ignoredCount,
    hasEnvIgnored,
    conflictCount,
    dirtyTotal: stagedCount + modifiedCount + untrackedCount + conflictCount,
    dirtySamplePaths,
    dirtyPaths,
    ignoredSamplePaths,
  };
}

export async function checkLockFileHolders(
  lockReal: string,
  exec: CareExecFn,
  signal?: AbortSignal,
): Promise<'free' | 'held' | 'unknown'> {
  const res = await exec('lsof', ['-w', '-nP', '-F', 'p', '--', lockReal], { timeoutMs: 8_000, signal });
  if (res.timedOut || res.errorCode === 'ENOENT' || res.errorCode === 'ABORT_ERR') {
    return 'unknown';
  }
  const hasPidLines = res.stdout
    .split(/\r?\n/)
    .some((line) => line.length > 1 && line.startsWith('p') && /^\d+$/.test(line.slice(1)));
  if (hasPidLines) {
    return 'held';
  }
  // Standard POSIX lsof exits 1 with empty stdout/stderr when zero processes hold the file
  if ((res.exitCode === 0 || res.exitCode === 1) && res.stderr.trim() === '') {
    return 'free';
  }
  return 'unknown';
}

async function detectSequencerConflict(
  worktreeGitDir: string | undefined,
  unmergedCount: number,
  now: number,
): Promise<{ kind?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'unmerged'; ageMs?: number }> {
  if (worktreeGitDir) {
    const markers: readonly [string, 'merge' | 'rebase' | 'cherry-pick' | 'revert'][] = [
      ['rebase-merge', 'rebase'],
      ['rebase-apply', 'rebase'],
      ['MERGE_HEAD', 'merge'],
      ['CHERRY_PICK_HEAD', 'cherry-pick'],
      ['REVERT_HEAD', 'revert'],
    ];
    for (const [name, kind] of markers) {
      const st = await lstat(join(worktreeGitDir, name)).catch(() => undefined);
      if (st && !st.isSymbolicLink()) {
        return { kind, ageMs: Math.max(0, now - st.mtimeMs) };
      }
    }
  }
  if (unmergedCount > 0) {
    return { kind: 'unmerged' };
  }
  return {};
}

async function inspectWorktreeIndexSpecialEntries(
  worktreePath: string,
  exec: CareExecFn,
  signal?: AbortSignal,
): Promise<{ ok: boolean; hasSubmoduleGitlink: boolean; hasMaskedWorktreeEntry: boolean }> {
  const res = await exec('git', ['-c', 'core.quotePath=false', '-C', worktreePath, 'ls-files', '-v', '--stage'], {
    readOnlyGit: true,
    timeoutMs: 3_500,
    maxBuffer: 32 * 1024 * 1024,
    signal,
  });
  if (!res.ok) {
    return { ok: false, hasSubmoduleGitlink: false, hasMaskedWorktreeEntry: false };
  }
  let hasSubmoduleGitlink = false;
  let hasMaskedWorktreeEntry = false;
  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const tag = line[0];
    if (tag && tag !== 'H') {
      // `S`/`s` = --skip-worktree, `h` = --assume-unchanged, `M` = unmerged
      hasMaskedWorktreeEntry = true;
    }
    if (line.slice(2, 8) === '160000') {
      hasSubmoduleGitlink = true;
    }
    if (hasSubmoduleGitlink && hasMaskedWorktreeEntry) break;
  }
  return { ok: true, hasSubmoduleGitlink, hasMaskedWorktreeEntry };
}

async function detectRepoBaseRef(
  worktreePath: string,
  exec: CareExecFn,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const symRes = await exec(
    'git',
    ['-C', worktreePath, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    { readOnlyGit: true, timeoutMs: 2_000, signal },
  );
  if (symRes.ok && symRes.stdout.trim()) {
    return symRes.stdout.trim();
  }
  for (const candidate of [
    'refs/heads/main',
    'refs/heads/master',
    'refs/remotes/origin/main',
    'refs/remotes/origin/master',
    'refs/remotes/hub/main',
    'refs/remotes/upstream/main',
  ]) {
    const verify = await exec('git', ['-C', worktreePath, 'show-ref', '--verify', '--quiet', candidate], {
      readOnlyGit: true,
      timeoutMs: 1_500,
      signal,
    });
    if (verify.ok) return candidate;
  }
  return undefined;
}

export async function inspectRepoHygiene(options: {
  now: number;
  homeDir: string;
  discovery: DiscoveryReport;
  exec: CareExecFn;
  activeExemptionMs?: number;
  deadLockMinAgeMs?: number;
  conflictUncomfortableMs?: number;
  dirtyUncomfortableMs?: number;
  mergedWorktreeIdleMs?: number;
  signal?: AbortSignal;
}): Promise<RepoHygieneReport> {
  const { now, homeDir, discovery, exec, signal } = options;
  const activeExemptionMs = options.activeExemptionMs ?? ACTIVE_EXEMPTION_MS;
  const deadLockMinAgeMs = options.deadLockMinAgeMs ?? DEAD_LOCK_MIN_AGE_MS;
  const conflictUncomfortableMs = options.conflictUncomfortableMs ?? CONFLICT_UNCOMFORTABLE_MS;
  const dirtyUncomfortableMs = options.dirtyUncomfortableMs ?? DIRTY_UNCOMFORTABLE_MS;
  const mergedWorktreeIdleMs = options.mergedWorktreeIdleMs ?? MERGED_WORKTREE_IDLE_MS;
  const homeReal = await tryRealpath(homeDir);

  const prunableRepos: RepoHygieneReport['prunableRepos'] = [];
  for (const repo of discovery.repos) {
    if (repo.prunablePaths.length > 0) {
      prunableRepos.push({
        mainWorktreePath: repo.mainWorktreePath,
        displayMainPath: repo.displayMainPath,
        prunablePaths: [...repo.prunablePaths],
      });
    }
  }

  const deadLocks: DeadGitLockItem[] = [];
  const cleanMergedWorktrees: CleanMergedWorktreeCandidate[] = [];
  const conflictWorktrees: WorktreeHygieneStatus[] = [];
  const staleDirtyWorktrees: WorktreeHygieneStatus[] = [];
  const unpushedWorktrees: WorktreeHygieneStatus[] = [];
  const statuses: WorktreeHygieneStatus[] = [];
  const checkedLockReals = new Set<string>();
  const baseRefByCommonDir = new Map<string, string | null>();

  const activeRepos = new Set<string>(
    discovery.worktrees
      .filter((w) => w.kind === 'git-worktree' && w.activeExempt && w.repoCommonGitDir)
      .map((w) => w.repoCommonGitDir as string),
  );

  interface PreInspectedWorktree {
    wt: DiscoveryReport['worktrees'][number];
    parsed: ParsedGitStatus;
    effectiveIdleMs: number;
    effectiveActiveExempt: boolean;
    effectiveExemptReason?: 'active-dsh-session' | 'recent-file-activity';
  }
  const preInspected: PreInspectedWorktree[] = [];

  for (const wt of discovery.worktrees) {
    if (signal?.aborted) break;
    if (wt.kind !== 'git-worktree') continue;

    const statusRes = await exec(
      'git',
      [
        '-c',
        'core.quotePath=false',
        '-C',
        wt.path,
        'status',
        '--porcelain=v1',
        '--branch',
        '--untracked-files=normal',
        '--ignored=matching',
      ],
      { readOnlyGit: true, timeoutMs: 3_500, signal },
    );
    if (!statusRes.ok) continue;

    const parsed = parseGitStatusPorcelainV1(statusRes.stdout);

    // Refine latest activity from all dirty files (or parent dir when file was recently deleted)
    let latestDirtyMtime = wt.latestActivityAt;
    for (const rel of parsed.dirtyPaths ?? parsed.dirtySamplePaths) {
      const full = join(wt.path, rel);
      const st = await lstat(full).catch(() => undefined);
      if (st && !st.isSymbolicLink()) {
        const real = await tryRealpath(full);
        if (!real || isSameOrInside(wt.path, real)) {
          latestDirtyMtime = Math.max(latestDirtyMtime, st.mtimeMs);
        }
      } else {
        const parentDir = dirname(full);
        if (isSameOrInside(wt.path, parentDir)) {
          const parentSt = await lstat(parentDir).catch(() => undefined);
          if (parentSt && !parentSt.isSymbolicLink()) {
            latestDirtyMtime = Math.max(latestDirtyMtime, parentSt.mtimeMs);
          }
        }
      }
    }
    const effectiveIdleMs = latestDirtyMtime > 0 ? Math.max(0, now - latestDirtyMtime) : wt.idleMs;
    const effectiveActiveExempt = wt.activeExempt || effectiveIdleMs < activeExemptionMs;
    const effectiveExemptReason = wt.exemptReason ?? (effectiveActiveExempt ? 'recent-file-activity' : undefined);

    // Synchronize refined activity back onto DiscoveryReport so port-inspector, artifact-scanner & care_status agree
    wt.latestActivityAt = latestDirtyMtime;
    wt.idleMs = effectiveIdleMs;
    wt.activeExempt = effectiveActiveExempt;
    if (effectiveExemptReason) {
      wt.exemptReason = effectiveExemptReason;
    }

    if (effectiveActiveExempt && wt.repoCommonGitDir) {
      activeRepos.add(wt.repoCommonGitDir);
    }

    preInspected.push({
      wt,
      parsed,
      effectiveIdleMs,
      effectiveActiveExempt,
      ...(effectiveExemptReason ? { effectiveExemptReason } : {}),
    });
  }

  for (const { wt, parsed, effectiveIdleMs, effectiveActiveExempt, effectiveExemptReason } of preInspected) {
    if (signal?.aborted) break;

    // Inspect lock files in worktree gitdir (and common gitdir ONLY when NO sibling worktree in the repo is active)
    const wtDeadLocks: DeadGitLockItem[] = [];
    const lockDirs = new Set<string>();
    if (wt.worktreeGitDir && wt.worktreeGitDir !== wt.repoCommonGitDir) {
      lockDirs.add(wt.worktreeGitDir);
    }
    if (wt.repoCommonGitDir && !activeRepos.has(wt.repoCommonGitDir)) {
      lockDirs.add(wt.repoCommonGitDir);
    }

    if (!effectiveActiveExempt) {
      for (const lockDir of lockDirs) {
        for (const lockName of CONTROLLED_GIT_LOCK_NAMES) {
          const candidate = join(lockDir, lockName);
          const st = await lstat(candidate).catch(() => undefined);
          if (!st || st.isSymbolicLink() || !st.isFile()) continue;
          const lockReal = await tryRealpath(candidate);
          if (!lockReal || checkedLockReals.has(lockReal)) continue;
          checkedLockReals.add(lockReal);

          const ageMs = Math.max(0, now - st.mtimeMs);
          if (ageMs < deadLockMinAgeMs) continue;

          const holderState = await checkLockFileHolders(lockReal, exec, signal);
          if (holderState === 'free') {
            const item: DeadGitLockItem = {
              lockPath: lockReal,
              displayLockPath: formatHomePath(lockReal, homeDir, homeReal),
              lockName,
              worktreePath: wt.path,
              displayWorktreePath: wt.displayPath,
              ageMs,
              holderState,
            };
            wtDeadLocks.push(item);
            deadLocks.push(item);
          }
        }
      }
    }

    const seq = await detectSequencerConflict(wt.worktreeGitDir, parsed.conflictCount, now);
    const conflictIdleMs =
      seq.kind !== undefined
        ? seq.ageMs !== undefined
          ? Math.min(seq.ageMs, effectiveIdleMs)
          : effectiveIdleMs
        : undefined;
    const conflictTargetId = seq.kind !== undefined ? makeTargetToken('conflict', `${wt.path}:${seq.kind}`) : undefined;

    const dirtyIdleMs = parsed.dirtyTotal > 0 ? effectiveIdleMs : undefined;
    const dirtyTargetId = parsed.dirtyTotal > 0 ? makeTargetToken('dirty', wt.path) : undefined;

    // Check clean + merged idle linked worktree (>= 3d) with zero gitignored files/artifacts/submodules
    let cleanMergedCandidate: CleanMergedWorktreeCandidate | undefined;
    const branchName = parsed.branch ?? wt.branch;
    const hasGitmodules = Boolean(await lstat(join(wt.path, '.gitmodules')).catch(() => undefined));
    if (
      !effectiveActiveExempt &&
      !wt.isMainWorktree &&
      !wt.locked &&
      !wt.detached &&
      !hasGitmodules &&
      branchName &&
      !PROTECTED_BRANCH_NAMES.has(branchName) &&
      parsed.dirtyTotal === 0 &&
      parsed.ignoredCount === 0 &&
      !parsed.hasEnvIgnored &&
      seq.kind === undefined &&
      parsed.ahead === 0 &&
      effectiveIdleMs >= mergedWorktreeIdleMs &&
      wt.repoCommonGitDir &&
      wt.mainWorktreePath
    ) {
      let baseRef = baseRefByCommonDir.get(wt.repoCommonGitDir);
      if (baseRef === undefined) {
        baseRef = (await detectRepoBaseRef(wt.mainWorktreePath, exec, signal)) ?? null;
        baseRefByCommonDir.set(wt.repoCommonGitDir, baseRef);
      }
      if (baseRef) {
        const anc = await exec('git', ['-C', wt.path, 'merge-base', '--is-ancestor', 'HEAD', baseRef], {
          readOnlyGit: true,
          timeoutMs: 2_000,
          signal,
        });
        if (anc.exitCode === 0) {
          // Deep check with `--ignored=traditional` (fast because node_modules etc. are already known absent)
          // to catch untracked subdirectories containing only gitignored files (e.g. `config/.env`).
          const deepCleanRes = await exec(
            'git',
            [
              '-c',
              'core.quotePath=false',
              '-C',
              wt.path,
              'status',
              '--porcelain=v1',
              '--branch',
              '--untracked-files=all',
              '--ignored=traditional',
            ],
            { readOnlyGit: true, timeoutMs: 3_000, signal },
          );
          if (deepCleanRes.ok) {
            const deepParsed = parseGitStatusPorcelainV1(deepCleanRes.stdout);
            if (
              deepParsed.dirtyTotal === 0 &&
              deepParsed.ignoredCount === 0 &&
              !deepParsed.hasEnvIgnored &&
              deepParsed.ahead === 0
            ) {
              const indexCheck = await inspectWorktreeIndexSpecialEntries(wt.path, exec, signal);
              if (indexCheck.ok && !indexCheck.hasSubmoduleGitlink && !indexCheck.hasMaskedWorktreeEntry) {
                cleanMergedCandidate = {
                  targetId: makeTargetToken('wt', wt.path),
                  worktreePath: wt.path,
                  displayWorktreePath: wt.displayPath,
                  mainWorktreePath: wt.mainWorktreePath,
                  branch: branchName,
                  baseRef,
                  idleMs: effectiveIdleMs,
                };
                cleanMergedWorktrees.push(cleanMergedCandidate);
              }
            }
          }
        }
      }
    }

    const wtStatus: WorktreeHygieneStatus = {
      path: wt.path,
      displayPath: wt.displayPath,
      isMainWorktree: wt.isMainWorktree,
      ...(branchName ? { branch: branchName } : {}),
      activeExempt: effectiveActiveExempt,
      ...(effectiveExemptReason ? { exemptReason: effectiveExemptReason } : {}),
      idleMs: effectiveIdleMs,
      status: parsed,
      ...(seq.kind ? { conflictKind: seq.kind } : {}),
      ...(conflictIdleMs !== undefined ? { conflictIdleMs } : {}),
      ...(conflictTargetId ? { conflictTargetId } : {}),
      ...(dirtyIdleMs !== undefined ? { dirtyIdleMs } : {}),
      ...(dirtyTargetId ? { dirtyTargetId } : {}),
      deadLocks: wtDeadLocks,
      ...(cleanMergedCandidate ? { cleanMergedCandidate } : {}),
    };
    statuses.push(wtStatus);

    if (!effectiveActiveExempt) {
      if (seq.kind && (conflictIdleMs ?? 0) >= conflictUncomfortableMs) {
        conflictWorktrees.push(wtStatus);
      } else if (parsed.dirtyTotal > 0 && (dirtyIdleMs ?? 0) >= dirtyUncomfortableMs) {
        staleDirtyWorktrees.push(wtStatus);
      }
      if (parsed.ahead > 0) {
        unpushedWorktrees.push(wtStatus);
      }
    }
  }

  return {
    inspectedAt: now,
    prunableRepos,
    deadLocks,
    cleanMergedWorktrees,
    conflictWorktrees,
    staleDirtyWorktrees,
    unpushedWorktrees,
    worktrees: statuses,
  };
}

/**
 * Level 1 Unattended Zero-Loss Effector: prune dangling git worktree metadata.
 */
export async function pruneDanglingWorktrees(options: {
  repos: readonly Pick<DiscoveredRepo, 'mainWorktreePath' | 'displayMainPath' | 'prunablePaths'>[];
  exec: CareExecFn;
  signal?: AbortSignal;
}): Promise<{ prunedRepoCount: number; prunedEntryCount: number; details: string[] }> {
  let prunedRepoCount = 0;
  let prunedEntryCount = 0;
  const details: string[] = [];

  for (const repo of options.repos) {
    if (options.signal?.aborted) break;
    if (repo.prunablePaths.length === 0) continue;
    const res = await options.exec('git', ['-C', repo.mainWorktreePath, 'worktree', 'prune', '-v'], {
      timeoutMs: 4_000,
      signal: options.signal,
    });
    if (res.ok) {
      prunedRepoCount += 1;
      prunedEntryCount += repo.prunablePaths.length;
      details.push(`${repo.displayMainPath} (${repo.prunablePaths.length})`);
    }
  }
  return { prunedRepoCount, prunedEntryCount, details };
}

/**
 * Level 1 Unattended Zero-Loss Effector: unlink verified zero-holder stale `.git/*.lock` files.
 */
export async function cleanDeadGitLocks(options: {
  locks: readonly DeadGitLockItem[];
  now: number;
  deadLockMinAgeMs?: number;
  activeExemptionMs?: number;
  exec: CareExecFn;
  signal?: AbortSignal;
}): Promise<{ removedLocks: string[]; skippedLocks: string[] }> {
  const minAgeMs = options.deadLockMinAgeMs ?? DEAD_LOCK_MIN_AGE_MS;
  const activeExemptionMs = options.activeExemptionMs ?? ACTIVE_EXEMPTION_MS;
  const removedLocks: string[] = [];
  const skippedLocks: string[] = [];

  for (const item of options.locks) {
    if (options.signal?.aborted) break;
    if (!(CONTROLLED_GIT_LOCK_NAMES as readonly string[]).includes(item.lockName)) {
      skippedLocks.push(item.displayLockPath);
      continue;
    }
    const st = await lstat(item.lockPath).catch(() => undefined);
    if (!st || st.isSymbolicLink() || !st.isFile()) {
      skippedLocks.push(item.displayLockPath);
      continue;
    }
    if (options.now - st.mtimeMs < minAgeMs) {
      skippedLocks.push(item.displayLockPath);
      continue;
    }
    const wtLatest = await measureDirectoryLatestActivity(item.worktreePath, undefined, options.signal);
    if (options.signal?.aborted || (wtLatest > 0 && options.now - wtLatest < activeExemptionMs)) {
      skippedLocks.push(item.displayLockPath);
      continue;
    }
    const holderState = await checkLockFileHolders(item.lockPath, options.exec, options.signal);
    if (options.signal?.aborted || holderState !== 'free') {
      skippedLocks.push(item.displayLockPath);
      continue;
    }
    try {
      await unlink(item.lockPath);
      removedLocks.push(item.displayLockPath);
    } catch {
      skippedLocks.push(item.displayLockPath);
    }
  }
  return { removedLocks, skippedLocks };
}

/**
 * Level 2 User-Approved Effector: safely remove a clean, merged, idle linked Git worktree.
 * Strictly re-verifies cleanliness (including ignored `.env*`/artifacts), live process holders,
 * ancestor status, and 2h exemption before calling `git worktree remove` (NO `--force`).
 */
export async function removeApprovedMergedWorktree(options: {
  candidate: CleanMergedWorktreeCandidate;
  now: number;
  activeSessionCwds: readonly string[];
  activeExemptionMs?: number;
  exec: CareExecFn;
  signal?: AbortSignal;
}): Promise<{ removed: boolean; displayPath: string }> {
  const { candidate, now, exec, signal } = options;
  const activeExemptionMs = options.activeExemptionMs ?? ACTIVE_EXEMPTION_MS;

  const wtReal = await tryRealpath(candidate.worktreePath);
  if (!wtReal || wtReal === candidate.mainWorktreePath) {
    throw new Error('Target worktree no longer exists or resolves to main worktree');
  }
  for (const sessCwd of options.activeSessionCwds) {
    if (isSameOrInside(wtReal, sessCwd)) {
      throw new Error('Refusing to remove worktree: an active DSH session is currently running inside it');
    }
  }

  if (await lstat(join(wtReal, '.gitmodules')).catch(() => undefined)) {
    throw new Error('Refusing to remove worktree: submodules (.gitmodules) are present');
  }

  if (signal?.aborted) {
    throw new Error('Worktree removal aborted');
  }
  const latestAct = await measureDirectoryLatestActivity(wtReal, undefined, signal);
  if (signal?.aborted) {
    throw new Error('Worktree removal aborted');
  }
  if (latestAct > 0 && now - latestAct < activeExemptionMs) {
    throw new Error('Refusing to remove worktree: files were modified within the 2-hour active protection window');
  }

  const statusRes = await exec(
    'git',
    [
      '-c',
      'core.quotePath=false',
      '-C',
      wtReal,
      'status',
      '--porcelain=v1',
      '--branch',
      '--untracked-files=all',
      '--ignored=traditional',
    ],
    {
      readOnlyGit: true,
      timeoutMs: 3_500,
      signal,
    },
  );
  if (!statusRes.ok) {
    throw new Error('Failed to verify git status before removing worktree');
  }
  const parsed = parseGitStatusPorcelainV1(statusRes.stdout);
  if (parsed.dirtyTotal > 0 || parsed.ahead > 0) {
    throw new Error('Refusing to remove worktree: uncommitted files or unpushed commits were detected');
  }
  if (parsed.hasEnvIgnored) {
    throw new Error('Refusing to remove worktree: ignored .env* configuration files are present');
  }
  if (parsed.ignoredCount > 0) {
    throw new Error('Refusing to remove worktree: gitignored files or build artifacts are still present');
  }

  const indexCheck = await inspectWorktreeIndexSpecialEntries(wtReal, exec, signal);
  if (!indexCheck.ok) {
    throw new Error('Failed to verify git index entries before removing worktree (fail-closed)');
  }
  if (indexCheck.hasSubmoduleGitlink) {
    throw new Error('Refusing to remove worktree: submodule gitlinks (160000) are present in index');
  }
  if (indexCheck.hasMaskedWorktreeEntry) {
    throw new Error(
      'Refusing to remove worktree: tracked files with skip-worktree or assume-unchanged flags are present',
    );
  }

  const holders = await checkDirectoryProcessHolders({
    targetPaths: [wtReal, candidate.worktreePath],
    exec,
    signal,
  });
  if (signal?.aborted) {
    throw new Error('Worktree removal aborted');
  }
  if (holders.state === 'held') {
    throw new Error(
      `Refusing to remove worktree: live external process (${holders.holderDetail ?? 'active holder'}) is occupying it`,
    );
  }
  if (holders.state !== 'free') {
    throw new Error('Refusing to remove worktree: unable to verify zero live process holders (fail-closed)');
  }

  const ancRes = await exec('git', ['-C', wtReal, 'merge-base', '--is-ancestor', 'HEAD', candidate.baseRef], {
    readOnlyGit: true,
    timeoutMs: 2_500,
    signal,
  });
  if (ancRes.exitCode !== 0) {
    throw new Error(`Refusing to remove worktree: HEAD is no longer merged into ${candidate.baseRef}`);
  }

  const rmRes = await exec('git', ['-C', candidate.mainWorktreePath, 'worktree', 'remove', '--', wtReal], {
    timeoutMs: 8_000,
    signal,
  });
  if (!rmRes.ok) {
    throw new Error(`git worktree remove refused operation: ${rmRes.stderr.trim() || 'non-clean state'}`);
  }
  return { removed: true, displayPath: candidate.displayWorktreePath };
}
