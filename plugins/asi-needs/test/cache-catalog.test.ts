import { mkdir, mkdtemp, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLEANABLE_EXTERNAL_CACHE_IDS,
  cleanExternalCacheTarget,
  EXTERNAL_CACHE_ACTIVE_PROTECTION_MS,
  EXTERNAL_CACHE_RULES,
  isCleanableExternalCacheId,
  MIT_CACHE_ADAPTATION_SOURCES,
  scanExternalCachesAndTrash,
  TRASH_READONLY_RULE,
  validateProtectedTargetRoot,
} from '../src/host/cache-catalog.js';
import { T0 } from './fixtures.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function setMtime(path: string, mtimeMs: number): Promise<void> {
  const sec = mtimeMs / 1000;
  await utimes(path, sec, sec);
}

describe('MIT 内化开发者与系统缓存规则字典及 1 小时活跃保护清理', () => {
  it('保留 MIT 开源出处元数据，覆盖全部关键开发者缓存，且严格将废纸篓标为只读 risky', () => {
    expect(MIT_CACHE_ADAPTATION_SOURCES).toEqual([
      'bysiber/cleardisk (MIT)',
      'guhcostan/mac-cleaner-cli (MIT)',
      'tw93/Mole (MIT)',
    ]);
    for (const id of [
      'xcode-derived-data',
      'xcode-archives',
      'homebrew',
      'pnpm-store',
      'npm-cache',
      'pip-cache',
      'uv-cache',
      'cargo-registry-cache',
      'go-build-cache',
      'go-mod-cache',
      'gradle-caches',
      'playwright-browsers',
    ]) {
      expect(CLEANABLE_EXTERNAL_CACHE_IDS).toContain(id);
      expect(isCleanableExternalCacheId(id)).toBe(true);
    }
    expect(EXTERNAL_CACHE_RULES.find((r) => r.id === 'xcode-derived-data')?.risk).toBe('safe');
    expect(EXTERNAL_CACHE_RULES.find((r) => r.id === 'xcode-archives')?.risk).toBe('caution');
    expect(TRASH_READONLY_RULE.risk).toBe('risky');
    expect(TRASH_READONLY_RULE.cleanable).toBe(false);
    expect(isCleanableExternalCacheId('macos-trash')).toBe(false);
    expect(isCleanableExternalCacheId('../Documents')).toBe(false);
    expect(isCleanableExternalCacheId('/tmp/cache')).toBe(false);
    expect(isCleanableExternalCacheId('')).toBe(false);
  });

  it('只读嗅探精确区分总体积与 >1h 可清理体积、按可清理体积降序排列，并只读统计废纸篓体积', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'asi-cache-scan-'));
    tempDirs.push(homeDir);

    const derived = join(homeDir, 'Library', 'Developer', 'Xcode', 'DerivedData');
    const brew = join(homeDir, 'Library', 'Caches', 'Homebrew');
    const trash = join(homeDir, '.Trash');
    await mkdir(join(derived, 'OldProj'), { recursive: true });
    await mkdir(join(derived, 'ActiveProj'), { recursive: true });
    await mkdir(brew, { recursive: true });
    await mkdir(trash, { recursive: true });

    const staleXcode = join(derived, 'OldProj', 'stale.o');
    const activeXcode = join(derived, 'ActiveProj', 'compiling.o');
    const staleBrew = join(brew, 'pkg-1.0.tar.gz');
    const trashItem = join(trash, 'old-video.mov');

    await writeFile(staleXcode, Buffer.alloc(12_000));
    await writeFile(activeXcode, Buffer.alloc(8_000));
    await writeFile(staleBrew, Buffer.alloc(20_000));
    await writeFile(trashItem, Buffer.alloc(32_000));

    await setMtime(staleXcode, T0 - EXTERNAL_CACHE_ACTIVE_PROTECTION_MS - 60_000);
    await setMtime(activeXcode, T0 - 5 * 60_000); // 5 分钟前活跃修改
    await setMtime(staleBrew, T0 - 3 * EXTERNAL_CACHE_ACTIVE_PROTECTION_MS);
    await setMtime(trashItem, T0 - 10 * EXTERNAL_CACHE_ACTIVE_PROTECTION_MS);

    const report = await scanExternalCachesAndTrash({ homeDir, now: T0 });
    expect(report.externalCaches.map((c) => c.targetId)).toEqual(['homebrew', 'xcode-derived-data']);

    const brewEntry = report.externalCaches[0];
    if (!brewEntry) throw new Error('missing brewEntry');
    expect(brewEntry.totalBytes).toBe(20_000);
    expect(brewEntry.reclaimableBytes).toBe(20_000);
    expect(brewEntry.paths).toEqual(['~/Library/Caches/Homebrew']);

    const xcodeEntry = report.externalCaches[1];
    if (!xcodeEntry) throw new Error('missing xcodeEntry');
    expect(xcodeEntry.totalBytes).toBe(20_000);
    expect(xcodeEntry.reclaimableBytes).toBe(12_000);
    expect(xcodeEntry.activeProtectedBytes).toBe(8_000);
    expect(xcodeEntry.staleEntryCount).toBe(1);
    expect(xcodeEntry.activeEntryCount).toBe(1);

    expect(report.trash.exists).toBe(true);
    expect(report.trash.totalBytes).toBe(32_000);
    expect(report.trash.itemCount).toBe(1);
    expect(report.trash.cleanable).toBe(false);
    expect(report.trash.risk).toBe('risky');
  });

  it('1 小时活跃保护边界精确到毫秒，防符号链接越界，且拒绝废纸篓/任意路径/受保护目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asi-cache-clean-'));
    tempDirs.push(root);
    const homeDir = join(root, 'fake-home');
    const outsideDir = join(root, 'outside-precious');
    await mkdir(homeDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    const preciousDoc = join(homeDir, 'Documents', 'thesis.md');
    const outsideSecret = join(outsideDir, 'vault.txt');
    const trashFile = join(homeDir, '.Trash', 'keep-in-trash.txt');
    await mkdir(join(homeDir, 'Documents'), { recursive: true });
    await mkdir(join(homeDir, '.Trash'), { recursive: true });
    await writeFile(preciousDoc, 'do not touch', 'utf8');
    await writeFile(outsideSecret, 'outside secret', 'utf8');
    await writeFile(trashFile, 'trash data', 'utf8');

    const derived = join(homeDir, 'Library', 'Developer', 'Xcode', 'DerivedData');
    await mkdir(join(derived, 'StaleBuild'), { recursive: true });
    await mkdir(join(derived, 'SharedBucket'), { recursive: true });
    await mkdir(join(derived, 'FreshEmptyStaging'), { recursive: true });

    const exact1hFile = join(derived, 'StaleBuild', 'exact-1h.bin');
    const almost1hFile = join(derived, 'SharedBucket', 'almost-1h.bin');
    const futureSkewFile = join(derived, 'SharedBucket', 'future.bin');
    const oldBucketFile = join(derived, 'SharedBucket', 'old-2h.bin');

    await writeFile(exact1hFile, Buffer.alloc(4096));
    await writeFile(almost1hFile, Buffer.alloc(2048));
    await writeFile(futureSkewFile, Buffer.alloc(1024));
    await writeFile(oldBucketFile, Buffer.alloc(8192));

    await setMtime(exact1hFile, T0 - EXTERNAL_CACHE_ACTIVE_PROTECTION_MS); // 恰好满 1 小时 -> 清除
    await setMtime(almost1hFile, T0 - EXTERNAL_CACHE_ACTIVE_PROTECTION_MS + 1); // 差 1ms 未满 1 小时 -> 保护跳过
    await setMtime(futureSkewFile, T0 + 60_000); // 时钟前偏未来文件 -> 保护跳过
    await setMtime(oldBucketFile, T0 - 2 * EXTERNAL_CACHE_ACTIVE_PROTECTION_MS); // 2 小时前 -> 清除
    await setMtime(join(derived, 'FreshEmptyStaging'), T0 - 10_000); // 10s 前新建空构建目录 -> 保护跳过

    // 符号链接越界攻击：缓存内指向用户文档与外部目录，以及将整个 npm 缓存根目录做成指向 Documents 的符号链接
    await symlink(preciousDoc, join(derived, 'escape-doc.lnk'));
    await symlink(outsideDir, join(derived, 'escape-dir'));
    await mkdir(join(homeDir, '.npm'), { recursive: true });
    await symlink(join(homeDir, 'Documents'), join(homeDir, '.npm', '_cacache'));

    const res = await cleanExternalCacheTarget({
      homeDir,
      targetId: 'xcode-derived-data',
      now: T0,
    });

    expect(res.deletedEntries).toBe(2);
    expect(res.freedBytes).toBe(4096 + 8192);
    expect(res.skippedActiveEntries).toBe(2);
    expect(res.protectedActiveBytes).toBe(2048 + 1024);
    expect(res.skippedSymlinks).toBe(2);

    // StaleBuild 全部清空后空壳子目录自动移除，但顶层 DerivedData 与 10s 内新建空目录保留
    await expect(stat(join(derived, 'StaleBuild'))).rejects.toThrow();
    expect((await stat(derived)).isDirectory()).toBe(true);
    expect((await stat(join(derived, 'FreshEmptyStaging'))).isDirectory()).toBe(true);
    expect((await stat(almost1hFile)).isFile()).toBe(true);
    expect((await stat(futureSkewFile)).isFile()).toBe(true);

    // 符号链接目标、用户文档与废纸篓文件毫发无损
    expect((await stat(preciousDoc)).isFile()).toBe(true);
    expect((await stat(outsideSecret)).isFile()).toBe(true);
    expect((await stat(trashFile)).isFile()).toBe(true);

    // 整个缓存根目录自身是符号链接时拒绝跟随，不触碰被链接的 Documents
    const npmRes = await cleanExternalCacheTarget({
      homeDir,
      targetId: 'npm-cache',
      now: T0,
    });
    expect(npmRes.deletedEntries).toBe(0);
    expect(npmRes.skippedSymlinks).toBe(1);
    expect((await stat(preciousDoc)).isFile()).toBe(true);

    // 严禁清理废纸篓、未知目标或路径字符串
    await expect(cleanExternalCacheTarget({ homeDir, targetId: 'macos-trash', now: T0 })).rejects.toThrow(
      /Refused non-whitelisted or risky cache target/,
    );
    await expect(cleanExternalCacheTarget({ homeDir, targetId: '../Documents', now: T0 })).rejects.toThrow();

    const homeReal = await realpath(homeDir);
    expect(validateProtectedTargetRoot('/', homeReal)).toBe(false);
    expect(validateProtectedTargetRoot(homeReal, homeReal)).toBe(false);
    expect(validateProtectedTargetRoot(join(homeReal, 'Documents'), homeReal)).toBe(false);
    expect(validateProtectedTargetRoot(join(homeReal, '.Trash'), homeReal)).toBe(false);
    expect(validateProtectedTargetRoot(join(homeReal, '.secrets', 'sub'), homeReal)).toBe(false);
    expect(validateProtectedTargetRoot(await realpath(derived), homeReal)).toBe(true);
  });
});
