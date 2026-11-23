import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PKG_DIR = resolve(import.meta.dirname, '..');
const REQUIRED_NODE = '^22.12.0 || ^24.0.0 || >=26.0.0';
const REQUIRED_DSH = '0.2.2-rc.3 || 0.2.2-rc.5';

describe('asi-care package version contracts', () => {
  it('declares supported Node, DSH, and peerDependencies version constraints covering all bundled @deepseek-ai/* imports', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
      engines?: { node?: string; dsh?: string };
      peerDependencies?: Record<string, string>;
    };

    expect(pkg.engines?.node).toBe(REQUIRED_NODE);
    expect(pkg.engines?.dsh).toBe(REQUIRED_DSH);
    expect(pkg.peerDependencies).toEqual({
      '@deepseek-ai/cordis': '4.1.0',
      '@deepseek-ai/dsh-jobs': REQUIRED_DSH,
      '@deepseek-ai/dsh-llm': REQUIRED_DSH,
      '@deepseek-ai/dsh-session': REQUIRED_DSH,
      '@deepseek-ai/dsh-tools': REQUIRED_DSH,
      '@deepseek-ai/schemastery': '3.19.0',
    });

    const bundlePath = join(PKG_DIR, 'lib/index.js');
    if (!existsSync(bundlePath)) {
      const built = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: PKG_DIR, encoding: 'utf8' });
      expect(built.status, built.stderr || built.stdout).toBe(0);
    }
    const bundleCode = readFileSync(bundlePath, 'utf8');
    const importedPeers = new Set<string>();
    for (const match of bundleCode.matchAll(/from\s+["'](@deepseek-ai\/[^/"']+)/g)) {
      if (match[1]) importedPeers.add(match[1]);
    }
    expect(importedPeers.size).toBeGreaterThan(0);
    for (const spec of importedPeers) {
      expect(pkg.peerDependencies?.[spec], `missing peerDependency for runtime import ${spec}`).toBeDefined();
      if (spec.startsWith('@deepseek-ai/dsh-')) {
        expect(pkg.peerDependencies?.[spec]).toBe(REQUIRED_DSH);
      }
    }
  });
});
