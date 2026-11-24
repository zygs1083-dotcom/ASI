/**
 * Path containment, sensitive directory exclusion, and controlled target token
 * helpers for `asi-care`.
 *
 * Open-Source MIT Adaptation:
 * - Protected root validation adapted from `tw93/Mole` (MIT License, Copyright (c) Tw93).
 * - Never touches or reads `~/.secrets`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.Trash`,
 *   or bare OS/home roots.
 */

import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { sanitizeForModel } from '@asi/sense-types';

const BARE_SYSTEM_SEGMENTS: readonly (readonly string[])[] = [
  [],
  ['System'],
  ['Library'],
  ['Library', 'Application Support'],
  ['Library', 'Extensions'],
  ['Applications'],
  ['Volumes'],
  ['bin'],
  ['sbin'],
  ['usr'],
  ['etc'],
  ['var'],
  ['var', 'root'],
  ['private'],
  ['private', 'var'],
  ['private', 'tmp'],
  ['private', 'etc'],
  ['tmp'],
  ['opt'],
  ['Users'],
  ['home'],
];

const SENSITIVE_HOME_SUBDIRS: readonly (readonly string[])[] = [
  ['.secrets'],
  ['.ssh'],
  ['.gnupg'],
  ['.aws'],
  ['.kube'],
  ['.Trash'],
  ['.local', 'share', 'Trash'],
];

const SYSTEM_PREFIX_SEGMENTS: readonly (readonly string[])[] = [
  ['System'],
  ['Library', 'Extensions'],
  ['bin'],
  ['sbin'],
  ['etc'],
  ['private', 'etc'],
  ['var', 'db'],
];

export function isStrictlyInside(parentReal: string, candidateReal: string): boolean {
  const prefix = parentReal.endsWith(sep) ? parentReal : `${parentReal}${sep}`;
  return candidateReal.startsWith(prefix) && candidateReal.length > prefix.length;
}

export function isSameOrInside(parentReal: string, candidateReal: string): boolean {
  return candidateReal === parentReal || isStrictlyInside(parentReal, candidateReal);
}

export async function tryRealpath(targetPath: string): Promise<string | undefined> {
  if (!targetPath?.trim()) return undefined;
  try {
    return await realpath(targetPath);
  } catch {
    return undefined;
  }
}

export function isBareForbiddenRoot(candidateReal: string, homeReal: string): boolean {
  const norm = resolve(candidateReal);
  const normHome = homeReal ? resolve(homeReal) : '';
  if (normHome && norm === normHome) return true;
  for (const segs of BARE_SYSTEM_SEGMENTS) {
    const bare = segs.length === 0 ? sep : join(sep, ...segs);
    if (norm === bare) return true;
  }
  return false;
}

export function isForbiddenCarePath(
  candidateReal: string,
  homeReal: string,
  excludedReals: readonly string[] = [],
): boolean {
  if (!candidateReal) return true;
  const norm = resolve(candidateReal);
  const normHome = homeReal ? resolve(homeReal) : '';

  if (isBareForbiddenRoot(norm, normHome)) return true;

  for (const segs of SYSTEM_PREFIX_SEGMENTS) {
    const sysPrefix = join(sep, ...segs);
    if (isSameOrInside(sysPrefix, norm)) return true;
  }

  // Reject any `.secrets` or `.Trash` segment anywhere in the path
  const parts = norm.split(sep);
  if (parts.includes('.secrets') || parts.includes('.Trash')) {
    return true;
  }

  if (normHome) {
    for (const sub of SENSITIVE_HOME_SUBDIRS) {
      const sensitiveRoot = join(normHome, ...sub);
      if (isSameOrInside(sensitiveRoot, norm)) return true;
    }
  }

  for (const ex of excludedReals) {
    if (!ex) continue;
    if (isSameOrInside(resolve(ex), norm)) return true;
  }

  return false;
}

export function validateArtifactDeletionTarget(options: {
  artifactReal: string;
  worktreeReal: string;
  homeReal: string;
  excludedReals?: readonly string[];
}): boolean {
  const { artifactReal, worktreeReal, homeReal, excludedReals } = options;
  if (!artifactReal || !worktreeReal) return false;
  const normArtifact = resolve(artifactReal);
  const normWorktree = resolve(worktreeReal);

  if (isForbiddenCarePath(normWorktree, homeReal, excludedReals)) return false;
  if (isForbiddenCarePath(normArtifact, homeReal, excludedReals)) return false;
  if (!isStrictlyInside(normWorktree, normArtifact)) return false;
  return true;
}

export function formatHomePath(rawPath: string, homeDir: string, homeReal?: string): string {
  let formatted = rawPath;
  for (const h of [homeReal, homeDir]) {
    if (!h) continue;
    const cleanHome = h.endsWith(sep) && h.length > 1 ? h.slice(0, -1) : h;
    if (formatted === cleanHome) {
      formatted = '~';
      break;
    }
    if (formatted.startsWith(`${cleanHome}${sep}`)) {
      formatted = `~${formatted.slice(cleanHome.length).split(sep).join('/')}`;
      break;
    }
  }
  return String(sanitizeForModel(formatted));
}

export function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${Math.round(bytes)} B`;
}

export function formatDurationCompact(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${Math.max(1, totalMinutes)}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 48) return `${totalHours}h`;
  const days = Math.floor(totalHours / 24);
  return `${days}d`;
}

export function makeTargetToken(prefix: 'art' | 'wt' | 'port' | 'conflict' | 'dirty', stableIdentity: string): string {
  const digest = createHash('sha256').update(stableIdentity).digest('hex').slice(0, 12);
  return `${prefix}_${digest}`;
}

/**
 * Decode Git C-quoted path strings (e.g. `"src/\\347\\273\\204\\344\\273\\266 a.tsx"` -> `"src/组件 a.tsx"`).
 */
export function unquoteGitCPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return trimmed;
  }
  const inner = trimmed.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch !== '\\') {
      for (const b of Buffer.from(ch ?? '', 'utf8')) bytes.push(b);
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) {
      bytes.push(0x5c);
      break;
    }
    if (next >= '0' && next <= '7') {
      let oct = next;
      let consumed = 1;
      while (consumed < 3) {
        const c = inner[i + 1 + consumed];
        if (c !== undefined && c >= '0' && c <= '7') {
          oct += c;
          consumed += 1;
        } else {
          break;
        }
      }
      bytes.push(Number.parseInt(oct, 8) & 0xff);
      i += consumed;
      continue;
    }
    i += 1;
    switch (next) {
      case '\\':
        bytes.push(0x5c);
        break;
      case '"':
        bytes.push(0x22);
        break;
      case 'a':
        bytes.push(0x07);
        break;
      case 'b':
        bytes.push(0x08);
        break;
      case 'f':
        bytes.push(0x0c);
        break;
      case 'n':
        bytes.push(0x0a);
        break;
      case 'r':
        bytes.push(0x0d);
        break;
      case 't':
        bytes.push(0x09);
        break;
      case 'v':
        bytes.push(0x0b);
        break;
      default:
        for (const b of Buffer.from(next, 'utf8')) bytes.push(b);
        break;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
