import type { DeliveryLevel, SignalCause, SourceRef } from '@asi/sense-types';

export const HISTORY_RETENTION_DAYS = 30;
export const DAILY_SUMMARY_RETENTION_DAYS = 400;
export const MAX_DAILY_EVENT_BYTES = 20 * 1024 * 1024;
export const HISTORY_HEARTBEAT_MS = 300_000;
export const MAX_HISTORY_LIMIT = 200;
export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_QUERY_RANGE_MS = 30 * 86_400_000;

export interface PersistedEventEntry {
  id: string;
  kind: string;
  subject: string;
  level: DeliveryLevel;
  reason?: string;
  ruleId?: string;
  cause?: SignalCause;
  at: number;
  restarts?: number;
  source: SourceRef;
  detail?: Record<string, string | number | boolean>;
  currentEta?: { asOf: number; ratePerMinute: number; timeToThresholdMs?: number };
  feedback?: 'useful' | 'noise';
  feedbackAvailable?: boolean;
  bundleId?: string;
  title?: string;
}

export type HistoryLifecycleState = 'active' | 'paused' | 'stopped' | 'heartbeat';

export interface HistoryLifecycleRecord {
  record: 'lifecycle';
  state: HistoryLifecycleState;
  at: number;
  paused?: boolean;
  app?: string;
  boot?: boolean;
}

export interface HistoryPatchRecord {
  record: 'patch';
  id: string;
  level?: DeliveryLevel;
  reason?: string;
  feedback?: 'useful' | 'noise';
}

export type HistoryEventLine = PersistedEventEntry & { record: 'event' };

export interface DailyAppStats {
  foregroundMs: number;
  switches: number;
}

export interface DailyDirectoryStats {
  events: number;
  created: number;
  modified: number;
  deleted: number;
  externalDeletionExceeded?: number;
}

export interface DailyDeliveryCounts {
  wake: number;
  context: number;
  suppressed: number;
}

export interface DailySummary {
  version: 1;
  date: string;
  dayStartMs: number;
  dayEndMs: number;
  dayDurationMs: number;
  apps: Record<string, DailyAppStats>;
  appSwitches: number;
  deliveries: DailyDeliveryCounts & {
    byRule: Record<string, DailyDeliveryCounts>;
  };
  fileBursts: Record<string, DailyDirectoryStats>;
  fileActivity: Record<string, DailyDirectoryStats>;
  bodyAnomalies: {
    total: number;
    threshold: number;
    rate: number;
    anomaly: number;
    byMetric: Record<string, number>;
  };
  coverage: {
    observedMs: number;
    pausedMs: number;
    notRunningMs: number;
  };
  totalEvents: number;
  truncatedAtLimit?: boolean;
}

export interface MonthlySummary {
  version: 1;
  month: string;
  daysInMonth: number;
  coveredDays: number;
  missingDays: string[];
  includedDays: string[];
  apps: Record<string, DailyAppStats>;
  appSwitches: number;
  deliveries: DailyDeliveryCounts & {
    byRule: Record<string, DailyDeliveryCounts>;
  };
  fileBursts: Record<string, DailyDirectoryStats>;
  fileActivity: Record<string, DailyDirectoryStats>;
  bodyAnomalies: {
    total: number;
    threshold: number;
    rate: number;
    anomaly: number;
    byMetric: Record<string, number>;
  };
  coverage: {
    totalDayMs: number;
    observedMs: number;
    pausedMs: number;
    notRunningMs: number;
  };
  totalEvents: number;
  generatedAt: number;
  partial?: boolean;
}

export interface HistoryUnsafeEntry {
  kind: 'dir' | 'events' | 'daily' | 'monthly';
  name: string;
  code: string;
}

export interface HistoryStoragePort {
  eventFileSize(date: string): Promise<number>;
  appendEvent(date: string, line: string): Promise<void>;
  readEvents(date: string): Promise<string | undefined>;
  readEventLines?(date: string): AsyncIterable<string>;
  readEventLinesDesc?(date: string): AsyncIterable<string>;
  listEventDates(): Promise<string[]>;
  deleteEventDate(date: string): Promise<void>;

  readDaily(date: string): Promise<string | undefined>;
  writeDaily(date: string, json: string): Promise<void>;
  listDailyDates(): Promise<string[]>;
  deleteDailyDate(date: string): Promise<void>;

  readMonthly(month: string): Promise<string | undefined>;
  writeMonthly(month: string, json: string): Promise<void>;
  listMonthlyMonths(): Promise<string[]>;

  harden?(): Promise<HistoryUnsafeEntry[]>;
  clearAll(): Promise<void>;
}

export interface HistoryQuery {
  from?: number | string;
  to?: number | string;
  kinds?: readonly string[];
  app?: string;
  limit?: number;
}

export interface HistoryQueryResult {
  available: boolean;
  reason?: string;
  from: number;
  to: number;
  rangeClamped?: boolean;
  note?: string;
  limit: number;
  total: number;
  truncated: boolean;
  titlesAllowed: boolean;
  events: PersistedEventEntry[];
}

export interface SummaryQuery {
  month?: string;
}

export type SummaryQueryResult =
  | { available: true; partial?: boolean; pendingDays?: string[]; note?: string; summary: MonthlySummary }
  | { available: false; partial?: boolean; month: string; reason: string };

export function sanitizeAppName(value: string): string {
  return Array.from(value.replace(/\p{Cc}/gu, ''))
    .slice(0, 256)
    .join('');
}

export function sanitizeDirPath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts.at(-1) ?? '[path]';
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
