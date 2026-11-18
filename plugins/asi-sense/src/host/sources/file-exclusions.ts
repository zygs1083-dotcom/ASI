import { realpathSync } from 'node:fs';
import path from 'node:path';
import { type CompiledGlob, compileGlob } from '../attention/glob.ts';

export const MAX_FILE_EXCLUSION_LENGTH = 1024;
export const MAX_FILE_EXCLUSIONS = 200;

/** Built-in default exclusions for whole-disk file watching (DESIGN §2.8). */
export const DEFAULT_FILE_EXCLUSIONS: readonly string[] = [
  '/System',
  '/Library',
  '/private',
  '/dev',
  '/usr',
  '/bin',
  '/sbin',
  '/cores',
  path.posix.join('/', 'opt', 'homebrew'),
  '~/Library',
  '~/.Trash',
  'node_modules',
  '.git',
  '.cache',
  'Caches',
  'DerivedData',
  '.pnpm-store',
  '__pycache__',
];

const MAC_ALIAS_PAIRS: readonly [string, string][] = [
  ['/var', '/private/var'],
  ['/tmp', '/private/tmp'],
  ['/etc', '/private/etc'],
];

const NON_ASCII_OR_CTRL = /[^\x20-\x7f]/;
const UPPER_ASCII = /[A-Z]/;
const REGEX_ESC = /[.*+?^${}()|[\]\\]/g;

const escapeLiteral = (s: string) => s.replace(REGEX_ESC, '\\$&');

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

function foldNormalized(nfc: string, platform: string): string {
  if (platform !== 'darwin') return nfc;
  return NON_ASCII_OR_CTRL.test(nfc) || UPPER_ASCII.test(nfc) ? nfc.toLowerCase() : nfc;
}

/** Canonical deduplication key for a normalized exclusion pattern. */
export function exclusionKey(pattern: string, platform: string = process.platform): string {
  return foldPath(pattern, platform);
}

/**
 * Resolves the realpath of an absolute path, walking up to the nearest
 * existing ancestor if the path itself has not been created yet.
 */
