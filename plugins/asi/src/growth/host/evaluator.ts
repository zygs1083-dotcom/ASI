/**
 * L4 Skill Synthesis Homeostatic Evaluator & Deep Quiet Gate (`asi-growth`).
 *
 * - Satisfaction stays `100` (`comfortable`) when zero topics meet the high-evidence
 *   threshold (even if `< 3` memories or `1` trajectory exist).
 * - Enters `uncomfortable` (`satisfaction < 60`) ONLY when `readyClusters >= 1`.
 * - Auto-drafting requires:
 *   1. All L1 (`asi-needs`), L2 (`asi-sleep`), and L3 (`asi-care`) drives are
 *      comfortable (`tier < 4` non-active & `zone === 'comfortable'`) and `powerMode !== 'eco'`.
 *   2. Deep quiet window: all ordinary sessions idle `>= 20 minutes` OR `env.system.locked === true`.
 *   3. Rolling 24-hour auto-draft quota `<= 2` drafts/day.
 */

import { type AsiDrivesSnapshot, factStatusAt, type NeedZone, type SenseSnapshot } from '@asi/sense-types';
import type { GrowthDriveView } from '../shared/types.js';

export const DEEP_QUIET_IDLE_THRESHOLD_MS = 20 * 60_000;
export const DAILY_AUTO_DRAFT_QUOTA = 2;
export const ROLLING_DAY_WINDOW_MS = 24 * 3_600_000;
export const STALE_SKILL_ZERO_USAGE_MS = 60 * 86_400_000;
export const NON_BLOCKING_TIER3_SOURCES: ReadonlySet<string> = new Set(['asi-intuition', 'asi-tom']);

export interface EvaluateGrowthInput {
  now: number;
  sense: SenseSnapshot;
  drivesSnapshot?: AsiDrivesSnapshot;
  readyClusters: number;
  highRetentionMemoryCount: number;
  recurringTrajectoryCount: number;
  lastSynthesisAt: number | null;
  lastOrdinaryActivityAt: number;
  anyOrdinarySessionRunning: boolean;
  autoGrowthPaused: boolean;
  autoDraftTimestamps: readonly number[];
}

export interface EvaluatedGrowthState {
  driveView: GrowthDriveView;
  canAutoDraft: boolean;
  remainingAutoQuota: number;
}

export function detectLowerTierBlock(
  sense: SenseSnapshot,
  drivesSnap?: AsiDrivesSnapshot,
): { suppressed: boolean; suppressionReason?: string; lowerTierBlocked: boolean; lowerTierReason?: string } {
  const ecoActive = sense.settings.powerMode === 'eco';
  const l1OrEcoSuppressed = Boolean(drivesSnap?.higherOrderSuppressed) || ecoActive;
  const suppressionReason =
    drivesSnap?.suppressionReason ?? (ecoActive ? '当前处于节能降频模式，高阶需求已挂起' : undefined);

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
    const reason = `等待低阶需求恢复舒适（${labels.join('、')}）后再自动提炼`;
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

export function isScreenLockedAt(sense: SenseSnapshot, now: number): boolean {
  const sysFact = sense.state.env.system;
  return Boolean(sysFact && factStatusAt(sysFact, now) === 'ok' && sysFact.value?.locked === true);
}

export function evaluateGrowthState(input: EvaluateGrowthInput): EvaluatedGrowthState {
  const screenLocked = isScreenLockedAt(input.sense, input.now);
  const idleDurationMs = input.anyOrdinarySessionRunning ? 0 : Math.max(0, input.now - input.lastOrdinaryActivityAt);
  const deepQuietWindow =
    !input.anyOrdinarySessionRunning && (screenLocked || idleDurationMs >= DEEP_QUIET_IDLE_THRESHOLD_MS);

  const autoDraftsToday = input.autoDraftTimestamps.filter((ts) => input.now - ts < ROLLING_DAY_WINDOW_MS).length;
  const remainingAutoQuota = Math.max(0, DAILY_AUTO_DRAFT_QUOTA - autoDraftsToday);

  const block = detectLowerTierBlock(input.sense, input.drivesSnapshot);

  let satisfaction = 100;
  if (input.readyClusters > 0) {
    satisfaction = Math.max(32, 56 - (input.readyClusters - 1) * 10);
  }
  const urgency = 100 - satisfaction;
  const zone: NeedZone = satisfaction < 25 ? 'critical' : satisfaction < 60 ? 'uncomfortable' : 'comfortable';
  const readyToSynthesize = input.readyClusters > 0;

  const canAutoDraft =
    readyToSynthesize &&
    !input.autoGrowthPaused &&
    !input.sense.settings.paused &&
    !block.suppressed &&
    !block.lowerTierBlocked &&
    deepQuietWindow &&
    remainingAutoQuota > 0;

  let summary: string;
  if (block.suppressed) {
    summary = block.suppressionReason ?? '优先保障 L1 生理稳态，L4 技能自进化已挂起';
  } else if (!readyToSynthesize) {
    summary = '尚未积累达标高证据簇（需同主题 >=3 条高保留率踩坑/决策/偏好记忆或 >=2 次多步排障轨迹）';
  } else if (input.autoGrowthPaused) {
    summary = `已发现 ${input.readyClusters} 个可提炼技能主题 · 自动提炼已暂停（可点击立即提炼技能）`;
  } else if (block.lowerTierBlocked) {
    summary = block.lowerTierReason ?? '等待 L1–L3 需求全部恢复舒适后再自动提炼';
  } else if (remainingAutoQuota <= 0) {
    summary = `今日自动提炼草案配额已满（${autoDraftsToday}/${DAILY_AUTO_DRAFT_QUOTA}），可手动点击立即提炼技能`;
  } else if (!deepQuietWindow) {
    const idleMins = Math.floor(idleDurationMs / 60_000);
    summary = input.anyOrdinarySessionRunning
      ? `已积累 ${input.readyClusters} 个高证据技能主题 · 普通对话运行中，等待回合结束并进入 20 分钟深静默窗口`
      : `已积累 ${input.readyClusters} 个高证据技能主题 · 等待 20 分钟深静默窗口（当前空闲 ${idleMins}/20 分钟）`;
  } else {
    summary = `深静默就绪 · 准备将 ${input.readyClusters} 个高证据主题提炼为待审 SKILL.md 草案`;
  }

  return {
    driveView: {
      satisfaction,
      urgency,
      zone,
      readyToSynthesize,
      suppressed: block.suppressed,
      ...(block.suppressionReason ? { suppressionReason: block.suppressionReason } : {}),
      lowerTierBlocked: block.lowerTierBlocked,
      ...(block.lowerTierReason ? { lowerTierReason: block.lowerTierReason } : {}),
      readyClusters: input.readyClusters,
      highRetentionMemoryCount: input.highRetentionMemoryCount,
      recurringTrajectoryCount: input.recurringTrajectoryCount,
      deepQuietWindow,
      screenLocked,
      idleDurationMs,
      idleThresholdMs: DEEP_QUIET_IDLE_THRESHOLD_MS,
      autoDraftsToday,
      dailyAutoQuota: DAILY_AUTO_DRAFT_QUOTA,
      lastSynthesisAt: input.lastSynthesisAt,
      summary,
    },
    canAutoDraft,
    remainingAutoQuota,
  };
}
