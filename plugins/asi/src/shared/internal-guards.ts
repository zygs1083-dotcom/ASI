/**
 * Centralized 8-module ASI internal session & storage directory guards.
 *
 * Shared across `sense`, `needs`, `sleep`, `care`, `growth`, `intuition`, `tom`, and `dream`
 * so internal daemons, maintenance sandboxes, vaults, and subagents never pollute user
 * telemetry, memory consolidation, skill synthesis, or cross-repo DMN dreaming.
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

export const ASI_MODULE_NAMES = ['sense', 'needs', 'sleep', 'care', 'growth', 'intuition', 'tom', 'dream'] as const;

export type AsiModuleName = (typeof ASI_MODULE_NAMES)[number];

const ASI_MODULE_SET: ReadonlySet<string> = new Set<string>(ASI_MODULE_NAMES);

export const ASI_INTERNAL_SESSION_ID_RE =
  /^asi-(?:maint|sleep|care|sense|growth|intuition|tom|dream|internal)(?:[-_:]|$)/i;

export const ASI_INTERNAL_CWD_RE =
  /(?:^|[\\/])(?:(?:asi[-_])?(?:sense|needs|sleep|care|growth|intuition|tom|dream)[\\/](?:sandbox|vault|skills)|data[\\/]asi(?:-(?:sense|needs|sleep|care|growth|intuition|tom|dream))?|\.dsh[\\/]data[\\/]asi)(?:[\\/]|$)/i;

export function fastSafeRealpath(p: string): string {
  const norm = resolve(p);
  if (existsSync(norm)) {
    try {
      return realpathSync.native(norm);
    } catch {
      return norm;
    }
  }
  let cur = dirname(norm);
  for (let i = 0; i < 32 && cur; i += 1) {
    if (existsSync(cur)) {
      try {
        const realBase = realpathSync.native(cur);
        return realBase === cur ? norm : resolve(realBase, relative(cur, norm));
      } catch {
        return norm;
      }
    }
    const next = dirname(cur);
    if (next === cur) break;
    cur = next;
  }
  return norm;
}

function isSameOrInsidePath(candidate: string, parent: string): boolean {
  if (candidate === parent) return true;
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return candidate.startsWith(prefix);
}

export function isInsideExcludedRoots(
  candidate: string | undefined,
  excludedRoots: readonly (string | undefined)[],
): boolean {
  if (!candidate || !candidate.trim() || excludedRoots.length === 0) return false;
  const normCand = resolve(candidate);
  for (const root of excludedRoots) {
    if (!root || !root.trim()) continue;
    if (isSameOrInsidePath(normCand, resolve(root))) return true;
  }
  const realCand = fastSafeRealpath(normCand);
  for (const root of excludedRoots) {
    if (!root || !root.trim()) continue;
    if (isSameOrInsidePath(realCand, fastSafeRealpath(root))) return true;
  }
  return false;
}

const safeRealpath = fastSafeRealpath;

export function buildUnifiedExcludedInternalRoots(...anchors: readonly (string | undefined)[]): string[] {
  const roots = new Set<string>();
  for (const rawAnchor of anchors) {
    if (!rawAnchor || !rawAnchor.trim()) continue;
    const resolved = resolve(rawAnchor);
    const real = safeRealpath(resolved);
    roots.add(resolved);
    roots.add(real);

    for (const anchor of resolved === real ? [resolved] : [resolved, real]) {
      const parent = dirname(anchor);
      const anchorBase = basename(anchor).toLowerCase();
      if (!parent || parent === '/' || parent === '.') continue;

      for (const mod of ASI_MODULE_NAMES) {
        roots.add(join(parent, `asi-${mod}`));
      }
      roots.add(join(parent, 'needs', 'sandbox'));
      roots.add(join(parent, 'sleep', 'vault'));
      roots.add(join(parent, 'sleep', 'memories'));
      roots.add(join(parent, 'care', 'sandbox'));
      roots.add(join(parent, 'growth', 'skills'));
      roots.add(join(parent, 'growth', 'sandbox'));
      roots.add(join(parent, 'dream', 'vault'));

      if (ASI_MODULE_SET.has(anchorBase)) {
        for (const sib of ASI_MODULE_NAMES) {
          roots.add(join(parent, sib));
        }
        if (basename(parent).toLowerCase() === 'asi') {
          roots.add(parent);
          const grandParent = dirname(parent);
          if (grandParent && grandParent !== '/' && grandParent !== '.' && grandParent !== parent) {
            for (const mod of ASI_MODULE_NAMES) {
              roots.add(join(grandParent, `asi-${mod}`));
            }
          }
        }
      }
    }
  }
  return [...roots];
}
