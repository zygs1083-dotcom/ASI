/**
 * Idle Worktree Build & Dependency Artifact Scanner + Safe Approved Cleaner.
 *
 * Open-Source MIT Adaptations & Attribution:
 * - Multi-ecosystem build/dependency artifact target profiles (`node_modules`,
 *   `target`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.parcel-cache`, `.vite`,
 *   `.angular`, `.gradle`, `build`, `coverage`, `dist`, `.pytest_cache`, etc.)
 *   adapted from `voidcosmos/npkill` (MIT License, Copyright (c) Npkill contributors).
 * - Non-symlink bounded tree walk & recent-modification safety guard adapted from
 *   `guhcostan/mac-cleaner-cli` (MIT License) and `tw93/Mole` (MIT License).
 *
 * Safety Boundaries:
 * - Only matches an artifact directory when its parent directory contains the
 *   required ecosystem project manifest (e.g. `package.json` for `node_modules`,
 *   `Cargo.toml`/`pom.xml` for `target`, `src` + `package.json` + bundler config for `dist`).
 * - Never follows symlinks (`lstat` only); yields via `setImmediate` every 250 entries
 *   so main-thread latency stays well below 10ms even on large monorepos.
 * - Deletion is strictly Level 2 (requires explicit user one-click approval) and
 *   aborts immediately if any file inside the artifact or worktree was modified
 *   within the 2-hour active protection window.
 */

import { lstat, readdir, rm, utimes } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { type CareExecFn, defaultCareExec } from './command.js';
import { ACTIVE_EXEMPTION_MS, type DiscoveryReport, measureDirectoryLatestActivity } from './discovery.js';
import { checkDirectoryProcessHolders } from './port-inspector.js';
import {
  formatHomePath,
  isSameOrInside,
  isStrictlyInside,
  makeTargetToken,
  tryRealpath,
  validateArtifactDeletionTarget,
} from './safety.js';

export const ARTIFACT_IDLE_THRESHOLD_MS = 7 * 86_400_000; // >= 7 days
export const BLOAT_UNCOMFORTABLE_BYTES = 1024 ** 3; // >= 1 GiB
export const BLOAT_CRITICAL_BYTES = 8 * 1024 ** 3; // >= 8 GiB

const MAX_CANDIDATE_SEARCH_DEPTH = 3;
const MAX_ENTRIES_PER_ARTIFACT = 250_000;
const MAX_ENTRIES_PER_WORKTREE = 500_000;
const YIELD_EVERY_ENTRIES = 250;

export interface ArtifactRule {
  dirName: string;
  ecosystem: string;
  label: string;
  /** At least one of these sibling files must exist in the parent directory. */
  anySiblingManifest: readonly string[];
  /** Every listed sibling directory/file must ALSO exist (used to protect hand-authored `dist`). */
  allSiblingPaths?: readonly string[];
  /** Every listed file must exist directly inside the candidate directory itself (e.g. `pyvenv.cfg` in `.venv`). */
  allInternalFiles?: readonly string[];
}

