import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  allowed,
  auditFiles,
  expectedPackageFiles,
  extractClientCssClasses,
  registryUrl,
  registryVersionAvailable,
} from '../../scripts/release-audit.mjs';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REQUIRED_DSH = '0.2.2-rc.3 || 0.2.2-rc.5';

describe('统一单插件 asi (0.6.0) 发布包审计与 Desktop Profile 迁移核对', () => {
  it('全工作区源码包均保持 private=true、版本对齐 0.6.0，且 cordis.patch.yml 指向 dshHomePath("data", "asi")', async () => {
    for (const rel of [
      '../../../../package.json',
      '../../../../packages/body-probe/package.json',
      '../../../../packages/sense-types/package.json',
      '../../../../packages/sense-ui/package.json',
      '../../package.json',
    ]) {
      const manifest = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
      expect(manifest.private).toBe(true);
      if (rel !== '../../../../package.json') {
        expect(manifest.version).toBe('0.6.0');
      }
    }

    const pluginManifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
    expect(pluginManifest.name).toBe('asi');
    expect(pluginManifest.engines.dsh).toBe(REQUIRED_DSH);
    expect(pluginManifest.files).toEqual([
      'lib/index.js',
      'lib/client.js',
      'lib/typert.host.js',
      'lib/asi-sense-helper',
      'cordis.patch.yml',
      'scripts/dsh.sh',
    ]);

    const patchYml = await readFile(join(pkgDir, 'cordis.patch.yml'), 'utf8');
    expect(patchYml).toContain('id: asi');
    expect(patchYml).toContain('name: asi');
    expect(patchYml).toContain("storageRoot: !!js dshHomePath('data', 'asi')");

    expect(expectedPackageFiles('darwin', false)).toContain('lib/asi-sense-helper');
    expect(expectedPackageFiles('linux', false)).not.toContain('lib/asi-sense-helper');
    expect(expectedPackageFiles('linux', true)).toContain('lib/asi-sense-helper');
  });

  it('真实构建产物通过敏感扫描、单侧栏契约检查且 peerDependencies 100% 覆盖运行时 @deepseek-ai/* 导入', {
    timeout: 45_000,
  }, async () => {
    const built = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: pkgDir, encoding: 'utf8' });
    expect(built.status, built.stderr || built.stdout).toBe(0);

    const files = [
      'package.json',
      'cordis.patch.yml',
      'scripts/dsh.sh',
      'lib/index.js',
      'lib/client.js',
      'lib/typert.host.js',
    ];
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

    const manifest = JSON.parse(buffers.get('package.json').toString('utf8'));
    const importedPeers = new Set();
    for (const bundleFile of ['lib/index.js', 'lib/typert.host.js']) {
      const code = buffers.get(bundleFile).toString('utf8');
      for (const match of code.matchAll(/from\s+["'](@deepseek-ai\/[^/"']+)/g)) {
        if (match[1]) importedPeers.add(match[1]);
      }
    }
    expect(importedPeers.size).toBeGreaterThan(0);
    for (const spec of importedPeers) {
      expect(manifest.peerDependencies?.[spec], `missing peerDependency for ${spec}`).toBeDefined();
      if (spec.startsWith('@deepseek-ai/dsh-')) {
        expect(manifest.peerDependencies?.[spec]).toBe(REQUIRED_DSH);
      }
    }

    const clientCode = buffers.get('lib/client.js').toString('utf8');
    expect(extractClientCssClasses(clientCode).size).toBeGreaterThan(40);
    expect(clientCode).toContain('order: 90');
    expect(clientCode).not.toContain('order: 91');
    expect(clientCode).not.toContain('order: 92');
  });

  it('严格拦截未知文件、单字节与双字节序 UTF-16 凭据/邮箱/绝对路径/本机用户名与内外联 sourcemap', () => {
    expect(() => auditFiles([{ path: 'lib/extra.js' }], () => Buffer.from('safe'), 'exampleuser')).toThrow(
      /Unexpected package file/,
    );
    expect(() => auditFiles([{ path: 'lib/index.js' }], () => Buffer.from('hello exampleuser'), 'exampleuser')).toThrow(
      /Local username/,
    );

    const samples = [
      `npm_${'a'.repeat(24)}`,
      `ghp_${'b'.repeat(36)}`,
      `github_pat_${'e'.repeat(22)}_${'f'.repeat(59)}`,
      `glpat-${'g'.repeat(20)}`,
      `xoxb-${'2'.repeat(10)}-${'i'.repeat(32)}`,
      `AIza${'m'.repeat(35)}`,
      `sk-${'c'.repeat(32)}`,
      `AKIA${'D'.repeat(16)}`,
      '-----BEGIN PRIVATE KEY-----',
      'invented.person@example.invalid',
      '/Users/other/build/file',
      '/home/other/file',
      '/opt/build/file',
      'C:\\Users\\other\\file',
      '//# sourceMappingURL=index.js.map',
    ];
    for (const sample of samples) {
      const le = Buffer.from(sample, 'utf16le');
      const be = Buffer.from(le).swap16();
      for (const bytes of [Buffer.from(sample), le, be]) {
        for (const path of ['lib/index.js', 'lib/client.js', 'lib/asi-sense-helper']) {
          expect(() => auditFiles([{ path }], () => Buffer.concat([Buffer.from([0xff]), bytes]), '')).toThrow();
        }
      }
    }

    expect(() => auditFiles([{ path: 'scripts/dsh.sh' }], () => Buffer.from('/dev/null'), '')).not.toThrow();
    expect(() => auditFiles([{ path: 'lib/index.js' }], () => Buffer.from('/dev/null'), '')).toThrow();
    expect(() =>
      auditFiles(
        [...allowed].map((path) => ({ path })),
        () => Buffer.from('ok'),
        'alice',
      ),
    ).not.toThrow();

    expect(registryVersionAvailable(1, '{"error":{"code":"E404"}}')).toBe(true);
    expect(registryVersionAvailable(0, '"0.6.0"')).toBe(false);
    expect(() => registryVersionAvailable(1, '{"error":{"code":"E403"}}')).toThrow();
    expect(registryUrl()).toBe('https://registry.npmjs.org/');
    expect(() => registryUrl('https://user:secret@example.com/')).toThrow();
  });

  it('docs/release.md 内嵌的 Desktop profile 五合一迁移与回退核对脚本真实可执行且严格保护 dsh-context / dsh-superagent', async () => {
    const releaseDoc = await readFile(join(pkgDir, '../../docs/release.md'), 'utf8');
    const inlineHelpers = [
      ...releaseDoc.matchAll(/node -e '\n([\s\S]*?)\n' "\$PROFILE\/package\.json" "\$BACKUP\/package\.json"/g),
    ].map((m) => m[1]);
    expect(inlineHelpers).toHaveLength(2);
    const [syncDisabledHelper, syncRollbackBundlesHelper] = inlineHelpers;

    const snippets = [...releaseDoc.matchAll(/node - ([^\n]+) <<'NODE'\n([\s\S]*?)\nNODE/g)].map((m) => m[2]);
    expect(snippets).toHaveLength(2);
    const [verifyUpgradeScript, verifyRollbackScript] = snippets;

    const dir = await mkdtemp(join(tmpdir(), 'asi-release-060-test-'));
    try {
      const profileDir = join(dir, 'profile');
      const backupPath = join(dir, 'backup-package.json');
      await mkdir(join(profileDir, 'node_modules/asi'), { recursive: true });
      await writeFile(join(profileDir, 'node_modules/asi/package.json'), '{"version":"0.6.0"}');

      const runSyncDisabled = () =>
        spawnSync(process.execPath, ['-e', syncDisabledHelper, join(profileDir, 'package.json'), backupPath], {
          encoding: 'utf8',
        });
      const runSyncRollbackBundles = () =>
        spawnSync(process.execPath, ['-e', syncRollbackBundlesHelper, join(profileDir, 'package.json'), backupPath], {
          encoding: 'utf8',
        });
      const runUpgrade = (ver = '0.6.0') =>
        spawnSync(process.execPath, ['-', profileDir, backupPath, ver], {
          input: verifyUpgradeScript,
          encoding: 'utf8',
        });
      const runRollback = () =>
        spawnSync(process.execPath, ['-', join(profileDir, 'package.json'), backupPath], {
          input: verifyRollbackScript,
          encoding: 'utf8',
        });

      // 1. 从 0.5.0 五插件迁移至单插件 asi@0.6.0（保留 dsh-context 与 dsh-superagent）
      await writeFile(
        backupPath,
        JSON.stringify({
          dependencies: {
            'dsh-context': '0.2.2-rc.3',
            'dsh-superagent': '0.2.2-rc.3',
            'asi-sense': 'file:/old/asi-sense-0.5.0.tgz',
            'asi-needs': 'file:/old/asi-needs-0.5.0.tgz',
            'asi-sleep': 'file:/old/asi-sleep-0.5.0.tgz',
            'asi-care': 'file:/old/asi-care-0.5.0.tgz',
            'asi-growth': 'file:/old/asi-growth-0.5.0.tgz',
          },
          dsh: {
            profile: {
              bundles: [
                'dsh-context',
                'dsh-superagent',
                'asi-sense',
                'asi-needs',
                'asi-sleep',
                'asi-care',
                'asi-growth',
              ],
            },
          },
        }),
      );

      // 若残留旧版 asi-sleep，必须报错拦截
      await writeFile(
        join(profileDir, 'package.json'),
        JSON.stringify({
          dependencies: {
            'dsh-context': '0.2.2-rc.3',
            'dsh-superagent': '0.2.2-rc.3',
            'asi-sleep': 'file:/old/asi-sleep-0.5.0.tgz',
            asi: '0.6.0',
          },
          dsh: { profile: { bundles: ['dsh-context', 'dsh-superagent', 'asi'] } },
        }),
      );
      expect(runUpgrade().status).not.toBe(0);

      // 若意外丢失 dsh-superagent，必须报错拦截
      await writeFile(
        join(profileDir, 'package.json'),
        JSON.stringify({
          dependencies: {
            'dsh-context': '0.2.2-rc.3',
            asi: '0.6.0',
          },
          dsh: { profile: { bundles: ['dsh-context', 'asi'] } },
        }),
      );
      expect(runUpgrade().status).not.toBe(0);

      // 干净移除 5 个旧包、保留 dsh-context + dsh-superagent 并启用 asi@0.6.0 时通过
      await writeFile(
        join(profileDir, 'package.json'),
        JSON.stringify({
          dependencies: {
            'dsh-context': '0.2.2-rc.3',
            'dsh-superagent': '0.2.2-rc.3',
            asi: '0.6.0',
          },
          dsh: { profile: { bundles: ['dsh-context', 'dsh-superagent', 'asi'] } },
        }),
      );
      expect(runUpgrade().status).toBe(0);

      // 回退至 0.5.0 五个 file: tgz：残留 asi 时报错，完整恢复 5 个 file: tgz 时通过
      expect(runRollback().status).not.toBe(0);
      await writeFile(
        join(profileDir, 'package.json'),
        JSON.stringify({
          dependencies: {
            'dsh-context': '0.2.2-rc.3',
            'dsh-superagent': '0.2.2-rc.3',
            'asi-sense': 'file:/old/asi-sense-0.5.0.tgz',
            'asi-needs': 'file:/old/asi-needs-0.5.0.tgz',
            'asi-sleep': 'file:/old/asi-sleep-0.5.0.tgz',
            'asi-care': 'file:/old/asi-care-0.5.0.tgz',
            'asi-growth': 'file:/old/asi-growth-0.5.0.tgz',
          },
          dsh: {
            profile: {
              bundles: [
                'dsh-context',
                'dsh-superagent',
                'asi-sense',
                'asi-needs',
                'asi-sleep',
                'asi-care',
                'asi-growth',
              ],
            },
          },
        }),
      );
      expect(runRollback().status).toBe(0);

      // 2. 后续单包 asi 0.6.0 tgz -> 0.6.1 registry 原位升级（保留中间位置与禁用态）及回退
      await writeFile(join(profileDir, 'node_modules/asi/package.json'), '{"version":"0.6.1"}');
      await writeFile(
        backupPath,
        JSON.stringify({
          dependencies: {
            'dsh-context': '0.2.2-rc.3',
            asi: 'file:/old/asi-0.6.0.tgz',
            'dsh-superagent': '0.2.2-rc.3',
          },
          dsh: { profile: { bundles: ['dsh-context', 'asi', 'dsh-superagent'] } },
        }),
      );
      await writeFile(
        join(profileDir, 'package.json'),
        JSON.stringify({
          dependencies: {
            'dsh-context': '0.2.2-rc.3',
            asi: '0.6.1',
            'dsh-superagent': '0.2.2-rc.3',
          },
          dsh: { profile: { bundles: ['dsh-context', 'asi', 'dsh-superagent'] } },
        }),
      );
      expect(runUpgrade('0.6.1').status).toBe(0);

      await writeFile(
        join(profileDir, 'package.json'),
        JSON.stringify({
          dependencies: {
            'dsh-context': '0.2.2-rc.3',
            asi: 'file:/old/asi-0.6.0.tgz',
            'dsh-superagent': '0.2.2-rc.3',
          },
          dsh: { profile: { bundles: ['dsh-context', 'asi', 'dsh-superagent'] } },
        }),
      );
      expect(runRollback().status).toBe(0);

      // 3. 当升级前 5 个旧版 asi-* 全部处于手动禁用状态，且 dsh plugin add 默认将 asi 推入 bundles 时：
      //    内联同步脚本保持禁用态且核对脚本通过；回退时即使原 5 个包夹在 dsh-context 与 dsh-superagent 中间也能精确还原顺序
      await writeFile(join(profileDir, 'node_modules/asi/package.json'), '{"version":"0.6.0"}');
      await writeFile(
        backupPath,
        JSON.stringify({
          dependencies: {
            'dsh-context': '0.2.2-rc.3',
            'asi-sense': 'file:/old/asi-sense-0.5.0.tgz',
            'asi-needs': 'file:/old/asi-needs-0.5.0.tgz',
            'asi-sleep': 'file:/old/asi-sleep-0.5.0.tgz',
            'asi-care': 'file:/old/asi-care-0.5.0.tgz',
            'asi-growth': 'file:/old/asi-growth-0.5.0.tgz',
            'dsh-superagent': '0.2.2-rc.3',
          },
          dsh: { profile: { bundles: ['dsh-context', 'dsh-superagent'] } },
        }),
      );
      await writeFile(
        join(profileDir, 'package.json'),
        JSON.stringify({
          dependencies: {
            'dsh-context': '0.2.2-rc.3',
            'dsh-superagent': '0.2.2-rc.3',
            asi: '0.6.0',
          },
          dsh: { profile: { bundles: ['dsh-context', 'dsh-superagent', 'asi'] } },
        }),
      );
      expect(runSyncDisabled().status).toBe(0);
      expect(runUpgrade('0.6.0').status).toBe(0);

      // 非末尾顺序 5 插件回退还原
      await writeFile(
        backupPath,
        JSON.stringify({
          dependencies: {
            'dsh-context': '0.2.2-rc.3',
            'asi-sense': 'file:/old/asi-sense-0.5.0.tgz',
            'asi-needs': 'file:/old/asi-needs-0.5.0.tgz',
            'asi-sleep': 'file:/old/asi-sleep-0.5.0.tgz',
            'asi-care': 'file:/old/asi-care-0.5.0.tgz',
            'asi-growth': 'file:/old/asi-growth-0.5.0.tgz',
            'dsh-superagent': '0.2.2-rc.3',
          },
          dsh: {
            profile: {
              bundles: [
                'dsh-context',
                'asi-sense',
                'asi-needs',
                'asi-sleep',
                'asi-care',
                'asi-growth',
                'dsh-superagent',
              ],
            },
          },
        }),
      );
      await writeFile(
        join(profileDir, 'package.json'),
        JSON.stringify({
          dependencies: {
            'dsh-context': '0.2.2-rc.3',
            'dsh-superagent': '0.2.2-rc.3',
            'asi-sense': 'file:/old/asi-sense-0.5.0.tgz',
            'asi-needs': 'file:/old/asi-needs-0.5.0.tgz',
            'asi-sleep': 'file:/old/asi-sleep-0.5.0.tgz',
            'asi-care': 'file:/old/asi-care-0.5.0.tgz',
            'asi-growth': 'file:/old/asi-growth-0.5.0.tgz',
          },
          dsh: {
            profile: {
              bundles: [
                'dsh-context',
                'dsh-superagent',
                'asi-sense',
                'asi-needs',
                'asi-sleep',
                'asi-care',
                'asi-growth',
              ],
            },
          },
        }),
      );
      expect(runSyncRollbackBundles().status).toBe(0);
      expect(runRollback().status).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
