import type { DeliveryLevel, SignalCause, SourceRef } from '@asi/sense-types';
import { type DayBounds, datesInMonth, daysInMonth, parseDateKey, parseMonthKey } from './time.ts';
import {
  type DailyAppStats,
  type DailyDeliveryCounts,
  type DailyDirectoryStats,
  type DailySummary,
  type HistoryLifecycleRecord,
  type HistoryLifecycleState,
  isNonEmptyString,
  type MonthlySummary,
  type PersistedEventEntry,
  sanitizeAppName,
  sanitizeDirPath,
} from './types.ts';

export interface ParsedHistoryDay {
  events: PersistedEventEntry[];
  lifecycle: HistoryLifecycleRecord[];
}

const VALID_LEVELS = new Set<DeliveryLevel>(['record', 'context', 'wake']);
const VALID_CAUSES = new Set<SignalCause>(['agent', 'user', 'unknown']);
const VALID_LIFECYCLE = new Set<HistoryLifecycleState>(['active', 'paused', 'stopped', 'heartbeat']);

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validSource(value: unknown): SourceRef {
  if (!isRecordObject(value)) return { id: 'unknown', api: 'unknown', host: 'local' };
  return {
    id: typeof value.id === 'string' ? value.id : 'unknown',
    api: typeof value.api === 'string' ? value.api : 'unknown',
    host: typeof value.host === 'string' ? value.host : 'local',
  };
}

function validDetail(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!isRecordObject(value)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  let hasAny = false;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) {
      out[k] = v;
      hasAny = true;
    }
  }
  return hasAny ? out : undefined;
}

function validEta(value: unknown): PersistedEventEntry['currentEta'] | undefined {
  if (!isRecordObject(value)) return undefined;
  if (
    typeof value.asOf !== 'number' ||
    !Number.isFinite(value.asOf) ||
    typeof value.ratePerMinute !== 'number' ||
    !Number.isFinite(value.ratePerMinute)
  ) {
    return undefined;
  }
  return {
    asOf: value.asOf,
    ratePerMinute: value.ratePerMinute,
    ...(typeof value.timeToThresholdMs === 'number' && Number.isFinite(value.timeToThresholdMs)
      ? { timeToThresholdMs: value.timeToThresholdMs }
      : {}),
  };
}

export function toPersistedEvent(raw: Record<string, unknown>): PersistedEventEntry | undefined {
  if (
    typeof raw.id !== 'string' ||
    !raw.id ||
    typeof raw.kind !== 'string' ||
    !raw.kind ||
    typeof raw.at !== 'number' ||
    !Number.isFinite(raw.at)
  ) {
    return undefined;
  }
  const level: DeliveryLevel = VALID_LEVELS.has(raw.level as DeliveryLevel) ? (raw.level as DeliveryLevel) : 'record';
  const entry: PersistedEventEntry = {
    id: raw.id,
    kind: raw.kind,
    subject: typeof raw.subject === 'string' ? raw.subject : '',
    level,
    at: raw.at,
    source: validSource(raw.source),
  };
  if (typeof raw.reason === 'string') entry.reason = raw.reason;
  if (typeof raw.ruleId === 'string') entry.ruleId = raw.ruleId;
  if (VALID_CAUSES.has(raw.cause as SignalCause)) entry.cause = raw.cause as SignalCause;
  if (typeof raw.restarts === 'number' && Number.isFinite(raw.restarts)) entry.restarts = raw.restarts;
  const detail = validDetail(raw.detail);
  if (detail) entry.detail = detail;
  const eta = validEta(raw.currentEta);
  if (eta) entry.currentEta = eta;
  if (raw.feedback === 'useful' || raw.feedback === 'noise') entry.feedback = raw.feedback;
  if (typeof raw.feedbackAvailable === 'boolean') entry.feedbackAvailable = raw.feedbackAvailable;
  if (typeof raw.bundleId === 'string') entry.bundleId = raw.bundleId;
  if (typeof raw.title === 'string') entry.title = raw.title;
  return entry;
}

