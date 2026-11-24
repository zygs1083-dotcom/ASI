import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export type LegacyModuleKey = 'sense' | 'needs' | 'sleep' | 'care' | 'growth';

export type LegacyModuleMigrationStatus = 'migrated' | 'target-exists' | 'absent' | 'empty' | 'skipped-symlink';

export interface LegacyMigrationReport {
  status: 'migrated' | 'already-migrated' | 'nothing-to-migrate';
  migratedAt: number;
  modules: Record<LegacyModuleKey, LegacyModuleMigrationStatus>;
  filesCopied: number;
  bytesCopied: number;
  skippedSymlinks: number;
  skippedUnreadable: number;
}

interface PersistedMigrationMarker {
  version: 1;
  completed: true;
  migratedAt: number;
  modules: Record<LegacyModuleKey, LegacyModuleMigrationStatus>;
  filesCopied: number;
  bytesCopied: number;
  skippedSymlinks: number;
  skippedUnreadable: number;
}

interface ModuleMigrationSpec {
  module: LegacyModuleKey;
  legacyName: string;
  skipTopDirs: ReadonlySet<string>;
  primaryChecks: readonly string[];
}

const MIGRATION_SPECS: readonly ModuleMigrationSpec[] = [
  {
    module: 'sense',
    legacyName: 'asi-sense',
    skipTopDirs: new Set(['tmp', 'cache']),
    primaryChecks: ['settings.json'],
  },
  {
    module: 'needs',
    legacyName: 'asi-needs',
    skipTopDirs: new Set(['sandbox', 'tmp', 'cache']),
    primaryChecks: ['state.json'],
  },
  {
    module: 'sleep',
    legacyName: 'asi-sleep',
    skipTopDirs: new Set(['tmp', 'cache']),
    primaryChecks: ['state.json', 'vault/memories.jsonl', 'vault/MEMORY.md', 'vault/sleep-journal.jsonl'],
  },
  {
    module: 'care',
    legacyName: 'asi-care',
    skipTopDirs: new Set(['sandbox', 'tmp', 'cache']),
    primaryChecks: ['state.json'],
  },
  {
    module: 'growth',
    legacyName: 'asi-growth',
    skipTopDirs: new Set(['sandbox', 'tmp', 'cache']),
    primaryChecks: ['state.json', 'catalog.json', 'journal.jsonl', 'skills/active', 'skills/drafts', 'skills/archived'],
  },
];

const MAX_COPY_DEPTH = 8;

function isStrictlyInside(parentReal: string, candidateReal: string): boolean {
  const prefix = parentReal.endsWith(sep) ? parentReal : `${parentReal}${sep}`;
  return candidateReal.startsWith(prefix) && candidateReal.length > prefix.length;
}

function isTransientTempFile(name: string): boolean {
  return name.endsWith('.tmp') || /^\..*\.tmp$/i.test(name);
}

