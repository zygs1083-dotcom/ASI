import type {
  MonthlySummaryView,
  SensePanelModel,
  TimelineDaySummary,
  TimelineMetricBucket,
  TimelineMetrics,
} from '../view-model';
import { T0 } from './fixtures';

const STEP_5M = 5 * 60_000;

function makeBuckets(
  count: number,
  fn: (i: number) => { min: number; avg: number; max: number },
): TimelineMetricBucket[] {
  const start = T0 - (count - 1) * STEP_5M;
  const out: TimelineMetricBucket[] = [];
  for (let i = 0; i < count; i++) {
    const stats = fn(i);
    out.push({ at: start + i * STEP_5M, ...stats });
  }
  return out;
}

export function makeTimelineMetrics24h(): TimelineMetrics {
  const count = 96;
  return {
    cpu: {
      unit: 'ratio',
      points: makeBuckets(count, (i) => {
        const avg = Math.round((0.24 + 0.14 * Math.sin(i / 6)) * 1000) / 1000;
        return {
          min: Math.max(0.05, Math.round((avg - 0.08) * 1000) / 1000),
          avg,
          max: Math.min(0.95, Math.round((avg + 0.14) * 1000) / 1000),
        };
      }),
    },
    memory: {
      unit: 'ratio',
      points: makeBuckets(count, (i) => {
        const avg = Math.round((0.58 + 0.06 * Math.cos(i / 10)) * 1000) / 1000;
        return {
          min: Math.round((avg - 0.03) * 1000) / 1000,
          avg,
          max: Math.round((avg + 0.04) * 1000) / 1000,
        };
      }),
    },
    disk: {
      unit: 'bytes',
      points: makeBuckets(count, (i) => {
        const avg = Math.round((46 - i * 0.02) * 1024 ** 3);
        return {
          min: Math.round(avg - 120 * 1024 ** 2),
          avg,
          max: Math.round(avg + 80 * 1024 ** 2),
        };
      }),
    },
    battery: {
      unit: 'percent',
      points: makeBuckets(count, (i) => {
        const avg = Math.round(78 + 14 * Math.sin(i / 8));
        return {
          min: Math.max(10, avg - 3),
          avg,
          max: Math.min(100, avg + 2),
        };
      }),
    },
  };
}

export const MOCK_TODAY_SUMMARY: TimelineDaySummary = {
  date: '2026-11-18',
  topApps: [
    { app: 'CodeForge', foregroundMs: 7_800_000, switches: 18 },
    { app: 'TermShell', foregroundMs: 4_200_000, switches: 14 },
    { app: 'DocReader', foregroundMs: 2_100_000, switches: 7 },
    { app: 'NotesPad', foregroundMs: 1_200_000, switches: 5 },
    { app: 'MailBox', foregroundMs: 600_000, switches: 3 },
  ],
  wakeCount: 2,
  alertCount: 1,
  fileBurstCount: 1,
  sleepCount: 1,
  sleepDurationMs: 900_000,
  lockDurationMs: 1_500_000,
  observedMs: 15_900_000,
};

export const MOCK_YESTERDAY_SUMMARY: TimelineDaySummary = {
  date: '2026-11-17',
  topApps: [
    { app: 'CodeForge', foregroundMs: 11_400_000, switches: 24 },
    { app: 'DocReader', foregroundMs: 5_100_000, switches: 11 },
    { app: 'TermShell', foregroundMs: 3_600_000, switches: 9 },
  ],
  wakeCount: 1,
  alertCount: 0,
  fileBurstCount: 0,
  sleepCount: 2,
  sleepDurationMs: 3_600_000,
  lockDurationMs: 2_400_000,
  observedMs: 28_800_000,
};

export const MOCK_MONTHLY_2026_10: MonthlySummaryView = {
  month: '2026-10',
  coveredDays: 29,
  daysInMonth: 31,
  partial: true,
  pendingDays: ['2026-10-02', '2026-10-19'],
  topApps: [
    { app: 'CodeForge', foregroundMs: 240 * 3_600_000, switches: 410 },
    { app: 'TermShell', foregroundMs: 98 * 3_600_000, switches: 260 },
    { app: 'DocReader', foregroundMs: 64 * 3_600_000, switches: 150 },
    { app: 'NotesPad', foregroundMs: 28 * 3_600_000, switches: 95 },
    { app: 'MailBox', foregroundMs: 14 * 3_600_000, switches: 48 },
  ],
  wakeCount: 12,
  alertCount: 7,
  fileBurstCount: 5,
  sleepCount: 24,
  sleepDurationMs: 36 * 3_600_000,
  lockDurationMs: 42 * 3_600_000,
  observedMs: 480 * 3_600_000,
};

export function historyReady(base: SensePanelModel): SensePanelModel {
  return {
    ...base,
    timeline: {
      today: MOCK_TODAY_SUMMARY,
      yesterday: MOCK_YESTERDAY_SUMMARY,
      metrics: makeTimelineMetrics24h(),
      lastAway: {
        awayFrom: T0 - 2 * 3_600_000,
        returnAt: T0 - 60_000,
        durationMs: 2 * 3_600_000,
        hasAnomaly: false,
        anomalies: [],
        pushed: false,
      },
    },
  };
}

export function historyEmpty(base: SensePanelModel): SensePanelModel {
  return {
    ...base,
    events: [],
    timeline: undefined,
  };
}

export function historyAwayAnomaly(base: SensePanelModel): SensePanelModel {
  return {
    ...base,
    timeline: {
      today: MOCK_TODAY_SUMMARY,
      yesterday: MOCK_YESTERDAY_SUMMARY,
      metrics: makeTimelineMetrics24h(),
      lastAway: {
        awayFrom: T0 - 3.5 * 3_600_000,
        returnAt: T0 - 120_000,
        durationMs: 3.5 * 3_600_000,
        hasAnomaly: true,
        anomalies: ['磁盘可用 注意告警 2 次', '外部删除 14 个文件（workspace-demo）'],
        pushed: true,
      },
    },
  };
}