export function createHistoryLineParser() {
  const eventsById = new Map<string, PersistedEventEntry>();
  const lifecycle: HistoryLifecycleRecord[] = [];
  return {
    feed(rawLine: string): void {
      const line = rawLine.trim();
      if (!line) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecordObject(parsed)) return;
      if (parsed.record === 'lifecycle') {
        if (
          VALID_LIFECYCLE.has(parsed.state as HistoryLifecycleState) &&
          typeof parsed.at === 'number' &&
          Number.isFinite(parsed.at)
        ) {
          lifecycle.push({
            record: 'lifecycle',
            state: parsed.state as HistoryLifecycleState,
            at: parsed.at,
            ...(typeof parsed.paused === 'boolean' ? { paused: parsed.paused } : {}),
            ...(typeof parsed.app === 'string' ? { app: parsed.app } : {}),
            ...(typeof parsed.boot === 'boolean' ? { boot: parsed.boot } : {}),
          });
        }
        return;
      }
      if (parsed.record === 'patch') {
        if (typeof parsed.id !== 'string') return;
        const existing = eventsById.get(parsed.id);
        if (!existing) return;
        if (VALID_LEVELS.has(parsed.level as DeliveryLevel)) existing.level = parsed.level as DeliveryLevel;
        if (typeof parsed.reason === 'string') existing.reason = parsed.reason;
        if (parsed.feedback === 'useful' || parsed.feedback === 'noise') existing.feedback = parsed.feedback;
        return;
      }
      if (parsed.record === 'event' || parsed.record === undefined) {
        const event = toPersistedEvent(parsed);
        if (event) eventsById.set(event.id, event);
      }
    },
    finish(): ParsedHistoryDay {
      return { events: [...eventsById.values()], lifecycle };
    },
  };
}

export function parseHistoryLines(jsonl: string): ParsedHistoryDay {
  const parser = createHistoryLineParser();
  let start = 0;
  while (start < jsonl.length) {
    const nl = jsonl.indexOf('\n', start);
    if (nl < 0) {
      parser.feed(jsonl.slice(start));
      break;
    }
    parser.feed(jsonl.slice(start, nl));
    start = nl + 1;
  }
  return parser.finish();
}

