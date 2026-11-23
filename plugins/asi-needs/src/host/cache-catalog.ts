/**
 * Internalized macOS Developer & System Cache Rule Dictionary, Risk Taxonomy,
 * and Symlink-Safe Path Protection Layer.
 *
 * Open-Source MIT Adaptations & Attributions:
 * - Cache target categories & `safe | caution | risky` risk classification
 *   adapted from `bysiber/cleardisk` (MIT License, Copyright (c) bysiber).
 * - Developer build/package artifact discovery & recent-activity preservation
 *   adapted from `guhcostan/mac-cleaner-cli` (MIT License, Copyright (c) Gustavo Costa).
 * - Centralized deletion path validation sink (`validateProtectedTargetRoot`) &
 *   anti-symlink-escape containment adapted from `tw93/Mole` (MIT License, Copyright (c) Tw93).
 */

import { lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { CacheRiskLevel } from '@asi/sense-types';

/** Default 1-hour active modification protection window (3,600,000 ms). */
export const EXTERNAL_CACHE_ACTIVE_PROTECTION_MS = 60 * 60_000;

const DEFAULT_MAX_SCAN_ENTRIES = 25_000;
const DEFAULT_MAX_SCAN_DEPTH = 12;
const EVENT_LOOP_YIELD_EVERY = 400;

export const MIT_CACHE_ADAPTATION_SOURCES = [
  'bysiber/cleardisk (MIT)',
  'guhcostan/mac-cleaner-cli (MIT)',
  'tw93/Mole (MIT)',
] as const;

export type ExternalCacheCategory = 'xcode' | 'package-manager' | 'build-tool' | 'browser-testing' | 'system-trash';

export interface ExternalCacheRule {
  readonly id: string;
  readonly label: string;
  readonly category: ExternalCacheCategory;
  readonly risk: CacheRiskLevel;
  readonly cleanable: boolean;
  /** Home-relative path segment tuples (`~/<seg0>/<seg1>/...`). */
  readonly homeSubpaths: readonly (readonly string[])[];
  readonly note: string;
}

/**
 * Controlled static dictionary of developer caches (safe / caution) and Trash (risky, read-only).
 * Constructed from path segment arrays so compiled bundles never embed raw absolute path literals.
 */
export const EXTERNAL_CACHE_RULES: readonly ExternalCacheRule[] = [
  {
    id: 'xcode-derived-data',
    label: 'Xcode DerivedData',
    category: 'xcode',
    risk: 'safe',
    cleanable: true,
    homeSubpaths: [['Library', 'Developer', 'Xcode', 'DerivedData']],
    note: 'Xcode 编译中间产物与索引缓存，下次构建会自动重建；自动跳过 1 小时内活跃项目。',
  },
  {
    id: 'xcode-archives',
    label: 'Xcode Archives',
    category: 'xcode',
    risk: 'caution',
    cleanable: true,
    homeSubpaths: [['Library', 'Developer', 'Xcode', 'Archives']],
    note: '历史归档构建包（.xcarchive）；清理前请确认无需保留旧版符号表。',
  },
  {
    id: 'homebrew',
    label: 'Homebrew 下载缓存',
    category: 'package-manager',
    risk: 'safe',
    cleanable: true,
    homeSubpaths: [
      ['Library', 'Caches', 'Homebrew'],
      ['.cache', 'Homebrew'],
    ],
    note: 'Homebrew 历史安装包与瓶装缓存，不影响已安装软件。',
  },
  {
    id: 'pnpm-store',
    label: 'pnpm 缓存与存储池',
    category: 'package-manager',
    risk: 'safe',
    cleanable: true,
    homeSubpaths: [
      ['Library', 'Caches', 'pnpm'],
      ['Library', 'pnpm', 'store'],
      ['.cache', 'pnpm'],
      ['.local', 'share', 'pnpm', 'store'],
    ],
    note: 'pnpm 包下载缓存与内容寻址存储池，后续安装时按需拉取。',
  },
  {
    id: 'npm-cache',
    label: 'npm 缓存 (_cacache)',
    category: 'package-manager',
    risk: 'safe',
    cleanable: true,
    homeSubpaths: [
      ['.npm', '_cacache'],
      ['Library', 'Caches', 'npm'],
    ],
    note: 'npm tarball HTTP 缓存，不影响项目内 node_modules。',
  },
  {
    id: 'pip-cache',
    label: 'pip 缓存',
    category: 'package-manager',
    risk: 'safe',
    cleanable: true,
    homeSubpaths: [
      ['Library', 'Caches', 'pip'],
      ['.cache', 'pip'],
    ],
    note: 'Python wheel 与源码包下载缓存，不影响虚拟环境。',
  },
  {
    id: 'uv-cache',
    label: 'uv 缓存',
    category: 'package-manager',
    risk: 'safe',
    cleanable: true,
    homeSubpaths: [
      ['Library', 'Caches', 'uv'],
      ['.cache', 'uv'],
    ],
    note: 'Astral uv Python 包缓存，需要时可自动重新下载。',
  },
  {
    id: 'cargo-registry-cache',
    label: 'Cargo Registry/Git 缓存',
    category: 'build-tool',
    risk: 'safe',
    cleanable: true,
    homeSubpaths: [
      ['.cargo', 'registry', 'cache'],
      ['.cargo', 'git', 'db'],
    ],
    note: 'Rust crate 压缩包与 Git 仓库缓存，不影响 cargo bin 工具链。',
  },
  {
    id: 'go-build-cache',
    label: 'Go Build 编译缓存',
    category: 'build-tool',
    risk: 'safe',
    cleanable: true,
    homeSubpaths: [
      ['Library', 'Caches', 'go-build'],
      ['.cache', 'go-build'],
    ],
    note: 'Go 编译对象缓存，下次 go build/test 自动重新生成。',
  },
  {
    id: 'go-mod-cache',
    label: 'Go Module 下载缓存',
    category: 'package-manager',
    risk: 'caution',
    cleanable: true,
    homeSubpaths: [['go', 'pkg', 'mod', 'cache']],
    note: 'Go 模块版本下载包缓存，清理后首次编译需联网重新拉取。',
  },
  {
    id: 'gradle-caches',
    label: 'Gradle 构建缓存',
    category: 'build-tool',
    risk: 'safe',
    cleanable: true,
    homeSubpaths: [['.gradle', 'caches']],
    note: 'Gradle 依赖与构建缓存，清理后下次构建会重新同步。',
  },
  {
    id: 'playwright-browsers',
    label: 'Playwright 浏览器缓存',
    category: 'browser-testing',
    risk: 'caution',
    cleanable: true,
    homeSubpaths: [
      ['Library', 'Caches', 'ms-playwright'],
      ['.cache', 'ms-playwright'],
    ],
    note: 'Playwright 测试浏览器内核二进制；清理后跑 E2E 前需执行 playwright install。',
  },
] as const;

export const TRASH_READONLY_RULE: ExternalCacheRule = {
  id: 'macos-trash',
  label: '系统废纸篓 (Trash)',
  category: 'system-trash',
  risk: 'risky',
  cleanable: false,
  homeSubpaths: [['.Trash'], ['.local', 'share', 'Trash', 'files']],
  note: '废纸篓仅做只读体积统计提示，ASI 绝不代为清空；请在 Finder 中人工检查后清空。',
};

const CLEANABLE_RULE_MAP = new Map<string, ExternalCacheRule>(
  EXTERNAL_CACHE_RULES.filter((r) => r.cleanable && (r.risk === 'safe' || r.risk === 'caution')).map((r) => [r.id, r]),
);

export const CLEANABLE_EXTERNAL_CACHE_IDS: readonly string[] = [...CLEANABLE_RULE_MAP.keys()];

export function isCleanableExternalCacheId(targetId: string | undefined): targetId is string {
  if (typeof targetId !== 'string' || !targetId.trim()) return false;
  return CLEANABLE_RULE_MAP.has(targetId);
}

export function getCleanableExternalCacheRule(targetId: string): ExternalCacheRule | undefined {
  return CLEANABLE_RULE_MAP.get(targetId);
}

function formatTildePath(segments: readonly string[]): string {
  return ['~', ...segments].join('/');
}

function isStrictlyInside(parentReal: string, candidateReal: string): boolean {
  const prefix = parentReal.endsWith(sep) ? parentReal : `${parentReal}${sep}`;
  return candidateReal.startsWith(prefix) && candidateReal.length > prefix.length;
}

const BARE_FORBIDDEN_ROOT_SEGMENTS: readonly (readonly string[])[] = [
  [],
  ['System'],
  ['bin'],
  ['sbin'],
  ['usr'],
  ['etc'],
  ['var'],
  ['var', 'root'],
  ['private'],
  ['private', 'var'],
  ['private', 'tmp'],
  ['tmp'],
  ['Library'],
  ['Library', 'Application Support'],
  ['Library', 'Extensions'],
  ['Applications'],
  ['Volumes'],
  ['opt'],
  ['Users'],
  ['home'],
];

const PROTECTED_HOME_SUBDIRS: readonly (readonly string[])[] = [
  ['Documents'],
  ['Downloads'],
  ['Pictures'],
  ['Movies'],
  ['Music'],
  ['.Trash'],
  ['.local', 'share', 'Trash'],
  ['.ssh'],
  ['.gnupg'],
  ['.aws'],
  ['.secrets'],
];

/**
 * Mole-inspired deletion root sink validator (`validate_path_for_deletion`):
 * ensures candidate realpath is strictly inside `homeReal`, never equals a bare
 * system/home root, and never lands inside user documents, credentials, or Trash.
 */
export function validateProtectedTargetRoot(rootReal: string, homeReal: string): boolean {
  if (!rootReal || !homeReal) return false;
  const normalizedRoot = resolve(rootReal);
  const normalizedHome = resolve(homeReal);
  if (normalizedRoot === normalizedHome) return false;

  for (const segs of BARE_FORBIDDEN_ROOT_SEGMENTS) {
    const bare = segs.length === 0 ? sep : join(sep, ...segs);
    if (normalizedRoot === bare) return false;
  }

  for (const sysPrefix of [
    join(sep, 'System'),
    join(sep, 'Library', 'Extensions'),
    join(sep, 'bin'),
    join(sep, 'sbin'),
    join(sep, 'etc'),
    join(sep, 'var', 'db'),
  ]) {
    if (normalizedRoot === sysPrefix || isStrictlyInside(sysPrefix, normalizedRoot)) {
      return false;
    }
  }

  if (!isStrictlyInside(normalizedHome, normalizedRoot)) {
    return false;
  }

  for (const sub of PROTECTED_HOME_SUBDIRS) {
    const protectedPath = join(normalizedHome, ...sub);
    if (normalizedRoot === protectedPath || isStrictlyInside(protectedPath, normalizedRoot)) {
      return false;
    }
  }

  return true;
}

export interface ScannedExternalCacheEntry {
  targetId: string;
  label: string;
  category: ExternalCacheCategory;
  risk: 'safe' | 'caution';
  paths: string[];
  totalBytes: number;
  reclaimableBytes: number;
  activeProtectedBytes: number;
  staleEntryCount: number;
  activeEntryCount: number;
  skippedSymlinks: number;
  approvable: boolean;
  note: string;
}

export interface TrashReadonlySummary {
  exists: boolean;
  paths: string[];
  totalBytes: number;
  itemCount: number;
  risk: 'risky';
  cleanable: false;
  note: string;
}

export interface ExternalCacheScanReport {
  scannedAt: number;
  activeProtectionWindowMs: number;
  externalCaches: ScannedExternalCacheEntry[];
  trash: TrashReadonlySummary;
  truncated: boolean;
}

interface WalkBudget {
  remaining: number;
  truncated: boolean;
  opsSinceYield: number;
}

async function tickBudget(budget: WalkBudget): Promise<boolean> {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return false;
  }
  budget.remaining -= 1;
  budget.opsSinceYield += 1;
  if (budget.opsSinceYield >= EVENT_LOOP_YIELD_EVERY) {
    budget.opsSinceYield = 0;
    await new Promise<void>((r) => setImmediate(r));
  }
  return true;
}

