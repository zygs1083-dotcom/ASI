import { renderSkillMarkdown } from '../shared/skill-spec.js';
import type { GrowthPanelModel } from '../shared/types.js';

export const GROWTH_SCENARIOS = [
  'workshop-ready',
  'deep-quiet-waiting',
  'suppressed-lower-tier',
  'empty-workshop',
] as const;

export type GrowthScenarioName = (typeof GROWTH_SCENARIOS)[number];

const BASE_NOW = 1_780_000_000_000;
const WS_DEMO = ['', 'tmp', 'demo-web'].join('/');
const WS_API = ['', 'tmp', 'demo-api'].join('/');

const V1_MARKDOWN = renderSkillMarkdown({
  name: 'playwright-contrast-guard',
  description:
    'Ensure sidebar components meet WCAG AA 4.5:1 contrast in light and dark themes and pass 320px zero-overflow checks.',
  whenToUse: 'Use when building or editing sidebar panels, CSS modules, or Playwright accessibility specs.',
  license: 'MIT',
  metadata: {
    version: '1.0.0',
    'topic-key': 'playwright-contrast',
    'synthesized-by': 'asi-growth',
  },
  body: [
    '# Playwright Sidebar Contrast & Layout Guardrails',
    '',
    '## When to Use',
    '- Creating or modifying sidebar React components and CSS Modules.',
    '',
    '## Standard Procedure',
    '1. Mix state colors with `--dsw-alias-label-primary` via `color-mix` for text badges.',
    '2. Enforce `min-width: 0` and `overflow-x: hidden` on flex/grid containers.',
    '',
    '## Verification Checklist',
    '- Run Playwright at 320px width in both light and dark themes with `axe-core`.',
  ].join('\n'),
});

const V2_MARKDOWN = renderSkillMarkdown({
  name: 'playwright-contrast-guard',
  description:
    'Ensure sidebar components meet WCAG AA 4.5:1 contrast in light and dark themes, isolate CSS Module selectors, and pass 320px checks.',
  whenToUse: 'Use when building or editing sidebar panels, CSS modules, or Playwright accessibility specs.',
  license: 'MIT',
  metadata: {
    version: '2.0.0',
    'topic-key': 'playwright-contrast',
    'synthesized-by': 'asi-growth',
  },
  body: [
    '# Playwright Sidebar Contrast & Layout Guardrails',
    '',
    '## When to Use',
    '- Creating or modifying sidebar React components and CSS Modules.',
    '',
    '## Standard Procedure',
    '1. Mix state colors with `--dsw-alias-label-primary` via `color-mix` for text badges.',
    '2. Enforce `min-width: 0` and `overflow-x: hidden` on flex/grid containers.',
    '3. Prefix CSS Module classes uniquely per bundle so multi-panel stylesheets never collide.',
    '',
    '## Known Pitfalls & Guardrails',
    '- [v2 新增] **CSS Module 类名碰撞**: 不同插件客户端包共用 `.panel` 会互相覆盖，须使用独立文件与类名前缀。',
    '',
    '## Verification Checklist',
    '- Run Playwright at 320px width in both light and dark themes with `axe-core`.',
  ].join('\n'),
});

const STALE_SKILL_MARKDOWN = renderSkillMarkdown({
  name: 'legacy-sqlite-migration',
  description: 'Checklist for migrating legacy local caches away from native C++ addons to plain JSONL files.',
  whenToUse: 'Use when replacing native database bindings with pure TypeScript persistence.',
  license: 'MIT',
  metadata: {
    version: '1.0.0',
    'topic-key': 'sqlite-jsonl',
    'synthesized-by': 'asi-growth',
  },
  body: [
    '# Pure TypeScript JSONL Persistence Checklist',
    '',
    '## Standard Procedure',
    '1. Replace native addon dependencies with atomic temp-file write + rename.',
    '2. Sanitize every persisted record via `sanitizeForModel` before and after disk I/O.',
  ].join('\n'),
});

const ARCHIVED_MARKDOWN = renderSkillMarkdown({
  name: 'old-webpack-loader-debug',
  description: 'Historical troubleshooting steps for legacy bundler loader resolution.',
  license: 'MIT',
  body: '# Legacy Bundler Troubleshooting\n\n1. Check module resolution aliases.',
});