export async function parseHistoryStream(lines: AsyncIterable<string>): Promise<ParsedHistoryDay> {
  const parser = createHistoryLineParser();
  for await (const line of lines) {
    parser.feed(line);
  }
  return parser.finish();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function getOrInit<T>(record: Record<string, T>, key: string, create: () => T): T {
  const existing = record[key];
  if (existing !== undefined) return existing;
  const created = create();
  record[key] = created;
  return created;
}

function addAppDuration(apps: Record<string, DailyAppStats>, app: string | undefined, ms: number): void {
  if (!app || ms <= 0) return;
  const entry = getOrInit(apps, app, () => ({ foregroundMs: 0, switches: 0 }));
  entry.foregroundMs += ms;
}

function addDirStats(
  target: Record<string, DailyDirectoryStats>,
  dir: string,
  detail: Record<string, string | number | boolean> | undefined,
  withExcessiveDeletion: boolean,
): void {
  const entry = getOrInit<DailyDirectoryStats>(target, dir, () => ({
    events: 0,
    created: 0,
    modified: 0,
    deleted: 0,
  }));
  entry.events += 1;
  entry.created += finiteCount(detail?.created);
  entry.modified += finiteCount(detail?.modified);
  entry.deleted += finiteCount(detail?.deleted);
  if (withExcessiveDeletion && detail?.externalDeletionExceeded === true) {
    entry.externalDeletionExceeded = (entry.externalDeletionExceeded ?? 0) + 1;
  }
}

function bumpDelivery(target: DailyDeliveryCounts, wake: boolean, context: boolean, suppressed: boolean): void {
  if (wake) target.wake += 1;
  if (context) target.context += 1;
  if (suppressed) target.suppressed += 1;
}

export interface SummarizeDayOptions {
  liveEndMs?: number;
  isRunningAtEnd?: boolean;
  truncatedAtLimit?: boolean;
}

export function summarizeDay(
  date: string,
  parsed: ParsedHistoryDay,
  bounds: DayBounds,
  options: SummarizeDayOptions = {},
): DailySummary {
  const { startMs, endMs, durationMs } = bounds;
  const events = [...parsed.events].sort((a, b) => a.at - b.at);
  const lifecycle = [...parsed.lifecycle].sort((a, b) => a.at - b.at);

  const apps: Record<string, DailyAppStats> = Object.create(null) as Record<string, DailyAppStats>;
  let appSwitches = 0;

  let observedMs = 0;
  let pausedMs = 0;
  let notRunningMs = 0;

  const activations = events.filter((ev) => ev.kind === 'app.activated' && isNonEmptyString(ev.subject));

  if (lifecycle.length > 0) {
    type TimelineItem =
      | { order: 0; at: number; item: HistoryLifecycleRecord }
      | { order: 1; at: number; item: PersistedEventEntry }
      | { order: 2; at: number };

    const timeline: TimelineItem[] = [
      ...lifecycle.map((item): TimelineItem => ({ order: 0, at: clamp(item.at, startMs, endMs), item })),
      ...activations.map((item): TimelineItem => ({ order: 1, at: clamp(item.at, startMs, endMs), item })),
      ...events
        .filter((ev) => ev.kind !== 'app.activated')
        .map((ev): TimelineItem => ({ order: 2, at: clamp(ev.at, startMs, endMs) })),
    ].sort((a, b) => a.at - b.at || a.order - b.order);

    let state: 'not-running' | 'active' | 'paused' = 'not-running';
    let cursor = startMs;
    let lastAlive = startMs;
    let currentApp: string | undefined;
    let appSince: number | undefined;

    const advanceCoverage = (to: number) => {
      const dt = Math.max(0, to - cursor);
      if (state === 'active') observedMs += dt;
      else if (state === 'paused') pausedMs += dt;
      else notRunningMs += dt;
      cursor = to;
    };

    const closeCrashGap = (at: number) => {
      if (state === 'not-running') return;
      const aliveEnd = clamp(lastAlive, cursor, at);
      advanceCoverage(aliveEnd);
      if (state === 'active' && currentApp && appSince !== undefined) {
        addAppDuration(apps, currentApp, aliveEnd - appSince);
      }
      state = 'not-running';
      currentApp = undefined;
      appSince = undefined;
      advanceCoverage(at);
    };

    for (const entry of timeline) {
      const at = entry.at;
      if (entry.order === 2) {
        if (state !== 'not-running' && at > lastAlive) lastAlive = at;
        continue;
      }
      if (entry.order === 0 && entry.item.boot && state !== 'not-running') {
        closeCrashGap(at);
      } else {
        advanceCoverage(at);
      }
      if (entry.order === 1) {
        if (at > lastAlive) lastAlive = at;
        const appName = sanitizeAppName(entry.item.subject);
        if (!appName) continue;
        const appStats = getOrInit(apps, appName, () => ({ foregroundMs: 0, switches: 0 }));
        appStats.switches += 1;
        appSwitches += 1;
        if (state === 'active') {
          if (currentApp && appSince !== undefined) {
            addAppDuration(apps, currentApp, at - appSince);
          }
          appSince = at;
        }
        currentApp = appName;
        continue;
      }

      const lc = entry.item;
      if (lc.state === 'active') {
        if (state === 'active' && currentApp && appSince !== undefined) {
          addAppDuration(apps, currentApp, at - appSince);
        }
        state = 'active';
        lastAlive = Math.max(lastAlive, at);
        if (isNonEmptyString(lc.app) && !currentApp) {
          currentApp = sanitizeAppName(lc.app);
        }
        appSince = currentApp ? at : undefined;
      } else if (lc.state === 'paused') {
        if (state === 'active' && currentApp && appSince !== undefined) {
          addAppDuration(apps, currentApp, at - appSince);
        }
        state = 'paused';
        lastAlive = Math.max(lastAlive, at);
        if (isNonEmptyString(lc.app) && !currentApp) {
          currentApp = sanitizeAppName(lc.app);
        }
        appSince = undefined;
      } else if (lc.state === 'stopped') {
        if (state === 'active' && currentApp && appSince !== undefined) {
          addAppDuration(apps, currentApp, at - appSince);
        }
        state = 'not-running';
        lastAlive = Math.max(lastAlive, at);
        currentApp = undefined;
        appSince = undefined;
      } else if (lc.state === 'heartbeat') {
        const nextState = lc.paused ? 'paused' : 'active';
        lastAlive = Math.max(lastAlive, at);
        if (state === 'not-running') {
          state = nextState;
          if (state === 'active' && currentApp) appSince = at;
        } else if (state === 'active' && nextState === 'paused') {
          if (currentApp && appSince !== undefined) {
            addAppDuration(apps, currentApp, at - appSince);
          }
          state = 'paused';
          appSince = undefined;
        } else if (state === 'paused' && nextState === 'active') {
          state = 'active';
          appSince = currentApp ? at : undefined;
        }
      }
    }

    if (state === 'not-running') {
      notRunningMs += Math.max(0, endMs - cursor);
    } else {
      const activeEnd = options.isRunningAtEnd
        ? clamp(options.liveEndMs ?? endMs, cursor, endMs)
        : clamp(lastAlive, cursor, endMs);
      advanceCoverage(activeEnd);
      if (state === 'active' && currentApp && appSince !== undefined) {
        addAppDuration(apps, currentApp, activeEnd - appSince);
      }
      notRunningMs += Math.max(0, endMs - activeEnd);
    }
  } else if (events.length > 0) {
    const firstAt = clamp(events[0].at, startMs, endMs);
    const lastAt = clamp(events[events.length - 1].at, startMs, endMs);
    let currentApp: string | undefined;
    let appSince: number | undefined;
    for (const ev of activations) {
      const at = clamp(ev.at, startMs, endMs);
      const appName = sanitizeAppName(ev.subject);
      if (!appName) continue;
      const appStats = getOrInit(apps, appName, () => ({ foregroundMs: 0, switches: 0 }));
      appStats.switches += 1;
      appSwitches += 1;
      if (currentApp && appSince !== undefined) {
        addAppDuration(apps, currentApp, at - appSince);
      }
      currentApp = appName;
      appSince = at;
    }
    if (currentApp && appSince !== undefined) {
      addAppDuration(apps, currentApp, Math.max(0, lastAt - appSince));
    }
    observedMs = Math.max(0, lastAt - firstAt);
    notRunningMs = Math.max(0, durationMs - observedMs);
  } else {
    notRunningMs = durationMs;
  }

  const deliveries: DailySummary['deliveries'] = {
    wake: 0,
    context: 0,
    suppressed: 0,
    byRule: Object.create(null) as Record<string, DailyDeliveryCounts>,
  };
  const fileBursts: Record<string, DailyDirectoryStats> = Object.create(null) as Record<string, DailyDirectoryStats>;
  const fileActivity: Record<string, DailyDirectoryStats> = Object.create(null) as Record<string, DailyDirectoryStats>;
  const bodyAnomalies: DailySummary['bodyAnomalies'] = {
    total: 0,
    threshold: 0,
    rate: 0,
    anomaly: 0,
    byMetric: Object.create(null) as Record<string, number>,
  };

  for (const ev of events) {
    const suppressed = ev.reason === 'wake-budget' || ev.reason === 'no-session' || ev.reason === 'self-caused';
    const isWake = ev.level === 'wake' && ev.reason !== 'no-session';
    const isContext = ev.level === 'context';
    if (isWake || isContext || suppressed) {
      bumpDelivery(deliveries, isWake, isContext, suppressed);
      const ruleKey = isNonEmptyString(ev.ruleId) ? ev.ruleId : '_none';
      const ruleCounts = getOrInit(deliveries.byRule, ruleKey, () => ({ wake: 0, context: 0, suppressed: 0 }));
      bumpDelivery(ruleCounts, isWake, isContext, suppressed);
    }

    if (ev.kind === 'file.burst') {
      const rawDir =
        typeof ev.detail?.directory === 'string'
          ? ev.detail.directory
          : typeof ev.detail?.dir === 'string'
            ? ev.detail.dir
            : ev.subject;
      addDirStats(fileBursts, sanitizeDirPath(rawDir), ev.detail, true);
    } else if (ev.kind === 'file.activity') {
      const rawDir =
        typeof ev.detail?.directory === 'string'
          ? ev.detail.directory
          : typeof ev.detail?.dir === 'string'
            ? ev.detail.dir
            : ev.subject;
      addDirStats(fileActivity, sanitizeDirPath(rawDir), ev.detail, false);
    } else if (ev.kind === 'body.threshold' || ev.kind === 'body.rate' || ev.kind === 'body.anomaly') {
      const isRebaseline =
        ev.kind === 'body.anomaly' &&
        (ev.detail?.type === 'rebaseline-suggestion' ||
          ev.id.startsWith('rebaseline:') ||
          ev.subject.startsWith('rebaseline:'));
      if (isRebaseline) continue;
      const severity = ev.detail?.severity;
      if (severity !== 'warn' && severity !== 'critical') continue;
      bodyAnomalies.total += 1;
      if (ev.kind === 'body.threshold') bodyAnomalies.threshold += 1;
      else if (ev.kind === 'body.rate') bodyAnomalies.rate += 1;
      else bodyAnomalies.anomaly += 1;

      const rawMetric =
        ev.kind === 'body.threshold'
          ? ev.subject
          : typeof ev.detail?.metric === 'string'
            ? ev.detail.metric
            : ev.subject;
      let metric = rawMetric;
      if (rawMetric.startsWith('disk:')) {
        metric = `disk:${sanitizeDirPath(rawMetric.slice(5))}`;
      } else {
        const diskIdx = rawMetric.indexOf(':disk:');
        if (diskIdx >= 0) {
          metric = `disk:${sanitizeDirPath(rawMetric.slice(diskIdx + 6))}`;
        }
      }
      if (metric) bodyAnomalies.byMetric[metric] = (bodyAnomalies.byMetric[metric] ?? 0) + 1;
    }
  }

  return {
    version: 1,
    date,
    dayStartMs: startMs,
    dayEndMs: endMs,
    dayDurationMs: durationMs,
    apps,
    appSwitches,
    deliveries,
    fileBursts,
    fileActivity,
    bodyAnomalies,
    coverage: { observedMs, pausedMs, notRunningMs },
    totalEvents: events.length,
    ...(options.truncatedAtLimit ? { truncatedAtLimit: true } : {}),
  };
}

function isFiniteNonNeg(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isValidAppStats(value: unknown): value is DailyAppStats {
  return isRecordObject(value) && isFiniteNonNeg(value.foregroundMs) && isFiniteNonNeg(value.switches);
}

function isValidDeliveryCounts(value: unknown): value is DailyDeliveryCounts {
  return (
    isRecordObject(value) &&
    isFiniteNonNeg(value.wake) &&
    isFiniteNonNeg(value.context) &&
    isFiniteNonNeg(value.suppressed)
  );
}

function isValidDeliveries(value: unknown): value is DailySummary['deliveries'] {
  return (
    isValidDeliveryCounts(value) && allRecordEntriesValid((value as { byRule?: unknown }).byRule, isValidDeliveryCounts)
  );
}

function isValidDirStats(value: unknown): value is DailyDirectoryStats {
  return (
    isRecordObject(value) &&
    isFiniteNonNeg(value.events) &&
    isFiniteNonNeg(value.created) &&
    isFiniteNonNeg(value.modified) &&
    isFiniteNonNeg(value.deleted) &&
    (value.externalDeletionExceeded === undefined || isFiniteNonNeg(value.externalDeletionExceeded))
  );
}

function allRecordEntriesValid<T>(value: unknown, check: (entry: unknown) => entry is T): value is Record<string, T> {
  if (!isRecordObject(value)) return false;
  for (const item of Object.values(value)) {
    if (!check(item)) return false;
  }
  return true;
}

export function parseDailySummary(raw: string): DailySummary | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !isRecordObject(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.date !== 'string' ||
    !parseDateKey(parsed.date) ||
    !isFiniteNonNeg(parsed.dayStartMs) ||
    !isFiniteNonNeg(parsed.dayEndMs) ||
    !isFiniteNonNeg(parsed.dayDurationMs) ||
    !isFiniteNonNeg(parsed.appSwitches) ||
    !isFiniteNonNeg(parsed.totalEvents)
  ) {
    return undefined;
  }
  if (parsed.truncatedAtLimit !== undefined && typeof parsed.truncatedAtLimit !== 'boolean') return undefined;
  if (
    !isRecordObject(parsed.coverage) ||
    !isFiniteNonNeg(parsed.coverage.observedMs) ||
    !isFiniteNonNeg(parsed.coverage.pausedMs) ||
    !isFiniteNonNeg(parsed.coverage.notRunningMs)
  ) {
    return undefined;
  }
  if (!allRecordEntriesValid(parsed.apps, isValidAppStats)) return undefined;
  if (!isValidDeliveries(parsed.deliveries)) {
    return undefined;
  }
  if (!allRecordEntriesValid(parsed.fileBursts, isValidDirStats)) return undefined;
  if (!allRecordEntriesValid(parsed.fileActivity, isValidDirStats)) return undefined;
  if (
    !isRecordObject(parsed.bodyAnomalies) ||
    !isFiniteNonNeg(parsed.bodyAnomalies.total) ||
    !isFiniteNonNeg(parsed.bodyAnomalies.threshold) ||
    !isFiniteNonNeg(parsed.bodyAnomalies.rate) ||
    !isFiniteNonNeg(parsed.bodyAnomalies.anomaly) ||
    !allRecordEntriesValid(parsed.bodyAnomalies.byMetric, isFiniteNonNeg)
  ) {
    return undefined;
  }
  return parsed as unknown as DailySummary;
}

export function parseMonthlySummary(raw: string): MonthlySummary | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !isRecordObject(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.month !== 'string' ||
    !parseMonthKey(parsed.month) ||
    !isFiniteNonNeg(parsed.daysInMonth) ||
    !isFiniteNonNeg(parsed.coveredDays) ||
    !isFiniteNonNeg(parsed.appSwitches) ||
    !isFiniteNonNeg(parsed.totalEvents) ||
    !isFiniteNonNeg(parsed.generatedAt)
  ) {
    return undefined;
  }
  if (
    !Array.isArray(parsed.missingDays) ||
    !parsed.missingDays.every((d) => typeof d === 'string') ||
    !Array.isArray(parsed.includedDays) ||
    !parsed.includedDays.every((d) => typeof d === 'string')
  ) {
    return undefined;
  }
  if (
    !isRecordObject(parsed.coverage) ||
    !isFiniteNonNeg(parsed.coverage.totalDayMs) ||
    !isFiniteNonNeg(parsed.coverage.observedMs) ||
    !isFiniteNonNeg(parsed.coverage.pausedMs) ||
    !isFiniteNonNeg(parsed.coverage.notRunningMs)
  ) {
    return undefined;
  }
  if (!allRecordEntriesValid(parsed.apps, isValidAppStats)) return undefined;
  if (!isValidDeliveries(parsed.deliveries)) {
    return undefined;
  }
  if (!allRecordEntriesValid(parsed.fileBursts, isValidDirStats)) return undefined;
  if (!allRecordEntriesValid(parsed.fileActivity, isValidDirStats)) return undefined;
  if (
    !isRecordObject(parsed.bodyAnomalies) ||
    !isFiniteNonNeg(parsed.bodyAnomalies.total) ||
    !isFiniteNonNeg(parsed.bodyAnomalies.threshold) ||
    !isFiniteNonNeg(parsed.bodyAnomalies.rate) ||
    !isFiniteNonNeg(parsed.bodyAnomalies.anomaly) ||
    !allRecordEntriesValid(parsed.bodyAnomalies.byMetric, isFiniteNonNeg)
  ) {
    return undefined;
  }
  return parsed as unknown as MonthlySummary;
}