export const ARTIFACT_RULES: readonly ArtifactRule[] = [
  {
    dirName: 'node_modules',
    ecosystem: 'node',
    label: 'Node.js 依赖目录 (node_modules)',
    anySiblingManifest: ['package.json', 'pnpm-workspace.yaml', 'yarn.lock', 'package-lock.json', 'bun.lockb'],
  },
  {
    dirName: 'target',
    ecosystem: 'rust-jvm',
    label: 'Rust/Maven 编译产物 (target)',
    anySiblingManifest: ['Cargo.toml', 'pom.xml'],
  },
  {
    dirName: '.next',
    ecosystem: 'nextjs',
    label: 'Next.js 构建缓存 (.next)',
    anySiblingManifest: ['next.config.js', 'next.config.mjs', 'next.config.ts', 'package.json'],
  },
  {
    dirName: '.nuxt',
    ecosystem: 'nuxt',
    label: 'Nuxt 构建缓存 (.nuxt)',
    anySiblingManifest: ['nuxt.config.ts', 'nuxt.config.js', 'package.json'],
  },
  {
    dirName: '.svelte-kit',
    ecosystem: 'sveltekit',
    label: 'SvelteKit 构建产物 (.svelte-kit)',
    anySiblingManifest: ['svelte.config.js', 'package.json'],
  },
  {
    dirName: '.turbo',
    ecosystem: 'turborepo',
    label: 'Turborepo 本地缓存 (.turbo)',
    anySiblingManifest: ['turbo.json', 'package.json'],
  },
  {
    dirName: '.parcel-cache',
    ecosystem: 'parcel',
    label: 'Parcel 编译缓存 (.parcel-cache)',
    anySiblingManifest: ['package.json'],
  },
  {
    dirName: '.vite',
    ecosystem: 'vite',
    label: 'Vite 预构建缓存 (.vite)',
    anySiblingManifest: ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'package.json'],
  },
  {
    dirName: '.angular',
    ecosystem: 'angular',
    label: 'Angular 编译缓存 (.angular)',
    anySiblingManifest: ['angular.json', 'package.json'],
  },
  {
    dirName: '.gradle',
    ecosystem: 'gradle',
    label: 'Gradle 项目缓存 (.gradle)',
    anySiblingManifest: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'],
  },
  {
    dirName: 'build',
    ecosystem: 'gradle-cmake',
    label: 'Gradle/CMake 构建产物 (build)',
    anySiblingManifest: ['build.gradle', 'build.gradle.kts', 'CMakeLists.txt'],
  },
  {
    dirName: 'coverage',
    ecosystem: 'test-coverage',
    label: '测试覆盖率报告 (coverage)',
    anySiblingManifest: ['package.json', 'pyproject.toml'],
  },
  {
    dirName: 'dist',
    ecosystem: 'ts-bundler',
    label: 'TS/Bundler 构建产物 (dist)',
    anySiblingManifest: ['tsconfig.json', 'vite.config.ts', 'rollup.config.js', 'tsup.config.ts'],
    allSiblingPaths: ['package.json', 'src'],
  },
  {
    dirName: '.pytest_cache',
    ecosystem: 'python',
    label: 'Pytest 缓存 (.pytest_cache)',
    anySiblingManifest: ['pyproject.toml', 'setup.py', 'requirements.txt', 'pytest.ini'],
  },
  {
    dirName: '.mypy_cache',
    ecosystem: 'python',
    label: 'Mypy 类型缓存 (.mypy_cache)',
    anySiblingManifest: ['pyproject.toml', 'setup.py', 'requirements.txt', 'mypy.ini'],
  },
  {
    dirName: '.ruff_cache',
    ecosystem: 'python',
    label: 'Ruff 检查缓存 (.ruff_cache)',
    anySiblingManifest: ['pyproject.toml', 'ruff.toml', 'requirements.txt'],
  },
  {
    dirName: '.venv',
    ecosystem: 'python-venv',
    label: 'Python 虚拟环境 (.venv)',
    anySiblingManifest: [
      'pyproject.toml',
      'requirements.txt',
      'Pipfile',
      'setup.py',
      'setup.cfg',
      'uv.lock',
      'poetry.lock',
    ],
    allInternalFiles: ['pyvenv.cfg'],
  },
];

const ARTIFACT_RULE_BY_DIR = new Map<string, ArtifactRule>(ARTIFACT_RULES.map((r) => [r.dirName, r]));

const SKIP_DESCENT_DIRS = new Set(['.git', '.hg', '.svn', 'venv']);
const NO_NESTED_SEARCH_DIRS = new Set(['.venv', 'node_modules']);

export interface ScannedWorkspaceArtifact {
  targetId: string;
  artifactPath: string;
  displayArtifactPath: string;
  worktreePath: string;
  displayWorktreePath: string;
  dirName: string;
  ecosystem: string;
  label: string;
  totalBytes: number;
  entryCount: number;
  latestMtimeMs: number;
  idleMs: number;
  /** True when worktree is non-active AND artifact idleMs >= `minArtifactIdleMs` (default 7 days). */
  eligibleIdle: boolean;
  truncated: boolean;
}

export interface WorkspaceBloatReport {
  scannedAt: number;
  totalIdleBytes: number;
  idleArtifacts: ScannedWorkspaceArtifact[];
  allArtifacts: ScannedWorkspaceArtifact[];
}

interface MeasureBudget {
  remaining: number;
  visitedSinceYield: number;
  truncated: boolean;
}

