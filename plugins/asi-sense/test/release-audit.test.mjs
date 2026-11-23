import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { auditFiles, registryUrl, registryVersionAvailable } from '../scripts/release-audit.mjs';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('release audit', () => {
  it('keeps every source workspace private and aligned at 0.4.0', () => {
    for (const path of [
      '../../../package.json',
      '../../../packages/body-probe/package.json',
      '../../../packages/sense-types/package.json',
      '../../../packages/sense-ui/package.json',
      '../../asi-needs/package.json',
      '../../asi-sleep/package.json',
      '../../asi-care/package.json',
      '../package.json',
    ]) {
      const manifest = JSON.parse(readFileSync(new URL(path, import.meta.url)));
      expect(manifest.private).toBe(true);
      if (path !== '../../../package.json') {
        expect(manifest.version).toBe('0.4.0');
      }
    }
  });

  it('builds clean-checkout artifacts and passes release-audit on real bundle files', { timeout: 30_000 }, () => {
    const built = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: pkgDir, encoding: 'utf8' });
    expect(built.status, built.stderr || built.stdout).toBe(0);

    const files = ['package.json', 'cordis.patch.yml', 'scripts/dsh.sh', 'lib/index.js'];
    if (existsSync(join(pkgDir, 'lib/asi-sense-helper'))) {
      files.push('lib/asi-sense-helper');
    }
    const buffers = new Map(files.map((f) => [f, readFileSync(join(pkgDir, f))]));
    buffers.set('LICENSE', readFileSync(join(pkgDir, '../../LICENSE')));

    expect(() =>
      auditFiles(
        [...buffers.keys()].map((path) => ({ path })),
        (path) => buffers.get(path),
        userInfo().username,
      ),
    ).not.toThrow();
  });

  it('accepts only the intended files without local paths or usernames', () => {
    expect(() => auditFiles([{ path: 'lib/index.js' }], () => Buffer.from('safe'), 'exampleuser')).not.toThrow();
    for (const path of ['.env', 'lib/secrets.env', 'lib/index.test.js', 'docs/reviews/result.md']) {
      expect(() => auditFiles([{ path }], () => Buffer.from('safe'), 'exampleuser')).toThrow();
    }
    for (const text of ['/Users/example/file', '/home/example/file', 'exampleuser']) {
      expect(() => auditFiles([{ path: 'lib/index.js' }], () => Buffer.from(text), 'exampleuser')).toThrow();
    }
  });

  it('rejects synthetic credentials, email addresses and absolute paths in text and binaries', () => {
    const samples = [
      `npm_${'a'.repeat(24)}`,
      `ghp_${'b'.repeat(36)}`,
      `github_pat_${'e'.repeat(22)}_${'f'.repeat(59)}`,
      `glpat-${'g'.repeat(20)}`,
      `xoxa-${'1'.repeat(10)}-${'h'.repeat(32)}`,
      `xoxb-${'2'.repeat(10)}-${'i'.repeat(32)}`,
      `xoxp-${'3'.repeat(10)}-${'j'.repeat(32)}`,
      `xoxr-${'4'.repeat(10)}-${'k'.repeat(32)}`,
      `xoxs-${'5'.repeat(10)}-${'l'.repeat(32)}`,
      `AIza${'m'.repeat(35)}`,
      `sk-${'c'.repeat(32)}`,
      `AKIA${'D'.repeat(16)}`,
      '-----BEGIN PRIVATE KEY-----',
      'invented.person@example.invalid',
      '/UsErS/other/build/file',
      '/Users/',
      '/HOME/other/file',
      '/OPT/build/file',
      '/PRIVATE/VAR/build/file',
      '/arbitrary/build/file',
      'C:\\build\\file',
      String.raw`C:\\Users\\other\\file`,
      String.raw`\/Users\/other\/file`,
      'file:///opt/build/file',
    ];
    for (const sample of samples) {
      const le = Buffer.from(sample, 'utf16le');
      const be = Buffer.from(le).swap16();
      for (const bytes of [Buffer.from(sample), le, be]) {
        for (const path of ['lib/index.js', 'lib/asi-sense-helper']) {
          expect(() => auditFiles([{ path }], () => Buffer.concat([Buffer.from([0xff]), bytes]), '')).toThrow();
        }
      }
    }
  });

  it('rejects embedded and external source maps instead of trusting encoded contents', () => {
    const map = Buffer.from(JSON.stringify({ sources: ['/opt/build/file'], sourcesContent: ['private'] })).toString(
      'base64',
    );
    for (const text of [
      `//# sourceMappingURL=data:application/json;base64,${map}`,
      '//# sourceMappingURL=index.js.map',
    ]) {
      const le = Buffer.from(text, 'utf16le');
      for (const bytes of [Buffer.from(text), le, Buffer.from(le).swap16()]) {
        for (const path of ['lib/index.js', 'lib/asi-sense-helper']) {
          expect(() => auditFiles([{ path }], () => bytes, '')).toThrow();
        }
      }
    }
  });

  it('allows only explicitly listed benign paths in their intended files', () => {
    expect(() => auditFiles([{ path: 'scripts/dsh.sh' }], () => Buffer.from('/dev/null'), '')).not.toThrow();
    expect(() => auditFiles([{ path: 'lib/index.js' }], () => Buffer.from('/dev/null'), '')).toThrow();
    expect(() => auditFiles([{ path: 'scripts/dsh.sh' }], () => Buffer.from('/dev/null/secret'), '')).toThrow();
  });

  it('accepts a registry 404 but fails closed on existing versions and other errors', () => {
    expect(registryVersionAvailable(1, '{"error":{"code":"E404"}}')).toBe(true);
    expect(registryVersionAvailable(0, '"0.1.2"')).toBe(false);
    expect(() => registryVersionAvailable(1, '{"error":{"code":"E403"}}')).toThrow();
    expect(() => registryVersionAvailable(1, '')).toThrow();
  });

  it('accepts an explicit registry without embedded credentials', () => {
    expect(registryUrl()).toBe('https://registry.npmjs.org/');
    expect(registryUrl('http://127.0.0.1:4873/')).toBe('http://127.0.0.1:4873/');
    for (const value of [
      'file:///tmp/registry',
      'https://user:secret@example.com/',
      'https://example.com/?token=secret',
    ]) {
      expect(() => registryUrl(value)).toThrow();
    }
  });
});
