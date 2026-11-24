import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyAsiData } from '../../src/migration/legacy-migration.ts';

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
});