async function tickWalkBudget(budget: MeasureBudget, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return false;
  }
  budget.remaining -= 1;
  budget.visitedSinceYield += 1;
  if (budget.visitedSinceYield >= YIELD_EVERY_ENTRIES) {
    budget.visitedSinceYield = 0;
    await new Promise<void>((r) => setImmediate(r));
    if (signal?.aborted) return false;
  }
  return true;
}

export async function verifyArtifactEcosystemMarkers(
  parentDir: string,
  rule: ArtifactRule,
  candidateDir?: string,
): Promise<boolean> {
  let matchedAny = false;
  for (const manifest of rule.anySiblingManifest) {
    const st = await lstat(join(parentDir, manifest)).catch(() => undefined);
    if (st && !st.isSymbolicLink() && st.isFile()) {
      matchedAny = true;
      break;
    }
  }
  if (!matchedAny) return false;

  for (const req of rule.allSiblingPaths ?? []) {
    const st = await lstat(join(parentDir, req)).catch(() => undefined);
    if (!st || st.isSymbolicLink()) return false;
  }

  if (rule.allInternalFiles && rule.allInternalFiles.length > 0) {
    const effectiveCandidate = candidateDir ?? join(parentDir, rule.dirName);
    for (const internalFile of rule.allInternalFiles) {
      const st = await lstat(join(effectiveCandidate, internalFile)).catch(() => undefined);
      if (!st || st.isSymbolicLink() || !st.isFile()) return false;
    }
  }
  return true;
}

async function measureArtifactTree(
  artifactRootReal: string,
  currentDir: string,
  budget: MeasureBudget,
  signal?: AbortSignal,
): Promise<{ totalBytes: number; entryCount: number; latestMtimeMs: number }> {
  let totalBytes = 0;
  let entryCount = 0;
  let latestMtimeMs = 0;

  const rootSt = await lstat(currentDir).catch(() => undefined);
  if (rootSt) {
    latestMtimeMs = Math.max(latestMtimeMs, rootSt.mtimeMs);
  }

  const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!(await tickWalkBudget(budget, signal))) break;
    const full = join(currentDir, entry.name);
    const st = await lstat(full).catch(() => undefined);
    if (!st || st.isSymbolicLink()) continue;

    if (st.isDirectory()) {
      const childReal = await tryRealpath(full);
      if (!childReal || !isStrictlyInside(artifactRootReal, childReal)) continue;
      const sub = await measureArtifactTree(artifactRootReal, childReal, budget, signal);
      totalBytes += sub.totalBytes;
      entryCount += sub.entryCount + 1;
      latestMtimeMs = Math.max(latestMtimeMs, st.mtimeMs, sub.latestMtimeMs);
    } else if (st.isFile()) {
      totalBytes += st.size;
      entryCount += 1;
      latestMtimeMs = Math.max(latestMtimeMs, st.mtimeMs);
    }
  }

  return { totalBytes, entryCount, latestMtimeMs };
}