function mergeDirStats(target: Record<string, DailyDirectoryStats>, source: Record<string, DailyDirectoryStats>): void {
  for (const [dir, stats] of Object.entries(source)) {
    if (!isRecordObject(stats)) continue;
    const dest = getOrInit<DailyDirectoryStats>(target, dir, () => ({
      events: 0,
      created: 0,
      modified: 0,
      deleted: 0,
    }));
    dest.events += finiteCount(stats.events);
    dest.created += finiteCount(stats.created);
    dest.modified += finiteCount(stats.modified);
    dest.deleted += finiteCount(stats.deleted);
    if (
      typeof stats.externalDeletionExceeded === 'number' &&
      Number.isFinite(stats.externalDeletionExceeded) &&
      stats.externalDeletionExceeded > 0
    ) {
      dest.externalDeletionExceeded = (dest.externalDeletionExceeded ?? 0) + stats.externalDeletionExceeded;
    }
  }
}

export function synthesizeMonth(month: string, dailies: readonly DailySummary[], generatedAt: number): MonthlySummary {
  const byDate = new Map<string, DailySummary>();
  for (const daily of dailies) {
    if (daily.date.startsWith(`${month}-`)) byDate.set(daily.date, daily);
  }
  const allDates = datesInMonth(month);
  const includedDays: string[] = [];
  const missingDays: string[] = [];
  for (const date of allDates) {
    if (byDate.has(date)) includedDays.push(date);
    else missingDays.push(date);
  }

  const apps: Record<string, DailyAppStats> = Object.create(null) as Record<string, DailyAppStats>;
  let appSwitches = 0;
  const deliveries: MonthlySummary['deliveries'] = {
    wake: 0,
    context: 0,
    suppressed: 0,
    byRule: Object.create(null) as Record<string, DailyDeliveryCounts>,
  };
  const fileBursts: Record<string, DailyDirectoryStats> = Object.create(null) as Record<string, DailyDirectoryStats>;
  const fileActivity: Record<string, DailyDirectoryStats> = Object.create(null) as Record<string, DailyDirectoryStats>;
  const bodyAnomalies: MonthlySummary['bodyAnomalies'] = {
    total: 0,
    threshold: 0,
    rate: 0,
    anomaly: 0,
    byMetric: Object.create(null) as Record<string, number>,
  };
  const coverage = { totalDayMs: 0, observedMs: 0, pausedMs: 0, notRunningMs: 0 };
  let totalEvents = 0;

  for (const date of includedDays) {
    const d = byDate.get(date);
    if (!d) continue;
    appSwitches += finiteCount(d.appSwitches);
    totalEvents += finiteCount(d.totalEvents);
    coverage.totalDayMs += finiteCount(d.dayDurationMs);
    coverage.observedMs += finiteCount(d.coverage?.observedMs);
    coverage.pausedMs += finiteCount(d.coverage?.pausedMs);
    coverage.notRunningMs += finiteCount(d.coverage?.notRunningMs);

    for (const [app, stats] of Object.entries(d.apps ?? {})) {
      if (!isRecordObject(stats)) continue;
      const dest = getOrInit(apps, app, () => ({ foregroundMs: 0, switches: 0 }));
      dest.foregroundMs += finiteCount(stats.foregroundMs);
      dest.switches += finiteCount(stats.switches);
    }

    deliveries.wake += finiteCount(d.deliveries?.wake);
    deliveries.context += finiteCount(d.deliveries?.context);
    deliveries.suppressed += finiteCount(d.deliveries?.suppressed);
    for (const [ruleId, counts] of Object.entries(d.deliveries?.byRule ?? {})) {
      if (!isRecordObject(counts)) continue;
      const dest = getOrInit(deliveries.byRule, ruleId, () => ({ wake: 0, context: 0, suppressed: 0 }));
      dest.wake += finiteCount(counts.wake);
      dest.context += finiteCount(counts.context);
      dest.suppressed += finiteCount(counts.suppressed);
    }

    if (isRecordObject(d.fileBursts)) mergeDirStats(fileBursts, d.fileBursts);
    if (isRecordObject(d.fileActivity)) mergeDirStats(fileActivity, d.fileActivity);

    bodyAnomalies.total += finiteCount(d.bodyAnomalies?.total);
    bodyAnomalies.threshold += finiteCount(d.bodyAnomalies?.threshold);
    bodyAnomalies.rate += finiteCount(d.bodyAnomalies?.rate);
    bodyAnomalies.anomaly += finiteCount(d.bodyAnomalies?.anomaly);
    for (const [metric, count] of Object.entries(d.bodyAnomalies?.byMetric ?? {})) {
      bodyAnomalies.byMetric[metric] = (bodyAnomalies.byMetric[metric] ?? 0) + finiteCount(count);
    }
  }

  return {
    version: 1,
    month,
    daysInMonth: daysInMonth(month),
    coveredDays: includedDays.length,
    missingDays,
    includedDays,
    apps,
    appSwitches,
    deliveries,
    fileBursts,
    fileActivity,
    bodyAnomalies,
    coverage,
    totalEvents,
    generatedAt,
  };
}