async function pathExistsNoFollow(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function atomicCopyFileIfMissing(
  sourceReal: string,
  sourceStat: Stats,
  destPath: string,
): Promise<{ copied: boolean; bytes: number; unreadable: boolean }> {
  if (await pathExistsNoFollow(destPath)) {
    return { copied: false, bytes: 0, unreadable: false };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(sourceReal);
  } catch {
    return { copied: false, bytes: 0, unreadable: true };
  }
  await mkdir(dirname(destPath), { recursive: true, mode: 0o700 });
  if (await pathExistsNoFollow(destPath)) {
    return { copied: false, bytes: 0, unreadable: false };
  }
  const tmp = `${destPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(tmp, bytes, { mode: 0o600 });
    await utimes(tmp, sourceStat.atime, sourceStat.mtime).catch(() => undefined);
    await rename(tmp, destPath);
    return { copied: true, bytes: bytes.byteLength, unreadable: false };
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function copyDirectoryTreeSafe(options: {
  legacyRootReal: string;
  currentLegacyReal: string;
  currentTargetDir: string;
  skipTopDirs: ReadonlySet<string>;
  depth: number;
}): Promise<{ filesCopied: number; bytesCopied: number; skippedSymlinks: number; skippedUnreadable: number }> {
  let filesCopied = 0;
  let bytesCopied = 0;
  let skippedSymlinks = 0;
  let skippedUnreadable = 0;

  if (options.depth > MAX_COPY_DEPTH) {
    return { filesCopied, bytesCopied, skippedSymlinks, skippedUnreadable };
  }

  const entries = await readdir(options.currentLegacyReal, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (isTransientTempFile(entry.name)) continue;
    if (options.depth === 0 && options.skipTopDirs.has(entry.name)) continue;

    const fullLegacy = join(options.currentLegacyReal, entry.name);
    const st = await lstat(fullLegacy).catch(() => undefined);
    if (!st) continue;
    if (st.isSymbolicLink()) {
      skippedSymlinks += 1;
      continue;
    }

    const childReal = await realpath(fullLegacy).catch(() => undefined);
    if (!childReal || !isStrictlyInside(options.legacyRootReal, childReal)) {
      skippedSymlinks += 1;
      continue;
    }

    const fullTarget = join(options.currentTargetDir, entry.name);
    if (st.isDirectory()) {
      const sub = await copyDirectoryTreeSafe({
        legacyRootReal: options.legacyRootReal,
        currentLegacyReal: childReal,
        currentTargetDir: fullTarget,
        skipTopDirs: options.skipTopDirs,
        depth: options.depth + 1,
      });
      filesCopied += sub.filesCopied;
      bytesCopied += sub.bytesCopied;
      skippedSymlinks += sub.skippedSymlinks;
      skippedUnreadable += sub.skippedUnreadable;
    } else if (st.isFile()) {
      const copied = await atomicCopyFileIfMissing(childReal, st, fullTarget);
      if (copied.unreadable) {
        skippedUnreadable += 1;
      } else if (copied.copied) {
        filesCopied += 1;
        bytesCopied += copied.bytes;
      }
    }
  }

  return { filesCopied, bytesCopied, skippedSymlinks, skippedUnreadable };
}

async function mergeStagedTreeIntoExistingDir(stageDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const entries = await readdir(stageDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = join(stageDir, entry.name);
    const dst = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      if (!(await pathExistsNoFollow(dst))) {
        await rename(src, dst);
      } else {
        await mergeStagedTreeIntoExistingDir(src, dst);
      }
    } else if (entry.isFile() && !(await pathExistsNoFollow(dst))) {
      await rename(src, dst);
    }
  }
}

/**
 * Non-destructively migrates existing user state, consolidated sleep memories,
 * session watermarks, and procedural skills from legacy split plugin directories
 * (`../asi-{sense,needs,sleep,care,growth}`) into `<storageRoot>/{sense,needs,sleep,care,growth}`.
 *
 * Legacy directories are NEVER modified or deleted so users retain a 100% intact rollback backup.
 */
export async function migrateLegacyAsiData(storageRoot: string): Promise<LegacyMigrationReport> {
  if (!isAbsolute(storageRoot)) {
    throw new TypeError('asi storageRoot must be an absolute path');
  }

  const normRoot = resolve(storageRoot);
  const markerPath = join(normRoot, '.migration-v1.json');

  try {
    const rawMarker = await readFile(markerPath, 'utf8');
    const parsed = JSON.parse(rawMarker) as Partial<PersistedMigrationMarker>;
    if (parsed && parsed.version === 1 && parsed.completed === true && parsed.modules) {
      return {
        status: 'already-migrated',
        migratedAt: typeof parsed.migratedAt === 'number' ? parsed.migratedAt : Date.now(),
        modules: parsed.modules,
        filesCopied: typeof parsed.filesCopied === 'number' ? parsed.filesCopied : 0,
        bytesCopied: typeof parsed.bytesCopied === 'number' ? parsed.bytesCopied : 0,
        skippedSymlinks: typeof parsed.skippedSymlinks === 'number' ? parsed.skippedSymlinks : 0,
        skippedUnreadable: typeof parsed.skippedUnreadable === 'number' ? parsed.skippedUnreadable : 0,
      };
    }
  } catch {
    // Marker absent or invalid; proceed with safe idempotent check.
  }

  const existingRootEntries = await readdir(normRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of existingRootEntries) {
    if (entry.name.startsWith('.mig-') && entry.name.endsWith('.tmp')) {
      await rm(join(normRoot, entry.name), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const dataParent = dirname(normRoot);
  const modules: Record<LegacyModuleKey, LegacyModuleMigrationStatus> = {
    sense: 'absent',
    needs: 'absent',
    sleep: 'absent',
    care: 'absent',
    growth: 'absent',
  };
  let filesCopied = 0;
  let bytesCopied = 0;
  let skippedSymlinks = 0;
  let skippedUnreadable = 0;

  if (dataParent && dataParent !== normRoot) {
    for (const spec of MIGRATION_SPECS) {
      const targetDir = join(normRoot, spec.module);
      const legacyDir = join(dataParent, spec.legacyName);
      if (resolve(legacyDir) === resolve(targetDir) || resolve(legacyDir) === normRoot) {
        continue;
      }

      let targetPopulated = false;
      for (const rel of spec.primaryChecks) {
        if (await pathExistsNoFollow(join(targetDir, rel))) {
          targetPopulated = true;
          break;
        }
      }
      if (targetPopulated) {
        modules[spec.module] = 'target-exists';
        continue;
      }

      const legacyStat = await lstat(legacyDir).catch(() => undefined);
      if (!legacyStat) {
        modules[spec.module] = 'absent';
        continue;
      }
      if (legacyStat.isSymbolicLink() || !legacyStat.isDirectory()) {
        modules[spec.module] = 'skipped-symlink';
        skippedSymlinks += 1;
        continue;
      }

      const legacyRootReal = await realpath(legacyDir).catch(() => undefined);
      if (!legacyRootReal) {
        modules[spec.module] = 'absent';
        continue;
      }

      await mkdir(normRoot, { recursive: true, mode: 0o700 });
      const stageDir = join(normRoot, `.mig-${spec.module}-${process.pid}-${randomUUID().slice(0, 8)}.tmp`);
      try {
        const res = await copyDirectoryTreeSafe({
          legacyRootReal,
          currentLegacyReal: legacyRootReal,
          currentTargetDir: stageDir,
          skipTopDirs: spec.skipTopDirs,
          depth: 0,
        });
        if (res.filesCopied > 0) {
          if (!(await pathExistsNoFollow(targetDir))) {
            await rename(stageDir, targetDir);
          } else {
            await mergeStagedTreeIntoExistingDir(stageDir, targetDir);
          }
          modules[spec.module] = 'migrated';
        } else {
          modules[spec.module] = 'empty';
        }
        filesCopied += res.filesCopied;
        bytesCopied += res.bytesCopied;
        skippedSymlinks += res.skippedSymlinks;
        skippedUnreadable += res.skippedUnreadable;
      } finally {
        await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  const migratedAt = Date.now();
  const anyMigrated = Object.values(modules).some((s) => s === 'migrated');
  const markerPayload: PersistedMigrationMarker = {
    version: 1,
    completed: true,
    migratedAt,
    modules,
    filesCopied,
    bytesCopied,
    skippedSymlinks,
    skippedUnreadable,
  };

  await mkdir(normRoot, { recursive: true, mode: 0o700 });
  const tmpMarker = `${markerPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(tmpMarker, `${JSON.stringify(markerPayload, null, 2)}\n`, { mode: 0o600 });
    await rename(tmpMarker, markerPath);
  } catch (err) {
    await rm(tmpMarker, { force: true }).catch(() => undefined);
    throw err;
  }

  return {
    status: anyMigrated ? 'migrated' : 'nothing-to-migrate',
    migratedAt,
    modules,
    filesCopied,
    bytesCopied,
    skippedSymlinks,
    skippedUnreadable,
  };
}