async function collectWorktreeArtifacts(options: {
  worktreeReal: string;
  displayWorktreePath: string;
  activeExempt: boolean;
  homeDir: string;
  homeReal?: string;
  excludedReals?: readonly string[];
  now: number;
  minArtifactIdleMs: number;
  signal?: AbortSignal;
}): Promise<ScannedWorkspaceArtifact[]> {
  const {
    worktreeReal,
    displayWorktreePath,
    activeExempt,
    homeDir,
    homeReal,
    excludedReals,
    now,
    minArtifactIdleMs,
    signal,
  } = options;
  const found: ScannedWorkspaceArtifact[] = [];
  let worktreeRemaining = MAX_ENTRIES_PER_WORKTREE;

  async function searchCandidates(dirReal: string, depth: number): Promise<void> {
    if (signal?.aborted || worktreeRemaining <= 0) return;
    const entries = await readdir(dirReal, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (signal?.aborted || worktreeRemaining <= 0) return;
      if (SKIP_DESCENT_DIRS.has(entry.name)) continue;

      const full = join(dirReal, entry.name);
      const st = await lstat(full).catch(() => undefined);
      if (!st || st.isSymbolicLink() || !st.isDirectory()) continue;

      const childReal = await tryRealpath(full);
      if (!childReal || !isStrictlyInside(worktreeReal, childReal)) continue;
      if (excludedReals?.some((ex) => ex && isSameOrInside(ex, childReal))) continue;

      const rule = ARTIFACT_RULE_BY_DIR.get(entry.name);
      if (rule && (await verifyArtifactEcosystemMarkers(dirReal, rule, childReal))) {
        const artifactCap = Math.min(MAX_ENTRIES_PER_ARTIFACT, worktreeRemaining);
        const artifactBudget: MeasureBudget = {
          remaining: artifactCap,
          visitedSinceYield: 0,
          truncated: false,
        };
        // Measure matched artifact tree and do NOT descend inside it for nested candidates
        const measured = await measureArtifactTree(childReal, childReal, artifactBudget, signal);
        worktreeRemaining -= artifactCap - artifactBudget.remaining;
        if (signal?.aborted) return;
        if (measured.totalBytes > 0) {
          const effMtime = Math.max(st.mtimeMs, measured.latestMtimeMs);
          const idleMs = effMtime > 0 ? Math.max(0, now - effMtime) : 0;
          const eligibleIdle = !activeExempt && !artifactBudget.truncated && idleMs >= minArtifactIdleMs;
          found.push({
            targetId: makeTargetToken('art', childReal),
            artifactPath: childReal,
            displayArtifactPath: formatHomePath(childReal, homeDir, homeReal),
            worktreePath: worktreeReal,
            displayWorktreePath,
            dirName: rule.dirName,
            ecosystem: rule.ecosystem,
            label: rule.label,
            totalBytes: measured.totalBytes,
            entryCount: measured.entryCount,
            latestMtimeMs: effMtime,
            idleMs,
            eligibleIdle,
            truncated: artifactBudget.truncated,
          });
        }
        continue;
      }

      if (depth < MAX_CANDIDATE_SEARCH_DEPTH && !NO_NESTED_SEARCH_DIRS.has(entry.name)) {
        await searchCandidates(childReal, depth + 1);
      }
    }
  }

  await searchCandidates(worktreeReal, 0);
  return found;
}

export async function scanWorkspaceArtifacts(options: {
  now: number;
  homeDir: string;
  discovery: DiscoveryReport;
  excludedReals?: readonly string[];
  minArtifactIdleMs?: number;
  signal?: AbortSignal;
}): Promise<WorkspaceBloatReport> {
  const { now, homeDir, discovery, excludedReals, signal } = options;
  const minArtifactIdleMs = options.minArtifactIdleMs ?? ARTIFACT_IDLE_THRESHOLD_MS;
  const homeReal = await tryRealpath(homeDir);

  const allArtifacts: ScannedWorkspaceArtifact[] = [];
  for (const wt of discovery.worktrees) {
    if (signal?.aborted) break;
    // Skip expensive tree walks on active worktrees (2h active exemption)
    if (wt.activeExempt) continue;
    const items = await collectWorktreeArtifacts({
      worktreeReal: wt.path,
      displayWorktreePath: wt.displayPath,
      activeExempt: wt.activeExempt,
      homeDir,
      homeReal,
      excludedReals,
      now,
      minArtifactIdleMs,
      signal,
    });
    allArtifacts.push(...items);
  }

  allArtifacts.sort((a, b) => b.totalBytes - a.totalBytes || b.idleMs - a.idleMs);
  const idleArtifacts = allArtifacts.filter((a) => a.eligibleIdle);
  const totalIdleBytes = idleArtifacts.reduce((acc, item) => acc + item.totalBytes, 0);

  return {
    scannedAt: now,
    totalIdleBytes,
    idleArtifacts,
    allArtifacts,
  };
}

/**
 * Level 2 User-Approved Effector: safely delete a controlled idle build artifact directory.
 * Re-validates realpath containment, non-symlink status, ecosystem manifest, and 2h activity guard.
 */
