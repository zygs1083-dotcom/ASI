import type { DreamInsightViewItem, DreamPanelModel } from './shared/types.ts';

export type DreamScenarioName = 'cross-repo-insights' | 'dream-quiet-waiting' | 'suppressed-lower-tier' | 'empty-dream';

const REPO_ALPHA = ['~', 'work', 'orca-hub'].join('/');
const REPO_BETA = ['~', 'work', 'asi-plugin'].join('/');
const REPO_GAMMA = ['~', 'work', 'data-sync'].join('/');

function sampleInsights(now: number): DreamInsightViewItem[] {
  return [
    {
      id: 'ins_mock_warn_01',
      kind: 'preventive-warning',
      status: 'open',
      title: '跨仓避坑预警：orca-hub 的「并发锁与原子写入竞争」踩坑可提前守护 data-sync',
      summary: `${REPO_ALPHA} 曾记录 SQLite WAL 未配置 busy_timeout 导致高并发写入锁死，而 ${REPO_GAMMA} 具备同构技术栈且近期正在排查并发落盘超时。`,
      bridgeMechanism:
        '跨项目结构画像匹配到共性机制面「并发锁与原子写入竞争」与共享栈特征（typescript, sqlite, vitest）。',
      actionableHypothesis:
        '建议在 data-sync 初始化连接池时显式设置 busy_timeout = 5000，并对状态快照采用临时文件加 rename 原子替换。',
      repoKeys: ['data-sync#a1b2c3d4e5', 'orca-hub#f6e5d4c3b2'],
      sourceRepos: [REPO_ALPHA, REPO_GAMMA],
      targetRepo: REPO_GAMMA,
      sourceMemoryIds: ['mem_pitfall_wal_01'],
      sourceSessionIds: ['sess_alpha_01', 'sess_gamma_03'],
      tags: ['concurrency-lock', 'sqlite', 'cross-repo'],
      topicKey: 'bridge:concurrency-lock:data-sync',
      pairSignature: 'data-sync#a1b2c3d4e5|orca-hub#f6e5d4c3b2::preventive-warning::bridge:concurrency-lock:data-sync',
      noveltyScore: 0.86,
      structuralSimilarity: 0.78,
      confidence: 0.88,
      createdAt: now - 2_400_000,
      updatedAt: now - 2_400_000,
    },
    {
      id: 'ins_mock_unify_02',
      kind: 'pattern-unification',
      status: 'adopted',
      title: '跨仓范式收敛：orca-hub 与 asi-plugin 共现「符号链接越界与脱敏沙盒护栏」规律',
      summary: `${REPO_ALPHA} 与 ${REPO_BETA} 独立演化出先 lstat 校验非符号链接、再经线性时间打码器过滤凭据的持久化契约。`,
      bridgeMechanism: '两仓库在本地目录扫描与持久化层均需防御符号链接逃逸与敏感令牌泄露。',
      actionableHypothesis: '可将非破坏性 lstat 边界守卫与主目录掩码提炼为全局复用的安全落盘规范。',
      repoKeys: ['asi-plugin#1122334455', 'orca-hub#f6e5d4c3b2'],
      sourceRepos: [REPO_BETA, REPO_ALPHA],
      sourceMemoryIds: ['mem_dec_symlink_01', 'mem_pit_redact_02'],
      sourceSessionIds: ['sess_alpha_02', 'sess_beta_04'],
      tags: ['path-symlink-sandbox', 'typescript', 'cross-repo'],
      topicKey: 'dmn:path-symlink-sandbox',
      pairSignature: 'asi-plugin#1122334455|orca-hub#f6e5d4c3b2::pattern-unification::dmn:path-symlink-sandbox',
      noveltyScore: 0.81,
      structuralSimilarity: 0.84,
      confidence: 0.91,
      adoptedMemoryId: 'mem_adopted_99',
      createdAt: now - 14_400_000,
      updatedAt: now - 7_200_000,
    },
  ];
}

