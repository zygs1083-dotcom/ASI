/**
 * Orthogonal 3-Drive Homeostatic Evaluator for `asi-care` (`tier: 3`).
 *
 * Evaluates three independent L3 drives (`0..100` integer satisfaction):
 * 1. `repo_hygiene`     — Git conflicts (>2h), dead locks, prunable worktrees,
 *                         clean merged worktrees (>=3d), uncommitted changes (>24h).
 * 2. `orphan_runtime`   — Orphan local dev ports (>2h in idle worktrees),
 *                         orphaned DSH background jobs, zombie process count hint.
 * 3. `workspace_bloat`  — Idle worktree regenerable build artifacts (>=7d & >=1 GiB).
 */

import type { ExternalDriveReading } from '@asi/sense-types';
import { BLOAT_CRITICAL_BYTES, BLOAT_UNCOMFORTABLE_BYTES, type WorkspaceBloatReport } from './artifact-scanner.js';
import type { DiscoveryReport } from './discovery.js';
import type { RepoHygieneReport } from './git-inspector.js';
import type { OrphanRuntimeReport } from './port-inspector.js';
import { formatBytesCompact, formatDurationCompact } from './safety.js';

export const CARE_DRIVE_KEYS = ['repo_hygiene', 'orphan_runtime', 'workspace_bloat'] as const;
export type CareDriveKey = (typeof CARE_DRIVE_KEYS)[number];

export const CARE_DRIVE_LABELS: Record<CareDriveKey, string> = {
  repo_hygiene: '仓库与工作树卫生',
  orphan_runtime: '僵尸进程与孤儿端口',
  workspace_bloat: '闲置工作树产物膨胀',
};

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function evaluateRepoHygieneDrive(
  discovery: DiscoveryReport,
  hygiene?: RepoHygieneReport,
): ExternalDriveReading {
  const totalWorktrees = discovery.worktrees.filter((w) => w.kind === 'git-worktree').length;
  const activeExemptCount = discovery.worktrees.filter((w) => w.kind === 'git-worktree' && w.activeExempt).length;

  if (!hygiene || totalWorktrees === 0) {
    return {
      key: 'repo_hygiene',
      label: CARE_DRIVE_LABELS.repo_hygiene,
      satisfaction: 100,
      summary: totalWorktrees === 0 ? '暂未发现本地 Git 工作树' : `已巡检 ${totalWorktrees} 个工作树，仓库状态干净`,
      evidence: {
        worktrees: totalWorktrees,
        activeExempt: activeExemptCount,
        conflicts: 0,
        deadLocks: 0,
        prunable: 0,
        cleanMerged: 0,
        staleDirty: 0,
      },
    };
  }

  const prunableCount = hygiene.prunableRepos.reduce((acc, r) => acc + r.prunablePaths.length, 0);
  const deadLockCount = hygiene.deadLocks.length;
  const conflictCount = hygiene.conflictWorktrees.length;
  const cleanMergedCount = hygiene.cleanMergedWorktrees.length;
  const staleDirtyCount = hygiene.staleDirtyWorktrees.length;
  const unpushedCount = hygiene.unpushedWorktrees.length;

  let score = 100;
  // Unattended Level-1 actionable items pull below 60 (`uncomfortable`) so self-maintenance can tidy them cleanly
  if (deadLockCount > 0) {
    score = Math.min(score, 52 - Math.min(20, (deadLockCount - 1) * 8));
  }
  if (prunableCount > 0) {
    score = Math.min(score, 56 - Math.min(16, (prunableCount - 1) * 5));
  }
  // Level-2 clean merged idle worktrees (>= 3d)
  if (cleanMergedCount > 0) {
    score = Math.min(score, 54 - Math.min(20, (cleanMergedCount - 1) * 6));
  }
  // Level-3 read-only advisories: conflicts (>2h) & stale uncommitted changes (>24h)
  if (conflictCount > 0) {
    const maxConflictIdle = Math.max(...hygiene.conflictWorktrees.map((w) => w.conflictIdleMs ?? 0));
    const baseConflictScore = maxConflictIdle >= 48 * 3_600_000 || conflictCount >= 3 ? 22 : 42;
    score = Math.min(score, baseConflictScore - Math.min(12, (conflictCount - 1) * 5));
  }
  if (staleDirtyCount > 0) {
    score = Math.min(score, 52 - Math.min(22, (staleDirtyCount - 1) * 6));
  }
  // Pure unpushed commits without >24h dirty state only apply a gentle comfortable-zone reminder
  if (score >= 70 && unpushedCount > 0) {
    score = Math.max(72, 90 - Math.min(15, unpushedCount * 4));
  }

  const parts: string[] = [];
  if (conflictCount > 0) {
    const first = hygiene.conflictWorktrees[0];
    parts.push(
      `${conflictCount} 处冲突残留超 2h${first ? `（如 ${first.displayPath} ${first.conflictKind ?? 'unmerged'}）` : ''}`,
    );
  }
  if (deadLockCount > 0) {
    parts.push(`${deadLockCount} 个无进程占用的陈旧 Git 锁`);
  }
  if (prunableCount > 0) {
    parts.push(`${prunableCount} 条悬空工作树元数据可清理`);
  }
  if (cleanMergedCount > 0) {
    const first = hygiene.cleanMergedWorktrees[0];
    parts.push(
      `${cleanMergedCount} 个已合入干净工作树闲置 ≥3d${first ? `（${first.displayWorktreePath} 闲置 ${formatDurationCompact(first.idleMs)}）` : ''}`,
    );
  }
  if (staleDirtyCount > 0) {
    const first = hygiene.staleDirtyWorktrees[0];
    parts.push(
      `${staleDirtyCount} 个工作树未提交改动静置 >24h${first ? `（${first.displayPath} 静置 ${formatDurationCompact(first.dirtyIdleMs ?? first.idleMs)}）` : ''}`,
    );
  }
  if (parts.length === 0 && unpushedCount > 0) {
    parts.push(`${unpushedCount} 个工作树有未推送本地提交`);
  }

  const exemptSuffix = activeExemptCount > 0 ? `（${activeExemptCount} 个活跃工作树享 2h 豁免）` : '';
  const summary =
    parts.length > 0
      ? `${parts.join('；')}${exemptSuffix}`
      : `已巡检 ${totalWorktrees} 个 Git 工作树，无陈旧锁、冲突或积压改动${exemptSuffix}`;

  return {
    key: 'repo_hygiene',
    label: CARE_DRIVE_LABELS.repo_hygiene,
    satisfaction: clampScore(score),
    summary,
    evidence: {
      worktrees: totalWorktrees,
      activeExempt: activeExemptCount,
      conflicts: conflictCount,
      deadLocks: deadLockCount,
      prunable: prunableCount,
      cleanMerged: cleanMergedCount,
      staleDirty: staleDirtyCount,
      unpushed: unpushedCount,
    },
  };
}