export function resolveRealPath(absPath: string): string | undefined {
  const norm = normalizeAbsPath(absPath);
  if (!norm) return undefined;
  try {
    return normalizeAbsPath(realpathSync(norm));
  } catch {
    const suffix: string[] = [];
    let cur = norm;
    while (cur !== '/') {
      const parent = path.posix.dirname(cur);
      suffix.push(path.posix.basename(cur));
      cur = parent;
      try {
        const realBase = realpathSync(cur);
        return normalizeAbsPath(path.posix.join(realBase, ...suffix.reverse()));
      } catch {
        // Keep walking up until an existing ancestor is found.
      }
    }
    return norm;
  }
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

/** Normalizes and validates one user-configurable file exclusion pattern. */
export function normalizeFileExclusion(raw: string): string {
  if (typeof raw !== 'string') throw new TypeError('Exclusion pattern must be a string');
  if (/[\0\r\n]/.test(raw)) throw new TypeError('Exclusion pattern contains invalid control characters');
  const trimmed = raw.trim();
  if (!trimmed) throw new TypeError('Exclusion pattern is required');
  if (trimmed.length > MAX_FILE_EXCLUSION_LENGTH) {
    throw new TypeError(`Exclusion pattern exceeds ${MAX_FILE_EXCLUSION_LENGTH} characters`);
  }
  const nfc = trimmed.normalize('NFC');
  if (nfc.length > MAX_FILE_EXCLUSION_LENGTH) {
    throw new TypeError(`Exclusion pattern exceeds ${MAX_FILE_EXCLUSION_LENGTH} characters`);
  }
  if (nfc === '~' || nfc === '~/') throw new TypeError('Cannot exclude entire home root with ~');
  if (nfc.startsWith('~/')) {
    const rawRest = nfc.slice(2);
    const rawSegs = rawRest.replace(/\/+$/, '').split('/');
    if (rawSegs.some((seg) => seg === '.' || seg === '..')) {
      throw new TypeError('Home-relative exclusion cannot contain . or .. segments');
    }
    const rest = path.posix.normalize(rawRest).replace(/\/+$/, '');
    if (!rest || rest === '.' || rest === '..' || rest.startsWith('../')) {
      throw new TypeError('Invalid home-relative exclusion pattern');
    }
    return `~/${rest}`;
  }
  if (nfc.startsWith('/')) {
    if (nfc.split('/').some((seg) => seg === '..')) {
      throw new TypeError('Exclusion path cannot contain .. segments');
    }
    const norm = path.posix.normalize(nfc);
    const clean = norm.length > 1 ? norm.replace(/\/+$/, '') : norm;
    if (clean === '/') throw new TypeError('Cannot exclude filesystem root /');
    return clean;
  }
  if (nfc.includes('/')) {
    throw new TypeError('Relative exclusion paths with / are not allowed; use /, ~/, or a single segment name');
  }
  if (nfc === '.' || nfc === '..') throw new TypeError('Invalid exclusion pattern');
  return nfc;
}

function normalizeHome(homedir: string): string | undefined {
  return normalizeAbsPath(homedir);
}

/**
 * Compiled, allocation-light matcher for whole-disk file exclusions.
 * Rebuilt only when settings or runtime data directories change.
 */
export class ExclusionMatcher {
  private readonly exactPrefixes = new Set<string>();
  private readonly segments = new Set<string>();
  private readonly prefixRe?: RegExp;
  private readonly segmentRe?: RegExp;
  private readonly absGlobs: CompiledGlob[] = [];
  private readonly absGlobKeys = new Set<string>();
  private readonly segmentGlobs: CompiledGlob[] = [];

  constructor(
    patterns: readonly string[],
    dataDirs: readonly string[] = [],
    homedir = '',
    private readonly platform: string = process.platform,
  ) {
    const home = normalizeHome(homedir);
    const homeVariants = home ? resolvePathVariants(home, this.platform) : [];

    const addAbsPrefix = (abs: string) => {
      for (const variant of resolvePathVariants(abs, this.platform)) {
        const folded = foldPath(variant, this.platform);
        if (folded !== '/') this.exactPrefixes.add(folded);
      }
    };

    const addAbsGlob = (globPattern: string) => {
      const normalized = globPattern.endsWith('/**') && globPattern.length > 3 ? globPattern.slice(0, -3) : globPattern;
      const wildcard = normalized.search(/[*?]/);
      const candidates = [normalized];
      if (wildcard > 0) {
        const slashBefore = normalized.lastIndexOf('/', wildcard);
        if (slashBefore > 0) {
          const literalDir = normalized.slice(0, slashBefore);
          const rest = normalized.slice(slashBefore);
          for (const variant of resolvePathVariants(literalDir, this.platform)) {
            candidates.push(`${variant}${rest}`);
          }
        }
      }
      for (const cand of candidates) {
        const folded = foldPath(cand, this.platform);
        if (this.absGlobKeys.has(folded)) continue;
        this.absGlobKeys.add(folded);
        this.absGlobs.push(compileGlob(folded, { matchDescendants: true }));
      }
    };

    for (const dir of dataDirs) addAbsPrefix(dir);

    for (const raw of patterns) {
      let pattern: string;
      try {
        pattern = normalizeFileExclusion(raw);
      } catch {
        continue;
      }
      const hasGlob = /[*?]/.test(pattern);
      if (pattern.startsWith('~/')) {
        if (homeVariants.length === 0) continue;
        const rest = pattern.slice(2);
        for (const h of homeVariants) {
          const expanded = `${h}/${rest}`;
          if (hasGlob) addAbsGlob(expanded);
          else addAbsPrefix(expanded);
        }
        continue;
      }
      if (pattern.startsWith('/')) {
        if (hasGlob) addAbsGlob(pattern);
        else addAbsPrefix(pattern);
        continue;
      }
      const folded = foldPath(pattern, this.platform);
      if (hasGlob) this.segmentGlobs.push(compileGlob(folded));
      else this.segments.add(folded);
    }

    if (this.exactPrefixes.size > 0) {
      const alts = [...this.exactPrefixes].sort((a, b) => b.length - a.length).map(escapeLiteral);
      this.prefixRe = new RegExp(`^(?:${alts.join('|')})(?:/|$)`);
    }
    if (this.segments.size > 0) {
      const alts = [...this.segments].sort((a, b) => b.length - a.length).map(escapeLiteral);
      this.segmentRe = new RegExp(`/(?:${alts.join('|')})(?:/|$)`);
    }
  }

  isExcluded(absPath: string): boolean {
    const norm = normalizeAbsPath(absPath);
    return norm ? this.isExcludedNormalized(norm) : false;
  }

  isExcludedNormalized(normAbsPath: string): boolean {
    const folded = foldNormalized(normAbsPath, this.platform);
    if (this.prefixRe?.test(folded)) return true;
    if (this.segmentRe?.test(folded)) return true;

    if (this.segmentGlobs.length > 0) {
      let start = 1;
      while (start <= folded.length) {
        const end = folded.indexOf('/', start);
        const seg = end < 0 ? folded.slice(start) : folded.slice(start, end);
        if (seg.length > 0) {
          for (let i = 0; i < this.segmentGlobs.length; i++) {
            if ((this.segmentGlobs[i] as CompiledGlob).test(seg)) return true;
          }
        }
        if (end < 0) break;
        start = end + 1;
      }
    }
    for (let i = 0; i < this.absGlobs.length; i++) {
      if ((this.absGlobs[i] as CompiledGlob).test(folded)) return true;
    }
    return false;
  }
}