export function makeDreamScenario(name: DreamScenarioName, baseNow = 1_763_960_000_000): DreamPanelModel {
  const now = baseNow;

  if (name === 'empty-dream') {
    return {
      now,
      autoDreamPaused: false,
      dreaming: false,
      drive: {
        satisfaction: 100,
        urgency: 0,
        zone: 'comfortable',
        readyToDream: false,
        suppressed: false,
        lowerTierBlocked: false,
        discoveredRepoCount: 1,
        candidateBridgeCount: 0,
        openInsightCount: 0,
        deepQuietWindow: false,
        screenLocked: false,
        idleDurationMs: 120_000,
        idleThresholdMs: 900_000,
        autoDreamsToday: 0,
        dailyAutoQuota: 3,
        lastDreamAt: null,
        summary: '已感知 1 个项目工作区（需 >=2 个独立 Git 仓库方可触发跨仓顿悟）',
      },
      openCount: 0,
      adoptedCount: 0,
      promotedCount: 0,
      dismissedCount: 0,
      totalInsights: 0,
      insights: [],
      recentDreams: [],
    };
  }

  if (name === 'suppressed-lower-tier') {
    return {
      now,
      autoDreamPaused: false,
      dreaming: false,
      drive: {
        satisfaction: 50,
        urgency: 50,
        zone: 'uncomfortable',
        readyToDream: true,
        suppressed: true,
        suppressionReason: 'L1 生理需求处于不适或恢复期，高阶需求已挂起',
        lowerTierBlocked: true,
        lowerTierReason: 'L1 生理需求处于不适或恢复期，高阶需求已挂起',
        discoveredRepoCount: 3,
        candidateBridgeCount: 2,
        openInsightCount: 0,
        deepQuietWindow: false,
        screenLocked: false,
        idleDurationMs: 60_000,
        idleThresholdMs: 900_000,
        autoDreamsToday: 0,
        dailyAutoQuota: 3,
        lastDreamAt: now - 28_800_000,
        summary: 'L1 生理需求处于不适或恢复期，高阶需求已挂起',
      },
      openCount: 0,
      adoptedCount: 0,
      promotedCount: 0,
      dismissedCount: 0,
      totalInsights: 0,
      insights: [],
      recentDreams: [],
    };
  }

  const items = sampleInsights(now);
  if (name === 'dream-quiet-waiting') {
    return {
      now,
      autoDreamPaused: false,
      dreaming: false,
      drive: {
        satisfaction: 50,
        urgency: 50,
        zone: 'uncomfortable',
        readyToDream: true,
        suppressed: false,
        lowerTierBlocked: false,
        discoveredRepoCount: 3,
        candidateBridgeCount: 2,
        openInsightCount: 1,
        deepQuietWindow: false,
        screenLocked: false,
        idleDurationMs: 360_000,
        idleThresholdMs: 900_000,
        autoDreamsToday: 1,
        dailyAutoQuota: 3,
        lastDreamAt: now - 3_600_000,
        summary: '待探索 2 条跨仓桥接 · 等待会话深静默（约还需空闲 9 分钟或锁屏）',
      },
      openCount: 1,
      adoptedCount: 1,
      promotedCount: 0,
      dismissedCount: 0,
      totalInsights: items.length,
      insights: items,
      recentDreams: [
        {
          id: 'drm_mock_01',
          at: now - 3_600_000,
          trigger: 'auto',
          reposScanned: 3,
          bridgesEvaluated: 2,
          insightsCreated: 2,
          insightsReinforced: 0,
          durationMs: 42,
          summary: '扫描 3 个仓库、评估 2 条远距桥接，新生成 2 条顿悟',
        },
      ],
    };
  }

  return {
    now,
    autoDreamPaused: false,
    dreaming: false,
    drive: {
      satisfaction: 100,
      urgency: 0,
      zone: 'comfortable',
      readyToDream: false,
      suppressed: false,
      lowerTierBlocked: false,
      discoveredRepoCount: 3,
      candidateBridgeCount: 0,
      openInsightCount: 0,
      deepQuietWindow: true,
      screenLocked: false,
      idleDurationMs: 1_200_000,
      idleThresholdMs: 900_000,
      autoDreamsToday: 1,
      dailyAutoQuota: 3,
      lastDreamAt: now - 3_600_000,
      summary: '已关联 3 个独立仓库 · 暂无新的未探索跨仓同构桥接',
    },
    openCount: 0,
    adoptedCount: 1,
    promotedCount: 0,
    dismissedCount: 0,
    totalInsights: 1,
    insights: items.filter((i) => i.status !== 'open'),
    recentDreams: [
      {
        id: 'drm_mock_01',
        at: now - 3_600_000,
        trigger: 'auto',
        reposScanned: 3,
        bridgesEvaluated: 1,
        insightsCreated: 1,
        insightsReinforced: 0,
        durationMs: 35,
        summary: '扫描 3 个仓库、评估 1 条远距桥接，新生成 1 条顿悟',
      },
    ],
  };
}
