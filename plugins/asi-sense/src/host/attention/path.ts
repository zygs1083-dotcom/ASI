import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAC_ALIAS_PAIRS: readonly [string, string][] = [
  ['/var', '/private/var'],
  ['/tmp', '/private/tmp'],
  ['/etc', '/private/etc'],
];

const NON_ASCII_OR_CTRL = /[^\x20-\x7f]/;
const UPPER_ASCII = /[A-Z]/;

/** Normalizes an absolute POSIX path to NFC and strips redundant slashes/dots. */
export function normalizeAbsPath(p: string): string | undefined {
  if (!p) return undefined;
  const nfc = NON_ASCII_OR_CTRL.test(p) ? p.normalize('NFC') : p;
  if (nfc.charCodeAt(0) !== 47) return undefined;
  if (!nfc.includes('//') && !nfc.includes('/.') && (nfc.length === 1 || nfc.charCodeAt(nfc.length - 1) !== 47)) {
    return nfc;
  }
  const norm = path.posix.normalize(nfc);
  return norm.length > 1 ? norm.replace(/\/+$/, '') : norm;
}

/** Applies NFC normalization and macOS case folding when `platform === 'darwin'`. */
export function foldPath(p: string, platform: string = process.platform): string {
  const nfc = NON_ASCII_OR_CTRL.test(p) ? p.normalize('NFC') : p;
  if (platform !== 'darwin') return nfc;
  return NON_ASCII_OR_CTRL.test(nfc) || UPPER_ASCII.test(nfc) ? nfc.toLowerCase() : nfc;
}

export function foldNormalized(nfc: string, platform: string): string {
  if (platform !== 'darwin') return nfc;
  return NON_ASCII_OR_CTRL.test(nfc) || UPPER_ASCII.test(nfc) ? nfc.toLowerCase() : nfc;
}

/** Maps macOS top-level symlinks (`/var`, `/tmp`, `/etc`) to their canonical `/private/*` forms. */
export function canonicalizeDarwinAlias(absPath: string, platform: string = process.platform): string {
  if (platform !== 'darwin') return absPath;
  const lower = NON_ASCII_OR_CTRL.test(absPath) || UPPER_ASCII.test(absPath) ? absPath.toLowerCase() : absPath;
  for (const [short, priv] of MAC_ALIAS_PAIRS) {
    if (lower === short || lower.startsWith(`${short}/`)) {
      return `${priv}${absPath.slice(short.length)}`;
    }
  }
  return absPath;
}

/**
 * Resolves the realpath of an absolute path, walking up to the nearest
 * existing ancestor if the path itself has not been created yet.
 */
export function resolveRealPath(absPath: string): string | undefined {
  const norm = normalizeAbsPath(absPath);
  if (!norm) return undefined;
  if (existsSync(norm)) {
    try {
      return normalizeAbsPath(realpathSync(norm));
    } catch {
      // Fall back to nearest existing ancestor below.
    }
  }
  const suffix: string[] = [];
  let cur = norm;
  while (cur !== '/') {
    const parent = path.posix.dirname(cur);
    suffix.push(path.posix.basename(cur));
    cur = parent;
    if (!existsSync(cur)) continue;
    try {
      const realBase = realpathSync(cur);
      return normalizeAbsPath(path.posix.join(realBase, ...suffix.reverse()));
    } catch {
      // Keep walking up until an existing ancestor is found.
    }
  }
  return norm;
}

function resolveRealPathOrGlob(norm: string): string {
  const wildcard = norm.search(/[*?]/);
  if (wildcard < 0) return resolveRealPath(norm) ?? norm;
  const slashBefore = norm.lastIndexOf('/', wildcard);
  if (slashBefore <= 0) return norm;
  const literalDir = norm.slice(0, slashBefore);
  const rest = norm.slice(slashBefore);
  const realBase = resolveRealPath(literalDir) ?? literalDir;
  return realBase === '/' ? rest : `${realBase}${rest}`;
}

function expandKnownAliases(absPath: string, platform: string): string[] {
  const out = [absPath];
  const folded = foldPath(absPath, platform);
  for (const [short, priv] of MAC_ALIAS_PAIRS) {
    if (folded === short || folded.startsWith(`${short}/`)) {
      out.push(`${priv}${absPath.slice(short.length)}`);
    } else if (folded === priv || folded.startsWith(`${priv}/`)) {
      out.push(`${short}${absPath.slice(priv.length)}`);
    }
  }
  if (platform === 'darwin' && folded === '/private') {
    out.push('/var', '/tmp', '/etc');
  }
  return out;
}

/** Returns normalized raw + realpath + known alias variants for an absolute path. */
export function resolvePathVariants(absPath: string, platform: string = process.platform): string[] {
  const norm = normalizeAbsPath(absPath);
  if (!norm) return [];
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | undefined) => {
    if (!value) return;
    for (const alias of expandKnownAliases(value, platform)) {
      const key = foldPath(alias, platform);
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(alias);
      }
    }
  };
  push(norm);
  push(resolveRealPath(norm));
  return candidates;
}

