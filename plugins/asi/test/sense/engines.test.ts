import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const NODE_PACKAGES = [
  ROOT,
  join(ROOT, 'packages/body-probe'),
  join(ROOT, 'packages/sense-types'),
  join(ROOT, 'packages/sense-ui'),
  join(ROOT, 'plugins/asi'),
];
const DSH_PACKAGES = [
  join(ROOT, 'packages/body-probe'),
  join(ROOT, 'packages/sense-types'),
  join(ROOT, 'packages/sense-ui'),
  join(ROOT, 'plugins/asi'),
];
const REQUIRED_NODE = '^22.12.0 || ^24.0.0 || >=26.0.0';
const REQUIRED_DSH = '0.2.2-rc.3 || 0.2.2-rc.5';

describe('package engines', () => {
  it('declares supported Node engines in every package', () => {
    for (const dir of NODE_PACKAGES) {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        engines?: { node?: string };
      };
      expect(pkg.engines?.node, `${dir}/package.json`).toBe(REQUIRED_NODE);
    }
  });

  it('declares DSH 0.2.2-rc.3 || 0.2.2-rc.5 compatibility across packages and plugins', () => {
    for (const dir of DSH_PACKAGES) {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        engines?: { dsh?: string };
      };
      expect(pkg.engines?.dsh, `${dir}/package.json`).toBe(REQUIRED_DSH);
    }
  });
});
