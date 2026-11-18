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

export class AwayReporter {
  private readonly active = new Map<Cause, number>();
  private readonly causeMs: Record<Cause, number> = { ...EMPTY_CAUSE_MS };
  private readonly alerts = new Map<string, AwayAlert>();
  private readonly failed: AwayFailedJob[] = [];
  private readonly bursts = new Map<string, AwayDeletion>();
  private startAt?: number;
  private lastAwayEnd?: number;

  constructor(
    private readonly metrics: MetricTimeline,
    private readonly clock: Clock,
    private readonly emit: (signal: Signal) => void,
  ) {}

  /** Observes one applied attention event; starts/ends episodes and collects anomalies. */
  observe(signal: Signal): void {
    const kind = signal.kind;
    if (kind === 'away.summary') return;
    const at = finite(signal.at) ? signal.at : this.clock.wall();
    const startCause = START_CAUSES[kind];
    if (startCause) {
      this.beginCause(startCause, at);
      return;
    }
    const endCause = END_CAUSES[kind];
    if (endCause) {
      const open = this.active.get(endCause);
      if (open !== undefined) {
        this.causeMs[endCause] += Math.max(0, at - open);
        this.active.delete(endCause);
      } else {
        this.consumeHint(endCause, signal, at);
      }
      if (this.active.size === 0 && this.startAt !== undefined) this.finish(at);
      return;
    }
    if (this.startAt === undefined || at < this.startAt) return;
    this.collect(signal);
  }

  private beginCause(cause: Cause, at: number): void {
    const open = this.active.get(cause);
    if (open === undefined || at < open) this.active.set(cause, at);
    this.startAt = this.startAt === undefined ? at : Math.min(this.startAt, at);
  }

  /**
   * Uses a paired end event's helper-computed `durationMs` when no start was
   * observed (e.g. DSH started mid-away). A hint whose inferred start lies
   * inside the previous episode is ignored so paired unlock/wake events can
   * never report the same away twice.
   */
  private consumeHint(cause: Cause, signal: Signal, at: number): void {
    const duration = signal.data.durationMs;
    if (!finite(duration) || duration <= 0) return;
    const inferred = at - duration;
    if (inferred < 0) return;
    if (this.lastAwayEnd !== undefined && inferred < this.lastAwayEnd) return;
    this.startAt = this.startAt === undefined ? inferred : Math.min(this.startAt, inferred);
    this.causeMs[cause] += duration;
  }

  private collect(signal: Signal): void {
    if (signal.kind === 'body.threshold') {
      const severity = signal.data.severity;
      if (severity !== 'warn' && severity !== 'critical') return;
      const metric = signal.subject.trim() || 'body';
      const key = `${metric}\u0000${severity}`;
      const existing = this.alerts.get(key);
      if (existing) existing.count += 1;
      else if (this.alerts.size < ALERT_CAP) this.alerts.set(key, { metric, severity, count: 1 });
      return;
    }
    if (
      signal.kind === 'job.failed' ||
      ((signal.kind === 'job.exited' || signal.kind === 'process.exited') &&
        finite(signal.data.exitCode) &&
        signal.data.exitCode !== 0)
    ) {
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
        ? signal.data.externalDeleted
        : finite(signal.data.deleted)
          ? signal.data.deleted
          : 0;
      if (this.bursts.size >= BURST_CAP && !this.bursts.has(directory)) return;
      const existing = this.bursts.get(directory);
      if (existing) existing.deleted += deleted;
      else this.bursts.set(directory, { directory, deleted });
    }
  }

  private finish(returnAt: number): void {
    const awayFrom = this.startAt ?? returnAt;
    const durationMs = Math.max(0, returnAt - awayFrom);
    const causes = { ...this.causeMs };
    for (const [cause, start] of this.active) causes[cause] += Math.max(0, returnAt - start);
    const alerts = [...this.alerts.values()].map((alert) => ({ ...alert }));
    const failed = this.failed.map((item) => ({ ...item }));
    const bursts = [...this.bursts.values()].map((item) => ({ ...item }));
    this.reset();
    if (durationMs < AWAY_MIN_MS) return;

    const trends: AwayMetricTrend[] = [];
    for (const metric of METRIC_KEYS) {
      const trend = this.metrics.trend(metric, awayFrom, returnAt);
      if (trend) trends.push(toMetricTrend(trend));
    }
    const anomalies = new Set<AwayAnomaly>();
    if (alerts.length > 0) anomalies.add('alerts');
    if (failed.length > 0) anomalies.add('failed-jobs');
    if (bursts.length > 0) anomalies.add('external-deletion');
    for (const trend of trends) {
      if (trend.metric === 'disk' || trend.metric === 'battery') {
        const threshold = BODY_THRESHOLDS[trend.metric];
        if (trend.ratioMin !== undefined) {
          const worsened =
            trend.ratioStart === undefined || trend.ratioStart >= threshold.warn || trend.ratioMin < trend.ratioStart;
          if (trend.ratioMin < threshold.warn && worsened) anomalies.add('metric-warning');
        }
      } else if (trend.start > 0 && (trend.end - trend.start) / trend.start >= AWAY_GROWTH_RATIO - 1e-9) {
        anomalies.add('metric-growth');
      }
    }
    const hasAnomaly = anomalies.size > 0;
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
      alertCount: alerts.reduce((sum, alert) => sum + alert.count, 0),
      failedCount: failed.length,
      deletedCount: bursts.reduce((sum, burst) => sum + burst.deleted, 0),
    };
    this.lastAwayEnd = returnAt;
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

  private reset(): void {
    this.active.clear();
    this.causeMs.lock = 0;
    this.causeMs.sleep = 0;
    this.causeMs.inactive = 0;
    this.alerts.clear();
    this.failed.length = 0;
    this.bursts.clear();
    this.startAt = undefined;
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
    ...(trend.ratioMin === undefined ? {} : { ratioMin: trend.ratioMin }),
  };
}
