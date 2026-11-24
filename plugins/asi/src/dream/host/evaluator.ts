/**
 * Default Mode Network (DMN) Homeostatic Evaluator & Deep Quiet Gate (`asi-dream`).
 *
 * - Satisfaction stays `100` (`comfortable`) until `>= 2` distinct canonical repositories
 *   have `>= 1` unexplored cross-repo structural bridge (`candidateBridgeCount >= 1`).
 * - Never enters `critical` (creative DMN dreaming is higher-order Tier 4 cognition).
 * - Auto-dreaming requires:
 *   1. All L1 (`asi-needs`), L2 (`asi-sleep`), and L3 (`asi-care`) drives are comfortable
 *      and `powerMode !== 'eco'` (ensuring L2 consolidates turns at 10m BEFORE DMN dreams at 15m).
 *   2. Deep quiet window: all ordinary sessions idle `>= 15 minutes` OR `env.system.locked === true`.
 *   3. Rolling 24-hour auto-dream quota `<= 3` cycles/day.
 */

import { type AsiDrivesSnapshot, factStatusAt, type NeedZone, type SenseSnapshot } from '@asi/sense-types';
import type { DreamDriveView } from '../shared/types.js';

export const DMN_QUIET_IDLE_THRESHOLD_MS = 15 * 60_000;
export const DAILY_AUTO_DREAM_QUOTA = 3;
export const DREAM_ROLLING_DAY_WINDOW_MS = 24 * 3_600_000;
export const NON_BLOCKING_TIER3_SOURCES: ReadonlySet<string> = new Set(['asi-intuition', 'asi-tom']);

export interface EvaluateDreamInput {
  now: number;
  sense: SenseSnapshot;
  drivesSnapshot?: AsiDrivesSnapshot;
  discoveredRepoCount: number;
  candidateBridgeCount: number;
  openInsightCount: number;
  lastDreamAt: number | null;
  lastOrdinaryActivityAt: number;
  anyOrdinarySessionRunning: boolean;
  autoDreamPaused: boolean;
  autoDreamTimestamps: readonly number[];
  partnerDeferProactive?: boolean;
}

export interface EvaluatedDreamState {
  driveView: DreamDriveView;
  canAutoDream: boolean;
  remainingAutoQuota: number;
}

export function detectDreamLowerTierBlock(
  sense: SenseSnapshot,
  drivesSnap?: AsiDrivesSnapshot,
): { suppressed: boolean; suppressionReason?: string; lowerTierBlocked: boolean; lowerTierReason?: string } {
  const ecoActive = sense.settings.powerMode === 'eco';
  const l1OrEcoSuppressed = Boolean(drivesSnap?.higherOrderSuppressed) || ecoActive;
  const suppressionReason =
    drivesSnap?.suppressionReason ?? (ecoActive ? '当前处于节能降频模式，DMN 做梦联想已挂起' : undefined);

  if (l1OrEcoSuppressed) {
    return {
      suppressed: true,
      ...(suppressionReason ? { suppressionReason } : {}),
      lowerTierBlocked: true,
      ...(suppressionReason ? { lowerTierReason: suppressionReason } : {}),
    };
  }

  const blockingLowerDrives = (drivesSnap?.drives ?? []).filter(
    (d) => d.tier < 4 && !NON_BLOCKING_TIER3_SOURCES.has(d.sourceId) && (d.driveActive || d.zone !== 'comfortable'),
  );
  if (blockingLowerDrives.length > 0) {
    const labels = blockingLowerDrives.slice(0, 2).map((d) => `L${d.tier} ${d.label}`);
    const reason = `等待低阶需求恢复舒适（${labels.join('、')}）后再进入做梦联想`;
    return {
      suppressed: false,
      lowerTierBlocked: true,
      lowerTierReason: reason,
    };
  }

  return {
    suppressed: false,
    lowerTierBlocked: false,
  };
}

export function isDreamScreenLockedAt(sense: SenseSnapshot, now: number): boolean {
  const sysFact = sense.state.env.system;
  return Boolean(sysFact && factStatusAt(sysFact, now) === 'ok' && sysFact.value?.locked === true);
}