export function makeGrowthScenario(name: GrowthScenarioName): GrowthPanelModel {
  const knownWorkspaces = [
    { path: WS_DEMO, display: '~/work/demo-web' },
    { path: WS_API, display: '~/work/demo-api' },
  ];

  if (name === 'empty-workshop') {
    return {
      now: BASE_NOW,
      autoGrowthPaused: false,
      synthesizing: false,
      drive: {
        satisfaction: 100,
        urgency: 0,
        zone: 'comfortable',
        readyToSynthesize: false,
        suppressed: false,
        lowerTierBlocked: false,
        readyClusters: 0,
        highRetentionMemoryCount: 1,
        recurringTrajectoryCount: 0,
        deepQuietWindow: false,
        screenLocked: false,
        idleDurationMs: 3 * 60_000,
        idleThresholdMs: 20 * 60_000,
        autoDraftsToday: 0,
        dailyAutoQuota: 2,
        lastSynthesisAt: null,
        summary: '尚未积累达标高证据簇（需同主题 >=3 条高保留率踩坑/决策/偏好记忆或 >=2 次多步排障轨迹）',
      },
      draftCount: 0,
      activeCount: 0,
      disabledCount: 0,
      archivedCount: 0,
      staleCount: 0,
      knownWorkspaces,
      drafts: [],
      skills: [],
      archivedSkills: [],
      recentSyntheses: [],
    };
  }

  if (name === 'suppressed-lower-tier') {
    return {
      now: BASE_NOW,
      autoGrowthPaused: false,
      synthesizing: false,
      drive: {
        satisfaction: 52,
        urgency: 48,
        zone: 'uncomfortable',
        readyToSynthesize: true,
        suppressed: true,
        suppressionReason: 'L1 生理需求处于不适或恢复期，高阶需求已挂起',
        lowerTierBlocked: true,
        lowerTierReason: 'L1 生理需求处于不适或恢复期，高阶需求已挂起',
        readyClusters: 1,
        highRetentionMemoryCount: 4,
        recurringTrajectoryCount: 2,
        deepQuietWindow: true,
        screenLocked: true,
        idleDurationMs: 25 * 60_000,
        idleThresholdMs: 20 * 60_000,
        autoDraftsToday: 0,
        dailyAutoQuota: 2,
        lastSynthesisAt: BASE_NOW - 8 * 3_600_000,
        summary: 'L1 生理需求处于不适或恢复期，高阶需求已挂起',
      },
      draftCount: 0,
      activeCount: 1,
      disabledCount: 0,
      archivedCount: 0,
      staleCount: 0,
      knownWorkspaces,
      drafts: [],
      skills: [
        {
          name: 'playwright-contrast-guard',
          version: 1,
          status: 'active',
          scope: 'global',
          description:
            'Ensure sidebar components meet WCAG AA 4.5:1 contrast in light and dark themes and pass 320px zero-overflow checks.',
          whenToUse: 'Use when building or editing sidebar panels, CSS modules, or Playwright accessibility specs.',
          markdown: V1_MARKDOWN,
          topicKey: 'playwright-contrast',
          evidenceIds: ['mem_1', 'mem_2', 'mem_3'],
          approvedAt: BASE_NOW - 5 * 86_400_000,
          updatedAt: BASE_NOW - 5 * 86_400_000,
          invocationCount: 6,
          lastInvokedAt: BASE_NOW - 2 * 3_600_000,
          evaluatedTurns: 6,
          completedTurns: 6,
          turnCompletionRate: 1,
          stale: false,
          daysSinceLastUse: 0,
          exportedWorkspaces: [],
        },
      ],
      archivedSkills: [],
      recentSyntheses: [],
    };
  }

  const drafts = [
    {
      id: 'draft_rev_v2',
      name: 'playwright-contrast-guard',
      description:
        'Ensure sidebar components meet WCAG AA 4.5:1 contrast in light and dark themes, isolate CSS Module selectors, and pass 320px checks.',
      whenToUse: 'Use when building or editing sidebar panels, CSS modules, or Playwright accessibility specs.',
      markdown: V2_MARKDOWN,
      scope: 'global' as const,
      targetVersion: 2,
      isRevision: true,
      revisesSkillName: 'playwright-contrast-guard',
      baseVersion: 1,
      baseMarkdown: V1_MARKDOWN,
      topicKey: 'playwright-contrast',
      evidenceIds: ['mem_1', 'mem_2', 'mem_3', 'mem_4'],
      memoryCount: 4,
      trajectoryCount: 1,
      evidenceSummary: '基于新增 1 条踩坑记忆与 1 条排障轨迹提炼 v1 → v2 增量修订',
      createdAt: BASE_NOW - 15 * 60_000,
      updatedAt: BASE_NOW - 15 * 60_000,
      trigger: 'auto' as const,
    },
  ];

  const skills = [
    {
      name: 'playwright-contrast-guard',
      version: 1,
      status: 'active' as const,
      scope: 'global' as const,
      description:
        'Ensure sidebar components meet WCAG AA 4.5:1 contrast in light and dark themes and pass 320px zero-overflow checks.',
      whenToUse: 'Use when building or editing sidebar panels, CSS modules, or Playwright accessibility specs.',
      markdown: V1_MARKDOWN,
      topicKey: 'playwright-contrast',
      evidenceIds: ['mem_1', 'mem_2', 'mem_3'],
      approvedAt: BASE_NOW - 5 * 86_400_000,
      updatedAt: BASE_NOW - 5 * 86_400_000,
      invocationCount: 8,
      lastInvokedAt: BASE_NOW - 45 * 60_000,
      evaluatedTurns: 8,
      completedTurns: 7,
      turnCompletionRate: 0.875,
      stale: false,
      daysSinceLastUse: 0,
      exportedWorkspaces: ['~/work/demo-web'],
    },
    {
      name: 'legacy-sqlite-migration',
      version: 1,
      status: 'active' as const,
      scope: 'workspace' as const,
      workspacePath: WS_API,
      workspaceDisplay: '~/work/demo-api',
      description: 'Checklist for migrating legacy local caches away from native C++ addons to plain JSONL files.',
      whenToUse: 'Use when replacing native database bindings with pure TypeScript persistence.',
      markdown: STALE_SKILL_MARKDOWN,
      topicKey: 'sqlite-jsonl',
      evidenceIds: ['traj_1', 'traj_2'],
      approvedAt: BASE_NOW - 68 * 86_400_000,
      updatedAt: BASE_NOW - 68 * 86_400_000,
      invocationCount: 0,
      lastInvokedAt: null,
      evaluatedTurns: 0,
      completedTurns: 0,
      turnCompletionRate: null,
      stale: true,
      daysSinceLastUse: 68,
      exportedWorkspaces: [],
    },
  ];

  const archivedSkills = [
    {
      name: 'old-webpack-loader-debug',
      version: 1,
      scope: 'global' as const,
      description: 'Historical troubleshooting steps for legacy bundler loader resolution.',
      markdown: ARCHIVED_MARKDOWN,
      topicKey: 'webpack-loader',
      approvedAt: BASE_NOW - 120 * 86_400_000,
      archivedAt: BASE_NOW - 10 * 86_400_000,
      invocationCount: 1,
      lastInvokedAt: BASE_NOW - 95 * 86_400_000,
      turnCompletionRate: 1,
    },
  ];

  if (name === 'deep-quiet-waiting') {
    return {
      now: BASE_NOW,
      autoGrowthPaused: false,
      synthesizing: false,
      drive: {
        satisfaction: 56,
        urgency: 44,
        zone: 'uncomfortable',
        readyToSynthesize: true,
        suppressed: false,
        lowerTierBlocked: false,
        readyClusters: 1,
        highRetentionMemoryCount: 5,
        recurringTrajectoryCount: 2,
        deepQuietWindow: false,
        screenLocked: false,
        idleDurationMs: 7 * 60_000,
        idleThresholdMs: 20 * 60_000,
        autoDraftsToday: 1,
        dailyAutoQuota: 2,
        lastSynthesisAt: BASE_NOW - 3 * 3_600_000,
        summary: '已积累 1 个高证据技能主题 · 等待 20 分钟深静默窗口（当前空闲 7/20 分钟）',
      },
      draftCount: drafts.length,
      activeCount: 2,
      disabledCount: 0,
      archivedCount: 1,
      staleCount: 1,
      knownWorkspaces,
      drafts,
      skills,
      archivedSkills,
      recentSyntheses: [
        {
          id: 'growth_rec_1',
          at: BASE_NOW - 15 * 60_000,
          trigger: 'auto',
          clustersInspected: 1,
          draftsCreated: 0,
          revisionsCreated: 1,
          durationMs: 24,
          summary: '提炼 1 份待审 SKILL.md 草案（新建 0 / 修订 1），等待人工批准启用',
        },
      ],
    };
  }

  return {
    now: BASE_NOW,
    autoGrowthPaused: false,
    synthesizing: false,
    drive: {
      satisfaction: 100,
      urgency: 0,
      zone: 'comfortable',
      readyToSynthesize: false,
      suppressed: false,
      lowerTierBlocked: false,
      readyClusters: 0,
      highRetentionMemoryCount: 4,
      recurringTrajectoryCount: 1,
      deepQuietWindow: true,
      screenLocked: false,
      idleDurationMs: 28 * 60_000,
      idleThresholdMs: 20 * 60_000,
      autoDraftsToday: 1,
      dailyAutoQuota: 2,
      lastSynthesisAt: BASE_NOW - 15 * 60_000,
      summary: '高证据主题已生成待审草案，等待人工批准启用',
    },
    draftCount: drafts.length,
    activeCount: 2,
    disabledCount: 0,
    archivedCount: 1,
    staleCount: 1,
    knownWorkspaces,
    drafts,
    skills,
    archivedSkills,
    recentSyntheses: [
      {
        id: 'growth_rec_1',
        at: BASE_NOW - 15 * 60_000,
        trigger: 'auto',
        clustersInspected: 1,
        draftsCreated: 0,
        revisionsCreated: 1,
        durationMs: 24,
        summary: '提炼 1 份待审 SKILL.md 草案（新建 0 / 修订 1），等待人工批准启用',
      },
    ],
  };
}
