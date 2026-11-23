import type { MemoryKind, MemoryViewItem, SleepPanelModel } from '../shared/types.js';

export const SLEEP_SCENARIOS = ['healthy-vault', 'sleepy-waiting', 'suppressed-l1', 'empty-vault'] as const;
export type SleepScenarioName = (typeof SLEEP_SCENARIOS)[number];

const BASE_NOW = 1_764_000_000_000;

function makeSampleMemories(now: number): MemoryViewItem[] {
  return [
    {
      id: 'mem_pref_pnpm',
      kind: 'preference',
      title: '统一使用 pnpm workspace 管理多包依赖',
      content: '项目固定采用 pnpm workspace 与锁文件校验，不使用 npm install 或 yarn。',
      tags: ['pnpm', 'workspace', 'typescript'],
      topicKey: 'preference:package-manager',
      pinned: true,
      confidence: 0.96,
      sourceSessionIds: ['sess-alpha'],
      evidenceCount: 4,
      recallCount: 5,
      createdAt: now - 7 * 86_400_000,
      updatedAt: now - 2 * 3_600_000,
      lastRecalledAt: now - 1_800_000,
      links: ['mem_dec_bundle'],
      retention: 1,
      fsrs: {
        stability: 24.5,
        difficulty: 3.2,
        elapsedDays: 2,
        scheduledDays: 25,
        learningSteps: 0,
        reps: 5,
        lapses: 0,
        state: 2,
        due: now + 22 * 86_400_000,
        lastReview: now - 1_800_000,
      },
    },
    {
      id: 'mem_dec_bundle',
      kind: 'decision',
      title: '插件构建为零原生依赖的独立 tgz 组合包',
      content: '所有核心逻辑经 esbuild 打包进单文件产物，严禁引入原生 C++ addon 或外部 CLI 二进制。',
      tags: ['esbuild', 'dsh', 'bundle'],
      topicKey: 'decision:bundler',
      pinned: false,
      confidence: 0.92,
      sourceSessionIds: ['sess-alpha', 'sess-beta'],
      evidenceCount: 3,
      recallCount: 2,
      createdAt: now - 4 * 86_400_000,
      updatedAt: now - 18 * 3_600_000,
      links: ['mem_pref_pnpm', 'mem_pit_contrast'],
      retention: 0.91,
      fsrs: {
        stability: 11.4,
        difficulty: 4.1,
        elapsedDays: 1,
        scheduledDays: 11,
        learningSteps: 0,
        reps: 3,
        lapses: 0,
        state: 2,
        due: now + 10 * 86_400_000,
        lastReview: now - 18 * 3_600_000,
      },
    },
    {
      id: 'mem_pit_contrast',
      kind: 'pitfall',
      title: '侧栏小字禁用裸绿/裸橙状态色以通过 axe 4.5:1 对比度',
      content: '浅色背景下小号文字若直接使用绿色或橙色会导致对比度不足，须使用 color-mix 与主墨色混合。',
      tags: ['css', 'axe', 'accessibility'],
      pinned: false,
      confidence: 0.9,
      sourceSessionIds: ['sess-beta'],
      evidenceCount: 2,
      recallCount: 1,
      createdAt: now - 3 * 86_400_000,
      updatedAt: now - 28 * 3_600_000,
      links: ['mem_dec_bundle'],
      retention: 0.84,
      fsrs: {
        stability: 7.2,
        difficulty: 4.8,
        elapsedDays: 1,
        scheduledDays: 7,
        learningSteps: 0,
        reps: 2,
        lapses: 0,
        state: 2,
        due: now + 6 * 86_400_000,
        lastReview: now - 28 * 3_600_000,
      },
    },
    {
      id: 'mem_epi_sleep',
      kind: 'episode',
      title: '会话进展：完成 L2 睡眠巩固与 FSRS 衰减设计',
      content: '完成了 NREM 聚类、REM 跨会话冲突消解与 MiniSearch 中英分词索引对接。',
      tags: ['fsrs', 'minisearch'],
      topicKey: 'episode:session-gamma',
      pinned: false,
      confidence: 0.82,
      sourceSessionIds: ['sess-gamma'],
      evidenceCount: 6,
      recallCount: 0,
      createdAt: now - 6 * 3_600_000,
      updatedAt: now - 5 * 3_600_000,
      retention: 0.76,
      fsrs: {
        stability: 2.1,
        difficulty: 5.4,
        elapsedDays: 0,
        scheduledDays: 2,
        learningSteps: 0,
        reps: 1,
        lapses: 0,
        state: 2,
        due: now + 2 * 86_400_000,
        lastReview: now - 5 * 3_600_000,
      },
    },
  ];
}