export async function cleanApprovedWorkspaceArtifact(options: {
  candidate: ScannedWorkspaceArtifact;
  now: number;
  homeDir: string;
  excludedReals?: readonly string[];
  activeSessionCwds: readonly string[];
  activeExemptionMs?: number;
  exec?: CareExecFn;
  signal?: AbortSignal;
}): Promise<{ freedBytes: number; deletedPath: string }> {
  const { candidate, now, homeDir, signal } = options;
  const activeExemptionMs = options.activeExemptionMs ?? ACTIVE_EXEMPTION_MS;
  const exec = options.exec ?? defaultCareExec;
  const homeReal = (await tryRealpath(homeDir)) ?? resolve(homeDir);

  if (signal?.aborted) {
    throw new Error('Artifact cleanup aborted');
  }

  const worktreeReal = await tryRealpath(candidate.worktreePath);
  if (!worktreeReal) {
    throw new Error('Owning worktree directory no longer exists');
  }
  for (const sessCwd of options.activeSessionCwds) {
    if (isSameOrInside(worktreeReal, sessCwd)) {
      throw new Error('Refusing to clean artifact: an active DSH session is now running in this worktree');
    }
  }

  // Re-verify owning worktree source files have not been modified within the 2-hour active protection window
  const wtLatestActivity = await measureDirectoryLatestActivity(worktreeReal, undefined, signal);
  if (signal?.aborted) {
    throw new Error('Artifact cleanup aborted');
  }
  if (wtLatestActivity > 0 && now - wtLatestActivity < activeExemptionMs) {
    throw new Error(
      'Refusing to clean artifact: source files in owning worktree were modified within the 2-hour active protection window',
    );
  }

  const rawStat = await lstat(candidate.artifactPath).catch(() => undefined);
  if (!rawStat || rawStat.isSymbolicLink() || !rawStat.isDirectory()) {
    throw new Error('Target artifact directory no longer exists or is a symbolic link');
  }

  const artifactReal = await tryRealpath(candidate.artifactPath);
  if (!artifactReal) {
    throw new Error('Could not resolve canonical artifact path');
  }

  if (
    !validateArtifactDeletionTarget({
      artifactReal,
      worktreeReal,
      homeReal,
      excludedReals: options.excludedReals,
    })
  ) {
    throw new Error('Artifact target failed protected root containment check');
  }

  const rule = ARTIFACT_RULE_BY_DIR.get(basename(artifactReal));
  if (!rule || rule.dirName !== candidate.dirName) {
    throw new Error(`Directory "${basename(artifactReal)}" is not a whitelisted build artifact`);
  }
  if (!(await verifyArtifactEcosystemMarkers(dirname(artifactReal), rule, artifactReal))) {
    throw new Error(`Parent directory no longer contains required ${rule.ecosystem} manifest`);
  }

  // Re-measure right before deletion to detect any fresh (<2h) modifications and measure exact freedBytes (fail-closed)
  const verifyBudget: MeasureBudget = {
    remaining: MAX_ENTRIES_PER_ARTIFACT,
    visitedSinceYield: 0,
    truncated: false,
  };
  const liveMeasure = await measureArtifactTree(artifactReal, artifactReal, verifyBudget, signal);
  if (signal?.aborted) {
    throw new Error('Artifact cleanup aborted before deletion');
  }
  if (verifyBudget.truncated) {
    throw new Error('Refusing to clean artifact: directory exceeds verification entry cap (fail-closed)');
  }
  const latestMtime = Math.max(rawStat.mtimeMs, liveMeasure.latestMtimeMs);
  if (latestMtime > 0 && now - latestMtime < activeExemptionMs) {
    throw new Error('Refusing to clean artifact: files were modified within the 2-hour active protection window');
  }

  // Fail-closed live external process occupancy check (e.g. >2h dev server or terminal shell cwd)
  const holders = await checkDirectoryProcessHolders({
    targetPaths: [worktreeReal, artifactReal, candidate.worktreePath, candidate.artifactPath],
    exec,
    signal,
  });
  if (signal?.aborted) {
    throw new Error('Artifact cleanup aborted before deletion');
  }
  if (holders.state === 'held') {
    throw new Error(
      `Refusing to clean artifact: live external process (${holders.holderDetail ?? 'active holder'}) is occupying this worktree or artifact`,
    );
  }
  if (holders.state !== 'free') {
    throw new Error('Refusing to clean artifact: unable to verify zero live process holders (fail-closed)');
  }

  const parentDir = dirname(artifactReal);
  const parentStatBefore = await lstat(parentDir).catch(() => undefined);
  await rm(artifactReal, { recursive: true, force: false });
  if (parentStatBefore && !parentStatBefore.isSymbolicLink()) {
    await utimes(parentDir, parentStatBefore.atime, parentStatBefore.mtime).catch(() => undefined);
  }
  return {
    freedBytes: liveMeasure.totalBytes,
    deletedPath: candidate.displayArtifactPath,
  };
}