export function evaluateOrphanRuntimeDrive(runtime?: OrphanRuntimeReport): ExternalDriveReading {
  if (!runtime) {
    return {
      key: 'orphan_runtime',
      label: CARE_DRIVE_LABELS.orphan_runtime,
      satisfaction: 100,
      summary: '本地开发端口与后台任务运行正常',
      evidence: {
        orphanPorts: 0,
        orphanJobs: 0,
        zombies: 0,
        orphanRssBytes: 0,
      },
    };
  }

  const portCount = runtime.orphanPorts.length;
  const jobCount = runtime.orphanDshJobCount;
  const zombieCount = runtime.zombieCount;
  const totalRss = runtime.orphanPorts.reduce((acc, p) => acc + p.rssBytes, 0);

  let score = 100;
  if (jobCount > 0) {
    score = Math.min(score, 55 - Math.min(20, (jobCount - 1) * 8));
  }
  if (portCount > 0) {
    const heavyOrMany = portCount >= 3 || totalRss >= 2 * 1024 ** 3;
    const basePortScore = heavyOrMany ? 22 : 48;
    score = Math.min(score, basePortScore - Math.min(16, (portCount - 1) * 7));
  }
  // Kernel zombie entries cannot be killed directly (parent must reap); only nudge gently unless severe
  if (score >= 70 && zombieCount > 0) {
    score = zombieCount >= 10 ? 58 : Math.max(75, 94 - zombieCount * 2);
  }

  const parts: string[] = [];
  if (portCount > 0) {
    const sample = runtime.orphanPorts
      .slice(0, 2)
      .map((p) => `${p.command}:${p.port}（${p.displayWorktreePath}，运行 ${formatDurationCompact(p.elapsedMs)}）`)
      .join('、');
    parts.push(`发现 ${portCount} 个闲置超 2h 的孤儿开发端口：${sample}`);
  }
  if (jobCount > 0) {
    parts.push(`${jobCount} 个无主 DSH 后台孤儿任务待回收`);
  }
  if (zombieCount > 0) {
    parts.push(`观测到 ${zombieCount} 个僵尸子进程 (<defunct>)`);
  }

  return {
    key: 'orphan_runtime',
    label: CARE_DRIVE_LABELS.orphan_runtime,
    satisfaction: clampScore(score),
    summary: parts.length > 0 ? parts.join('；') : '未发现孤儿开发监听端口或无主后台任务',
    evidence: {
      orphanPorts: portCount,
      orphanJobs: jobCount,
      zombies: zombieCount,
      orphanRssBytes: totalRss,
      topPort: runtime.orphanPorts[0]?.port ?? null,
    },
  };
}

