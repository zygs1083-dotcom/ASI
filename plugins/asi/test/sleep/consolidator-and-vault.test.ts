import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ConversationTurnInput,
  LLM_CONSOLIDATION_BATCH_SIZE,
  parseLlmCandidatesJson,
  runTwoPhaseSleepConsolidation,
} from '../../src/sleep/host/consolidator.js';
import { createInitialFsrsState, strengthenFsrsState } from '../../src/sleep/host/fsrs.js';
import { MemoryVault, maskHomePath, sanitizeSleepText } from '../../src/sleep/host/vault.js';

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

    // 回归：tags / topicKey / sleep-journal.jsonl 中手工混入的密钥与主目录在 load 时同样触发脱敏回写
    const secretC = ['ghp', 'C9d8E7f6G5h4I3j2K1l0M9n8O7p6'].join('_');
    const tamperedMeta = JSON.parse(scrubbedDisk.trim()) as Record<string, unknown>;
    tamperedMeta.tags = ['security', `tok-${secretC}`];
    tamperedMeta.topicKey = `${fakeHome}/secret-topic`;
    await writeFile(vaultReloaded.memoriesJsonlPath, `${JSON.stringify(tamperedMeta)}\n`, 'utf8');
    await writeFile(
      vaultReloaded.journalJsonlPath,
      `${JSON.stringify({
        id: 'sleep_1',
        at: T0,
        trigger: 'manual',
        turnsProcessed: 1,
        nremCandidates: 1,
        createdCount: 1,
        mergedCount: 0,
        conflictsResolved: 0,
        prunedCount: 0,
        linksUpdated: 0,
        durationMs: 10,
        summary: `日志误含 ${secretC} 与 ${fakeHome}/dir`,
      })}\n`,
      'utf8',
    );

    const vaultMetaReloaded = new MemoryVault(dir, fakeHome);
    const metaLoadRes = await vaultMetaReloaded.load(T0 + 2_000);
    expect(metaLoadRes.redactedOnLoad).toBe(true);
    const reScrubbedJsonl = await readFile(vaultMetaReloaded.memoriesJsonlPath, 'utf8');
    const reScrubbedJournal = await readFile(vaultMetaReloaded.journalJsonlPath, 'utf8');
    expect(reScrubbedJsonl).not.toContain(secretC);
    expect(reScrubbedJsonl).not.toContain(fakeHome);
    expect(reScrubbedJournal).not.toContain(secretC);
    expect(reScrubbedJournal).not.toContain(fakeHome);
  });

  it('回归防护：置顶记忆在冲突或强化时绝不被覆盖标题/内容；主目录边界与零宽绕过防护；短句提炼与多会话精确归属', async () => {
    const fakeHome = '/Users/alice';
    // 1. maskHomePath 路径边界与零宽字符绕过防护
    expect(maskHomePath('/Users/alice2/project', fakeHome)).toBe('/Users/alice2/project');
    expect(sanitizeSleepText('/Users/\u200balice/project', 200, fakeHome)).toBe('~/project');

    // 2. 置顶偏好遇相反立场对话（以及并存的未置顶旧冲突项）：置顶项标题/内容原样锁定，未置顶旧冲突项被清除
    const pinnedPref = {
      id: 'mem_pinned_pnpm',
      kind: 'preference' as const,
      title: '统一使用 pnpm',
      content: '严格使用 pnpm',
      tags: ['pnpm'],
      topicKey: 'preference:package-manager',
      pinned: true,
      confidence: 1,
      sourceSessionIds: ['manual'],
      evidenceCount: 1,
      recallCount: 0,
      createdAt: T0,
      updatedAt: T0,
      fsrs: createInitialFsrsState('preference', T0),
    };
    const staleUnpinnedPref = {
      id: 'mem_stale_npm',
      kind: 'preference' as const,
      title: '默认使用 npm',
      content: '早期使用 npm',
      tags: ['npm'],
      topicKey: 'preference:package-manager',
      pinned: false,
      confidence: 0.7,
      sourceSessionIds: ['sess-old'],
      evidenceCount: 1,
      recallCount: 0,
      createdAt: T0,
      updatedAt: T0,
      fsrs: createInitialFsrsState('preference', T0),
    };

    const resConflict = await runTwoPhaseSleepConsolidation({
      turns: [
        {
          turnId: 't-yarn',
          sessionId: 'sess-home',
          cwd: fakeHome, // cwd 恰等于主目录，绝不可把用户名 alice 提取进 tags！
          at: T0 + 5_000,
          userText: '请始终中文回复。改用 yarn 管理依赖，不再使用 pnpm 了，因为某个旧工程需要长描述文本测试！',
          assistantText: '收到，保持中文回复。',
        },
      ],
      existingMemories: [pinnedPref, staleUnpinnedPref],
      now: T0 + 10_000,
      trigger: 'manual',
      signal: new AbortController().signal,
      homeDir: fakeHome,
    });

    const afterPinned = resConflict.memories.find((m) => m.id === 'mem_pinned_pnpm');
    expect(afterPinned).toBeDefined();
    expect(afterPinned?.title).toBe('统一使用 pnpm');
    expect(afterPinned?.content).toBe('严格使用 pnpm');
    expect(resConflict.memories.some((m) => m.id === 'mem_stale_npm')).toBe(false);
    // 7 字中文短句「请始终中文回复」成功提炼，且所有 tags 中绝不含用户名 alice
    expect(resConflict.memories.some((m) => m.title.includes('请始终中文回复'))).toBe(true);
    for (const mem of resConflict.memories) {
      expect(mem.tags).not.toContain('alice');
    }

    // 3. 置顶记忆遇同立场但更长文本的强化时：evidenceCount 增加，但用户策展的标题与内容不被篡改
    const resReinforce = await runTwoPhaseSleepConsolidation({
      turns: [
        {
          turnId: 't-pnpm-long',
          sessionId: 'sess-reinforce',
          at: T0 + 20_000,
          userText: '以后都用 pnpm workspace 来管理整个单仓所有子包与锁文件，保持极其详细的长文本描述。',
          assistantText: '好的，统一使用 pnpm。',
        },
      ],
      existingMemories: [pinnedPref],
      now: T0 + 25_000,
      trigger: 'manual',
      signal: new AbortController().signal,
      homeDir: fakeHome,
    });
    const reinforcedPinned = resReinforce.memories.find((m) => m.id === 'mem_pinned_pnpm');
    expect(reinforcedPinned?.title).toBe('统一使用 pnpm');
    expect(reinforcedPinned?.content).toBe('严格使用 pnpm');
    expect(reinforcedPinned?.evidenceCount).toBeGreaterThan(1);

    // 4. 多会话 LLM 提取结果仅归属匹配的源会话，绝不污染同批次无关会话 ID
    const sourceTurns: ConversationTurnInput[] = [
      {
        turnId: 'ta',
        sessionId: 'sess-postgres',
        at: T0,
        userText: '数据库选型使用 PostgreSQL 连接池',
        assistantText: '已配置 PostgreSQL',
      },
      {
        turnId: 'tb',
        sessionId: 'sess-swift',
        at: T0 + 1_000,
        userText: '原生辅助进程使用 Swift 编译',
        assistantText: '已配置 Swift',
      },
    ];
    const llmParsed = parseLlmCandidatesJson(
      JSON.stringify([
        {
          kind: 'decision',
          title: '采用 PostgreSQL 数据库连接池',
          content: '后端持久化统一连接 PostgreSQL。',
          tags: ['postgresql'],
        },
      ]),
      ['sess-postgres', 'sess-swift'],
      fakeHome,
      sourceTurns,
    );
    expect(llmParsed[0]?.sourceSessionIds).toEqual(['sess-postgres']);
  });

  it('双向人类可编辑 MEMORY.md：启动 load() 与运行时读写/落盘前自动检测外部手工编辑，对账增删改、置顶/分类迁移、保留已有 FSRS 并强制脱敏', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-sleep-md-bi-'));
    tempDirs.push(dir);
    const fakeHome = '/Users/editoruser';
    const leakedSecret = ['sk', 'proj', 'ABCDEF1234567890abcdef123456'].join('-');

    const vault = new MemoryVault(dir, fakeHome);
    await vault.load(T0);

    const maturedFsrs = strengthenFsrsState(
      strengthenFsrsState(createInitialFsrsState('preference', T0), T0 + 3_600_000, 'recall'),
      T0 + 7_200_000,
      'recall',
    );

    vault.upsert({
      id: 'mem_keep_fsrs',
      kind: 'preference',
      title: '默认使用浅色模式',
      content: '编辑器平时使用浅色背景。',
      tags: ['ui', 'theme'],
      topicKey: 'pref:theme',
      pinned: false,
      confidence: 0.92,
      sourceSessionIds: ['sess-1'],
      evidenceCount: 3,
      recallCount: 2,
      createdAt: T0,
      updatedAt: T0 + 7_200_000,
      lastRecalledAt: T0 + 7_200_000,
      links: ['mem_to_delete'],
      fsrs: maturedFsrs,
    });
    vault.upsert({
      id: 'mem_to_delete',
      kind: 'episode',
      title: '临时待删里程碑',
      content: '将在 MEMORY.md 中被人类手工删除。',
      tags: ['temp'],
      pinned: false,
      confidence: 0.8,
      sourceSessionIds: ['sess-1'],
      evidenceCount: 1,
      recallCount: 0,
      createdAt: T0,
      updatedAt: T0,
      fsrs: createInitialFsrsState('episode', T0),
    });
    vault.upsert({
      id: 'mem_pinned_move',
      kind: 'preference',
      title: '旧置顶偏好将迁入决策',
      content: '原本置顶，手工拖入决策章节并取消置顶。',
      tags: ['arch'],
      pinned: true,
      confidence: 1,
      sourceSessionIds: ['manual'],
      evidenceCount: 1,
      recallCount: 1,
      createdAt: T0,
      updatedAt: T0,
      fsrs: maturedFsrs,
    });
    await vault.flush(T0 + 10_000);

    // 阶段 1：模拟进程离线期间人类直接手工编辑 vault/MEMORY.md：
    // - 修改 mem_keep_fsrs 标题、多行内容与标签，并移动到「已置顶记忆」；
    // - 删除 mem_to_delete（并验证 mem_keep_fsrs 指向它的悬空关联自动清理）；
    // - 将原置顶 mem_pinned_move 移入 `## 决策 (decision)` 取消置顶并变更为 decision；
    // - 手工新增一段无 ID 的 `###` 踩坑记忆（故意带入本机主目录与密钥，验证脱敏与新 ID + 初始 FSRS 分配）！
    const handEditedOfflineMd = [
      '# ASI 记忆库 (Memory Vault)',
      '',
      '## 已置顶记忆 (Pinned · 永不衰减)',
      '',
      '### [偏好] [UI] 默认使用深色高对比模式',
      '- ID: `mem_keep_fsrs` · FSRS 保留率: **99%** · 标签: `ui`, dark-mode',
      '- 内容: 编辑器统一改用深色高对比背景：',
      '- 夜间护眼',
      '- 路径配置位于 /Users/editoruser/.config/dsh',
      '',
      '## 决策 (decision)',
      '',
      '### [偏好] 旧置顶偏好将迁入决策',
      '- ID: `mem_pinned_move` · 保留率: **100% (已置顶)** · 回忆 1 次 · 标签: `arch`',
      '- 内容: 已由人类手工迁移至决策分类并取消置顶。',
      '',
      '## 踩坑 (pitfall)',
      '',
      '### 手工新增：严禁硬编码推理网关密钥',
      '- 标签: llm, security',
      `调试 /Users/editoruser/work 时切勿写入 ${leakedSecret}，应走本地网关。`,
      '',
    ].join('\n');
    await writeFile(vault.markdownPath, handEditedOfflineMd, 'utf8');

    const reloaded = new MemoryVault(dir, fakeHome);
    const loadResult = await reloaded.load(T0 + 20_000);
    expect(loadResult.redactedOnLoad).toBe(true);

    // 1a. 已删除条目彻底移除，且悬空链接已被清理
    expect(reloaded.get('mem_to_delete')).toBeUndefined();

    // 1b. 编辑过的已有 ID 完整保留原有 FSRS 状态、evidenceCount、recallCount、topicKey，同时标题/多行内容/标签/置顶已生效且脱敏
    const kept = reloaded.get('mem_keep_fsrs');
    expect(kept).toBeDefined();
    expect(kept?.pinned).toBe(true);
    expect(kept?.kind).toBe('preference');
    expect(kept?.title).toBe('[UI] 默认使用深色高对比模式');
    expect(kept?.content).toContain('- 夜间护眼');
    expect(kept?.content).toContain('~/.config/dsh');
    expect(kept?.content).not.toContain(fakeHome);
    expect(kept?.tags).toEqual(['ui', 'dark-mode']);
    expect(kept?.topicKey).toBe('pref:theme');
    expect(kept?.fsrs).toEqual(maturedFsrs);
    expect(kept?.evidenceCount).toBe(3);
    expect(kept?.recallCount).toBe(2);
    expect(kept?.links).toBeUndefined();

    // 1c. 从置顶区拖入 `## 决策 (decision)` 的条目成功取消置顶并变更为 decision，且保留 FSRS
    const moved = reloaded.get('mem_pinned_move');
    expect(moved?.pinned).toBe(false);
    expect(moved?.kind).toBe('decision');
    expect(moved?.fsrs).toEqual(maturedFsrs);

    // 1d. 手工新增无 ID 章节分配了 `mem_*` ID 与初始 FSRS，且密钥与主目录在内存与磁盘双文件中均已脱敏
    const allAfterLoad = reloaded.list(T0 + 20_000);
    expect(allAfterLoad).toHaveLength(3);
    const handAdded = allAfterLoad.find((m) => m.id !== 'mem_keep_fsrs' && m.id !== 'mem_pinned_move');
    expect(handAdded?.id).toMatch(/^mem_/);
    expect(handAdded?.kind).toBe('pitfall');
    expect(handAdded?.tags).toEqual(['llm', 'security']);
    expect(handAdded?.content).toContain('~/work');
    expect(handAdded?.content).toContain('[redacted]');
    expect(handAdded?.content).not.toContain(leakedSecret);
    expect(handAdded?.fsrs.reps).toBeGreaterThanOrEqual(1);

    const diskJsonlAfterLoad = await readFile(reloaded.memoriesJsonlPath, 'utf8');
    const diskMdAfterLoad = await readFile(reloaded.markdownPath, 'utf8');
    expect(diskJsonlAfterLoad).toContain(handAdded?.id ?? '');
    expect(diskJsonlAfterLoad).not.toContain('mem_to_delete');
    expect(diskJsonlAfterLoad).not.toContain(leakedSecret);
    expect(diskMdAfterLoad).toContain(`ID: \`${handAdded?.id}\``);
    expect(diskMdAfterLoad).not.toContain(leakedSecret);

    // 阶段 2：运行时在线期间（不重启 MemoryVault），人类再次在外部编辑器修改 MEMORY.md，
    // 紧接着直接触发读取与 flush/upsert，验证绝不覆盖丢失人类在线编辑！
    const liveEditedMd = diskMdAfterLoad
      .replace('已由人类手工迁移至决策分类并取消置顶。', '在线二次编辑后的最新架构决策内容。')
      .replace('_暂无未置顶条目_', '- 终端输出偏好: 始终输出简洁清晰的中文说明');
    await writeFile(reloaded.markdownPath, liveEditedMd, 'utf8');

    // 在线同步读取立即感知外部编辑，随后 upsert 新条目并 flush 不会冲掉外部修改
    expect(reloaded.get('mem_pinned_move', T0 + 30_000)?.content).toBe('在线二次编辑后的最新架构决策内容。');
    reloaded.upsert({
      id: 'mem_ui_added',
      kind: 'episode',
      title: '侧栏并发新增条目',
      content: '验证外部编辑 MEMORY.md 后再从 UI 新增条目双方共存。',
      tags: ['sync'],
      pinned: false,
      confidence: 1,
      sourceSessionIds: ['manual'],
      evidenceCount: 1,
      recallCount: 0,
      createdAt: T0 + 30_000,
      updatedAt: T0 + 30_000,
      fsrs: createInitialFsrsState('episode', T0 + 30_000),
    });
    await reloaded.flush(T0 + 30_000);

    const finalEntries = reloaded.list(T0 + 30_000);
    expect(finalEntries.some((m) => m.id === 'mem_ui_added')).toBe(true);
    expect(finalEntries.find((m) => m.id === 'mem_pinned_move')?.content).toBe('在线二次编辑后的最新架构决策内容。');
    expect(finalEntries.some((m) => m.content.includes('始终输出简洁清晰的中文说明'))).toBe(true);

    const finalJsonlLines = (await readFile(reloaded.memoriesJsonlPath, 'utf8')).trim().split('\n');
    expect(finalJsonlLines).toHaveLength(finalEntries.length);
  });

  it('超过 24 轮未整合对话时按批调用 llmExtract（零漏提早期轮次、按时间序消解跨批冲突、支持批间 AbortSignal 中断）', async () => {
    expect(LLM_CONSOLIDATION_BATCH_SIZE).toBe(24);
    const totalTurns = 55; // 24 + 24 + 7 = 3 个批次
    const turns: ConversationTurnInput[] = [];
    for (let i = 1; i <= totalTurns; i += 1) {
      turns.push({
        turnId: `turn-${i}`,
        sessionId: i <= 20 ? 'sess-early' : 'sess-late',
        seq: i,
        at: T0 + i * 1_000,
        userText:
          i === 3
            ? '早期隐藏口令线索：代号 ALPHA_EARLY_BATCH_FACT，采用旧版 npm 脚本。'
            : i === 52
              ? '晚期反转线索：代号 OMEGA_LATE_BATCH_FACT，决定改用 pnpm 替代 npm。'
              : `第 ${i} 轮常规问答`,
        assistantText: `第 ${i} 轮常规回复`,
      });
    }

    // 故意打乱输入顺序（把晚期轮次放前面、早期轮次放后面），验证引擎按真实时间序分批提取与冲突消解
    const shuffledTurns = [...turns.slice(30), ...turns.slice(0, 30)];
    const seenPrompts: string[] = [];

    const out = await runTwoPhaseSleepConsolidation({
      turns: shuffledTurns,
      existingMemories: [],
      now: T0 + 100_000,
      trigger: 'manual',
      signal: new AbortController().signal,
      llmExtract: async (prompt) => {
        seenPrompts.push(prompt);
        if (prompt.includes('ALPHA_EARLY_BATCH_FACT')) {
          return JSON.stringify([
            {
              kind: 'decision',
              title: '早期批次提炼记忆',
              content: '来自前 24 轮批次（含 ALPHA_EARLY_BATCH_FACT）的专属提取结果。',
              tags: ['early-batch'],
              topicKey: 'arch:early-fact',
            },
            {
              kind: 'preference',
              title: '旧包管理器 npm',
              content: '早期使用 npm。',
              tags: ['npm'],
              topicKey: 'pref:package-manager',
            },
          ]);
        }
        if (prompt.includes('OMEGA_LATE_BATCH_FACT')) {
          return JSON.stringify([
            {
              kind: 'preference',
              title: '改用 pnpm 替代 npm',
              content: '晚期批次决定统一改用 pnpm，不再使用 npm。',
              tags: ['pnpm'],
              topicKey: 'pref:package-manager',
              supersedes: true,
            },
          ]);
        }
        return '[]';
      },
    });

    // 55 轮拆分为 3 个批次（24 + 24 + 7），绝不丢弃前 31 轮！
    expect(seenPrompts).toHaveLength(3);
    expect(seenPrompts[0]).toContain('ALPHA_EARLY_BATCH_FACT');
    expect(seenPrompts[2]).toContain('OMEGA_LATE_BATCH_FACT');
    expect(out.record.turnsProcessed).toBe(55);
    expect(out.memories.some((m) => m.title === '早期批次提炼记忆')).toBe(true);
    // 跨批次立场反转：第 3 批 supersedes=true 的 pnpm 新偏好自动淘汰第 1 批的旧 npm 偏好
    const pkgPref = out.memories.find((m) => m.topicKey === 'pref:package-manager');
    expect(pkgPref?.title).toContain('pnpm');
    expect(out.record.conflictsResolved).toBeGreaterThanOrEqual(1);

    // 验证批间 AbortSignal 抢占：在第 1 批返回时触发 abort，第 2、3 批绝不继续请求且立即抛出 AbortError
    const abortCtrl = new AbortController();
    let abortedBatchCalls = 0;
    await expect(
      runTwoPhaseSleepConsolidation({
        turns,
        existingMemories: [],
        now: T0 + 110_000,
        trigger: 'auto',
        signal: abortCtrl.signal,
        llmExtract: async () => {
          abortedBatchCalls += 1;
          abortCtrl.abort();
          return '[]';
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortedBatchCalls).toBe(1);

    // 边界：LLM 响应前缀含 `[Turn 1]` 方括号说明且包裹在 ```json 代码块中时，仍能稳健解析 JSON 数组
    const fencedWithPrefix = `参考 [Turn 1] 与 [Turn 2] 的上下文，提炼结果如下：\n\`\`\`json\n[{"kind":"pitfall","title":"避免 indexOf 首括号误判","content":"前缀含方括号时仍应准确解析 JSON 数组"}]\n\`\`\``;
    const fencedParsed = parseLlmCandidatesJson(fencedWithPrefix, ['sess-early']);
    expect(fencedParsed).toHaveLength(1);
    expect(fencedParsed[0]?.title).toBe('避免 indexOf 首括号误判');

    // 边界：无代码块包裹但尾部附带含 `]` 的溯源说明（如 `Source: [Turn 1]`）时，平衡括号扫描器不会因 lastIndexOf(']') 丢弃整批 JSON
    const bareWithTrailingBracket = `[{"kind":"decision","title":"尾部括号耐受","content":"后缀含方括号说明仍可解析"}]\nSource: summarized from [Turn 1] and [Turn 2].`;
    const bareParsed = parseLlmCandidatesJson(bareWithTrailingBracket, ['sess-early']);
    expect(bareParsed).toHaveLength(1);
    expect(bareParsed[0]?.title).toBe('尾部括号耐受');

    // 回归防护：第 1 批 LLM 瞬时报错回退确定性提取（Turn 3 = npm），第 3 批 LLM 提取新立场（Turn 52 = pnpm），
    // 以及跨批非 supersedes 同主题工具切换（eslint -> biome），均严格按真实时间序保留晚期新立场！
    const mixedBatchTurns: ConversationTurnInput[] = [];
    for (let i = 1; i <= 52; i += 1) {
      mixedBatchTurns.push({
        turnId: `mturn-${i}`,
        sessionId: 'sess-chrono',
        seq: i,
        at: T0 + i * 1_000,
        userText:
          i === 3
            ? '早期习惯：偏好使用 npm 安装依赖。'
            : i === 52
              ? '脚手架升级完成，现在切到 pnpm 了。'
              : `第 ${i} 轮常规对话`,
        assistantText: `第 ${i} 轮回复`,
      });
    }
    let mixedCall = 0;
    const mixedOut = await runTwoPhaseSleepConsolidation({
      turns: mixedBatchTurns,
      existingMemories: [],
      now: T0 + 200_000,
      trigger: 'manual',
      signal: new AbortController().signal,
      llmExtract: async (prompt) => {
        mixedCall += 1;
        if (mixedCall === 1) {
          throw new Error('simulated transient gateway error on batch 1');
        }
        if (prompt.includes('切到 pnpm')) {
          return JSON.stringify([
            {
              kind: 'preference',
              title: '包管理器统一改用 pnpm',
              content: '晚期批次将包管理器从 npm 切到 pnpm。',
              tags: ['pnpm'],
              topicKey: 'preference:package-manager',
              supersedes: true,
            },
            {
              kind: 'decision',
              title: '代码检查统一使用 biome',
              content: '代码格式化与检查工具采用 biome。',
              tags: ['biome'],
              topicKey: 'decision:formatter-linter',
            },
          ]);
        }
        return JSON.stringify([
          {
            kind: 'decision',
            title: '代码检查统一使用 eslint',
            content: '中期批次曾临时使用 eslint。',
            tags: ['eslint'],
            topicKey: 'decision:formatter-linter',
          },
        ]);
      },
    });
    expect(mixedOut.memories.find((m) => m.topicKey === 'preference:package-manager')?.title).toContain('pnpm');
    expect(mixedOut.memories.find((m) => m.topicKey === 'decision:formatter-linter')?.title).toContain('biome');
  });

  it('MEMORY.md 边界：支持代码块内 `#` 注释与后置 `- 标签:` 元数据，且清空全部条目时准确同步清空 memories.jsonl', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-sleep-md-edge-'));
    tempDirs.push(dir);
    const vault = new MemoryVault(dir, '/Users/tester');
    await vault.load(T0);

    const codeFenceMd = [
      '# ASI 记忆库 (Memory Vault)',
      '',
      '## 踩坑 (pitfall)',
      '',
      '### 构建前清理旧产物脚本',
      '- 内容: 执行干净检出模拟时按以下步骤运行：',
      '```sh',
      '# 注意：代码块内的井号注释绝不能被误判为 H1 标题截断！',
      '## 二级井号同样保留',
      'rm -rf plugins/asi-sleep/lib',
      '```',
      '- 标签: build, clean-checkout',
      '',
    ].join('\n');
    await writeFile(vault.markdownPath, codeFenceMd, 'utf8');
    await vault.syncExternalChanges(T0 + 1_000);

    const items = vault.list(T0 + 1_000);
    expect(items).toHaveLength(1);
    expect(items[0]?.tags).toEqual(['build', 'clean-checkout']);
    expect(items[0]?.content).toContain('# 注意:代码块内的井号注释绝不能被误判为 H1 标题截断!');
    expect(items[0]?.content).toContain('rm -rf plugins/asi-sleep/lib');

    // 当人类清空 MEMORY.md 中全部条目（仅保留标题与空章节，含 Prettier `*暂无未置顶条目*` 变体）时，memories.jsonl 同步清空为 0 条
    await writeFile(
      vault.markdownPath,
      '# ASI 记忆库 (Memory Vault)\n\n## 踩坑 (pitfall)\n\n*暂无未置顶条目*\n',
      'utf8',
    );
    await vault.syncExternalChanges(T0 + 2_000);
    expect(vault.list(T0 + 2_000)).toHaveLength(0);
    expect(await readFile(vault.memoriesJsonlPath, 'utf8')).toBe('');
  });

  it('MEMORY.md 进阶回归：首行内联代码块不吞噬后序章节、保留 `[1]`/`[分类]` 标题前缀、消歧复制粘贴重复 ID，并支持与后台整合的三路快照合并', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-sleep-md-3way-'));
    tempDirs.push(dir);
    const vault = new MemoryVault(dir, '/Users/tester');
    await vault.load(T0);

    const maturedFsrs = strengthenFsrsState(
      strengthenFsrsState(createInitialFsrsState('preference', T0), T0 + 3_600_000, 'recall'),
      T0 + 7_200_000,
      'recall',
    );

    // 1. 首行即 ` ```sh ` 的代码块、带 `[1]` 的非置顶标题、带 `[决策]` 字面标题的进展记忆、带 `[偏好]` 字面标题的置顶记忆
    vault.upsert({
      id: 'mem_code_first',
      kind: 'pitfall',
      title: '首行代码块回归',
      content: '```sh\n# 注释行\necho clean\n```',
      tags: ['shell'],
      pinned: false,
      confidence: 0.9,
      sourceSessionIds: ['s1'],
      evidenceCount: 1,
      recallCount: 0,
      createdAt: T0,
      updatedAt: T0,
      fsrs: createInitialFsrsState('pitfall', T0),
    });
    vault.upsert({
      id: 'mem_bracket_num',
      kind: 'preference',
      title: '[1] 阶段一命名规范',
      content: '保持既有导出签名稳定。',
      tags: ['naming'],
      pinned: false,
      confidence: 0.9,
      sourceSessionIds: ['s1'],
      evidenceCount: 1,
      recallCount: 0,
      createdAt: T0,
      updatedAt: T0,
      fsrs: createInitialFsrsState('preference', T0),
    });
    vault.upsert({
      id: 'mem_episode_bracket',
      kind: 'episode',
      title: '[决策] 周五架构评审纪要',
      content: '完成三插件联调评审，属于近期进展条目。',
      tags: ['review'],
      pinned: false,
      confidence: 0.85,
      sourceSessionIds: ['s1'],
      evidenceCount: 1,
      recallCount: 0,
      createdAt: T0,
      updatedAt: T0,
      fsrs: createInitialFsrsState('episode', T0),
    });
    vault.upsert({
      id: 'mem_dup_origin',
      kind: 'preference',
      title: '[偏好] 保持单引号风格',
      content: 'Biome quoteStyle 固定为 single。',
      tags: ['biome'],
      pinned: true,
      confidence: 1,
      sourceSessionIds: ['manual'],
      evidenceCount: 2,
      recallCount: 4,
      createdAt: T0,
      updatedAt: T0,
      fsrs: maturedFsrs,
    });
    await vault.flush(T0 + 5_000);

    // 模拟用户在原置顶块上方复制粘贴了一段带相同 `mem_dup_origin` ID 的新块并修改标题/内容，
    // 且将 `mem_code_first` 编辑为 `- 内容: ```sh` 首行直接开启多行代码块（验证闭合围栏绝不反向吞噬后续章节！）
    const diskMd0 = await readFile(vault.markdownPath, 'utf8');
    const pastedDupMd = diskMd0
      .replace(
        '- 内容: ```sh # 注释行 echo clean ```',
        ['- 内容: ```sh', '  # 注释行', '  echo clean', '  ```'].join('\n'),
      )
      .replace(
        '### [偏好] [偏好] 保持单引号风格',
        [
          '### [偏好] 复制粘贴新增的行宽约定',
          '- ID: `mem_dup_origin` · 保留率: **100% (已置顶)** · 标签: `biome`',
          '- 内容: Biome lineWidth 固定为 120。',
          '',
          '### [偏好] [偏好] 保持单引号风格',
        ].join('\n'),
      );
    await writeFile(vault.markdownPath, pastedDupMd, 'utf8');
    await vault.syncExternalChanges(T0 + 6_000);

    // 首行代码块绝不吞噬后续章节；`[1]` 与 `[决策]` 字面标题及分类无损保留；重复 ID 原块保住原 ID 与 FSRS，粘贴块获新 ID
    expect(vault.get('mem_code_first')?.content).toBe('```sh # 注释行 echo clean ```');
    expect(vault.get('mem_bracket_num')?.pinned).toBe(false);
    expect(vault.get('mem_bracket_num')?.title).toBe('[1] 阶段一命名规范');
    expect(vault.get('mem_episode_bracket')?.kind).toBe('episode');
    expect(vault.get('mem_episode_bracket')?.title).toBe('[决策] 周五架构评审纪要');
    const keptOrigin = vault.get('mem_dup_origin');
    expect(keptOrigin?.title).toBe('[偏好] 保持单引号风格');
    expect(keptOrigin?.recallCount).toBe(4);
    expect(keptOrigin?.fsrs).toEqual(maturedFsrs);
    const pastedClone = vault.list(T0 + 6_000).find((m) => m.title === '复制粘贴新增的行宽约定');
    expect(pastedClone).toBeDefined();
    expect(pastedClone?.id).not.toBe('mem_dup_origin');
    expect(pastedClone?.recallCount).toBe(0);

    // 2. 三路快照合并：人类在外部编辑器打开旧版 H0 快照期间，后台完成了新记忆合并与旧记忆修剪并落盘 H1，
    //    随后人类保存基于 H0 修改的 MEMORY.md（将 mem_bracket_num 置顶 + 新增手写条目），验证后台新增记忆不丢失且已修剪项不复活！
    const editorSnapshotH0 = await readFile(vault.markdownPath, 'utf8');

    // 模拟后台睡眠整合：删除 mem_episode_bracket（模拟遗忘修剪）、强化 mem_bracket_num 并新增 mem_bg_sleep
    const strengthenedNumFsrs = strengthenFsrsState(
      vault.get('mem_bracket_num')?.fsrs ?? createInitialFsrsState('preference', T0),
      T0 + 10_000,
      'consolidate',
    );
    const nextAfterSleep = vault
      .list(T0 + 10_000)
      .filter((m) => m.id !== 'mem_episode_bracket')
      .map((m) => (m.id === 'mem_bracket_num' ? { ...m, evidenceCount: 3, fsrs: strengthenedNumFsrs } : m));
    nextAfterSleep.push({
      id: 'mem_bg_sleep',
      kind: 'decision',
      title: '后台睡眠期间新增的架构决策',
      content: '在外部编辑器持旧快照期间由后台整合生成，绝不可被旧快照保存误删。',
      tags: ['sleep-concurrent'],
      pinned: false,
      confidence: 0.92,
      sourceSessionIds: ['s2'],
      evidenceCount: 1,
      recallCount: 0,
      createdAt: T0 + 10_000,
      updatedAt: T0 + 10_000,
      fsrs: createInitialFsrsState('decision', T0 + 10_000),
    });
    vault.replaceAll(nextAfterSleep);
    await vault.flush(T0 + 10_000);

    // 人类基于旧 editorSnapshotH0 将 mem_bracket_num 标记置顶并新增一条手写笔记后保存覆盖 MEMORY.md
    const humanSavedFromH0 = editorSnapshotH0
      .replace('### [1] 阶段一命名规范', '### [置顶] [1] 阶段一命名规范')
      .replace('## 决策 (decision)', '## 决策 (decision)\n\n### 人类并发手写决策\n- 内容: 外部编辑器并发新增。\n');
    await writeFile(vault.markdownPath, humanSavedFromH0, 'utf8');
    await vault.syncExternalChanges(T0 + 15_000);

    expect(vault.get('mem_bg_sleep')?.title).toBe('后台睡眠期间新增的架构决策');
    expect(vault.get('mem_episode_bracket')).toBeUndefined();
    expect(vault.get('mem_bracket_num')?.pinned).toBe(true);
    expect(vault.get('mem_bracket_num')?.evidenceCount).toBe(3);
    expect(vault.get('mem_bracket_num')?.fsrs).toEqual(strengthenedNumFsrs);
    expect(vault.list(T0 + 15_000).some((m) => m.title === '人类并发手写决策')).toBe(true);
  });
});