const MAX_DIR_CACHE = 4096;

function resolveCachedDir(dir: string, platform: string, dirCache: Map<string, string>): string {
  let realDir = dirCache.get(dir);
  if (realDir === undefined) {
    const resolvedDir = resolveRealPath(dir) ?? dir;
    realDir = foldNormalized(canonicalizeDarwinAlias(resolvedDir, platform), platform);
    if (dirCache.size >= MAX_DIR_CACHE) {
      const first = dirCache.keys().next().value;
      if (first !== undefined) dirCache.delete(first);
    }
    dirCache.set(dir, realDir);
  }
  return realDir;
}

const DIRTY_ASCII_POSIX = /[?*]|\/\/|\/\.|\/$|[^\x20-\x7f]/;
const DIRTY_ASCII_DARWIN = /[?*A-Z]|\/\/|\/\.|\/$|[^\x20-\x7f]/;

/**
 * Shared canonical path normalization used by both FileSource and FileGlobalSource:
 * NFC normalization + realpath/macOS alias canonicalization + darwin case folding.
 * When `dirCache` is supplied for high-rate file events, parent directories are
 * memoized so hot paths perform zero allocations and zero syscalls on cache hits.
 */
export function normalizeWatchPath(
  rawPath: string,
  platform: string = process.platform,
  dirCache?: Map<string, string>,
  outDir?: { dir: string },
): string | undefined {
  if (!rawPath) return undefined;
  if (dirCache && rawPath.length > 1 && rawPath.charCodeAt(0) === 47) {
    const isDarwin = platform === 'darwin';
    if (!(isDarwin ? DIRTY_ASCII_DARWIN : DIRTY_ASCII_POSIX).test(rawPath)) {
      const lastSlash = rawPath.lastIndexOf('/');
      const dir = lastSlash <= 0 ? '/' : rawPath.slice(0, lastSlash);
      const realDir = resolveCachedDir(dir, platform, dirCache);
      if (dir === '/' && isDarwin) {
        const mapped = canonicalizeDarwinAlias(rawPath, platform);
        if (outDir) {
          const s = mapped.lastIndexOf('/');
          outDir.dir = s <= 0 ? '/' : mapped.slice(0, s);
        }
        return mapped;
      }
      if (outDir) outDir.dir = realDir;
      return realDir === dir
        ? rawPath
        : realDir === '/'
          ? rawPath.slice(lastSlash)
          : `${realDir}${rawPath.slice(lastSlash)}`;
    }
  }
  const norm = normalizeAbsPath(rawPath);
  if (!norm) return undefined;
  if (norm === '/') {
    if (outDir) outDir.dir = '/';
    return '/';
  }
  if (!dirCache || norm.includes('*') || norm.includes('?')) {
    const resolved = resolveRealPathOrGlob(norm);
    const out = foldNormalized(canonicalizeDarwinAlias(resolved, platform), platform);
    if (outDir) {
      const s = out.lastIndexOf('/');
      outDir.dir = s <= 0 ? '/' : out.slice(0, s);
    }
    return out;
  }
  const lastSlash = norm.lastIndexOf('/');
  const dir = lastSlash <= 0 ? '/' : norm.slice(0, lastSlash);
  const base = norm.slice(lastSlash + 1);
  const realDir = resolveCachedDir(dir, platform, dirCache);
  const foldedBase = foldNormalized(base, platform);
  if (dir === '/' && platform === 'darwin') {
    const mapped = canonicalizeDarwinAlias(`/${foldedBase}`, platform);
    if (outDir) {
      const s = mapped.lastIndexOf('/');
      outDir.dir = s <= 0 ? '/' : mapped.slice(0, s);
    }
    return mapped;
  }
  if (outDir) outDir.dir = realDir;
  if (realDir === dir && foldedBase === base) return norm;
  return realDir === '/' ? `/${foldedBase}` : `${realDir}/${foldedBase}`;
}

/** Returns true when `raw` points to the current user's home directory or a standard POSIX home root. */
export function isHomeRoot(raw: string, platform: string = process.platform): boolean {
  const clean = raw.replaceAll('\\', '/').replace(/\/+$/, '') || '/';
  const home = os.homedir().replaceAll('\\', '/').replace(/\/+$/, '');
  const nfcClean = clean.normalize('NFC');
  const nfcHome = home.normalize('NFC');
  if (
    nfcHome &&
    nfcHome !== '/' &&
    (platform === 'darwin' ? nfcClean.toLowerCase() === nfcHome.toLowerCase() : nfcClean === nfcHome)
  ) {
    return true;
  }
  return /^\/(?:Users|home)\/[^/]+$/i.test(nfcClean);
}
