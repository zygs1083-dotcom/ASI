import { useMemo, useState } from 'react';
import { formatBytes, formatDuration, formatPercent, formatPercentValue } from '../format';
import { Sparkline } from '../sparkline';
import type {
  MetricKey,
  MetricPoint,
  TimelineAppSummary,
  TimelineDaySummary,
  TimelineMetricKey,
  TimelineMetricSeries,
  TimelineMetricUnit,
} from '../view-model';
import css from './history.module.css';

const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const METRIC_SAMPLE_MS = 5 * 60 * 1000;

export const METRIC_SPECS: readonly { key: TimelineMetricKey; label: string; metric?: MetricKey }[] = [
  { key: 'cpu', label: 'CPU', metric: 'cpu' },
  { key: 'memory', label: '内存', metric: 'memory' },
  { key: 'disk', label: '磁盘可用' },
  { key: 'battery', label: '电池', metric: 'battery' },
];

export interface DigestShape {
  topApps: TimelineAppSummary[];
  wakeCount: number;
  alertCount: number;
  fileBurstCount: number;
  sleepCount: number;
  sleepDurationMs: number;
  lockDurationMs: number;
  observedMs: number;
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 秒';
  return formatDuration(Math.max(1, Math.round(ms / 1000)));
}

export function formatAwayHours(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 小时';
  const hours = Math.round((ms / 3_600_000) * 10) / 10;
  return `${hours} 小时`;
}

function formatterForUnit(unit: TimelineMetricUnit | undefined): (v: number) => string {
  if (unit === 'bytes') return formatBytes;
  if (unit === 'percent') return formatPercentValue;
  return formatPercent;
}

export function SummaryDigest({ summary, subtitle, note }: { summary: DigestShape; subtitle: string; note?: string }) {
  return (
    <div className={css.card}>
      <div className={css.metaLine}>{subtitle}</div>
      {note && <div className={css.metaLine}>{note}</div>}
      <div className={css.statsGrid}>
        <div className={css.statItem}>
          <span className={css.statLabel}>唤醒</span>
          <span className={css.statVal}>{summary.wakeCount} 次</span>
        </div>
        <div className={css.statItem}>
          <span className={css.statLabel}>告警</span>
          <span className={css.statVal}>{summary.alertCount} 次</span>
        </div>
        <div className={css.statItem}>
          <span className={css.statLabel}>文件突发</span>
          <span className={css.statVal}>{summary.fileBurstCount} 次</span>
        </div>
        <div className={css.statItem}>
          <span className={css.statLabel}>睡眠</span>
          <span className={css.statVal}>
            {summary.sleepCount} 次 · {formatMs(summary.sleepDurationMs)}
          </span>
        </div>
        <div className={css.statItem}>
          <span className={css.statLabel}>锁屏</span>
          <span className={css.statVal}>{formatMs(summary.lockDurationMs)}</span>
        </div>
      </div>
      {summary.topApps.length > 0 ? (
        <ul className={css.appList} aria-label="前台时长 Top 5 应用">
          {summary.topApps.slice(0, 5).map((item) => (
            <li key={item.app} className={css.appRow}>
              <span className={css.appName}>{item.app}</span>
              <span className={css.appDur}>{formatMs(item.foregroundMs)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className={css.empty}>暂无前台应用记录</div>
      )}
    </div>
  );
}

export function Metric24hCard({
  label,
  metric,
  series,
  now,
  paused,
}: {
  label: string;
  metric?: MetricKey;
  series?: TimelineMetricSeries;
  now: number;
  paused: boolean;
}) {
  const fmt = formatterForUnit(series?.unit);
  const derived = useMemo(() => {
    const raw = series?.points ?? [];
    if (raw.length === 0) return { avgPoints: [] as MetricPoint[], rangeText: '暂无数据' };
    let lo = Infinity;
    let hi = -Infinity;
    const avgPoints = raw.map((p) => {
      if (p.min < lo) lo = p.min;
      if (p.max > hi) hi = p.max;
      return { at: p.at, value: p.avg };
    });
    const last = raw[raw.length - 1]!;
    return { avgPoints, rangeText: `最新 ${fmt(last.avg)} · ${fmt(lo)}~${fmt(hi)}` };
  }, [series, fmt]);

  return (
    <div className={css.chartCard}>
      <div className={css.chartHead}>
        <span>{label}</span>
        <span className={css.metaLine}>{derived.rangeText}</span>
      </div>
      <Sparkline
        className={css.spark24h}
        metric={metric}
        points={derived.avgPoints}
        minMaxBand={series?.points}
        windowMs={DAY_WINDOW_MS}
        sampleIntervalMs={METRIC_SAMPLE_MS}
        now={now}
        paused={paused}
        label={`${label} 24 小时`}
        format={fmt}
      />
    </div>
  );
}

export function DaySummaryBlock({ today, yesterday }: { today?: TimelineDaySummary; yesterday?: TimelineDaySummary }) {
  const [tab, setTab] = useState<'today' | 'yesterday'>('today');
  const active = tab === 'today' ? today : yesterday;
  return (
    <div className={css.block}>
      <div className={css.blockHead}>
        <span className={css.blockTitle}>日汇总</span>
        <div className={css.tabs}>
          <button type="button" className={css.tabBtn} aria-pressed={tab === 'today'} onClick={() => setTab('today')}>
            今天
          </button>
          <button
            type="button"
            className={css.tabBtn}
            aria-pressed={tab === 'yesterday'}
            onClick={() => setTab('yesterday')}
          >
            昨天
          </button>
        </div>
      </div>
      {active ? (
        <SummaryDigest summary={active} subtitle={`${active.date} · 观测 ${formatMs(active.observedMs)}`} />
      ) : (
        <div className={css.empty}>{tab === 'today' ? '今日暂无汇总数据' : '昨日暂无汇总数据'}</div>
      )}
    </div>
  );
}
