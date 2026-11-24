import type { IntuitionPanelModel, ProspectiveIntention } from './shared/types.js';

export const INTUITION_SCENARIOS = [
  'intuition-healthy',
  'intuition-surfaced',
  'intuition-suppressed',
  'intuition-empty',
] as const;

export type IntuitionScenarioName = (typeof INTUITION_SCENARIOS)[number];

const BASE_NOW = 1_780_000_000_000;

function makeSampleIntentions(now: number, includeSurfaced: boolean): ProspectiveIntention[] {
  const items: ProspectiveIntention[] = [
    {
      id: 'pm_ctx_bundle',
      title: '核对发布前兼容版本与包审计',
      instruction: '切回 ASI 工作区准备发版前，务必运行 release:check 核对单包文件白名单与 peerDependencies。',
      trigger: {
        kind: 'context',
        workspaceMatch: 'asi',
        keywordMatch: 'release, 打包, 发版',
      },
      triggerSummary: '情境 · 工作区含「asi」 + 关键词「release, 打包, 发版」',
      priority: 'high',
      status: includeSurfaced ? 'surfaced' : 'pending',
      sourceSessionId: 'sess-alpha',
      createdAt: now - 3 * 3_600_000,
      updatedAt: includeSurfaced ? now - 8 * 60_000 : now - 3 * 3_600_000,
      surfacedCount: includeSurfaced ? 1 : 0,
      ...(includeSurfaced ? { lastSurfacedAt: now - 8 * 60_000 } : {}),
    },
    {
      id: 'pm_time_reg',
      title: '复查 320px 明暗双主题无障碍回归',
      instruction: '修改侧栏样式后定时复查 Playwright 320px 零水平溢出与 axe-core 对比度结果。',
      trigger: {
        kind: 'time',
        dueAt: now + 45 * 60_000,
      },
      triggerSummary: '定时 · 45m后到期',
      priority: 'normal',
      status: 'pending',
      sourceSessionId: 'sess-beta',
      createdAt: now - 50 * 60_000,
      updatedAt: now - 50 * 60_000,
      surfacedCount: 0,
    },
    {
      id: 'pm_done_mig',
      title: '确认旧版目录迁移幂等标记',
      instruction: '启动期验证 .migration-v1.json 幂等写入且原目录完整保留。',
      trigger: {
        kind: 'event',
        eventKind: 'next_session',
      },
      triggerSummary: '事件 · 下次开启会话',
      priority: 'normal',
      status: 'fulfilled',
      createdAt: now - 24 * 3_600_000,
      updatedAt: now - 12 * 3_600_000,
      fulfilledAt: now - 12 * 3_600_000,
      surfacedCount: 1,
      resolutionNote: '已在全栈集成测试验证通过',
    },
  ];
  return items;
}

export function makeIntuitionScenario(name: IntuitionScenarioName): IntuitionPanelModel {
  if (name === 'intuition-empty') {
    return {
      now: BASE_NOW,
      autoIntuitionPaused: false,
      drive: {
        satisfaction: 100,
        urgency: 0,
        zone: 'comfortable',
        suppressed: false,
        pendingCount: 0,
        surfacedCount: 0,
        overdueHighCount: 0,
        activeScarCount: 0,
        summary: '前额叶直觉与前瞻处于稳态舒适（本地 <10ms 零 Token 守候）',
      },
      pendingCount: 0,
      surfacedCount: 0,
      fulfilledCount: 0,
      mutedSourceCount: 0,
      intentions: [],
      recentFlashbacks: [],
    };
  }

  const includeSurfaced = name === 'intuition-surfaced';
  const suppressed = name === 'intuition-suppressed';
  const intentions = makeSampleIntentions(BASE_NOW, includeSurfaced);

  return {
    now: BASE_NOW,
    autoIntuitionPaused: false,
    drive: {
      satisfaction: includeSurfaced ? 66 : suppressed ? 84 : 100,
      urgency: includeSurfaced ? 34 : suppressed ? 16 : 0,
      zone: 'comfortable',
      suppressed,
      ...(suppressed ? { suppressionReason: 'L1 生理需求处于不适或节能模式，高阶需求已挂起' } : {}),
      pendingCount: includeSurfaced ? 1 : 2,
      surfacedCount: includeSurfaced ? 1 : 0,
      overdueHighCount: includeSurfaced ? 1 : 0,
      activeScarCount: 0,
      summary: suppressed
        ? 'L1 生理需求处于不适或节能模式，高阶需求已挂起'
        : includeSurfaced
          ? '已触发 1 项前瞻提醒待确认（高优 1 项） · 另有 1 项守候中'
          : '2 项前瞻记忆静默守候中 · 躯体标记前哨就绪（零 Token）',
    },
    pendingCount: includeSurfaced ? 1 : 2,
    surfacedCount: includeSurfaced ? 1 : 0,
    fulfilledCount: 1,
    mutedSourceCount: 0,
    intentions,
    recentFlashbacks: [
      {
        id: 'fb_demo_1',
        at: BASE_NOW - 12 * 60_000,
        channel: 'pre-step',
        sourceId: 'mem_pit_contrast',
        sourceKind: 'pitfall',
        title: '侧栏小字禁用裸绿/裸橙状态色以通过 axe 4.5:1 对比度',
        caution: '浅色背景下小号文字若直接使用绿色或橙色会导致对比度不足，须使用 color-mix 与主墨色混合。',
        score: 0.86,
        matchedCues: ['css', 'axe', '对比度'],
        sessionId: 'sess-beta',
      },
    ],
  };
}