async function measureDirTree(
  rootReal: string,
  currentReal: string,
  now: number,
  activeProtectionMs: number,
  depth: number,
  budget: WalkBudget,
): Promise<{
  totalBytes: number;
  reclaimableBytes: number;
  staleEntryCount: number;
  activeEntryCount: number;
  skippedSymlinks: number;
}> {
  let totalBytes = 0;
  let reclaimableBytes = 0;
  let staleEntryCount = 0;
  let activeEntryCount = 0;
  let skippedSymlinks = 0;

  if (depth > DEFAULT_MAX_SCAN_DEPTH) {
    budget.truncated = true;
    return { totalBytes, reclaimableBytes, staleEntryCount, activeEntryCount, skippedSymlinks };
  }

  const entries = await readdir(currentReal, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!(await tickBudget(budget))) break;
    const full = join(currentReal, entry.name);
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
      const sub = await measureDirTree(rootReal, real, now, activeProtectionMs, depth + 1, budget);
      totalBytes += sub.totalBytes;
      reclaimableBytes += sub.reclaimableBytes;
      staleEntryCount += sub.staleEntryCount;
      activeEntryCount += sub.activeEntryCount;
      skippedSymlinks += sub.skippedSymlinks;
    } else if (st.isFile()) {
      totalBytes += st.size;
      if (activeProtectionMs <= 0 || now - st.mtimeMs >= activeProtectionMs) {
        reclaimableBytes += st.size;
        staleEntryCount += 1;
      } else {
        activeEntryCount += 1;
      }
    }
  }

  return { totalBytes, reclaimableBytes, staleEntryCount, activeEntryCount, skippedSymlinks };
}

