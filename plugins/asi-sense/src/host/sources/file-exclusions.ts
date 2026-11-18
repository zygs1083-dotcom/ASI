import path from 'node:path';
import { globToRegExp } from '../attention/rules.ts';

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

/** Normalizes and validates one user-configurable file exclusion pattern. */
export function normalizeFileExclusion(raw: string): string {
  if (typeof raw !== 'string') throw new TypeError('exclusion pattern must be a string');
  const trimmed = raw.trim();
  if (!trimmed || /[\0\r\n]/.test(trimmed)) throw new TypeError('invalid exclusion pattern');
  if (trimmed === '~' || trimmed === '~/') throw new TypeError('cannot exclude entire home root with ~');
  if (trimmed.startsWith('~/')) {
    const rest = path.posix.normalize(trimmed.slice(2)).replace(/\/+$/, '');
    if (!rest || rest === '.' || rest === '..' || rest.startsWith('../')) {
      throw new TypeError('invalid home-relative exclusion pattern');
    }
    return `~/${rest}`;
  }
  if (trimmed.startsWith('/')) {
    const norm = path.posix.normalize(trimmed);
    const clean = norm.length > 1 ? norm.replace(/\/+$/, '') : norm;
    if (clean === '/') throw new TypeError('cannot exclude filesystem root /');
    return clean;
  }
  const clean = path.posix
    .normalize(trimmed)
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  if (!clean || clean === '.' || clean === '..' || clean.startsWith('../')) {
    throw new TypeError('invalid exclusion pattern');
  }
  return clean;
}

function normalizeHome(homedir: string): string | undefined {
  if (!homedir || !path.posix.isAbsolute(homedir)) return undefined;
  const norm = path.posix.normalize(homedir);
  return norm.length > 1 ? norm.replace(/\/+$/, '') : undefined;
}

function normalizeAbsPrefix(p: string): string | undefined {
  if (!p || !path.posix.isAbsolute(p)) return undefined;
  const norm = path.posix.normalize(p);
  const clean = norm.length > 1 ? norm.replace(/\/+$/, '') : norm;
  return clean === '/' ? undefined : clean;
}

/**
 * Compiled, allocation-light matcher for whole-disk file exclusions.
 * Rebuilt only when settings or runtime data directories change.
 */
export class ExclusionMatcher {
  private readonly exactPrefixes = new Set<string>();
  private readonly prefixSlashes: string[] = [];
  private readonly segments = new Set<string>();
  private readonly subpaths: string[] = [];
  private readonly absGlobs: RegExp[] = [];
  private readonly pathGlobs: RegExp[] = [];
  private readonly segmentGlobs: RegExp[] = [];

  constructor(patterns: readonly string[], dataDirs: readonly string[] = [], homedir = '') {
    const home = normalizeHome(homedir);
    const addPrefix = (abs: string) => {
      const clean = normalizeAbsPrefix(abs);
      if (!clean || this.exactPrefixes.has(clean)) return;
      this.exactPrefixes.add(clean);
      this.prefixSlashes.push(`${clean}/`);
    };

    for (const dir of dataDirs) addPrefix(dir);

    for (const raw of patterns) {
      let pattern: string;
      try {
        pattern = normalizeFileExclusion(raw);
      } catch {
        continue;
      }
      const hasGlob = /[*?]/.test(pattern);
      if (pattern.startsWith('~/')) {
        if (!home) continue;
        const expanded = `${home}/${pattern.slice(2)}`;
        if (hasGlob) this.absGlobs.push(globToRegExp(expanded));
        else addPrefix(expanded);
        continue;
      }
      if (pattern.startsWith('/')) {
        if (hasGlob) this.absGlobs.push(globToRegExp(pattern));
        else addPrefix(pattern);
        continue;
      }
      if (hasGlob) {
        if (pattern.includes('/')) this.pathGlobs.push(globToRegExp(`**/${pattern}`));
        else this.segmentGlobs.push(globToRegExp(pattern));
        continue;
      }
      if (pattern.includes('/')) this.subpaths.push(pattern);
      else this.segments.add(pattern);
    }
  }

  isExcluded(absPath: string): boolean {
    if (this.exactPrefixes.has(absPath)) return true;
    for (let i = 0; i < this.prefixSlashes.length; i++) {
      if (absPath.startsWith(this.prefixSlashes[i] as string)) return true;
    }
    if (this.segments.size > 0 || this.segmentGlobs.length > 0) {
      let start = 1;
      while (start <= absPath.length) {
        const end = absPath.indexOf('/', start);
        const seg = end < 0 ? absPath.slice(start) : absPath.slice(start, end);
        if (seg.length > 0) {
          if (this.segments.has(seg)) return true;
          for (let i = 0; i < this.segmentGlobs.length; i++) {
            if ((this.segmentGlobs[i] as RegExp).test(seg)) return true;
          }
        }
        if (end < 0) break;
        start = end + 1;
      }
    }
    for (let i = 0; i < this.subpaths.length; i++) {
      const sub = this.subpaths[i] as string;
      if (absPath.endsWith(`/${sub}`) || absPath.includes(`/${sub}/`)) return true;
    }
    for (let i = 0; i < this.absGlobs.length; i++) {
      if ((this.absGlobs[i] as RegExp).test(absPath)) return true;
    }
    for (let i = 0; i < this.pathGlobs.length; i++) {
      if ((this.pathGlobs[i] as RegExp).test(absPath)) return true;
    }
    return false;
  }
}
