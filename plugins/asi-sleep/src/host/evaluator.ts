/**
 * L2 Sleepiness Curve, Quiet-Window Gating, and Daily Quota Evaluator (`asi-sleep`).
 */

import { factStatusAt, type NeedZone, type SenseSnapshot } from '@asi/sense-types';
import type { SleepDriveView } from '../shared/types.js';

export const TURN_DISCOMFORT_THRESHOLD = 12;
export const TIME_DISCOMFORT_THRESHOLD_MS = 6 * 3_600_000;
export const QUIET_IDLE_THRESHOLD_MS = 10 * 60_000;
export const DAILY_AUTO_QUOTA = 6;
export const ROLLING_DAY_WINDOW_MS = 24 * 3_600_000;

export interface SleepEvaluationInput {
  now: number;
  sense: SenseSnapshot;
  unconsolidatedTurns: number;
  lastSleepAt: number | null;
  firstUnconsolidatedTurnAt: number | null;
  lastOrdinaryActivityAt: number;
  anyOrdinarySessionRunning: boolean;
  autoSleepPaused: boolean;
  autoRunTimestamps: readonly number[];
  higherOrderSuppressed: boolean;
  suppressionReason?: string;
}

export interface EvaluatedSleepState {
  driveView: SleepDriveView;
  canAutoConsolidate: boolean;
}

export function countRecentAutoRuns(timestamps: readonly number[], now: number): number {
  let count = 0;
  for (const ts of timestamps) {
    if (now - ts < ROLLING_DAY_WINDOW_MS) count += 1;
  }
  return count;
}

export function evaluateSleepState(input: SleepEvaluationInput): EvaluatedSleepState {
  const {
    now,
    sense,
    unconsolidatedTurns,
    lastSleepAt,
    firstUnconsolidatedTurnAt,
    lastOrdinaryActivityAt,
    anyOrdinarySessionRunning,
    autoSleepPaused,
    autoRunTimestamps,
    higherOrderSuppressed,
    suppressionReason,
  } = input;

  const referenceSleepTime = lastSleepAt ?? firstUnconsolidatedTurnAt;
  const elapsedSinceSleepMs =
    unconsolidatedTurns > 0 && referenceSleepTime !== null ? Math.max(0, now - referenceSleepTime) : null;

  const turnTriggered = unconsolidatedTurns >= TURN_DISCOMFORT_THRESHOLD;
  const timeTriggered =
    unconsolidatedTurns > 0 && elapsedSinceSleepMs !== null && elapsedSinceSleepMs >= TIME_DISCOMFORT_THRESHOLD_MS;
  const sleepy = turnTriggered || timeTriggered;

  let satisfaction: number;
  if (unconsolidatedTurns <= 0) {
    satisfaction = 100;
  } else if (!sleepy) {
    const turnRatio = unconsolidatedTurns / TURN_DISCOMFORT_THRESHOLD;
    const timeRatio = elapsedSinceSleepMs !== null ? elapsedSinceSleepMs / TIME_DISCOMFORT_THRESHOLD_MS : 0;
    const progress = Math.max(turnRatio, timeRatio);
    satisfaction = Math.max(70, Math.min(99, Math.round(100 - progress * 28)));
  } else {
    const extraTurns = Math.max(0, unconsolidatedTurns - TURN_DISCOMFORT_THRESHOLD);
    const extraHours =
      elapsedSinceSleepMs !== null ? Math.max(0, (elapsedSinceSleepMs - TIME_DISCOMFORT_THRESHOLD_MS) / 3_600_000) : 0;
    const raw = Math.round(52 - extraTurns * 1.6 - extraHours * 2);
    satisfaction = Math.max(10, Math.min(58, raw));
  }

  const urgency = 100 - satisfaction;
  const zone: NeedZone = satisfaction < 25 ? 'critical' : satisfaction < 60 ? 'uncomfortable' : 'comfortable';

  const sysFact = sense.state.env.system;
  const screenLocked = Boolean(sysFact && factStatusAt(sysFact, now) === 'ok' && sysFact.value?.locked === true);
  const idleDurationMs = anyOrdinarySessionRunning ? 0 : Math.max(0, now - lastOrdinaryActivityAt);
  const quietWindow = screenLocked || (!anyOrdinarySessionRunning && idleDurationMs >= QUIET_IDLE_THRESHOLD_MS);
  const autoRunsToday = countRecentAutoRuns(autoRunTimestamps, now);
  const quotaAvailable = autoRunsToday < DAILY_AUTO_QUOTA;

  const canAutoConsolidate =
    sleepy && !autoSleepPaused && !sense.settings.paused && quotaAvailable && quietWindow && !higherOrderSuppressed;

  let summary: string;
  if (unconsolidatedTurns <= 0) {
    summary = '对话记忆均已整合，睡眠稳态充沛';
  } else if (!sleepy) {
    summary = `已累计 ${unconsolidatedTurns}/${TURN_DISCOMFORT_THRESHOLD} 轮未整合对话，尚未产生困意`;
  } else if (higherOrderSuppressed) {
    summary = `待整合 ${unconsolidatedTurns} 轮对话 · ${suppressionReason ?? '优先保障 L1 生理稳态，睡眠整合已挂起'}`;
  } else if (autoSleepPaused) {
    summary = `待整合 ${unconsolidatedTurns} 轮对话 · 自动睡眠已暂停（可点击「立即睡眠整合」）`;
  } else if (!quotaAvailable) {
    summary = `待整合 ${unconsolidatedTurns} 轮对话 · 今日自动睡眠配额已满 (${autoRunsToday}/${DAILY_AUTO_QUOTA})`;
  } else if (!quietWindow) {
    const idleMin = Math.floor(idleDurationMs / 60_000);
    summary = anyOrdinarySessionRunning
      ? `待整合 ${unconsolidatedTurns} 轮对话 · 等待前台对话结束并空闲满 10 分钟或锁屏`
      : `待整合 ${unconsolidatedTurns} 轮对话 · 等待静默窗口（已空闲 ${idleMin}/10 分钟，或锁屏触发）`;
  } else {
    summary = `待整合 ${unconsolidatedTurns} 轮对话 · 静默窗口已就绪（${screenLocked ? '锁屏状态' : '空闲满 10 分钟'}），准备睡眠整合`;
  }

  return {
    driveView: {
      satisfaction,
      urgency,
      zone,
      sleepy,
      suppressed: higherOrderSuppressed,
      ...(suppressionReason ? { suppressionReason } : {}),
      unconsolidatedTurns,
      turnThreshold: TURN_DISCOMFORT_THRESHOLD,
      elapsedSinceSleepMs,
      timeThresholdMs: TIME_DISCOMFORT_THRESHOLD_MS,
      quietWindow,
      screenLocked,
      idleDurationMs,
      idleThresholdMs: QUIET_IDLE_THRESHOLD_MS,
      autoRunsToday,
      dailyAutoQuota: DAILY_AUTO_QUOTA,
      lastSleepAt,
      summary,
    },
    canAutoConsolidate,
  };
}
