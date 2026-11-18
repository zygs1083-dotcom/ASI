import type { AwaySummaryData } from '@asi/sense-types';
import type {
  TimelineAwaySummary,
  TimelineDaySummary,
  TimelineMetricBucket,
  TimelineMetricSeries,
  TimelineMetrics,
  TimelineState,
} from '@asi/sense-ui';
import type { EventEntry } from '../runtime/attention.ts';
import { toTimelineDaySummary } from '../runtime/history/index.ts';
import type { Timeline24hMemoryPoint, Timeline24hPoint } from '../runtime/metrics.ts';
import type { Runtime } from './project.ts';

const METRIC_LABELS: Record<string, string> = {
  cpu: 'CPU',
  load1: '1 分钟负载',
  load5: '5 分钟负载',
  load15: '15 分钟负载',
  memory: '内存',
  swap: 'Swap',
  disk: '磁盘可用',
  battery: '电池',
};

const AWAY_ANOMALY_LABELS: Record<string, string> = {
  alerts: '期间触发告警',
  'metric-warning': '指标达到告警阈值',
  'metric-growth': '指标明显上升',
  'failed-jobs': '后台任务失败',
  'external-deletion': '外部文件批量删除',
};

function roundRatio(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function toMetricSeries(
  points: readonly Timeline24hPoint[],
  unit: 'ratio' | 'percent' | 'bytes',
): TimelineMetricSeries | undefined {
  if (points.length === 0) return undefined;
  return {
    unit,
    points: points.map(({ at, min, avg, max }): TimelineMetricBucket => ({ at, min, avg, max })),
  };
}

function projectMemorySeries(
  points: readonly Timeline24hMemoryPoint[],
  fallbackTotal: number | undefined,
): TimelineMetricSeries | undefined {
  if (points.length === 0) return undefined;
  const allHaveTotal = points.every((p) => {
    const total = p.total ?? fallbackTotal;
    return total !== undefined && Number.isFinite(total) && total > 0;
  });
  if (!allHaveTotal) {
    return toMetricSeries(points, 'bytes');
  }
  return {
    unit: 'ratio',
    points: points.map((p): TimelineMetricBucket => {
      const total = (p.total ?? fallbackTotal)!;
      return {
        at: p.at,
        min: roundRatio(p.min / total),
        avg: roundRatio(p.avg / total),
        max: roundRatio(p.max / total),
      };
    }),
  };
}

function formatAwayAnomalies(data: AwaySummaryData): string[] {
  if (!data.hasAnomaly) return [];
  const items: string[] = [];
  for (const alert of data.alerts.slice(0, 4)) {
    const label = METRIC_LABELS[alert.metric] ?? alert.metric;
    const sev = alert.severity === 'critical' ? '紧急' : '注意';
    items.push(`${label} ${sev}告警 ${alert.count} 次`);
  }
  if (data.failedCount > 0) {
    const labels = data.failed
      .map((item) => item.kind || item.id)
      .filter((label) => label.length > 0)
      .slice(0, 2);
    items.push(
      labels.length > 0 ? `失败任务 ${data.failedCount} 个（${labels.join('、')}）` : `失败任务 ${data.failedCount} 个`,
    );
  }
  if (data.bursts.length > 0 || data.deletedCount > 0) {
    const firstDir = data.bursts[0]?.directory;
    items.push(
      firstDir ? `外部删除 ${data.deletedCount} 个文件（${firstDir}）` : `外部删除 ${data.deletedCount} 个文件`,
    );
  }
  if (data.anomalies.includes('metric-warning') || data.anomalies.includes('metric-growth')) {
    const parts = data.metrics
      .filter((m) => m.metric === 'disk' || m.metric === 'battery' || m.metric === 'memory' || m.metric === 'cpu')
      .slice(0, 2)
      .map((m) => METRIC_LABELS[m.metric] ?? m.metric);
    const suffix = parts.length > 0 ? `（${parts.join('、')}）` : '';
    if (data.anomalies.includes('metric-warning')) items.push(`指标进入告警区间${suffix}`);
    if (data.anomalies.includes('metric-growth')) items.push(`资源消耗上升${suffix}`);
  }
  if (items.length === 0) {
    for (const tag of data.anomalies) {
      items.push(AWAY_ANOMALY_LABELS[tag] ?? tag);
    }
  }
  return items;
}

function isAwayEntryPushed(data: AwaySummaryData, entries: readonly EventEntry[]): boolean {
  const id = `away.summary:${data.awayFrom}:${data.returnAt}`;
  const entry = entries.find((item) => item.id === id);
  if (!entry) return false;
  if (entry.level !== 'wake' && entry.level !== 'context') return false;
  return (
    entry.reason !== 'wake-budget' &&
    entry.reason !== 'no-session' &&
    entry.reason !== 'self-caused' &&
    entry.reason !== 'paused' &&
    entry.reason !== 'session-private' &&
    entry.reason !== 'session-closed'
  );
}

/**
 * Stateful timeline projector preserving referential stability across frames.
 * Recomputes daily summaries only when history revision advances and metrics only
 * when a new 5-minute bucket is entered (or cleared).
 */
export function createTimelineProjector() {
  let historyRevision = -1;
  let cachedDays: { today?: TimelineDaySummary; yesterday?: TimelineDaySummary } = {};

  let metricsRevision = -1;
  let metricsHadMemory = false;
  let cachedMetrics: TimelineMetrics | undefined;

  let awayRevision = -1;
  let awayPushed = false;
  let cachedAway: TimelineAwaySummary | undefined;

  let cachedTimeline: TimelineState | undefined;

  return function project(
    runtime: Runtime,
    entries: readonly EventEntry[],
    now: number,
    fallbackMemoryTotal: number | undefined,
  ): TimelineState | undefined {
    let changed = false;

    const snap = runtime.historySnapshot?.();
    const nextHistoryRevision = snap?.version ?? 0;
    if (nextHistoryRevision !== historyRevision) {
      historyRevision = nextHistoryRevision;
      cachedDays = {
        ...(snap?.today ? { today: toTimelineDaySummary(snap.today) } : {}),
        ...(snap?.yesterday ? { yesterday: toTimelineDaySummary(snap.yesterday) } : {}),
      };
      changed = true;
    }

    const nextMetricsRevision = runtime.metricsVersion?.() ?? 0;
    // Rebuild metrics only when a new 5-min bucket is created, cleared, or fallback total first resolves empty memory series.
    const fallbackPending =
      cachedMetrics?.memory?.unit === 'bytes' &&
      !metricsHadMemory &&
      fallbackMemoryTotal !== undefined &&
      fallbackMemoryTotal > 0;
    if (nextMetricsRevision !== metricsRevision || fallbackPending) {
      metricsRevision = nextMetricsRevision;
      const raw = runtime.metrics24h?.(now);
      if (raw) {
        const cpu = toMetricSeries(raw.cpu, 'ratio');
        const memory = projectMemorySeries(raw.memory, fallbackMemoryTotal);
        const disk = toMetricSeries(raw.disk, 'bytes');
        const battery = toMetricSeries(raw.battery, 'percent');
        metricsHadMemory = memory?.unit === 'ratio';
        const nextMetrics: TimelineMetrics = {
          ...(cpu ? { cpu } : {}),
          ...(memory ? { memory } : {}),
          ...(disk ? { disk } : {}),
          ...(battery ? { battery } : {}),
        };
        cachedMetrics = Object.keys(nextMetrics).length > 0 ? nextMetrics : undefined;
      } else {
        metricsHadMemory = false;
        cachedMetrics = undefined;
      }
      changed = true;
    }

    const away = runtime.awayLast?.();
    const nextAwayRevision = away?.version ?? 0;
    const nextAwayPushed = away ? isAwayEntryPushed(away.data, entries) : false;
    if (nextAwayRevision !== awayRevision || nextAwayPushed !== awayPushed) {
      awayRevision = nextAwayRevision;
      awayPushed = nextAwayPushed;
      cachedAway = away
        ? {
            awayFrom: away.data.awayFrom,
            returnAt: away.data.returnAt,
            durationMs: away.data.durationMs,
            hasAnomaly: away.data.hasAnomaly,
            anomalies: formatAwayAnomalies(away.data),
            pushed: nextAwayPushed,
          }
        : undefined;
      changed = true;
    }

    if (!changed) return cachedTimeline;

    const { today, yesterday } = cachedDays;
    if (!today && !yesterday && !cachedMetrics && !cachedAway) {
      cachedTimeline = undefined;
      return undefined;
    }
    cachedTimeline = {
      ...(today ? { today } : {}),
      ...(yesterday ? { yesterday } : {}),
      ...(cachedMetrics ? { metrics: cachedMetrics } : {}),
      ...(cachedAway ? { lastAway: cachedAway } : {}),
    };
    return cachedTimeline;
  };
}
