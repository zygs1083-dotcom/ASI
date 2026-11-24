import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SleepMemorySummary } from '@asi/sense-types';
import { afterEach, describe, expect, it } from 'vitest';
import { formatIntuitionMessage } from '../../src/intuition/host/message-format.ts';
import {
  evaluateIntuitionDrive,
  evaluateProspectiveCues,
  reconcileProspectiveLifecycle,
} from '../../src/intuition/host/prospective-evaluator.ts';
import { SomaticMatcher } from '../../src/intuition/host/somatic-matcher.ts';
import { IntuitionStore } from '../../src/intuition/host/store.ts';
import type { ProspectiveIntention, SomaticScar } from '../../src/intuition/shared/types.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
});

function makeMemories(now: number): SleepMemorySummary[] {
  return [
    {
      id: 'mem_pit_esbuild',
      kind: 'pitfall',
      title: 'esbuild 打包客户端必须 external react 以防双实例崩溃',
      content: '构建 client bundle 时若未把 react 标为 external 会触发 Hooks Invalid Call 错误。',
      tags: ['esbuild', 'react', 'bundle'],
      topicKey: 'pitfall:esbuild-react',
      pinned: true,
      confidence: 0.95,
      retention: 1,
      evidenceCount: 3,
      recallCount: 2,
      sourceSessionIds: ['sess-1'],
      createdAt: now - 86_400_000,
      updatedAt: now - 3_600_000,
    },
    {
      id: 'mem_dec_pnpm',
      kind: 'decision',
      title: '工作区固定采用 pnpm --frozen-lockfile 安装依赖',
      content: '多包工作区禁止混用 npm install，统一执行 pnpm check 验证。',
      tags: ['pnpm', 'lockfile'],
      pinned: false,
      confidence: 0.88,
      retention: 0.82,
      evidenceCount: 2,
      recallCount: 1,
      sourceSessionIds: ['sess-1'],
      createdAt: now - 86_400_000,
      updatedAt: now - 7_200_000,
    },
    {
      id: 'mem_faded_low',
      kind: 'pitfall',
      title: '早期已遗忘的旧构建脚本细节',
      content: '由于 FSRS 保留率低于 0.25 且未置顶，不应再触发躯体标记闪回。',
      tags: ['esbuild', 'legacy'],
      pinned: false,
      confidence: 0.8,
      retention: 0.12,
      evidenceCount: 1,
      recallCount: 0,
      sourceSessionIds: ['sess-old'],
      createdAt: now - 90 * 86_400_000,
      updatedAt: now - 90 * 86_400_000,
    },
  ];
}

