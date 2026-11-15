import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const PACKAGES = [ROOT, join(ROOT, 'packages/sense-types'), join(ROOT, 'plugins/asi-sense')];
const REQUIRED = '^22.12.0 || ^24.0.0 || >=26.0.0';

describe('package engines', () => {
  it('declares supported Node engines in every package', () => {
    for (const dir of PACKAGES) {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        engines?: { node?: string };
      };
      expect(pkg.engines?.node, `${dir}/package.json`).toBe(REQUIRED);
    }
  });
});
