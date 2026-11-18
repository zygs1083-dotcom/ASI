import type {
  AwayAlert,
  AwayAnomaly,
  AwayDeletion,
  AwayFailedJob,
  AwayMetricName,
  AwayMetricTrend,
  AwaySummaryData,
  Signal,
} from '@asi/sense-types';
import { BODY_THRESHOLDS } from '../attention/thresholds.ts';
import { METRIC_KEYS, type MetricTimeline, type MetricTrend } from './metrics.ts';
import type { Clock } from './ports.ts';

/**
 * Away-period reporter (change 4, owner decision 2026-11-18).
 *
 * A user is away while any of three independent causes is active: screen
 * locked, system asleep, or the user session inactive. Returning is the last
 * active cause ending. The episode start is the earliest start across all
 * causes observed in that episode. Episodes shorter than one hour produce no
 * record at all; longer ones always produce exactly one `away.summary`
 * signal, which only carries `hasAnomaly: true` (and therefore only matches
 * the default wake rule) when something is worth reporting.
 */

export const AWAY_MIN_MS = 60 * 60_000;
export const AWAY_GROWTH_RATIO = 0.2;
const ALERT_CAP = 20;
const FAILED_CAP = 20;
const BURST_CAP = 20;

type Cause = 'lock' | 'sleep' | 'inactive';

const START_CAUSES: Readonly<Record<string, Cause>> = {
  'screen.locked': 'lock',
  'system.sleep': 'sleep',
  'session.inactive': 'inactive',
};

const END_CAUSES: Readonly<Record<string, Cause>> = {
  'screen.unlocked': 'lock',
  'system.wake': 'sleep',
  'session.active': 'inactive',
};

const EMPTY_CAUSE_MS: Readonly<Record<Cause, number>> = { lock: 0, sleep: 0, inactive: 0 };

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const BODY_ALERT_RANK: Readonly<Record<string, number>> = {
  warn: 1,
  critical: 2,
};

function bodyAlertSeverity(value: unknown): 'warn' | 'critical' | undefined {
  if (typeof value !== 'string') return undefined;
  return (BODY_ALERT_RANK[value] ?? 0) >= BODY_ALERT_RANK.warn ? (value as 'warn' | 'critical') : undefined;
}

/** Returns true when an away metric trend crossed a warn threshold or grew by at least 20%. */
export function isAnomalousAwayMetric(trend: {
  metric: string;
  start: number;
  end: number;
  ratioStart?: number;
  ratioMin?: number;
}): boolean {
  if (trend.metric === 'disk' || trend.metric === 'battery') {
    const threshold = BODY_THRESHOLDS[trend.metric];
    if (trend.ratioMin === undefined) return false;
    const worsened =
      trend.ratioStart === undefined || trend.ratioStart >= threshold.warn || trend.ratioMin < trend.ratioStart;
    return trend.ratioMin < threshold.warn && worsened;
  }
  return trend.start > 0 && (trend.end - trend.start) / trend.start >= AWAY_GROWTH_RATIO - 1e-9;
}

interface ActiveCause {
  wall: number;
  mono: number;
}

export class AwayReporter {
  private readonly active = new Map<Cause, ActiveCause>();
  private readonly causeMs: Record<Cause, number> = { ...EMPTY_CAUSE_MS };
  private readonly alerts = new Map<string, AwayAlert>();
  private readonly failed: AwayFailedJob[] = [];
  private readonly bursts = new Map<string, AwayDeletion>();
  private startWall?: number;
  private startMono?: number;
  private lastAwayEndWall?: number;
  private lastAwayEndMono?: number;
  private totalAlertCount = 0;
  private totalAlertEntries = 0;
  private totalFailedCount = 0;
  private totalBurstEntries = 0;
  private totalDeletedCount = 0;
  private version = 0;
  private latest?: { version: number; data: AwaySummaryData };

  constructor(
    private readonly metrics: MetricTimeline,
    private readonly clock: Clock,
    private readonly emit: (signal: Signal) => void,
  ) {}

  /** Observes one applied attention event; starts/ends episodes and collects anomalies. */
  observe(signal: Signal): void {
    const kind = signal.kind;
    if (kind === 'away.summary') return;
    const wallAt = finite(signal.at) ? signal.at : this.clock.wall();
    const rawMono = this.clock.mono();
    const monoAt = finite(rawMono) ? rawMono : 0;
    const startCause = START_CAUSES[kind];
    if (startCause) {
      this.beginCause(startCause, wallAt, monoAt);
      return;
    }
    const endCause = END_CAUSES[kind];
    if (endCause) {
      const open = this.active.get(endCause);
      if (open !== undefined) {
        this.causeMs[endCause] += Math.max(0, wallAt - open.wall, monoAt - open.mono);
        this.active.delete(endCause);
      } else {
        this.consumeHint(endCause, signal, wallAt, monoAt);
      }
      if (this.active.size === 0 && this.startMono !== undefined) this.finish(wallAt, monoAt);
      return;
    }
    if (this.startMono === undefined || monoAt < this.startMono) return;
    this.collect(signal);
  }