export async function scanExternalCachesAndTrash(options: {
  homeDir: string;
  now: number;
  activeProtectionMs?: number;
  maxEntries?: number;
}): Promise<ExternalCacheScanReport> {
  const activeProtectionMs = Math.max(0, options.activeProtectionMs ?? EXTERNAL_CACHE_ACTIVE_PROTECTION_MS);
  const budget: WalkBudget = {
    remaining: Math.max(200, options.maxEntries ?? DEFAULT_MAX_SCAN_ENTRIES),
    truncated: false,
    opsSinceYield: 0,
  };

  const emptyReport: ExternalCacheScanReport = {
    scannedAt: options.now,
    activeProtectionWindowMs: activeProtectionMs,
    externalCaches: [],
    trash: {
      exists: false,
      paths: [],
      totalBytes: 0,
      itemCount: 0,
      risk: 'risky',
      cleanable: false,
      note: TRASH_READONLY_RULE.note,
    },
    truncated: false,
  };

  if (!options.homeDir?.trim()) return emptyReport;
  const homeStat = await lstat(options.homeDir).catch(() => undefined);
  if (!homeStat || homeStat.isSymbolicLink() || !homeStat.isDirectory()) return emptyReport;
  const homeReal = await realpath(options.homeDir).catch(() => undefined);
  if (!homeReal) return emptyReport;

  const scanned: ScannedExternalCacheEntry[] = [];
  const seenGlobalRoots = new Set<string>();

  for (const rule of EXTERNAL_CACHE_RULES) {
    if (!rule.cleanable || (rule.risk !== 'safe' && rule.risk !== 'caution')) continue;
    let totalBytes = 0;
    let reclaimableBytes = 0;
    let staleEntryCount = 0;
    let activeEntryCount = 0;
    let skippedSymlinks = 0;
    const matchedDisplayPaths: string[] = [];

    for (const segs of rule.homeSubpaths) {
      const candidate = join(homeReal, ...segs);
      const st = await lstat(candidate).catch(() => undefined);
      if (!st) continue;
      if (st.isSymbolicLink() || !st.isDirectory()) {
        if (st.isSymbolicLink()) skippedSymlinks += 1;
        continue;
      }
      const rootReal = await realpath(candidate).catch(() => undefined);
      if (!rootReal || seenGlobalRoots.has(rootReal) || !validateProtectedTargetRoot(rootReal, homeReal)) {
        continue;
      }
      seenGlobalRoots.add(rootReal);
      matchedDisplayPaths.push(formatTildePath(segs));

      const measured = await measureDirTree(rootReal, rootReal, options.now, activeProtectionMs, 0, budget);
      totalBytes += measured.totalBytes;
      reclaimableBytes += measured.reclaimableBytes;
      staleEntryCount += measured.staleEntryCount;
      activeEntryCount += measured.activeEntryCount;
      skippedSymlinks += measured.skippedSymlinks;
    }

    if (matchedDisplayPaths.length > 0 && (totalBytes > 0 || skippedSymlinks > 0 || activeEntryCount > 0)) {
      scanned.push({
        targetId: rule.id,
        label: rule.label,
        category: rule.category,
        risk: rule.risk,
        paths: matchedDisplayPaths,
        totalBytes,
        reclaimableBytes,
        activeProtectedBytes: Math.max(0, totalBytes - reclaimableBytes),
        staleEntryCount,
        activeEntryCount,
        skippedSymlinks,
        approvable: reclaimableBytes > 0,
        note: rule.note,
      });
    }
  }

  scanned.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes || b.totalBytes - a.totalBytes);

  // Read-only Trash sizing (never cleanable)
  let trashExists = false;
  let trashBytes = 0;
  let trashItems = 0;
  const trashPaths: string[] = [];
  const seenTrashRoots = new Set<string>();
  for (const segs of TRASH_READONLY_RULE.homeSubpaths) {
    const candidate = join(homeReal, ...segs);
    const st = await lstat(candidate).catch(() => undefined);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) continue;
    const trashReal = await realpath(candidate).catch(() => undefined);
    if (!trashReal || !isStrictlyInside(homeReal, trashReal) || seenTrashRoots.has(trashReal)) continue;
    seenTrashRoots.add(trashReal);
    trashExists = true;
    trashPaths.push(formatTildePath(segs));
    const topItems = await readdir(trashReal).catch(() => []);
    trashItems += topItems.length;
    const measured = await measureDirTree(trashReal, trashReal, options.now, 0, 0, budget);
    trashBytes += measured.totalBytes;
  }

  return {
    scannedAt: options.now,
    activeProtectionWindowMs: activeProtectionMs,
    externalCaches: scanned,
    trash: {
      exists: trashExists,
      paths: trashPaths,
      totalBytes: trashBytes,
      itemCount: trashItems,
      risk: 'risky',
      cleanable: false,
      note: TRASH_READONLY_RULE.note,
    },
    truncated: budget.truncated,
  };
}

