import type {
  MonthlySummaryLoadResult,
  MonthlySummaryView,
  TimelineAppSummary,
  TimelineDaySummary,
} from '@asi/sense-ui';
import type { DailySummary, MonthlySummary, SummaryQueryResult } from './types.ts';

interface SummaryCoreInput {
  apps: DailySummary['apps'];
  deliveries: Pick<DailySummary['deliveries'], 'wake'>;
  bodyAnomalies: Pick<DailySummary['bodyAnomalies'], 'total'>;
  fileBursts: DailySummary['fileBursts'];
  system?: DailySummary['system'];
  coverage: Pick<DailySummary['coverage'], 'observedMs'>;
}

export interface TimelineCoreFields {
  topApps: TimelineAppSummary[];
  wakeCount: number;
  alertCount: number;
  fileBurstCount: number;
  sleepCount: number;
  sleepDurationMs: number;
  lockDurationMs: number;
  observedMs: number;
}

/** Projects shared DailySummary / MonthlySummary counters and top-5 foreground apps into UI digest fields. */
export function digestSummaryFields(summary: SummaryCoreInput): TimelineCoreFields {
  const topApps = Object.entries(summary.apps)
    .map(([app, stats]) => ({ app, foregroundMs: stats.foregroundMs, switches: stats.switches }))
    .sort((a, b) => b.foregroundMs - a.foregroundMs || b.switches - a.switches || a.app.localeCompare(b.app))
    .slice(0, 5);
  let fileBurstCount = 0;
  for (const stats of Object.values(summary.fileBursts)) {
    fileBurstCount += stats.events;
  }
  return {
    topApps,
    wakeCount: summary.deliveries.wake,
    alertCount: summary.bodyAnomalies.total,
    fileBurstCount,
    sleepCount: summary.system?.sleepCount ?? 0,
    sleepDurationMs: summary.system?.sleepDurationMs ?? 0,
    lockDurationMs: summary.system?.lockDurationMs ?? 0,
    observedMs: summary.coverage.observedMs,
  };
}

export function toTimelineDaySummary(daily: DailySummary): TimelineDaySummary {
  return {
    date: daily.date,
    ...digestSummaryFields(daily),
  };
}

export function toMonthlySummaryView(
  summary: MonthlySummary,
  meta?: { partial?: boolean; pendingDays?: string[]; note?: string },
): MonthlySummaryView {
  return {
    month: summary.month,
    coveredDays: summary.coveredDays,
    daysInMonth: summary.daysInMonth,
    ...(meta?.partial ? { partial: true } : {}),
    ...(meta?.pendingDays?.length ? { pendingDays: meta.pendingDays } : {}),
    ...(meta?.note ? { note: meta.note } : {}),
    ...digestSummaryFields(summary),
  };
}

export function toMonthlySummaryResult(result: SummaryQueryResult): MonthlySummaryLoadResult {
  if (!result.available) {
    return { available: false, reason: result.reason };
  }
  return {
    available: true,
    summary: toMonthlySummaryView(result.summary, {
      partial: result.partial,
      pendingDays: result.pendingDays,
      note: result.note,
    }),
  };
}