export function evaluateWorkspaceBloatDrive(
  bloat?: WorkspaceBloatReport,
  options?: { uncomfortableBytes?: number; criticalBytes?: number },
): ExternalDriveReading {
  const uncomfortableBytes = options?.uncomfortableBytes ?? BLOAT_UNCOMFORTABLE_BYTES;
  const criticalBytes = options?.criticalBytes ?? BLOAT_CRITICAL_BYTES;

  if (!bloat || bloat.idleArtifacts.length === 0) {
    return {
      key: 'workspace_bloat',
      label: CARE_DRIVE_LABELS.workspace_bloat,
      satisfaction: 100,
      summary: '非活跃工作树未发现超 7 天闲置构建产物积压',
      evidence: {
        idleArtifactCount: 0,
        idleBytes: 0,
        topTargetId: null,
      },
    };
  }

  const { totalIdleBytes, idleArtifacts } = bloat;
  const top = idleArtifacts[0];
  let score = 100;

  if (totalIdleBytes >= criticalBytes) {
    score = 20;
  } else if (totalIdleBytes >= uncomfortableBytes) {
    const ratio = (totalIdleBytes - uncomfortableBytes) / Math.max(1, criticalBytes - uncomfortableBytes);
    score = Math.round(55 - ratio * 28);
  } else {
    // Below 1 GiB threshold: stay comfortably satisfied (>= 80) per user decision
    const subRatio = totalIdleBytes / Math.max(1, uncomfortableBytes);
    score = Math.max(80, Math.round(98 - subRatio * 16));
  }

  const summary =
    totalIdleBytes >= uncomfortableBytes
      ? `${idleArtifacts.length} 处闲置 ≥7d 构建产物共占用 ${formatBytesCompact(totalIdleBytes)}${top ? `（头号大户 ${top.displayArtifactPath} ${formatBytesCompact(top.totalBytes)}）` : ''}`
      : `闲置 ≥7d 构建产物共 ${formatBytesCompact(totalIdleBytes)}（未达 ${formatBytesCompact(uncomfortableBytes)} 阈值，状态舒适）`;

  return {
    key: 'workspace_bloat',
    label: CARE_DRIVE_LABELS.workspace_bloat,
    satisfaction: clampScore(score),
    summary,
    evidence: {
      idleArtifactCount: idleArtifacts.length,
      idleBytes: totalIdleBytes,
      topTargetId: top?.targetId ?? null,
    },
  };
}

export function evaluateCareDrives(input: {
  discovery: DiscoveryReport;
  hygiene?: RepoHygieneReport;
  orphanRuntime?: OrphanRuntimeReport;
  bloat?: WorkspaceBloatReport;
  bloatUncomfortableBytes?: number;
  bloatCriticalBytes?: number;
}): readonly ExternalDriveReading[] {
  return [
    evaluateRepoHygieneDrive(input.discovery, input.hygiene),
    evaluateOrphanRuntimeDrive(input.orphanRuntime),
    evaluateWorkspaceBloatDrive(input.bloat, {
      uncomfortableBytes: input.bloatUncomfortableBytes,
      criticalBytes: input.bloatCriticalBytes,
    }),
  ];
}
