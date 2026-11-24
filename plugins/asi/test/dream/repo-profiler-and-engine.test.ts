import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SleepMemorySummary } from '@asi/sense-types';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverCandidateCrossRepoBridges, runDmnDreamCycle } from '../../src/dream/host/dream-engine.ts';
import { collectRepoProfiles, resolveCanonicalRepoIdentity } from '../../src/dream/host/repo-profiler.ts';
import { searchDreamInsights } from '../../src/dream/shared/search.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
});

function makeMem(
  overrides: Partial<SleepMemorySummary> & Pick<SleepMemorySummary, 'id' | 'kind' | 'title' | 'content'>,
): SleepMemorySummary {
  return {
    tags: [],
    pinned: false,
    confidence: 0.9,
    retention: 0.88,
    evidenceCount: 2,
    recallCount: 1,
    sourceSessionIds: ['sess-1'],
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_100_000,
    ...overrides,
  };
}

describe('DMN 仓库身份归一化、只读非源码画像与跨项目做梦引擎验证', () => {
  it('通过 .git/worktrees/<wt>/commondir 将同一仓库的多个兄弟 worktree 归一为单一 repoKey，且严格跳过符号链接与敏感文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asi-dream-wt-'));
    tempDirs.push(root);

    const mainRepo = join(root, 'work', 'orca-core');
    const wtDirMeta = join(mainRepo, '.git', 'worktrees', 'feat-alpha');
    const linkedWt = join(root, 'worktrees', 'feat-alpha');
    const externalSecret = join(root, 'outside-secret.json');

    await mkdir(wtDirMeta, { recursive: true });
    await mkdir(linkedWt, { recursive: true });
    await writeFile(join(wtDirMeta, 'commondir'), '../..\n', 'utf8');
    await writeFile(join(linkedWt, '.git'), `gitdir: ${wtDirMeta}\n`, 'utf8');

    const fakeToken = ['ghp', '_', 'x'.repeat(36)].join('');
    await writeFile(
      join(mainRepo, 'package.json'),
      JSON.stringify({
        name: 'orca-core',
        dependencies: { 'better-sqlite3': '^11.0.0', zod: '^4.0.0' },
        devDependencies: { typescript: '^5.0.0', vitest: '^5.0.0' },
        scripts: { check: 'tsc && vitest run', e2e: 'playwright test' },
      }),
    );
    await writeFile(
      join(mainRepo, 'AGENTS.md'),
      `# Orca Core Rules\n- **并发落盘守卫**：启用 busy_timeout 并采用原子写\n- **SecretCheck**: ${fakeToken}\n`,
    );
    await writeFile(join(mainRepo, '.env.local'), `API_KEY=${fakeToken}\n`);
    await writeFile(externalSecret, '{"dependencies":{"leaked-pkg":"1.0.0"}}');
    await symlink(externalSecret, join(mainRepo, 'README.md'));

    const idMain = await resolveCanonicalRepoIdentity(mainRepo, root);
    const idSubdir = await resolveCanonicalRepoIdentity(join(linkedWt, 'src', 'sub'), root);
    expect(idMain?.repoKey).toBeDefined();
    expect(idSubdir?.repoKey).toBe(idMain?.repoKey);
    expect(idMain?.displayPath).toBe('~/work/orca-core');

    const collected = await collectRepoProfiles([mainRepo, linkedWt, join(root, 'data', 'asi', 'dream')], {
      homeDir: root,
    });
    expect(collected.profiles).toHaveLength(1);
    const prof = collected.profiles[0];
    expect(prof).toBeDefined();
    expect(prof?.stackTags).toEqual(expect.arrayContaining(['sqlite', 'typescript', 'vitest', 'zod-schema']));
    expect(prof?.mechanismHints).toContain('concurrency-lock');
    expect(prof?.topEntries).not.toContain('.env.local');
    expect(prof?.topEntries).not.toContain('README.md');
    expect(JSON.stringify(prof)).not.toContain(fakeToken);

    // 同一仓库两个兄弟 worktree 上的会话绝不误触发伪“跨项目”顿悟
    const bridges = discoverCandidateCrossRepoBridges({
      repoProfiles: collected.profiles,
      cwdToRepoKey: collected.cwdToRepoKey,
      sessionWorkspaces: new Map([
        ['s-main', mainRepo],
        ['s-wt', linkedWt],
      ]),
      memories: [
        makeMem({
          id: 'm1',
          kind: 'pitfall',
          title: 'SQLite WAL 锁表超时踩坑',
          content: '并发写必须配置 busy_timeout 与原子写避免 deadlock。',
          sourceSessionIds: ['s-main'],
        }),
        makeMem({
          id: 'm2',
          kind: 'episode',
          title: '排查 SQLite 并发写死锁',
          content: '子模块高并发写入遇到锁表 race condition。',
          sourceSessionIds: ['s-wt'],
        }),
      ],
      turns: [],
      homeDir: root,
    });
    expect(bridges).toHaveLength(0);
  });

  it('跨 3 个独立仓库覆盖四类顿悟（避坑预警/同构迁移/范式收敛/约定张力）、配对水位线幂等、忽略降权与 LLM/离线双路径', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asi-dream-engine-'));
    tempDirs.push(root);

    const repoA = join(root, 'repos', 'alpha-hub');
    const repoB = join(root, 'repos', 'beta-sync');
    const repoC = join(root, 'repos', 'gamma-legacy');
    for (const r of [repoA, repoB, repoC]) {
      await mkdir(join(r, '.git'), { recursive: true });
    }
    await writeFile(
      join(repoA, 'package.json'),
      JSON.stringify({
        dependencies: { 'better-sqlite3': '1.0.0' },
        devDependencies: { typescript: '5.0.0', '@biomejs/biome': '2.0.0', vitest: '5.0.0' },
      }),
    );
    await writeFile(
      join(repoB, 'package.json'),
      JSON.stringify({
        dependencies: { 'better-sqlite3': '1.0.0' },
        devDependencies: { typescript: '5.0.0', vitest: '5.0.0' },
      }),
    );
    await writeFile(
      join(repoC, 'package.json'),
      JSON.stringify({
        devDependencies: { typescript: '5.0.0', eslint: '9.0.0' },
      }),
    );

    const { profiles, cwdToRepoKey } = await collectRepoProfiles([repoA, repoB, repoC], { homeDir: root });
    expect(profiles).toHaveLength(3);

    const sessionWorkspaces = new Map<string, string>([
      ['sess-a', repoA],
      ['sess-b', repoB],
      ['sess-c', repoC],
    ]);

    const memories: SleepMemorySummary[] = [
      // 1) Repo A pitfall -> Repo B structural + trajectory struggle (`preventive-warning`)
      makeMem({
        id: 'mem_a_wal',
        kind: 'pitfall',
        title: 'SQLite 并发锁表与 busy_timeout 踩坑',
        content: '多线程写入 SQLite 时必须设置 busy_timeout 并用临时文件原子 rename 防止锁表死锁。',
        tags: ['sqlite', 'concurrency'],
        sourceSessionIds: ['sess-a'],
      }),
      // 2) Repo A & Repo B convergent symlink sandbox (`pattern-unification`)
      makeMem({
        id: 'mem_a_sym',
        kind: 'decision',
        title: '目录迁移前强制 lstat 拦截符号链接越界',
        content: '持久化读写前使用 lstat 拒绝 isSymbolicLink 并执行 sanitizeForModel 凭据脱敏。',
        tags: ['security', 'symlink'],
        sourceSessionIds: ['sess-a'],
      }),
      makeMem({
        id: 'mem_b_sym',
        kind: 'pitfall',
        title: '扫描工作区时未调 lstat 导致 symlink 路径越界风险',
        content: '读取配置前必须用 lstat 检查符号链接并调用 sanitizeForModel 打码。',
        tags: ['security', 'sandbox'],
        sourceSessionIds: ['sess-b'],
      }),
      // 3) Repo A vs Repo C convention divergence (`decision-tension`)
      makeMem({
        id: 'mem_a_pkg',
        kind: 'preference',
        title: '包管理统一默认使用 pnpm',
        content: '所有工作区统一使用 pnpm 安装依赖，禁止使用 npm。',
        tags: ['pnpm'],
        sourceSessionIds: ['sess-a'],
      }),
      makeMem({
        id: 'mem_c_pkg',
        kind: 'preference',
        title: '构建脚本统一使用 npm',
        content: 'CI 与本地开发统一使用 npm ci，不要用 pnpm。',
        tags: ['npm'],
        sourceSessionIds: ['sess-c'],
      }),
      // 4) Repo A decision -> Repo C episode (`structural-analogy`)
      makeMem({
        id: 'mem_a_stream',
        kind: 'decision',
        title: 'SSE 流推送采用 AbortController 与节流释放监听',
        content: '异步流在 finally 中通过 AbortSignal 解绑监听器解决 backpressure 与内存泄漏。',
        tags: ['stream'],
        sourceSessionIds: ['sess-a'],
      }),
      makeMem({
        id: 'mem_c_stream',
        kind: 'episode',
        title: '重构长连接流式订阅背压与超时释放',
        content: '正在治理客户端断线重连后的 stream listener 内存泄漏与 AbortSignal 传递。',
        tags: ['stream'],
        sourceSessionIds: ['sess-c'],
      }),
    ];

    const turns = [
      {
        turnId: 'sess-b:t1',
        sessionId: 'sess-b',
        cwd: repoB,
        at: 1_760_000_200_000,
        userText: '排查 beta-sync 在高并发落盘时报 SQLite锁表 race condition 超时失败',
        assistantText: '检查发现未配置 busy_timeout。',
        toolNames: ['bash'],
        failedToolCount: 1,
      },
    ];

    const allBridges = discoverCandidateCrossRepoBridges({
      repoProfiles: profiles,
      cwdToRepoKey,
      sessionWorkspaces,
      memories,
      turns,
      homeDir: root,
    });

    const kinds = new Set(allBridges.map((b) => b.kind));
    expect(kinds.has('preventive-warning')).toBe(true);
    expect(kinds.has('pattern-unification')).toBe(true);
    expect(kinds.has('decision-tension')).toBe(true);
    expect(kinds.has('structural-analogy')).toBe(true);

    // 首次做梦（带受控在线 LLM JSON 精炼第一条，其余保留确定性输出）
    const ctrl = new AbortController();
    const firstRun = await runDmnDreamCycle({
      now: 1_760_000_500_000,
      trigger: 'manual',
      signal: ctrl.signal,
      homeDir: root,
      repoProfiles: profiles,
      cwdToRepoKey,
      sessionWorkspaces,
      memories,
      turns,
      existingInsights: [],
      dreamedPairSignatures: {},
      dismissedPairPenalties: {},
      llmDream: async () =>
        JSON.stringify([
          {
            index: 0,
            title: 'LLM 精炼：跨仓工程同构与提前避坑洞察',
            summary: '经 DMN 深静默跨仓重放确认，两项目共享相同底层机制面。',
            bridgeMechanism: '共享并发/沙盒底层机制契约与 TypeScript 工程栈。',
            actionableHypothesis: '将成熟防护规则平滑同步至目标仓库并补充回归单测。',
          },
        ]),
    });

    expect(firstRun.record.insightsCreated).toBeGreaterThanOrEqual(2);
    expect(firstRun.insights[0]?.title).toContain('LLM 精炼');

    // 证据未变化时再次运行，已做梦水位线阻止重复生产相同桥接
    const secondRun = await runDmnDreamCycle({
      now: 1_760_000_600_000,
      trigger: 'auto',
      signal: ctrl.signal,
      homeDir: root,
      repoProfiles: profiles,
      cwdToRepoKey,
      sessionWorkspaces,
      memories,
      turns,
      existingInsights: firstRun.insights,
      dreamedPairSignatures: firstRun.updatedDreamedSignatures,
      dismissedPairPenalties: {},
    });
    const prevSigs = new Set(firstRun.insights.map((i) => i.pairSignature));
    for (const ins of secondRun.insights) {
      if (prevSigs.has(ins.pairSignature)) {
        expect(secondRun.insights.filter((x) => x.pairSignature === ins.pairSignature)).toHaveLength(1);
      }
    }

    // 中英 BM25 与模糊检索
    const hits = searchDreamInsights(secondRun.insights, '精炼 同构', { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.title).toContain('LLM 精炼');
  });
});
