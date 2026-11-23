import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { auditFiles, registryUrl, registryVersionAvailable } from '../scripts/release-audit.mjs';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('asi-care 发布包卫生审计', () => {
  it('package.json 保持 private=true、零第三方运行时依赖且声明兼容 Node 与 DSH 0.2.2-rc.3 || 0.2.2-rc.5', async () => {
    const manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
    expect(manifest.version).toBe('0.4.0');
    expect(manifest.private).toBe(true);
    expect(manifest.engines.node).toBe('^22.12.0 || ^24.0.0 || >=26.0.0');
    expect(manifest.engines.dsh).toBe('0.2.2-rc.3 || 0.2.2-rc.5');
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@asi/sense-types']);
    expect(manifest.peerDependencies).toEqual({
      '@deepseek-ai/cordis': '4.1.0',
      '@deepseek-ai/dsh-jobs': '0.2.2-rc.3 || 0.2.2-rc.5',
      '@deepseek-ai/dsh-llm': '0.2.2-rc.3 || 0.2.2-rc.5',
      '@deepseek-ai/dsh-session': '0.2.2-rc.3 || 0.2.2-rc.5',
      '@deepseek-ai/dsh-tools': '0.2.2-rc.3 || 0.2.2-rc.5',
      '@deepseek-ai/schemastery': '3.19.0',
    });
  });

  it('构建产物通过敏感路径、凭据、邮箱、本机用户名与 sourcemap 扫描', { timeout: 30_000 }, async () => {
    const files = ['package.json', 'cordis.patch.yml', 'scripts/dsh.sh', 'lib/index.js'];
    if (!existsSync(join(pkgDir, 'lib/index.js'))) {
      const built = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: pkgDir, encoding: 'utf8' });
      expect(built.status, built.stderr || built.stdout).toBe(0);
    }
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

  it('拒绝意外文件、合成凭据、邮箱、绝对路径、本机用户名与 sourcemap', () => {
    expect(() => auditFiles([{ path: 'lib/extra.js' }], () => Buffer.from('safe'), 'u')).toThrow();
    expect(() => auditFiles([{ path: 'lib/index.js' }], () => Buffer.from('localuser'), 'localuser')).toThrow();

    for (const bad of [
      `ghp_${'b'.repeat(36)}`,
      `sk-${'d'.repeat(32)}`,
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'someone@example.invalid',
      '/Users/someone/secret',
      '//# sourceMappingURL=index.js.map',
    ]) {
      expect(() => auditFiles([{ path: 'lib/index.js' }], () => Buffer.from(bad), '')).toThrow();
    }

    expect(registryVersionAvailable(1, '{"error":{"code":"E404"}}')).toBe(true);
    expect(registryVersionAvailable(0, '"0.4.0"')).toBe(false);
    expect(registryUrl()).toBe('https://registry.npmjs.org/');
  });
});
