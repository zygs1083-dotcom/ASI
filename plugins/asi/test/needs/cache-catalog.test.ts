import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
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
} from '../../src/needs/host/cache-catalog.js';
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
    const brew = join(homeDir, 'Library', 'Caches', 'Homebrew');
    await mkdir(join(derived, 'StaleBuild'), { recursive: true });
    await mkdir(join(derived, 'ActiveBuild'), { recursive: true });
    await mkdir(join(derived, 'FreshEmptyStaging'), { recursive: true });
    await mkdir(join(brew, 'SharedBucket'), { recursive: true });

    const exact1hFile = join(derived, 'StaleBuild', 'exact-1h.bin');
    const activeCompileObj = join(derived, 'ActiveBuild', 'compiling-5m.o');
    const activeProjectOldPcm = join(derived, 'ActiveBuild', 'module-2h.pcm');
    const almost1hFile = join(brew, 'SharedBucket', 'almost-1h.bin');
    const futureSkewFile = join(brew, 'SharedBucket', 'future.bin');
    const oldBucketFile = join(brew, 'SharedBucket', 'old-2h.bin');

    await writeFile(exact1hFile, Buffer.alloc(4096));
    await writeFile(activeCompileObj, Buffer.alloc(1024));
    await writeFile(activeProjectOldPcm, Buffer.alloc(2048));
    await writeFile(almost1hFile, Buffer.alloc(2048));
    await writeFile(futureSkewFile, Buffer.alloc(1024));
    await writeFile(oldBucketFile, Buffer.alloc(8192));

    await setMtime(exact1hFile, T0 - EXTERNAL_CACHE_ACTIVE_PROTECTION_MS); // 恰好满 1 小时 -> 清除
    await setMtime(activeCompileObj, T0 - 5 * 60_000); // 5 分钟前活跃编译对象
    await setMtime(activeProjectOldPcm, T0 - 2 * EXTERNAL_CACHE_ACTIVE_PROTECTION_MS); // 活跃工程内的旧中间文件 -> 随活跃工程原子保护！
    await setMtime(almost1hFile, T0 - EXTERNAL_CACHE_ACTIVE_PROTECTION_MS + 1); // 差 1ms 未满 1 小时 -> 保护跳过
    await setMtime(futureSkewFile, T0 + 60_000); // 时钟前偏未来文件 -> 保护跳过
    await setMtime(oldBucketFile, T0 - 2 * EXTERNAL_CACHE_ACTIVE_PROTECTION_MS); // 共享哈希桶内 2 小时前旧包 -> 清除
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

    expect(res.deletedEntries).toBe(1);
    expect(res.freedBytes).toBe(4096);
    expect(res.skippedActiveEntries).toBe(2);
    expect(res.protectedActiveBytes).toBe(1024 + 2048);
    expect(res.skippedSymlinks).toBe(2);

    // StaleBuild 全部清空后空壳子目录自动移除；活跃工程 ActiveBuild 内的旧模块缓存也不被半途撕裂删除！
    await expect(stat(join(derived, 'StaleBuild'))).rejects.toThrow();
    expect((await stat(derived)).isDirectory()).toBe(true);
    expect((await stat(join(derived, 'FreshEmptyStaging'))).isDirectory()).toBe(true);
    expect((await stat(activeCompileObj)).isFile()).toBe(true);
    expect((await stat(activeProjectOldPcm)).isFile()).toBe(true);

    // 共享哈希桶（Homebrew）清理 >1h 陈旧包，精确保留差 1ms 未满 1h 与未来时间戳文件
    const brewRes = await cleanExternalCacheTarget({
      homeDir,
      targetId: 'homebrew',
      now: T0,
    });
    expect(brewRes.deletedEntries).toBe(1);
    expect(brewRes.freedBytes).toBe(8192);
    expect(brewRes.skippedActiveEntries).toBe(2);
    expect(brewRes.protectedActiveBytes).toBe(2048 + 1024);
    expect((await stat(almost1hFile)).isFile()).toBe(true);
    expect((await stat(futureSkewFile)).isFile()).toBe(true);
    await expect(stat(oldBucketFile)).rejects.toThrow();

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

  it('原子保护 .xcarchive 归档包束、.cargo/git/db 裸仓库与 Playwright 浏览器目录，隔离单规则扫描配额防废纸篓饥饿，并容错断链与 000 权限目录', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'asi-cache-atomic-budget-'));
    tempDirs.push(homeDir);

    // 1. 同一日期目录下既有刚归档（含旧资源时间戳）的 Active.xcarchive，又有陈旧 Old.xcarchive
    const archiveDay = join(homeDir, 'Library', 'Developer', 'Xcode', 'Archives', '2026-11-23');
    const activeArchive = join(archiveDay, 'ActiveApp.xcarchive');
    const staleArchive = join(archiveDay, 'OldApp.xcarchive');
    await mkdir(join(activeArchive, 'Products'), { recursive: true });
    await mkdir(join(staleArchive, 'Products'), { recursive: true });
    const activePlist = join(activeArchive, 'Info.plist');
    const activeOldLogo = join(activeArchive, 'Products', 'logo.png');
    const stalePlist = join(staleArchive, 'Info.plist');
    await writeFile(activePlist, Buffer.alloc(512));
    await writeFile(activeOldLogo, Buffer.alloc(4096));
    await writeFile(stalePlist, Buffer.alloc(8192));
    await setMtime(activePlist, T0 - 3 * 60_000); // 3 分钟前归档完成
    await setMtime(activeOldLogo, T0 - 48 * EXTERNAL_CACHE_ACTIVE_PROTECTION_MS); // 归档内保留了 2 天前源码资源时间戳
    await setMtime(stalePlist, T0 - 5 * EXTERNAL_CACHE_ACTIVE_PROTECTION_MS);

    // 2. Cargo git/db 活跃裸仓库 vs 陈旧裸仓库
    const activeGitRepo = join(homeDir, '.cargo', 'git', 'db', 'serde-active');
    const staleGitRepo = join(homeDir, '.cargo', 'git', 'db', 'tokio-stale');
    await mkdir(activeGitRepo, { recursive: true });
    await mkdir(staleGitRepo, { recursive: true });
    const activeFetchHead = join(activeGitRepo, 'FETCH_HEAD');
    const activeOldPack = join(activeGitRepo, 'base.pack');
    const staleHead = join(staleGitRepo, 'HEAD');
    await writeFile(activeFetchHead, Buffer.alloc(256));
    await writeFile(activeOldPack, Buffer.alloc(6000));
    await writeFile(staleHead, Buffer.alloc(3000));
    await setMtime(activeFetchHead, T0 - 2 * 60_000);
    await setMtime(activeOldPack, T0 - 24 * EXTERNAL_CACHE_ACTIVE_PROTECTION_MS);
    await setMtime(staleHead, T0 - 24 * EXTERNAL_CACHE_ACTIVE_PROTECTION_MS);

    // 3. Playwright 刚解压安装的浏览器（标记 1 分钟前，内核二进制原始压缩包时间戳 7 天前）
    const pwChromium = join(homeDir, '.cache', 'ms-playwright', 'chromium-1140');
    await mkdir(pwChromium, { recursive: true });
    const pwMarker = join(pwChromium, 'INSTALLATION_COMPLETE');
    const pwBinary = join(pwChromium, 'chrome-linux');
    await writeFile(pwMarker, Buffer.alloc(64));
    await writeFile(pwBinary, Buffer.alloc(16_384));
    await setMtime(pwMarker, T0 - 60_000);
    await setMtime(pwBinary, T0 - 168 * EXTERNAL_CACHE_ACTIVE_PROTECTION_MS);

    // 4. 制造超配额 pnpm-store（230 个碎文件 > maxEntries=200）+ 废纸篓大文件，验证后序规则与废纸篓不被饥饿归零
    const pnpmStore = join(homeDir, '.local', 'share', 'pnpm', 'store');
    await mkdir(pnpmStore, { recursive: true });
    for (let i = 0; i < 230; i += 1) {
      const f = join(pnpmStore, `blob-${i}.bin`);
      await writeFile(f, Buffer.alloc(64));
      await setMtime(f, T0 - 2 * EXTERNAL_CACHE_ACTIVE_PROTECTION_MS);
    }
    const trashDir = join(homeDir, '.Trash');
    await mkdir(trashDir, { recursive: true });
    await writeFile(join(trashDir, 'movie.mov'), Buffer.alloc(50_000));

    const scan = await scanExternalCachesAndTrash({ homeDir, now: T0, maxEntries: 200 });
    expect(scan.truncated).toBe(true);
    expect(scan.trash.totalBytes).toBe(50_000);
    const pwScan = scan.externalCaches.find((c) => c.targetId === 'playwright-browsers');
    expect(pwScan?.totalBytes).toBe(16_384 + 64);
    expect(pwScan?.reclaimableBytes).toBe(0);
    expect(pwScan?.approvable).toBe(false);

    const archScan = scan.externalCaches.find((c) => c.targetId === 'xcode-archives');
    expect(archScan?.totalBytes).toBe(512 + 4096 + 8192);
    expect(archScan?.reclaimableBytes).toBe(8192);

    // 执行清理验证：OldApp.xcarchive 与 tokio-stale 被清除，而 ActiveApp.xcarchive、serde-active、chromium-1140 内旧文件均完整保留
    const archClean = await cleanExternalCacheTarget({ homeDir, targetId: 'xcode-archives', now: T0 });
    expect(archClean.freedBytes).toBe(8192);
    await expect(stat(staleArchive)).rejects.toThrow();
    expect((await stat(activeOldLogo)).isFile()).toBe(true);

    const cargoClean = await cleanExternalCacheTarget({ homeDir, targetId: 'cargo-registry-cache', now: T0 });
    expect(cargoClean.freedBytes).toBe(3000);
    await expect(stat(staleGitRepo)).rejects.toThrow();
    expect((await stat(activeOldPack)).isFile()).toBe(true);

    const pwClean = await cleanExternalCacheTarget({ homeDir, targetId: 'playwright-browsers', now: T0 });
    expect(pwClean.freedBytes).toBe(0);
    expect((await stat(pwBinary)).isFile()).toBe(true);

    // 5. 断链符号链接与权限 000 子目录容错（不抛未捕获异常、不误删不可读父目录）
    const goCache = join(homeDir, '.cache', 'go-build');
    const lockedSub = join(goCache, 'locked-000');
    await mkdir(lockedSub, { recursive: true });
    const lockedFile = join(lockedSub, 'inside.a');
    const staleGo = join(goCache, 'stale.a');
    await writeFile(lockedFile, Buffer.alloc(1024));
    await writeFile(staleGo, Buffer.alloc(2048));
    await setMtime(staleGo, T0 - 2 * EXTERNAL_CACHE_ACTIVE_PROTECTION_MS);
    await symlink(join(homeDir, 'missing-broken-target'), join(goCache, 'broken.lnk'));
    await chmod(lockedSub, 0o000);
    try {
      const goClean = await cleanExternalCacheTarget({ homeDir, targetId: 'go-build-cache', now: T0 });
      expect(goClean.deletedEntries).toBe(1);
      expect(goClean.freedBytes).toBe(2048);
      expect(goClean.skippedSymlinks).toBe(1);
      await expect(stat(staleGo)).rejects.toThrow();
    } finally {
      await chmod(lockedSub, 0o700);
    }
  });
});