function summarizeCounts(items: readonly MemoryViewItem[]): Record<MemoryKind, number> {
  const counts: Record<MemoryKind, number> = {
    preference: 0,
    decision: 0,
    pitfall: 0,
    episode: 0,
  };
  for (const m of items) counts[m.kind] += 1;
  return counts;
}

export function makeSleepScenario(name: SleepScenarioName): SleepPanelModel {
  const memories = name === 'empty-vault' ? [] : makeSampleMemories(BASE_NOW);
  const countsByKind = summarizeCounts(memories);
  const pinnedCount = memories.filter((m) => m.pinned).length;

  if (name === 'sleepy-waiting') {
    return {
      now: BASE_NOW,
      autoSleepPaused: false,
      consolidating: false,
      drive: {
        satisfaction: 46,
        urgency: 54,
        zone: 'uncomfortable',
        sleepy: true,
        suppressed: false,
        unconsolidatedTurns: 15,
        turnThreshold: 12,
        elapsedSinceSleepMs: 3 * 3_600_000,
        timeThresholdMs: 6 * 3_600_000,
        quietWindow: false,
        screenLocked: false,
        idleDurationMs: 4 * 60_000,
        idleThresholdMs: 10 * 60_000,
        autoRunsToday: 2,
        dailyAutoQuota: 6,
        lastSleepAt: BASE_NOW - 3 * 3_600_000,
        summary: '待整合 15 轮对话 · 等待静默窗口（已空闲 4/10 分钟，或锁屏触发）',
      },
      countsByKind,
      totalMemories: memories.length,
      pinnedCount,
      memories,
      recentConsolidations: [
        {
          id: 'sleep_prev_1',
          at: BASE_NOW - 3 * 3_600_000,
          trigger: 'auto',
          turnsProcessed: 12,
          nremCandidates: 4,
          createdCount: 2,
          mergedCount: 1,
          conflictsResolved: 1,
          prunedCount: 0,
          linksUpdated: 2,
          durationMs: 42,
          summary: '整合 12 轮对话 · NREM 聚类 4 项 · 新增 2 / 强化 1 / 消解冲突 1 / 遗忘修剪 0',
        },
      ],
    };
  }

  if (name === 'suppressed-l1') {
    return {
      now: BASE_NOW,
      autoSleepPaused: false,
      consolidating: false,
      drive: {
        satisfaction: 42,
        urgency: 58,
        zone: 'uncomfortable',
        sleepy: true,
        suppressed: true,
        suppressionReason: 'L1 生理需求处于不适或节能模式，高阶需求已挂起',
        unconsolidatedTurns: 16,
        turnThreshold: 12,
        elapsedSinceSleepMs: 7 * 3_600_000,
        timeThresholdMs: 6 * 3_600_000,
        quietWindow: true,
        screenLocked: true,
        idleDurationMs: 15 * 60_000,
        idleThresholdMs: 10 * 60_000,
        autoRunsToday: 1,
        dailyAutoQuota: 6,
        lastSleepAt: BASE_NOW - 7 * 3_600_000,
        summary: '待整合 16 轮对话 · L1 生理需求处于不适或节能模式，高阶需求已挂起',
      },
      countsByKind,
      totalMemories: memories.length,
      pinnedCount,
      memories,
      recentConsolidations: [],
    };
  }

  return {
    now: BASE_NOW,
    autoSleepPaused: false,
    consolidating: false,
    drive: {
      satisfaction: 95,
      urgency: 5,
      zone: 'comfortable',
      sleepy: false,
      suppressed: false,
      unconsolidatedTurns: 2,
      turnThreshold: 12,
      elapsedSinceSleepMs: 45 * 60_000,
      timeThresholdMs: 6 * 3_600_000,
      quietWindow: false,
      screenLocked: false,
      idleDurationMs: 2 * 60_000,
      idleThresholdMs: 10 * 60_000,
      autoRunsToday: 1,
      dailyAutoQuota: 6,
      lastSleepAt: BASE_NOW - 45 * 60_000,
      summary: '已累计 2/12 轮未整合对话，尚未产生困意',
    },
    countsByKind,
    totalMemories: memories.length,
    pinnedCount,
    memories,
    recentConsolidations:
      name === 'empty-vault'
        ? []
        : [
            {
              id: 'sleep_rec_01',
              at: BASE_NOW - 45 * 60_000,
              trigger: 'auto',
              turnsProcessed: 13,
              nremCandidates: 4,
              createdCount: 3,
              mergedCount: 1,
              conflictsResolved: 0,
              prunedCount: 0,
              linksUpdated: 2,
              durationMs: 36,
              summary: '整合 13 轮对话 · NREM 聚类 4 项 · 新增 3 / 强化 1 / 消解冲突 0 / 遗忘修剪 0',
            },
          ],
  };
}