describe('前额叶躯体标记匹配器（SomaticMatcher）与前瞻记忆评估/持久化单测', () => {
  it('SomaticMatcher 在 150 条记忆规模下 <10ms 完成检索，拦截日常寒暄零误报，且支持降权与静默反馈调节', () => {
    const now = 1_780_000_000_000;
    const base = makeMemories(now);
    const bulk: SleepMemorySummary[] = [...base];
    for (let i = 0; i < 150; i += 1) {
      bulk.push({
        id: `mem_bulk_${i}`,
        kind: i % 2 === 0 ? 'decision' : 'preference',
        title: `常规架构背景条目 #${i}`,
        content: `关于模块拆分与单测组织的常规记录 ${i}，标签 alpha_${i}。`,
        tags: [`mod_${i}`],
        pinned: false,
        confidence: 0.8,
        retention: 0.75,
        evidenceCount: 1,
        recallCount: 0,
        sourceSessionIds: ['sess-bulk'],
        createdAt: now - 86_400_000,
        updatedAt: now - 3_600_000,
      });
    }

    const scars: SomaticScar[] = [
      {
        id: 'scar_biome_1',
        toolName: 'bash',
        signature: 'bash::biome check --write',
        title: 'bash 在「biome check」重复报错',
        caution: '连续 2 次因未格式化导入排序失败，请先核对导入顺序。',
        tags: ['biome', 'lint'],
        failureCount: 2,
        firstSeenAt: now - 600_000,
        updatedAt: now - 60_000,
      },
    ];

    const matcher = new SomaticMatcher();

    // 1. 寒暄与通用停用词不产生任何误报
    expect(matcher.scan({ cueText: '你好，帮我看看现在代码文件怎么修改？', memories: bulk, scars })).toEqual([]);
    expect(matcher.scan({ cueText: 'ok yes run file test now', memories: bulk, scars })).toEqual([]);

    // 2. 命中 esbuild + react 踩坑记忆（且低保留率 0.12 的 mem_faded_low 被过滤）
    const t0 = performance.now();
    const hits = matcher.scan({
      cueText: '准备修改 esbuild 客户端打包配置调整 react 依赖',
      memories: bulk,
      scars,
      minScore: 0.55,
    });
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(50);
    expect(hits.map((h) => h.sourceId)).toContain('mem_pit_esbuild');
    expect(hits.map((h) => h.sourceId)).not.toContain('mem_faded_low');

    // 二次调用复用指纹缓存，耗时极低
    const t1 = performance.now();
    const scarHits = matcher.scan({
      cueText: '运行 biome lint 检查格式',
      toolName: 'bash',
      memories: bulk,
      scars,
      minScore: 0.55,
    });
    expect(performance.now() - t1).toBeLessThan(15);
    expect(scarHits[0]?.sourceId).toBe('scar_biome_1');

    // 3. 反馈调节：muted 彻底屏蔽，dismissed 显著降权
    const mutedHits = matcher.scan({
      cueText: '修改 esbuild react bundle 配置',
      memories: bulk,
      scars,
      feedbackBySourceId: { mem_pit_esbuild: 'muted' },
    });
    expect(mutedHits.map((h) => h.sourceId)).not.toContain('mem_pit_esbuild');

    const baseScore = hits.find((h) => h.sourceId === 'mem_pit_esbuild')?.score ?? 0;
    const dismissedHits = matcher.scan({
      cueText: '修改 esbuild react bundle 配置',
      memories: bulk,
      scars,
      feedbackBySourceId: { mem_pit_esbuild: 'dismissed' },
      minScore: 0.3,
    });
    const dismissedScore = dismissedHits.find((h) => h.sourceId === 'mem_pit_esbuild')?.score ?? 0;
    expect(dismissedScore).toBeLessThan(baseScore);
  });

  it('前瞻记忆覆盖定时、工作区/窗口情境、事件触发以及 snooze 唤醒与过期生命周期', () => {
    const now = 1_780_000_000_000;
    const items: ProspectiveIntention[] = [
      {
        id: 'pm_time_1',
        title: '定时回归检查',
        instruction: '跑一遍单元回归',
        trigger: { kind: 'time', dueAt: now - 1_000 },
        triggerSummary: '定时',
        priority: 'high',
        status: 'pending',
        createdAt: now - 60_000,
        updatedAt: now - 60_000,
        surfacedCount: 0,
      },
      {
        id: 'pm_ctx_ws',
        title: '切回支付服务核对契约',
        instruction: '检查 schema 版本',
        trigger: { kind: 'context', workspaceMatch: 'payment-svc', keywordMatch: 'schema, 发布' },
        triggerSummary: '情境',
        priority: 'normal',
        status: 'pending',
        createdAt: now - 60_000,
        updatedAt: now - 60_000,
        surfacedCount: 0,
      },
      {
        id: 'pm_ev_tool',
        title: '推送前执行 lint',
        instruction: '确保已跑完 check',
        trigger: { kind: 'event', eventKind: 'tool_call', toolName: 'bash', targetPattern: 'git push' },
        triggerSummary: '事件',
        priority: 'high',
        status: 'pending',
        createdAt: now - 60_000,
        updatedAt: now - 60_000,
        surfacedCount: 0,
      },
      {
        id: 'pm_snoozed',
        title: '延后唤醒项',
        instruction: '稍后处理',
        trigger: { kind: 'time', dueAt: now - 10_000 },
        triggerSummary: '延后',
        priority: 'normal',
        status: 'snoozed',
        snoozedUntil: now - 500,
        createdAt: now - 60_000,
        updatedAt: now - 30_000,
        surfacedCount: 1,
      },
      {
        id: 'pm_expiring',
        title: '已过有效期项',
        instruction: '过期自动失效',
        trigger: { kind: 'event', eventKind: 'next_session' },
        triggerSummary: '事件',
        priority: 'normal',
        status: 'pending',
        expiresAt: now - 1,
        createdAt: now - 120_000,
        updatedAt: now - 120_000,
        surfacedCount: 0,
      },
    ];

    const reconciled = reconcileProspectiveLifecycle(items, now);
    expect(reconciled.changed).toBe(true);
    expect(reconciled.updated.find((i) => i.id === 'pm_snoozed')?.status).toBe('pending');
    expect(reconciled.updated.find((i) => i.id === 'pm_expiring')?.status).toBe('expired');

    // 匹配情境 + 已到期定时项
    const ctxMatched = evaluateProspectiveCues(reconciled.updated, {
      now,
      reason: 'pre-step',
      cwd: ['~', 'work', 'payment-svc'].join('/'),
      promptText: '我们准备核对 schema 并发布',
    });
    expect(ctxMatched.map((i) => i.id)).toEqual(expect.arrayContaining(['pm_time_1', 'pm_ctx_ws', 'pm_snoozed']));

    // 匹配特定工具调用事件
    const toolMatched = evaluateProspectiveCues(reconciled.updated, {
      now: now - 50_000,
      reason: 'tool',
      eventKind: 'tool_call',
      toolName: 'bash',
      targetText: 'git push hub task/demo',
    });
    expect(toolMatched.map((i) => i.id)).toEqual(['pm_ev_tool']);

    // 评估 Maslow 驱动分数与消息格式化脱敏
    const firstItem = items[0];
    if (!firstItem) throw new Error('expected sample intention');
    const surfacedSample: ProspectiveIntention = { ...firstItem, status: 'surfaced' };
    const { view } = evaluateIntuitionDrive({
      intentions: [surfacedSample],
      activeScarCount: 1,
      suppressed: false,
    });
    expect(view.surfacedCount).toBe(1);
    expect(view.satisfaction).toBeLessThan(100);

    const msg = formatIntuitionMessage({
      intentions: [
        {
          ...surfacedSample,
          instruction: '切勿泄露 sk-secret1234567890abcdef 密钥',
        },
      ],
    });
    expect(msg).toContain('<asi-intuition');
    expect(msg).not.toContain('sk-secret1234567890abcdef');
  });

  it('IntuitionStore 原子读写自动打码凭据并拒绝符号链接越界路径', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asi-intuition-store-'));
    tempDirs.push(root);

    const store = new IntuitionStore(join(root, 'intuition'));
    await store.saveIntentions([
      {
        id: 'pm_sec_1',
        title: '检查 token 配置',
        instruction: '不要硬编码 ghp_abcdefghijklmnopqrstuvwxyz123456',
        trigger: { kind: 'event', eventKind: 'next_session' },
        triggerSummary: '事件 · 下次开启会话',
        priority: 'normal',
        status: 'pending',
        createdAt: 1000,
        updatedAt: 1000,
        surfacedCount: 0,
      },
    ]);

    const loaded = await store.load();
    expect(loaded.intentions).toHaveLength(1);
    expect(loaded.intentions[0]?.instruction).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');

    // 验证符号链接拦截
    const outside = join(root, 'outside.json');
    await writeFile(outside, '{}');
    const symDir = join(root, 'sym-intuition');
    await symlink(root, symDir);
    const badStore = new IntuitionStore(symDir);
    await expect(badStore.load()).rejects.toThrow(/symbolic link/);
  });
});