export interface ExternalCacheCleanResult {
  targetId: string;
  label: string;
  risk: 'safe' | 'caution';
  deletedEntries: number;
  freedBytes: number;
  skippedActiveEntries: number;
  protectedActiveBytes: number;
  skippedSymlinks: number;
  rootsCleaned: number;
}

async function cleanStaleEntriesInDir(
  rootReal: string,
  currentReal: string,
  now: number,
  activeProtectionMs: number,
  isTopRoot: boolean,
  ops: { count: number },
): Promise<{
  deletedEntries: number;
  freedBytes: number;
  skippedActiveEntries: number;
  protectedActiveBytes: number;
  skippedSymlinks: number;
}> {
  let deletedEntries = 0;
  let freedBytes = 0;
  let skippedActiveEntries = 0;
  let protectedActiveBytes = 0;
  let skippedSymlinks = 0;

  const entries = await readdir(currentReal, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    ops.count += 1;
    if (ops.count % EVENT_LOOP_YIELD_EVERY === 0) {
      await new Promise<void>((r) => setImmediate(r));
    }
    const full = join(currentReal, entry.name);
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
      const childEntriesBefore = await readdir(real).catch(() => []);
      const sub = await cleanStaleEntriesInDir(rootReal, real, now, activeProtectionMs, false, ops);
      deletedEntries += sub.deletedEntries;
      freedBytes += sub.freedBytes;
      skippedActiveEntries += sub.skippedActiveEntries;
      protectedActiveBytes += sub.protectedActiveBytes;
      skippedSymlinks += sub.skippedSymlinks;

      const canRemoveEmptyDir =
        childEntriesBefore.length > 0
          ? sub.skippedActiveEntries === 0 && sub.skippedSymlinks === 0
          : activeProtectionMs <= 0 || now - st.mtimeMs >= activeProtectionMs;
      if (canRemoveEmptyDir) {
        const remaining = await readdir(real).catch(() => ['keep']);
        if (remaining.length === 0) {
          await rmdir(real).catch(() => undefined);
        }
      }
    } else if (st.isFile()) {
      if (activeProtectionMs > 0 && now - st.mtimeMs < activeProtectionMs) {
        skippedActiveEntries += 1;
        protectedActiveBytes += st.size;
        continue;
      }
      try {
        await unlink(real);
        deletedEntries += 1;
        freedBytes += st.size;
      } catch {
        // Ignore concurrent deletion race
      }
    }
  }

  if (!isTopRoot && entries.length === 0 && activeProtectionMs <= 0) {
    await rmdir(currentReal).catch(() => undefined);
  }

  return { deletedEntries, freedBytes, skippedActiveEntries, protectedActiveBytes, skippedSymlinks };
}