  private beginCause(cause: Cause, wallAt: number, monoAt: number): void {
    const open = this.active.get(cause);
    if (open === undefined || monoAt < open.mono) {
      this.active.set(cause, { wall: wallAt, mono: monoAt });
    }
    if (this.startMono === undefined || monoAt < this.startMono) {
      this.startMono = monoAt;
      this.startWall = wallAt;
    } else if (this.startWall === undefined) {
      this.startWall = wallAt;
    }
  }

  /**
   * Uses a paired end event's helper-computed `durationMs` when no start was
   * observed (e.g. DSH started mid-away). A hint whose inferred start lies
   * inside the previous episode is ignored so paired unlock/wake events can
   * never report the same away twice.
   */
  private consumeHint(cause: Cause, signal: Signal, wallAt: number, monoAt: number): void {
    const duration = signal.data.durationMs;
    if (!finite(duration) || duration <= 0) return;
    const inferredWall = wallAt - duration;
    if (inferredWall < 0) return;
    const inferredMono = monoAt - duration;
    const beforeLastMono = this.lastAwayEndMono !== undefined && inferredMono < this.lastAwayEndMono;
    const beforeLastWall = this.lastAwayEndWall !== undefined && inferredWall < this.lastAwayEndWall;
    if (
      this.lastAwayEndMono !== undefined && this.lastAwayEndWall !== undefined
        ? beforeLastMono && beforeLastWall
        : beforeLastMono || beforeLastWall
    ) {
      return;
    }
    if (this.startMono === undefined || inferredMono < this.startMono) {
      this.startMono = inferredMono;
      this.startWall = this.startWall === undefined ? inferredWall : Math.min(this.startWall, inferredWall);
    } else if (this.startWall === undefined) {
      this.startWall = inferredWall;
    }
    this.causeMs[cause] += duration;
  }

  private collect(signal: Signal): void {
    if (signal.kind.startsWith('body.')) {
      if (signal.kind === 'body.anomaly' && signal.data.type === 'rebaseline-suggestion') return;
      const severity = bodyAlertSeverity(signal.data.severity);
      if (!severity) return;
      const metric =
        typeof signal.data.metric === 'string' && signal.data.metric.trim()
          ? signal.data.metric.trim()
          : signal.subject.trim() || 'body';
      const key = `${metric}\u0000${severity}`;
      this.totalAlertCount += 1;
      const existing = this.alerts.get(key);
      if (existing) {
        existing.count += 1;
        return;
      }
      this.totalAlertEntries += 1;
      if (this.alerts.size >= ALERT_CAP) {
        if (severity === 'critical') {
          const warnKey = [...this.alerts.entries()].find(([, alert]) => alert.severity === 'warn')?.[0];
          if (warnKey !== undefined) {
            this.alerts.delete(warnKey);
            this.alerts.set(key, { metric, severity, count: 1 });
          }
        }
        return;
      }
      this.alerts.set(key, { metric, severity, count: 1 });
      return;
    }
    if (
      signal.kind === 'job.failed' ||
      ((signal.kind === 'job.exited' || signal.kind === 'process.exited') &&
        finite(signal.data.exitCode) &&
        signal.data.exitCode !== 0)
    ) {
      this.totalFailedCount += 1;
      if (this.failed.length < FAILED_CAP) {
        const id =
          typeof signal.data.id === 'string' && signal.data.id.trim() ? signal.data.id : signal.subject || signal.kind;
        const exitCode = finite(signal.data.exitCode) ? signal.data.exitCode : undefined;
        this.failed.push({ id, kind: signal.kind, ...(exitCode === undefined ? {} : { exitCode }) });
      }
      return;
    }
    if (signal.kind === 'file.burst') {
      const external =
        signal.data.externalDeletionExceeded === true ||
        (finite(signal.data.externalDeleted) && signal.data.externalDeleted > 0);
      if (!external) return;
      const directory =
        typeof signal.data.directory === 'string' && signal.data.directory.trim()
          ? signal.data.directory
          : signal.subject || '';
      const deleted = finite(signal.data.externalDeleted)
        ? Math.max(0, signal.data.externalDeleted)
        : finite(signal.data.deleted)
          ? Math.max(0, signal.data.deleted)
          : 0;
      this.totalDeletedCount += deleted;
      const existing = this.bursts.get(directory);
      if (existing) {
        existing.deleted += deleted;
        return;
      }
      this.totalBurstEntries += 1;
      if (this.bursts.size < BURST_CAP) {
        this.bursts.set(directory, { directory, deleted });
      }
    }
  }