export function evaluateDreamState(input: EvaluateDreamInput): EvaluatedDreamState {
  const screenLocked = isDreamScreenLockedAt(input.sense, input.now);
  const idleDurationMs = input.anyOrdinarySessionRunning ? 0 : Math.max(0, input.now - input.lastOrdinaryActivityAt);
  const deepQuietWindow =
    !input.anyOrdinarySessionRunning && (screenLocked || idleDurationMs >= DMN_QUIET_IDLE_THRESHOLD_MS);

  const autoDreamsToday = input.autoDreamTimestamps.filter((ts) => input.now - ts < DREAM_ROLLING_DAY_WINDOW_MS).length;
  const remainingAutoQuota = Math.max(0, DAILY_AUTO_DREAM_QUOTA - autoDreamsToday);

  const block = detectDreamLowerTierBlock(input.sense, input.drivesSnapshot);
  const readyToDream = input.discoveredRepoCount >= 2 && input.candidateBridgeCount > 0;
  const tomDeferring = !screenLocked && Boolean(input.partnerDeferProactive);

  let satisfaction = 100;
  if (readyToDream) {
    satisfaction = Math.max(34, 56 - (input.candidateBridgeCount - 1) * 6);
  }
  const urgency = 100 - satisfaction;
  const zone: NeedZone = satisfaction < 25 ? 'critical' : satisfaction < 60 ? 'uncomfortable' : 'comfortable';

  const canAutoDream =
    readyToDream &&
    !input.autoDreamPaused &&
    !input.sense.settings.paused &&
    !block.suppressed &&
    !block.lowerTierBlocked &&
    !tomDeferring &&
    deepQuietWindow &&
    remainingAutoQuota > 0;

  let summary: string;
  if (block.suppressed) {
    summary = block.suppressionReason ?? '优先保障 L1 生理稳态，DMN 睡眠做梦已挂起';
  } else if (input.sense.settings.paused) {
    summary = '全局感知与自维护已暂停，DMN 睡眠做梦已挂起';
  } else if (input.discoveredRepoCount < 2) {
    summary = `已感知 ${input.discoveredRepoCount} 个项目工作区（需 >=2 个独立 Git 仓库方可触发跨仓顿悟）`;
  } else if (!readyToDream) {
    summary = `已关联 ${input.discoveredRepoCount} 个独立仓库 · 暂无新的未探索跨仓同构桥接`;
  } else if (input.autoDreamPaused) {
    summary = `发现 ${input.candidateBridgeCount} 条跨仓潜在桥接 · 自动做梦已暂停（可手动触发）`;
  } else if (block.lowerTierBlocked) {
    summary = block.lowerTierReason ?? '等待 L1–L3 需求全部恢复舒适后再自动做梦';
  } else if (tomDeferring) {
    summary = `待探索 ${input.candidateBridgeCount} 条跨仓桥接 · 搭档心流专注中，自动做梦静默避让（锁屏或节奏平缓后恢复）`;
  } else if (remainingAutoQuota <= 0) {
    summary = `今日自动做梦配额已满（${autoDreamsToday}/${DAILY_AUTO_DREAM_QUOTA} 次），明日自动恢复`;
  } else if (!deepQuietWindow) {
    const remainMin = Math.max(1, Math.ceil((DMN_QUIET_IDLE_THRESHOLD_MS - idleDurationMs) / 60_000));
    summary = `待探索 ${input.candidateBridgeCount} 条跨仓桥接 · 等待会话深静默（约还需空闲 ${remainMin} 分钟或锁屏）`;
  } else {
    summary = `深静默就绪 · 准备跨 ${input.discoveredRepoCount} 个仓库合成 ${input.candidateBridgeCount} 条潜在顿悟`;
  }

  return {
    driveView: {
      satisfaction,
      urgency,
      zone,
      readyToDream,
      suppressed: block.suppressed,
      ...(block.suppressionReason ? { suppressionReason: block.suppressionReason } : {}),
      lowerTierBlocked: block.lowerTierBlocked,
      ...(block.lowerTierReason ? { lowerTierReason: block.lowerTierReason } : {}),
      discoveredRepoCount: input.discoveredRepoCount,
      candidateBridgeCount: input.candidateBridgeCount,
      openInsightCount: input.openInsightCount,
      deepQuietWindow,
      screenLocked,
      idleDurationMs,
      idleThresholdMs: DMN_QUIET_IDLE_THRESHOLD_MS,
      autoDreamsToday,
      dailyAutoQuota: DAILY_AUTO_DREAM_QUOTA,
      lastDreamAt: input.lastDreamAt,
      summary,
    },
    canAutoDream,
    remainingAutoQuota,
  };
}
