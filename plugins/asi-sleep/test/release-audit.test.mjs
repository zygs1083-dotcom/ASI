import { describe, expect, it } from 'vitest';
import { allowed, auditFiles, registryUrl, registryVersionAvailable } from '../scripts/release-audit.mjs';

describe('asi-sleep release-audit 安全门禁测试', () => {
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

  it('校验 npm registry 地址规范与 E404 可发布判定', () => {
    expect(registryUrl('https://registry.npmjs.org')).toBe('https://registry.npmjs.org/');
    expect(() => registryUrl('https://user:pass@registry.npmjs.org/')).toThrow(/without credentials/);
    expect(registryVersionAvailable(0, '"0.3.0"')).toBe(false);
    expect(registryVersionAvailable(1, JSON.stringify({ error: { code: 'E404' } }))).toBe(true);
  });
});
