import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyAsiData } from '../../src/migration/legacy-migration.ts';
import { MemoryVault } from '../../src/sleep/host/vault.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('migrateLegacyAsiData 无损旧版五插件数据自动迁移', () => {
  it('100% 无损迁移 ../asi-{sense,needs,sleep,care,growth}（含 76 条真实结构记忆与水位线），跳过沙盒临时文件与符号链接，且保留原目录备份不改动', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asi-legacy-mig-'));
    tempDirs.push(root);
    const dataDir = join(root, 'data');

    // 1. 构造旧版 5 个同级插件目录
    await mkdir(join(dataDir, 'asi-sense', 'tmp'), { recursive: true });
    await writeFile(
      join(dataDir, 'asi-sense', 'settings.json'),
      JSON.stringify({ version: 1, paused: false, sendTitles: false }),
    );
    await writeFile(join(dataDir, 'asi-sense', 'tmp', 'scratch.txt'), 'skip-me');

    await mkdir(join(dataDir, 'asi-needs', 'sandbox'), { recursive: true });
    await writeFile(
      join(dataDir, 'asi-needs', 'state.json'),
      JSON.stringify({
        maintTotalTurns: 7,
        actionLedger: [{ need: 'space', action: 'needs_clean_cache', attempts: 2 }],
      }),
    );
    await writeFile(join(dataDir, 'asi-needs', 'sandbox', 'temp-job.txt'), 'do-not-copy');
    await writeFile(join(dataDir, 'asi-needs', 'state.json.123.tmp'), 'transient-tmp');

    // 76 条模拟真实 MacPro 睡眠记忆 + 水位线
    await mkdir(join(dataDir, 'asi-sleep', 'vault'), { recursive: true });
    const memoriesLines: string[] = [];
    for (let i = 1; i <= 76; i += 1) {
      memoriesLines.push(
        JSON.stringify({
          id: `mem_live_${i}`,
          kind: i % 4 === 0 ? 'pitfall' : i % 3 === 0 ? 'decision' : i % 2 === 0 ? 'preference' : 'episode',
          title: `MacPro 历史沉淀记忆 #${i}`,
          content: `第 ${i} 条长期记忆内容，验证从 ~/.dsh/data/asi-sleep 零丢失迁移到 ~/.dsh/data/asi/sleep。`,
          tags: ['migration', `tag-${(i % 5) + 1}`],
          topicKey: `topic-group-${(i % 10) + 1}`,
          pinned: i <= 6,
          confidence: 0.92,
          sourceSessionIds: ['sess-macpro-1'],
          evidenceCount: 2,
          recallCount: i % 3,
          createdAt: 1_760_000_000_000 + i * 1_000,
          updatedAt: 1_760_100_000_000 + i * 1_000,
          fsrs: {
            stability: 18.5,
            difficulty: 3.4,
            elapsedDays: 1,
            scheduledDays: 18,
            learningSteps: 0,
            reps: 3,
            lapses: 0,
            state: 2,
            due: 1_780_000_000_000,
            lastReview: 1_760_100_000_000,
          },
        }),
      );
    }
    const rawJsonl = `${memoriesLines.join('\n')}\n`;
    const rawMemoryMd = '# ASI Memory Vault\n\nMigrated 76 memories.\n';
    const rawJournal = `${JSON.stringify({ id: 'sleep_1', turnsProcessed: 40, summary: 'consolidated 40 turns' })}\n`;
    const rawSleepState = JSON.stringify({
      autoSleepPaused: false,
      lastSleepAt: 1_760_200_000_000,
      firstUnconsolidatedTurnAt: null,
      lastOrdinaryActivityAt: 1_760_200_000_000,
      autoRunTimestamps: [1_760_200_000_000],
      consolidatedTurnKeys: ['legacy-sess::turn-1'],
      consolidatedSessionWatermarks: { 'sess-macpro-1': 80 },
    });

    await writeFile(join(dataDir, 'asi-sleep', 'vault', 'memories.jsonl'), rawJsonl);
    await writeFile(join(dataDir, 'asi-sleep', 'vault', 'MEMORY.md'), rawMemoryMd);
    await writeFile(join(dataDir, 'asi-sleep', 'vault', 'sleep-journal.jsonl'), rawJournal);
    await writeFile(join(dataDir, 'asi-sleep', 'state.json'), rawSleepState);

    // 植入外部越界符号链接，验证安全拦截
    const outsideSecret = join(root, 'outside-secret.txt');
    await writeFile(outsideSecret, 'DO_NOT_READ_SYMLINK');
    await symlink(outsideSecret, join(dataDir, 'asi-sleep', 'vault', 'evil-link.txt'));

    await mkdir(join(dataDir, 'asi-care'), { recursive: true });
    await writeFile(join(dataDir, 'asi-care', 'state.json'), JSON.stringify({ dismissedTargets: ['art_1'] }));

    await mkdir(join(dataDir, 'asi-growth', 'skills', 'active', 'pnpm-workspace-guard'), { recursive: true });
    await writeFile(join(dataDir, 'asi-growth', 'state.json'), JSON.stringify({ autoGrowthPaused: false }));
    await writeFile(join(dataDir, 'asi-growth', 'catalog.json'), JSON.stringify({ version: 1, skills: [] }));
    await writeFile(
      join(dataDir, 'asi-growth', 'skills', 'active', 'pnpm-workspace-guard', 'SKILL.md'),
      '---\nname: pnpm-workspace-guard\ndescription: Enforce workspace lockfile hygiene.\n---\n\n# Guard\n',
    );

    const unifiedRoot = join(dataDir, 'asi');
    const report = await migrateLegacyAsiData(unifiedRoot);

    expect(report.status).toBe('migrated');
    expect(report.modules).toEqual({
      sense: 'migrated',
      needs: 'migrated',
      sleep: 'migrated',
      care: 'migrated',
      growth: 'migrated',
    });
    expect(report.skippedSymlinks).toBe(1);

    // 校验 76 条记忆、MEMORY.md、日志与会话整合水位线 100% 原样落位
    const migratedJsonl = await readFile(join(unifiedRoot, 'sleep', 'vault', 'memories.jsonl'), 'utf8');
    expect(migratedJsonl).toBe(rawJsonl);
    expect(migratedJsonl.trim().split('\n')).toHaveLength(76);
    expect(await readFile(join(unifiedRoot, 'sleep', 'vault', 'MEMORY.md'), 'utf8')).toBe(rawMemoryMd);
    expect(await readFile(join(unifiedRoot, 'sleep', 'vault', 'sleep-journal.jsonl'), 'utf8')).toBe(rawJournal);
    expect(JSON.parse(await readFile(join(unifiedRoot, 'sleep', 'state.json'), 'utf8'))).toMatchObject({
      consolidatedSessionWatermarks: { 'sess-macpro-1': 80 },
      consolidatedTurnKeys: ['legacy-sess::turn-1'],
    });

    // 校验符号链接、sandbox、tmp 与 .tmp 临时文件均被跳过
    expect(existsSync(join(unifiedRoot, 'sleep', 'vault', 'evil-link.txt'))).toBe(false);
    expect(existsSync(join(unifiedRoot, 'needs', 'sandbox'))).toBe(false);
    expect(existsSync(join(unifiedRoot, 'sense', 'tmp'))).toBe(false);
    expect(existsSync(join(unifiedRoot, 'needs', 'state.json.123.tmp'))).toBe(false);

    // 校验旧版 ../asi-* 目录在磁盘上 100% 原样保留供安全回退
    expect(await readFile(join(dataDir, 'asi-sleep', 'vault', 'memories.jsonl'), 'utf8')).toBe(rawJsonl);
    expect(existsSync(join(dataDir, 'asi-growth', 'skills', 'active', 'pnpm-workspace-guard', 'SKILL.md'))).toBe(true);

    // 二次调用幂等快速返回 already-migrated
    const second = await migrateLegacyAsiData(unifiedRoot);
    expect(second.status).toBe('already-migrated');
  });

  it('当目标子目录已有实时数据时绝不覆盖或混入旧快照（target-exists），且拒绝非绝对路径与符号链接根目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asi-legacy-guard-'));
    tempDirs.push(root);
    const dataDir = join(root, 'data');

    await expect(migrateLegacyAsiData('relative/asi')).rejects.toThrow(TypeError);

    // 构造符号链接伪装的 ../asi-sense 目录
    const fakeTarget = join(root, 'fake-sense');
    await mkdir(fakeTarget, { recursive: true });
    await writeFile(join(fakeTarget, 'settings.json'), '{"version":1,"paused":true,"sendTitles":true}');
    await mkdir(dataDir, { recursive: true });
    await symlink(fakeTarget, join(dataDir, 'asi-sense'));

    // 目标 <unified>/sleep 已存在实时数据，旧目录 ../asi-sleep 有不同内容 -> 绝不能覆盖！
    await mkdir(join(dataDir, 'asi-sleep', 'vault'), { recursive: true });
    await writeFile(join(dataDir, 'asi-sleep', 'vault', 'memories.jsonl'), '{"id":"old"}\n');

    const unifiedRoot = join(dataDir, 'asi');
    await mkdir(join(unifiedRoot, 'sleep', 'vault'), { recursive: true });
    await writeFile(join(unifiedRoot, 'sleep', 'vault', 'memories.jsonl'), '{"id":"newer-live"}\n');

    const report = await migrateLegacyAsiData(unifiedRoot);
    expect(report.modules.sense).toBe('skipped-symlink');
    expect(report.modules.sleep).toBe('target-exists');
    expect(existsSync(join(unifiedRoot, 'sense', 'settings.json'))).toBe(false);
    expect(await readFile(join(unifiedRoot, 'sleep', 'vault', 'memories.jsonl'), 'utf8')).toBe('{"id":"newer-live"}\n');
  });

  it('容忍残损半行 JSONL、不可读锁文件与残留 .mig-*.tmp 暂存目录，并严格保留源文件 mtime 防止旧 MEMORY.md 倒灌覆盖新 memories.jsonl', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asi-legacy-resilience-'));
    tempDirs.push(root);
    const dataDir = join(root, 'data');
    const unifiedRoot = join(dataDir, 'asi');

    // 模拟上次迁移崩溃遗留的半截 .mig-sleep-*.tmp 暂存目录（未落入正式 sleep 目录）
    const crashedStage = join(unifiedRoot, '.mig-sleep-99999-deadbeef.tmp');
    await mkdir(crashedStage, { recursive: true });
    await writeFile(join(crashedStage, 'state.json'), '{"corrupt":true}');

    // 构造不可读权限文件（非 root 下触发 EACCES），不应中断后续 sleep 模块迁移
    await mkdir(join(dataDir, 'asi-needs'), { recursive: true });
    await writeFile(join(dataDir, 'asi-needs', 'state.json'), '{"maintTotalTurns":2}');
    const unreadableFile = join(dataDir, 'asi-needs', 'locked.bak');
    await writeFile(unreadableFile, 'locked');
    await chmod(unreadableFile, 0o000);

    // 构造旧版 asi-sleep：先用 MemoryVault 生成带合法 sync footer 的旧版 MEMORY.md（仅 1 条旧记忆，mtime 较早），
    // 再写入 mtime 更新的 memories.jsonl（含 2 条有效记忆 + 末尾半行残损 JSONL）
    const legacySleepDir = join(dataDir, 'asi-sleep');
    const seedVault = new MemoryVault(legacySleepDir);
    await seedVault.load(1_760_050_000_000);
    seedVault.upsert({
      id: 'mem_keep_1',
      kind: 'preference',
      title: '旧标题',
      content: '旧正文内容。',
      tags: ['legacy'],
      pinned: false,
      confidence: 0.8,
      sourceSessionIds: ['sess-1'],
      evidenceCount: 1,
      recallCount: 0,
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_050_000_000,
      fsrs: {
        stability: 10,
        difficulty: 3,
        elapsedDays: 0,
        scheduledDays: 10,
        learningSteps: 0,
        reps: 1,
        lapses: 0,
        state: 2,
        due: 1_780_000_000_000,
        lastReview: 1_760_050_000_000,
      },
    });
    await seedVault.flush(1_760_050_000_000);

    const newerEntry1 = JSON.stringify({
      id: 'mem_keep_1',
      kind: 'preference',
      title: '外部更新后的新标题',
      content: '保留更新后的 memories.jsonl 条目 #1。',
      tags: ['fresh'],
      pinned: true,
      confidence: 0.95,
      sourceSessionIds: ['sess-1'],
      evidenceCount: 1,
      recallCount: 0,
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_500_000_000,
      fsrs: {
        stability: 15,
        difficulty: 3,
        elapsedDays: 0,
        scheduledDays: 15,
        learningSteps: 0,
        reps: 1,
        lapses: 0,
        state: 2,
        due: 1_780_000_000_000,
        lastReview: 1_760_500_000_000,
      },
    });
    const newerEntry2 = JSON.stringify({
      id: 'mem_keep_2',
      kind: 'pitfall',
      title: '第二条有效踩坑记忆',
      content: '即使文件末尾存在截断半行也必须无损加载。',
      tags: ['resilience'],
      pinned: false,
      confidence: 0.9,
      sourceSessionIds: ['sess-1'],
      evidenceCount: 2,
      recallCount: 1,
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_600_000_000,
      fsrs: {
        stability: 12,
        difficulty: 3.2,
        elapsedDays: 0,
        scheduledDays: 12,
        learningSteps: 0,
        reps: 1,
        lapses: 0,
        state: 2,
        due: 1_780_000_000_000,
        lastReview: 1_760_600_000_000,
      },
    });
    const truncatedJsonl = `${newerEntry1}\n${newerEntry2}\n{"id":"mem_truncated_half","kind":"pit`;

    const legacyMdPath = join(dataDir, 'asi-sleep', 'vault', 'MEMORY.md');
    const legacyJsonlPath = join(dataDir, 'asi-sleep', 'vault', 'memories.jsonl');
    await writeFile(legacyJsonlPath, truncatedJsonl);

    const oldTime = new Date(1_760_100_000_000);
    const newerTime = new Date(1_760_800_000_000);
    await utimes(legacyMdPath, oldTime, oldTime);
    await utimes(legacyJsonlPath, newerTime, newerTime);

    try {
      const report = await migrateLegacyAsiData(unifiedRoot);
      expect(report.status).toBe('migrated');
      expect(report.modules.needs).toBe('migrated');
      expect(report.modules.sleep).toBe('migrated');
      expect(existsSync(crashedStage)).toBe(false);
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        expect(report.skippedUnreadable).toBe(1);
      }

      const migMdStat = await stat(join(unifiedRoot, 'sleep', 'vault', 'MEMORY.md'));
      const migJsonlStat = await stat(join(unifiedRoot, 'sleep', 'vault', 'memories.jsonl'));
      expect(migJsonlStat.mtimeMs).toBeGreaterThan(migMdStat.mtimeMs);

      // 启动真实 MemoryVault，验证保留较新的 2 条有效 JSONL 记忆且忽略末尾半行残损记录
      const vault = new MemoryVault(join(unifiedRoot, 'sleep'));
      await vault.load(1_760_900_000_000);
      const loaded = vault.list(1_760_900_000_000);
      expect(loaded).toHaveLength(2);
      expect(loaded.find((m) => m.id === 'mem_keep_1')?.title).toBe('外部更新后的新标题');
      expect(loaded.find((m) => m.id === 'mem_keep_2')?.title).toBe('第二条有效踩坑记忆');
    } finally {
      await chmod(unreadableFile, 0o600).catch(() => undefined);
    }
  });
});