/**
 * User-approved one-click cleanup for a controlled external developer cache target.
 * - Hard-rejects unknown IDs, arbitrary paths, and risky targets (`macos-trash`).
 * - Verifies `lstat` (no symlink root or symlink traversal) and `realpath` containment.
 * - Preserves any item modified within `activeProtectionMs` (default 1 hour) so active
 *   compilations or package downloads are never disrupted.
 */
export async function cleanExternalCacheTarget(options: {
  homeDir: string;
  targetId: string;
  now: number;
  activeProtectionMs?: number;
}): Promise<ExternalCacheCleanResult> {
  const rule = getCleanableExternalCacheRule(options.targetId);
  if (!rule || (rule.risk !== 'safe' && rule.risk !== 'caution')) {
    throw new Error(`Refused non-whitelisted or risky cache target: ${String(options.targetId)}`);
  }

  const activeProtectionMs = Math.max(0, options.activeProtectionMs ?? EXTERNAL_CACHE_ACTIVE_PROTECTION_MS);
  if (!options.homeDir?.trim()) {
    return {
      targetId: rule.id,
      label: rule.label,
      risk: rule.risk,
      deletedEntries: 0,
      freedBytes: 0,
      skippedActiveEntries: 0,
      protectedActiveBytes: 0,
      skippedSymlinks: 0,
      rootsCleaned: 0,
    };
  }

  const homeStat = await lstat(options.homeDir).catch(() => undefined);
  if (!homeStat || homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
    throw new Error('Refused external cache cleanup: invalid or symlinked home directory');
  }
  const homeReal = await realpath(options.homeDir);

  let deletedEntries = 0;
  let freedBytes = 0;
  let skippedActiveEntries = 0;
  let protectedActiveBytes = 0;
  let skippedSymlinks = 0;
  let rootsCleaned = 0;
  const seenRoots = new Set<string>();
  const ops = { count: 0 };

  for (const segs of rule.homeSubpaths) {
    const candidate = join(homeReal, ...segs);
    const st = await lstat(candidate).catch(() => undefined);
    if (!st) continue;
    if (st.isSymbolicLink()) {
      skippedSymlinks += 1;
      continue;
    }
    if (!st.isDirectory()) continue;

    const rootReal = await realpath(candidate).catch(() => undefined);
    if (!rootReal || seenRoots.has(rootReal)) continue;
    if (!validateProtectedTargetRoot(rootReal, homeReal)) {
      throw new Error(`Refused external cache cleanup: target failed root boundary check (${rule.id})`);
    }
    seenRoots.add(rootReal);
    rootsCleaned += 1;

    const res = await cleanStaleEntriesInDir(rootReal, rootReal, options.now, activeProtectionMs, true, ops);
    deletedEntries += res.deletedEntries;
    freedBytes += res.freedBytes;
    skippedActiveEntries += res.skippedActiveEntries;
    protectedActiveBytes += res.protectedActiveBytes;
    skippedSymlinks += res.skippedSymlinks;
  }

  return {
    targetId: rule.id,
    label: rule.label,
    risk: rule.risk,
    deletedEntries,
    freedBytes,
    skippedActiveEntries,
    protectedActiveBytes,
    skippedSymlinks,
    rootsCleaned,
  };
}
