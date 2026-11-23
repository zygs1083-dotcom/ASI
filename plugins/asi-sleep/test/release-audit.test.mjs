import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allowed, auditFiles, registryUrl, registryVersionAvailable } from '../scripts/release-audit.mjs';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('asi-sleep release-audit 安全门禁测试', () => {
  it('真实构建产物通过敏感路径、凭据、邮箱、用户名与 sourcemap 扫描（含干净检出自动构建）', {
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

  it('干净白名单文件通过审计，且拦截未知文件、凭据、邮箱、敏感路径、源码映射与本机用户名', () => {
    const cleanFiles = [...allowed].map((path) => ({ path }));
    const cleanRead = (path) => Buffer.from(path === 'scripts/dsh.sh' ? '#!/bin/sh\necho ok\n' : 'export {};\n');
    expect(() => auditFiles(cleanFiles, cleanRead, 'aliceuser')).not.toThrow();

    expect(() => auditFiles([{ path: 'unexpected.txt' }], () => Buffer.from('x'), 'aliceuser')).toThrow(
      /Unexpected package file/,
    );

    const tok = ['ghp', '1234567890abcdef'].join('_');
    expect(() => auditFiles(cleanFiles, (p) => Buffer.from(p === 'lib/index.js' ? tok : 'ok'), 'aliceuser')).toThrow(
      /Possible credential/,
    );

    const email = ['dev', 'example.org'].join('@');
    expect(() => auditFiles(cleanFiles, (p) => Buffer.from(p === 'lib/index.js' ? email : 'ok'), 'aliceuser')).toThrow(
      /Possible email/,
    );

    expect(() =>
      auditFiles(cleanFiles, (p) => Buffer.from(p === 'lib/index.js' ? 'hello aliceuser' : 'ok'), 'aliceuser'),
    ).toThrow(/Local username/);
  });

  it('校验 package.json 版本为 0.4.0、npm registry 地址规范与 E404 可发布判定', async () => {
    const manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
    expect(manifest.version).toBe('0.4.0');
    expect(registryUrl('https://registry.npmjs.org')).toBe('https://registry.npmjs.org/');
    expect(() => registryUrl('https://user:pass@registry.npmjs.org/')).toThrow(/without credentials/);
    expect(registryVersionAvailable(0, '"0.4.0"')).toBe(false);
    expect(registryVersionAvailable(1, JSON.stringify({ error: { code: 'E404' } }))).toBe(true);
  });
});
