import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allowed, auditFiles, registryUrl, registryVersionAvailable } from '../scripts/release-audit.mjs';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('asi-growth release-audit 安全门禁测试', () => {
  it('真实构建产物通过敏感路径、凭据、邮箱、本机用户名与 sourcemap 扫描（含干净检出自动构建）', {
    timeout: 30_000,
  }, async () => {
    const files = [
      'package.json',
      'cordis.patch.yml',
      'scripts/dsh.sh',
      'lib/index.js',
      'lib/client.js',
      'lib/typert.host.js',
    ];
    const built = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: pkgDir, encoding: 'utf8' });
    expect(built.status, built.stderr || built.stdout).toBe(0);
    const buffers = new Map();
    for (const f of files) {
      buffers.set(f, await readFile(join(pkgDir, f)));
    }
    buffers.set('LICENSE', await readFile(join(pkgDir, '../../LICENSE')));

    expect(() =>
      auditFiles(
        [...buffers.keys()].map((path) => ({ path })),
        (path) => buffers.get(path),
        userInfo().username,
      ),
    ).not.toThrow();
  });

  it('校验 package.json 版本为 0.5.0、零第三方运行时依赖、兼容 DSH 0.2.2-rc.3 || 0.2.2-rc.5 并拦截敏感样本', async () => {
    const manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
    expect(manifest.version).toBe('0.5.0');
    expect(manifest.private).toBe(true);
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@asi/sense-types']);
    expect(manifest.peerDependencies['@deepseek-ai/dsh-skill']).toBe('0.2.2-rc.3 || 0.2.2-rc.5');

    const cleanFiles = [...allowed].map((path) => ({ path }));
    const tok = ['ghp', '1234567890abcdef'].join('_');
    expect(() => auditFiles(cleanFiles, (p) => Buffer.from(p === 'lib/index.js' ? tok : 'ok'), 'aliceuser')).toThrow(
      /Possible credential/,
    );
    expect(() =>
      auditFiles(cleanFiles, (p) => Buffer.from(p === 'lib/client.js' ? 'hello aliceuser' : 'ok'), 'aliceuser'),
    ).toThrow(/Local username/);

    expect(registryUrl('https://registry.npmjs.org')).toBe('https://registry.npmjs.org/');
    expect(registryVersionAvailable(0, '"0.5.0"')).toBe(false);
    expect(registryVersionAvailable(1, JSON.stringify({ error: { code: 'E404' } }))).toBe(true);
  });
});
