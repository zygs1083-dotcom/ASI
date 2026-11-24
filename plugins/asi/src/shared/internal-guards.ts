/**
 * Centralized 8-module ASI internal session & storage directory guards.
 *
 * Shared across `sense`, `needs`, `sleep`, `care`, `growth`, `intuition`, `tom`, and `dream`
 * so internal daemons, maintenance sandboxes, vaults, and subagents never pollute user
 * telemetry, memory consolidation, skill synthesis, or cross-repo DMN dreaming.
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const ASI_MODULE_NAMES = ['sense', 'needs', 'sleep', 'care', 'growth', 'intuition', 'tom', 'dream'] as const;

export type AsiModuleName = (typeof ASI_MODULE_NAMES)[number];

const ASI_MODULE_SET: ReadonlySet<string> = new Set<string>(ASI_MODULE_NAMES);

export const ASI_INTERNAL_SESSION_ID_RE =
  /^asi-(?:maint|sleep|care|sense|growth|intuition|tom|dream|internal)(?:[-_:]|$)/i;

export const ASI_INTERNAL_CWD_RE =
  /(?:^|[\\/])(?:asi-(?:sense|needs|sleep|care|growth|intuition|tom|dream)|(?:sense|needs|sleep|care|growth|intuition|tom|dream)[\\/](?:sandbox|vault|skills)|data[\\/]asi(?:-(?:sense|needs|sleep|care|growth|intuition|tom|dream))?|\.dsh[\\/]data[\\/]asi)(?:[\\/]|$)/i;

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

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
