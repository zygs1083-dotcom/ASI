import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type ConversationTurnInput, runTwoPhaseSleepConsolidation } from '../src/host/consolidator.js';
import { createInitialFsrsState } from '../src/host/fsrs.js';
import { MemoryVault } from '../src/host/vault.js';

const T0 = 1_764_000_000_000;
const DAY = 86_400_000;
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('NREM + REM 双阶段睡眠记忆巩固与 Markdown/JSONL 脱敏存储库', () => {
  it('NREM 同批聚类去重 + REM 跨会话强化、立场冲突消解、关联链接构建与 FSRS 遗忘修剪（置顶免疫）', async () => {
    const fakeSecret = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4'].join('_');
    const fakeHome = '/Users/tester';

    // 第一轮睡眠：从对话提炼偏好（初版用 yarn）、决策、踩坑与近期进展，且自动脱敏密钥和主目录
    const batch1: ConversationTurnInput[] = [
      {
        turnId: 't1',
        sessionId: 'sess-1',
        cwd: `${fakeHome}/workspace/demo`,
        at: T0,
        userText: `我偏好统一使用 yarn 管理依赖，顺便这是临时令牌 ${fakeSecret} 不要泄露。`,
        assistantText: '明白，已记录统一使用 yarn 管理工作区依赖。',
      },
      {
        turnId: 't2',
        sessionId: 'sess-1',
        cwd: `${fakeHome}/workspace/demo`,
        at: T0 + 10_000,
        userText: '重复确认一下：以后默认用 yarn 安装包。',
        assistantText: '好的，继续保持使用 yarn。',
      },
      {
        turnId: 't3',
        sessionId: 'sess-1',
        cwd: `${fakeHome}/workspace/demo`,
        at: T0 + 20_000,
        userText: '架构决策：决定采用 esbuild 打包单文件插件产物，避免原生依赖。',
        assistantText: '敲定方案：使用 esbuild 生成零原生依赖 bundle。',
      },
      {
        turnId: 't4',
        sessionId: 'sess-2',
        cwd: `${fakeHome}/workspace/demo`,
        at: T0 + 30_000,
        userText: '刚才排查报错原因：踩坑发现浅色背景直接用亮绿色文字会导致 axe 对比度不达标。',
        assistantText: '修复方案是改用 color-mix 与主文本色混合保证 4.5:1 对比度。',
      },
    ];

    const cycle1 = await runTwoPhaseSleepConsolidation({
      turns: batch1,
      existingMemories: [],
      now: T0 + 60_000,
      trigger: 'auto',
      signal: new AbortController().signal,
      homeDir: fakeHome,
    });

    expect(cycle1.memories.length).toBeGreaterThanOrEqual(4);
    const kinds1 = new Set(cycle1.memories.map((m) => m.kind));
    expect(kinds1).toEqual(new Set(['preference', 'decision', 'pitfall', 'episode']));

    // 校验绝对不含密钥原文，已被 sanitizeForModel 打码为 [redacted]
    const serialized1 = JSON.stringify(cycle1.memories);
    expect(serialized1).not.toContain(fakeSecret);
    expect(serialized1).toContain('[redacted]');

    const yarnPref = cycle1.memories.find(
      (m) => m.kind === 'preference' && m.topicKey === 'preference:package-manager',
    );
    expect(yarnPref).toBeDefined();
    // t1 与 t2 在 NREM 同批聚类合并，evidenceCount >= 2
    expect(yarnPref?.evidenceCount).toBeGreaterThanOrEqual(2);

    // 准备一个已置顶的古老条目和一个未置顶的古老 episode 条目以验证 REM 遗忘修剪与置顶保护
    const ancientTime = T0 - 240 * DAY;
    const pinnedAncient = {
      id: 'mem_pinned_old',
      kind: 'episode' as const,
      title: '置顶里程碑：核心安全红线',
      content: '绝不读取本机密钥目录。',
      tags: ['security'],
      pinned: true,
      confidence: 1,
      sourceSessionIds: ['sess-0'],
      evidenceCount: 1,
      recallCount: 0,
      createdAt: ancientTime,
      updatedAt: ancientTime,
      fsrs: createInitialFsrsState('episode', ancientTime),
    };
    const unpinnedAncient = {
      id: 'mem_faded_old',
      kind: 'episode' as const,
      title: '半年前的一次性调试日志',
      content: '临时查看某行输出。',
      tags: ['debug'],
      pinned: false,
      confidence: 0.7,
      sourceSessionIds: ['sess-0'],
      evidenceCount: 1,
      recallCount: 0,
      createdAt: ancientTime,
      updatedAt: ancientTime,
      fsrs: createInitialFsrsState('episode', ancientTime),
    };

    // 第二轮睡眠：跨会话立场反转（不再使用 yarn，改用 pnpm！）+ 强化 esbuild 决策 + 修剪半年前未置顶 episode
    const batch2: ConversationTurnInput[] = [
      {
        turnId: 't5',
        sessionId: 'sess-3',
        at: T0 + 3_600_000,
        userText: '我们改用 pnpm 管理依赖，不再使用 yarn 了！以后统一使用 pnpm。',
        assistantText: '已更新偏好：弃用 yarn，全面改用 pnpm workspace。',
      },
      {
        turnId: 't6',
        sessionId: 'sess-3',
        at: T0 + 3_610_000,
        userText: '再次确认架构决策：采用 esbuild 打包独立单文件 bundle 产物。',
        assistantText: '是的，esbuild 单文件打包方案保持不变。',
      },
    ];

    const cycle2 = await runTwoPhaseSleepConsolidation({
      turns: batch2,
      existingMemories: [...cycle1.memories, pinnedAncient, unpinnedAncient],
      now: T0 + 3_660_000,
      trigger: 'auto',
      signal: new AbortController().signal,
      homeDir: fakeHome,
    });

    // 1. 立场冲突已消解：旧 yarn 偏好被新 pnpm 偏好取代！
    expect(cycle2.record.conflictsResolved).toBeGreaterThanOrEqual(1);
    const activePrefs = cycle2.memories.filter(
      (m) => m.kind === 'preference' && m.topicKey === 'preference:package-manager',
    );
    expect(activePrefs).toHaveLength(1);
    expect(activePrefs[0]?.content.toLowerCase()).toContain('pnpm');

    // 2. 跨会话重复的 esbuild 决策被合并强化（mergedCount >= 1），未产生重复条目
    expect(cycle2.record.mergedCount).toBeGreaterThanOrEqual(1);
    const bundlerDecisions = cycle2.memories.filter((m) => m.topicKey === 'decision:bundler');
    expect(bundlerDecisions).toHaveLength(1);

    // 3. 未置顶的古老 episode 被 FSRS 遗忘修剪，而置顶的古老 episode 完好保留！
    expect(cycle2.record.prunedCount).toBeGreaterThanOrEqual(1);
    expect(cycle2.memories.some((m) => m.id === 'mem_faded_old')).toBe(false);
    expect(cycle2.memories.some((m) => m.id === 'mem_pinned_old')).toBe(true);
  });

  it('落盘前与读取后双向强制执行 sanitizeForModel 脱敏，同步生成可读 MEMORY.md 与 memories.jsonl', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-sleep-vault-'));
    tempDirs.push(dir);
    const fakeHome = '/Users/devuser';
    const secretA = ['sk', 'proj', '9876543210abcdefABCDEF123456'].join('-');
    const secretB = ['glpat', '1234567890abcdefghij'].join('-');

    const vault = new MemoryVault(dir, fakeHome);
    await vault.load(T0);

    vault.upsert({
      id: 'mem_sec_1',
      kind: 'pitfall',
      title: `配置路径 ${fakeHome}/app 与密钥 ${secretA}`,
      content: `切勿硬编码 Authorization: Bearer ${secretA}`,
      tags: ['security'],
      pinned: true,
      confidence: 1,
      sourceSessionIds: ['s1'],
      evidenceCount: 1,
      recallCount: 0,
      createdAt: T0,
      updatedAt: T0,
      fsrs: createInitialFsrsState('pitfall', T0),
    });
    await vault.flush(T0);

    const rawMd = await readFile(vault.markdownPath, 'utf8');
    const rawJsonl = await readFile(vault.memoriesJsonlPath, 'utf8');
    expect(rawMd).toContain('# ASI 记忆库 (Memory Vault)');
    expect(rawMd).toContain('~/app');
    expect(rawMd).not.toContain(fakeHome);
    expect(rawMd).not.toContain(secretA);
    expect(rawJsonl).not.toContain(secretA);
    expect(rawJsonl).toContain('[redacted]');

    // 模拟用户在磁盘手工编辑 memories.jsonl 时误贴入明文凭据 secretB -> 重新 load 时立即拦截脱敏并回写干净文件！
    const tampered = JSON.parse(rawJsonl.trim()) as Record<string, unknown>;
    tampered.content = `手工误贴入 ${secretB} 令牌`;
    await writeFile(vault.memoriesJsonlPath, `${JSON.stringify(tampered)}\n`, 'utf8');

    const vaultReloaded = new MemoryVault(dir, fakeHome);
    const loadRes = await vaultReloaded.load(T0 + 1_000);
    expect(loadRes.redactedOnLoad).toBe(true);
    expect(vaultReloaded.get('mem_sec_1')?.content).not.toContain(secretB);
    expect(vaultReloaded.get('mem_sec_1')?.content).toContain('[redacted]');

    const scrubbedDisk = await readFile(vaultReloaded.memoriesJsonlPath, 'utf8');
    expect(scrubbedDisk).not.toContain(secretB);
  });
});