  private finish(returnWall: number, returnMono: number): void {
    const awayFrom = this.startWall ?? returnWall;
    const startMono = this.startMono ?? returnMono;
    const durationMs = Math.max(0, returnWall - awayFrom, returnMono - startMono);
    const causes = { ...this.causeMs };
    for (const [cause, open] of this.active) {
      causes[cause] += Math.max(0, returnWall - open.wall, returnMono - open.mono);
    }
    const alerts = [...this.alerts.values()]
      .map((alert) => ({ ...alert }))
      .sort((a, b) => (BODY_ALERT_RANK[b.severity] ?? 0) - (BODY_ALERT_RANK[a.severity] ?? 0));
    const failed = this.failed.map((item) => ({ ...item }));
    const bursts = [...this.bursts.values()].map((item) => ({ ...item }));
    const alertCount = this.totalAlertCount;
    const alertEntries = this.totalAlertEntries;
    const failedCount = this.totalFailedCount;
    const burstEntries = this.totalBurstEntries;
    const deletedCount = this.totalDeletedCount;
    this.reset();
    if (durationMs < AWAY_MIN_MS) return;

    const returnAt = returnWall >= awayFrom ? returnWall : awayFrom + durationMs;
    const rawTrends: AwayMetricTrend[] = [];
    for (const metric of METRIC_KEYS) {
      const trend = this.metrics.trend(metric, awayFrom, returnAt, { from: startMono, to: returnMono });
      if (trend) rawTrends.push(toMetricTrend(trend));
    }
    const anomalies = new Set<AwayAnomaly>();
    if (alertEntries > 0 || alerts.length > 0) anomalies.add('alerts');
    if (failedCount > 0 || failed.length > 0) anomalies.add('failed-jobs');
    if (burstEntries > 0 || bursts.length > 0) anomalies.add('external-deletion');
    const anomalousTrends: AwayMetricTrend[] = [];
    const normalTrends: AwayMetricTrend[] = [];
    for (const trend of rawTrends) {
      if (isAnomalousAwayMetric(trend)) {
        anomalies.add(trend.metric === 'disk' || trend.metric === 'battery' ? 'metric-warning' : 'metric-growth');
        anomalousTrends.push(trend);
      } else {
        normalTrends.push(trend);
      }
    }
    const trends = [...anomalousTrends, ...normalTrends];
    const hasAnomaly = anomalies.size > 0;
    const anomalyCount = alertEntries + failedCount + burstEntries + anomalousTrends.length;
    const omitted = alertEntries - alerts.length + (failedCount - failed.length) + (burstEntries - bursts.length);
    const data: AwaySummaryData = {
      awayFrom,
      returnAt,
      durationMs,
      sleepMs: Math.round(causes.sleep),
      lockMs: Math.round(causes.lock),
      ...(causes.inactive > 0 ? { inactiveMs: Math.round(causes.inactive) } : {}),
      hasAnomaly,
      anomalies: [...anomalies].sort() as AwayAnomaly[],
      alerts,
      metrics: trends,
      failed,
      bursts,
      alertCount,
      failedCount,
      deletedCount,
      anomalyCount,
      ...(omitted > 0 ? { omitted } : {}),
    };
    this.lastAwayEndWall = Math.max(returnWall, returnAt);
    this.lastAwayEndMono = returnMono;
    this.latest = { version: ++this.version, data };
    this.emit({
      id: `away.summary:${awayFrom}:${returnAt}`,
      kind: 'away.summary',
      at: returnAt,
      source: { id: 'away', api: 'detector', host: 'local' },
      subject: 'away',
      cause: 'user',
      data,
    });
  }

  lastSummary(): { version: number; data: AwaySummaryData } | undefined {
    return this.latest;
  }

  clear(): void {
    this.reset();
    // lastAwayEndWall/lastAwayEndMono are de-duplication watermarks for an
    // already-pushed away episode, not history data: keep them so a late
    // paired end hint for the same episode cannot push a second away.summary.
    this.latest = undefined;
    this.version += 1;
  }

  private reset(): void {
    this.active.clear();
    this.causeMs.lock = 0;
    this.causeMs.sleep = 0;
    this.causeMs.inactive = 0;
    this.alerts.clear();
    this.failed.length = 0;
    this.bursts.clear();
    this.startWall = undefined;
    this.startMono = undefined;
    this.totalAlertCount = 0;
    this.totalAlertEntries = 0;
    this.totalFailedCount = 0;
    this.totalBurstEntries = 0;
    this.totalDeletedCount = 0;
  }
}

function toMetricTrend(trend: MetricTrend): AwayMetricTrend {
  const metric = trend.metric as AwayMetricName;
  return {
    metric,
    unit: trend.unit,
    start: trend.start,
    end: trend.end,
    min: trend.min,
    max: trend.max,
    ...(trend.ratioStart === undefined ? {} : { ratioStart: trend.ratioStart }),
    ...(trend.ratioMin === undefined ? {} : { ratioMin: trend.ratioMin }),
  };
}
