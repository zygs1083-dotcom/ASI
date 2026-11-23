import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { auditFiles, registryUrl, registryVersionAvailable } from '../scripts/release-audit.mjs';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('asi-needs 发布包卫生审计', () => {
  it('package.json 保持 private=true 且声明兼容 0.2.2-rc.3 || 0.2.2-rc.5', async () => {
    const manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
    expect(manifest.private).toBe(true);
    expect(manifest.engines.dsh).toBe('0.2.2-rc.3 || 0.2.2-rc.5');
    for (const dep of [
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-typert-protocol',
    ]) {
      expect(manifest.peerDependencies[dep]).toBe('0.2.2-rc.3 || 0.2.2-rc.5');
    }
  });

  it('构建产物通过敏感路径、凭据、邮箱、用户名与 sourcemap 扫描', async () => {
    const files = [
      'package.json',
      'cordis.patch.yml',
      'scripts/dsh.sh',
      'lib/index.js',
      'lib/client.js',
      'lib/typert.host.js',
    ];
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

  it('拒绝意外文件、合成凭据、邮箱、绝对路径、本机用户名与 sourcemap，并严格校验 registry E404', () => {
    expect(() => auditFiles([{ path: 'lib/extra.js' }], () => Buffer.from('safe'), 'u')).toThrow();
    expect(() => auditFiles([{ path: 'lib/index.js' }], () => Buffer.from('localuser'), 'localuser')).toThrow();

    for (const bad of [
      `npm_${'a'.repeat(24)}`,
      `sk-${'c'.repeat(32)}`,
      '-----BEGIN PRIVATE KEY-----',
      'person@example.invalid',
      '/Users/someone/secret',
      '//# sourceMappingURL=client.js.map',
    ]) {
      const le = Buffer.from(bad, 'utf16le');
      for (const bytes of [Buffer.from(bad), le, Buffer.from(le).swap16()]) {
        expect(() => auditFiles([{ path: 'lib/client.js' }], () => bytes, '')).toThrow();
      }
    }

    expect(registryVersionAvailable(1, '{"error":{"code":"E404"}}')).toBe(true);
    expect(registryVersionAvailable(0, '"0.2.0"')).toBe(false);
    expect(() => registryVersionAvailable(1, '{"error":{"code":"E403"}}')).toThrow();
    expect(() => registryVersionAvailable(1, 'not-json')).toThrow();

    expect(registryUrl()).toBe('https://registry.npmjs.org/');
    expect(registryUrl('http://100.108.45.41:4873/')).toBe('http://100.108.45.41:4873/');
    expect(() => registryUrl('https://user:pw@example.com/')).toThrow();
  });

  it('docs/release.md 内嵌的 Desktop profile 双插件迁移与回退核对脚本真实可执行且拦截漏启用缺陷', async () => {
    const releaseDoc = await readFile(join(pkgDir, '../../docs/release.md'), 'utf8');
    const snippets = [...releaseDoc.matchAll(/node - ([^\n]+) <<'NODE'\n([\s\S]*?)\nNODE/g)].map((m) => m[2]);
    expect(snippets).toHaveLength(2);
    const [verifyUpgradeScript, verifyRollbackScript] = snippets;

    const dir = await mkdtemp(join(tmpdir(), 'asi-release-doc-test-'));
    try {
      const profileDir = join(dir, 'profile');
      const backupPath = join(dir, 'backup-package.json');
      await mkdir(join(profileDir, 'node_modules/asi-sense'), { recursive: true });
      await mkdir(join(profileDir, 'node_modules/asi-needs'), { recursive: true });
      await writeFile(join(profileDir, 'node_modules/asi-sense/package.json'), '{"version":"0.2.0"}');
      await writeFile(join(profileDir, 'node_modules/asi-needs/package.json'), '{"version":"0.2.0"}');

      const runUpgradeCheck = () =>
        spawnSync(process.execPath, ['-', profileDir, backupPath, '0.2.0', '0.2.0'], {
          input: verifyUpgradeScript,
          encoding: 'utf8',
        });
      const runRollbackCheck = () =>
        spawnSync(process.execPath, ['-', join(profileDir, 'package.json'), backupPath], {
          input: verifyRollbackScript,
          encoding: 'utf8',
        });

      // 1. 从 0.1.x 单插件升级到 0.2.0 双插件：若 asi-needs 漏进 bundles 必须报错失败（修复假阳性漏洞）
      await writeFile(
        backupPath,
        JSON.stringify({
          dependencies: { 'asi-sense': 'file:/old/asi-sense-0.1.5.tgz' },
          dsh: { profile: { bundles: ['other-a', 'asi-sense', 'other-b'] } },
        }),
      );
      await writeFile(
        join(profileDir, 'package.json'),
        JSON.stringify({
          dependencies: { 'asi-sense': '^0.2.0', 'asi-needs': '^0.2.0' },
          dsh: { profile: { bundles: ['other-a', 'asi-sense', 'other-b'] } },
        }),
      );
      expect(runUpgradeCheck().status).not.toBe(0);

      // 正确将 asi-needs 追加至末尾且保留 asi-sense 原顺序时通过
      await writeFile(
        join(profileDir, 'package.json'),
        JSON.stringify({
          dependencies: { 'asi-sense': '^0.2.0', 'asi-needs': '^0.2.0' },
          dsh: { profile: { bundles: ['other-a', 'asi-sense', 'other-b', 'asi-needs'] } },
        }),
      );
      expect(runUpgradeCheck().status).toBe(0);

      // 0.1.x 单插件回退：移除 asi-needs 并恢复 asi-sense file: 源
      await writeFile(
        join(profileDir, 'package.json'),
        JSON.stringify({
          dependencies: { 'asi-sense': 'file:/old/asi-sense-0.1.5.tgz' },
          dsh: { profile: { bundles: ['other-a', 'asi-sense', 'other-b'] } },
        }),
      );
      expect(runRollbackCheck().status).toBe(0);

      // 2. 从 0.2.0 双插件 tgz 原位切换至 registry（包括其中一个被用户手动禁用的情形）：保留原有启用/禁用选择
      await writeFile(
        backupPath,
        JSON.stringify({
          dependencies: {
            'asi-sense': 'file:/old/asi-sense-0.2.0.tgz',
            'asi-needs': 'file:/old/asi-needs-0.2.0.tgz',
          },
          dsh: { profile: { bundles: ['asi-sense'] } },
        }),
      );
      await writeFile(
        join(profileDir, 'package.json'),
        JSON.stringify({
          dependencies: { 'asi-sense': '0.2.0', 'asi-needs': '0.2.0' },
          dsh: { profile: { bundles: ['asi-sense'] } },
        }),
      );
      expect(runUpgradeCheck().status).toBe(0);

      // 双插件回退核对：缺少 asi-needs file: 时报错，两个均为 file: 时通过
      await writeFile(
        join(profileDir, 'package.json'),
        JSON.stringify({
          dependencies: { 'asi-sense': 'file:/old/asi-sense-0.2.0.tgz', 'asi-needs': '0.2.0' },
          dsh: { profile: { bundles: ['asi-sense'] } },
        }),
      );
      expect(runRollbackCheck().status).not.toBe(0);
      await writeFile(
        join(profileDir, 'package.json'),
        JSON.stringify({
          dependencies: {
            'asi-sense': 'file:/old/asi-sense-0.2.0.tgz',
            'asi-needs': 'file:/old/asi-needs-0.2.0.tgz',
          },
          dsh: { profile: { bundles: ['asi-sense'] } },
        }),
      );
      expect(runRollbackCheck().status).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
