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

function validDetail(value: unknown): Record<string, string | number | boolean | string[]> | undefined {
  if (!isRecordObject(value)) return undefined;
  const out: Record<string, string | number | boolean | string[]> = {};
  let hasAny = false;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) {
      out[k] = v;
      hasAny = true;
    } else if (Array.isArray(v)) {
      const items = v.filter((item): item is string => typeof item === 'string');
      if (items.length > 0) {
        out[k] = items;
        hasAny = true;
      }
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

function adjustDeliveryCounts(
  target: DailyDeliveryCounts,
  wake: boolean,
  context: boolean,
  suppressed: boolean,
  delta: 1 | -1,
): void {
  if (wake) target.wake += delta;
  if (context) target.context += delta;
  if (suppressed) target.suppressed += delta;
}

function levelToCode(level: DeliveryLevel): number {
  return level === 'wake' ? 2 : level === 'context' ? 1 : 0;
}

function reasonToCode(reason: unknown): number {
  if (reason === 'no-session') return 1;
  if (reason === 'wake-budget' || reason === 'self-caused') return 2;
  return 0;
}

function extractDirRaw(subject: string, detail: Record<string, unknown> | undefined): string {
  if (typeof detail?.directory === 'string') return detail.directory;
  if (typeof detail?.dir === 'string') return detail.dir;
  return subject;
}

function adjustDirStats(
  target: Record<string, DailyDirectoryStats>,
  dir: string,
  created: number,
  modified: number,
  deleted: number,
  excessive: boolean,
  delta: 1 | -1,
): void {
  if (delta === -1) {
    const existing = target[dir];
    if (!existing) return;
    existing.events -= 1;
    existing.created -= created;
    existing.modified -= modified;
    existing.deleted -= deleted;
    if (excessive && existing.externalDeletionExceeded !== undefined) {
      existing.externalDeletionExceeded -= 1;
      if (existing.externalDeletionExceeded <= 0) delete existing.externalDeletionExceeded;
    }
    if (existing.events <= 0) delete target[dir];
    return;
  }
  const entry = getOrInit<DailyDirectoryStats>(target, dir, () => ({
    events: 0,
    created: 0,
    modified: 0,
    deleted: 0,
  }));
  entry.events += 1;
  entry.created += created;
  entry.modified += modified;
  entry.deleted += deleted;
  if (excessive) {
    entry.externalDeletionExceeded = (entry.externalDeletionExceeded ?? 0) + 1;
  }
}

function extractBodyMetric(
  id: string,
  kind: string,
  subject: string,
  detail: Record<string, unknown> | undefined,
): { bodyType: 0 | 1 | 2; metric: string } | undefined {
  const isRebaseline =
    kind === 'body.anomaly' &&
    (detail?.type === 'rebaseline-suggestion' || id.startsWith('rebaseline:') || subject.startsWith('rebaseline:'));
  if (isRebaseline) return undefined;
  const severity = detail?.severity;
  if (severity !== 'warn' && severity !== 'critical') return undefined;
  const bodyType: 0 | 1 | 2 = kind === 'body.threshold' ? 0 : kind === 'body.rate' ? 1 : 2;
  const rawMetric = kind === 'body.threshold' ? subject : typeof detail?.metric === 'string' ? detail.metric : subject;
  let metric = rawMetric;
  if (rawMetric.startsWith('disk:')) {
    metric = `disk:${sanitizeDirPath(rawMetric.slice(5))}`;
  } else {
    const diskIdx = rawMetric.indexOf(':disk:');
    if (diskIdx >= 0) {
      metric = `disk:${sanitizeDirPath(rawMetric.slice(diskIdx + 6))}`;
    }
  }
  return { bodyType, metric };
}

function createLifecycleMachine(bounds: DayBounds, options: SummarizeDayOptions, apps: Record<string, DailyAppStats>) {
  const { startMs, endMs } = bounds;
  let state: 'not-running' | 'active' | 'paused' = 'not-running';
  let cursor = startMs;
  let lastAlive = startMs;
  let currentApp: string | undefined;
  let appSince: number | undefined;
  let observedMs = 0;
  let pausedMs = 0;
  let notRunningMs = 0;
  let appSwitches = 0;

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

  return {
    stepOther(rawAt: number): void {
      const at = clamp(rawAt, startMs, endMs);
      if (state !== 'not-running' && at > lastAlive) lastAlive = at;
    },
    stepActivation(rawAt: number, appName: string): void {
      const at = clamp(rawAt, startMs, endMs);
      advanceCoverage(at);
      if (at > lastAlive) lastAlive = at;
      if (!appName) return;
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
    },
    stepLifecycle(lc: HistoryLifecycleRecord): void {
      const at = clamp(lc.at, startMs, endMs);
      if (lc.boot && state !== 'not-running') {
        closeCrashGap(at);
      } else {
        advanceCoverage(at);
      }
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
    },
    finish(): { observedMs: number; pausedMs: number; notRunningMs: number; appSwitches: number } {
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
      return { observedMs, pausedMs, notRunningMs, appSwitches };
    },
  };
}

const LOW_PACK_RADIX = 16_777_216; // 2^24 fallback for ruleIdx >= 8 or slotIdx >= 1_048_576

function packEventState(
  levelCode: number,
  reasonCode: number,
  kindTag: number,
  ruleIdx: number,
  slotIdx: number,
): number {
  if (ruleIdx < 8 && slotIdx < 1_048_576) {
    return (slotIdx << 10) | (ruleIdx << 7) | (kindTag << 4) | (reasonCode << 2) | levelCode;
  }
  const low = (ruleIdx << 7) | (kindTag << 4) | (reasonCode << 2) | levelCode;
  return -(slotIdx * LOW_PACK_RADIX + low) - 1;
}

function unpackEventState(packed: number): {
  levelCode: number;
  reasonCode: number;
  kindTag: number;
  ruleIdx: number;
  slotIdx: number;
} {
  if (packed >= 0) {
    return {
      levelCode: packed & 3,
      reasonCode: (packed >>> 2) & 3,
      kindTag: (packed >>> 4) & 7,
      ruleIdx: (packed >>> 7) & 7,
      slotIdx: packed >>> 10,
    };
  }
  const raw = -packed - 1;
  const low = raw % LOW_PACK_RADIX;
  return {
    levelCode: low & 3,
    reasonCode: (low >>> 2) & 3,
    kindTag: (low >>> 4) & 7,
    ruleIdx: low >>> 7,
    slotIdx: (raw - low) / LOW_PACK_RADIX,
  };
}

export function createDailySummaryAccumulator(date: string, bounds: DayBounds, options: SummarizeDayOptions = {}) {
  const { startMs, endMs, durationMs } = bounds;
  const seenEvents = new Map<string, number>();
  const lifecycle: HistoryLifecycleRecord[] = [];

  const appNames: string[] = [''];
  const appNameToIdx = new Map<string, number>([['', 0]]);
  let actCap = 256;
  let actCount = 0;
  let actAt = new Float64Array(actCap);
  let actApp = new Int32Array(actCap);

  let otherCap = 256;
  let otherCount = 0;
  let otherAt = new Float64Array(otherCap);
  const emptyActAts: number[] = [];

  const ruleKeys: string[] = ['_none'];
  const ruleKeyToIdx = new Map<string, number>([['_none', 0]]);

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

  const fileDirs: string[] = [];
  const fileDirToIdx = new Map<string, number>();
  const fileOtherIdx: number[] = [];
  const fileDirIdx: number[] = [];
  const fileCreated: number[] = [];
  const fileModified: number[] = [];
  const fileDeleted: number[] = [];
  const fileFlags: number[] = [];

  const bodyMetrics: string[] = [];
  const bodyMetricToIdx = new Map<string, number>();
  const bodyOtherIdx: number[] = [];
  const bodyTypes: number[] = [];
  const bodyMetricIds: number[] = [];

  const applyDelivery = (levelCode: number, reasonCode: number, ruleIdx: number, delta: 1 | -1) => {
    const suppressed = reasonCode !== 0;
    const isWake = levelCode === 2 && reasonCode !== 1;
    const isContext = levelCode === 1;
    if (!isWake && !isContext && !suppressed) return;
    adjustDeliveryCounts(deliveries, isWake, isContext, suppressed, delta);
    const ruleKey = ruleKeys[ruleIdx] ?? '_none';
    if (delta === -1) {
      const ruleCounts = deliveries.byRule[ruleKey];
      if (!ruleCounts) return;
      adjustDeliveryCounts(ruleCounts, isWake, isContext, suppressed, -1);
      if (ruleCounts.wake <= 0 && ruleCounts.context <= 0 && ruleCounts.suppressed <= 0) {
        delete deliveries.byRule[ruleKey];
      }
      return;
    }
    const ruleCounts = getOrInit(deliveries.byRule, ruleKey, () => ({ wake: 0, context: 0, suppressed: 0 }));
    adjustDeliveryCounts(ruleCounts, isWake, isContext, suppressed, 1);
  };

  const pushActivation = (at: number, appName: string): number => {
    let appIdx = appNameToIdx.get(appName);
    if (appIdx === undefined) {
      appIdx = appNames.length;
      appNames.push(appName);
      appNameToIdx.set(appName, appIdx);
    }
    if (actCount === actCap) {
      actCap *= 2;
      const nextAt = new Float64Array(actCap);
      nextAt.set(actAt);
      actAt = nextAt;
      const nextApp = new Int32Array(actCap);
      nextApp.set(actApp);
      actApp = nextApp;
    }
    const idx = actCount++;
    actAt[idx] = at;
    actApp[idx] = appIdx;
    return idx;
  };

  const pushOtherAt = (at: number): number => {
    if (otherCount === otherCap) {
      otherCap *= 2;
      const nextAt = new Float64Array(otherCap);
      nextAt.set(otherAt);
      otherAt = nextAt;
    }
    const idx = otherCount++;
    otherAt[idx] = at;
    return idx;
  };

  const undoPrevious = (packed: number) => {
    const { levelCode, reasonCode, kindTag, ruleIdx, slotIdx } = unpackEventState(packed);

    applyDelivery(levelCode, reasonCode, ruleIdx, -1);
    if (kindTag === 0) {
      otherAt[slotIdx] = Number.NaN;
    } else if (kindTag === 1) {
      actApp[slotIdx] = -1;
    } else if (kindTag === 2) {
      emptyActAts[slotIdx] = Number.NaN;
    } else if (kindTag === 3) {
      otherAt[fileOtherIdx[slotIdx]] = Number.NaN;
      const flags = fileFlags[slotIdx];
      const target = (flags & 1) !== 0 ? fileBursts : fileActivity;
      const dir = fileDirs[fileDirIdx[slotIdx]];
      adjustDirStats(
        target,
        dir,
        fileCreated[slotIdx],
        fileModified[slotIdx],
        fileDeleted[slotIdx],
        (flags & 2) !== 0,
        -1,
      );
    } else if (kindTag === 4) {
      otherAt[bodyOtherIdx[slotIdx]] = Number.NaN;
      const bType = bodyTypes[slotIdx];
      bodyAnomalies.total -= 1;
      if (bType === 0) bodyAnomalies.threshold -= 1;
      else if (bType === 1) bodyAnomalies.rate -= 1;
      else bodyAnomalies.anomaly -= 1;
      const metricIdx = bodyMetricIds[slotIdx];
      if (metricIdx >= 0) {
        const metric = bodyMetrics[metricIdx];
        const nextCount = (bodyAnomalies.byMetric[metric] ?? 0) - 1;
        if (nextCount <= 0) delete bodyAnomalies.byMetric[metric];
        else bodyAnomalies.byMetric[metric] = nextCount;
      }
    }
  };

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
        const packed = seenEvents.get(parsed.id);
        if (packed === undefined) return;
        const { levelCode: oldLevel, reasonCode: oldReason, kindTag, ruleIdx, slotIdx } = unpackEventState(packed);
        const newLevel = VALID_LEVELS.has(parsed.level as DeliveryLevel)
          ? levelToCode(parsed.level as DeliveryLevel)
          : oldLevel;
        const newReason = typeof parsed.reason === 'string' ? reasonToCode(parsed.reason) : oldReason;
        if (newLevel === oldLevel && newReason === oldReason) return;
        applyDelivery(oldLevel, oldReason, ruleIdx, -1);
        applyDelivery(newLevel, newReason, ruleIdx, 1);
        seenEvents.set(parsed.id, packEventState(newLevel, newReason, kindTag, ruleIdx, slotIdx));
        return;
      }

      if (parsed.record !== 'event' && parsed.record !== undefined) return;
      if (
        typeof parsed.id !== 'string' ||
        !parsed.id ||
        typeof parsed.kind !== 'string' ||
        !parsed.kind ||
        typeof parsed.at !== 'number' ||
        !Number.isFinite(parsed.at)
      ) {
        return;
      }

      const prevPacked = seenEvents.get(parsed.id);
      if (prevPacked !== undefined) {
        undoPrevious(prevPacked);
      }

      const id = parsed.id;
      const kind = parsed.kind;
      const at = parsed.at;
      const subject = typeof parsed.subject === 'string' ? parsed.subject : '';
      const level: DeliveryLevel = VALID_LEVELS.has(parsed.level as DeliveryLevel)
        ? (parsed.level as DeliveryLevel)
        : 'record';
      const levelCode = levelToCode(level);
      const reasonCode = typeof parsed.reason === 'string' ? reasonToCode(parsed.reason) : 0;
      const ruleKey = isNonEmptyString(parsed.ruleId) ? parsed.ruleId : '_none';
      let ruleIdx = ruleKeyToIdx.get(ruleKey);
      if (ruleIdx === undefined) {
        ruleIdx = ruleKeys.length;
        ruleKeys.push(ruleKey);
        ruleKeyToIdx.set(ruleKey, ruleIdx);
      }

      applyDelivery(levelCode, reasonCode, ruleIdx, 1);

      let kindTag = 0;
      let slotIdx = 0;

      if (kind === 'app.activated') {
        if (isNonEmptyString(subject)) {
          kindTag = 1;
          slotIdx = pushActivation(at, sanitizeAppName(subject));
        } else {
          kindTag = 2;
          slotIdx = emptyActAts.length;
          emptyActAts.push(at);
        }
      } else if (kind === 'file.burst' || kind === 'file.activity') {
        const detail = isRecordObject(parsed.detail) ? parsed.detail : undefined;
        const isBurst = kind === 'file.burst';
        const dir = sanitizeDirPath(extractDirRaw(subject, detail));
        const created = finiteCount(detail?.created);
        const modified = finiteCount(detail?.modified);
        const deleted = finiteCount(detail?.deleted);
        const excessive = isBurst && detail?.externalDeletionExceeded === true;
        adjustDirStats(isBurst ? fileBursts : fileActivity, dir, created, modified, deleted, excessive, 1);

        let dIdx = fileDirToIdx.get(dir);
        if (dIdx === undefined) {
          dIdx = fileDirs.length;
          fileDirs.push(dir);
          fileDirToIdx.set(dir, dIdx);
        }
        kindTag = 3;
        slotIdx = fileOtherIdx.length;
        fileOtherIdx.push(pushOtherAt(at));
        fileDirIdx.push(dIdx);
        fileCreated.push(created);
        fileModified.push(modified);
        fileDeleted.push(deleted);
        fileFlags.push((isBurst ? 1 : 0) | (excessive ? 2 : 0));
      } else if (kind === 'body.threshold' || kind === 'body.rate' || kind === 'body.anomaly') {
        const detail = isRecordObject(parsed.detail) ? parsed.detail : undefined;
        const bodyInfo = extractBodyMetric(id, kind, subject, detail);
        if (bodyInfo) {
          bodyAnomalies.total += 1;
          if (bodyInfo.bodyType === 0) bodyAnomalies.threshold += 1;
          else if (bodyInfo.bodyType === 1) bodyAnomalies.rate += 1;
          else bodyAnomalies.anomaly += 1;
          let mIdx = -1;
          if (bodyInfo.metric) {
            bodyAnomalies.byMetric[bodyInfo.metric] = (bodyAnomalies.byMetric[bodyInfo.metric] ?? 0) + 1;
            mIdx = bodyMetricToIdx.get(bodyInfo.metric) ?? -1;
            if (mIdx < 0) {
              mIdx = bodyMetrics.length;
              bodyMetrics.push(bodyInfo.metric);
              bodyMetricToIdx.set(bodyInfo.metric, mIdx);
            }
          }
          kindTag = 4;
          slotIdx = bodyOtherIdx.length;
          bodyOtherIdx.push(pushOtherAt(at));
          bodyTypes.push(bodyInfo.bodyType);
          bodyMetricIds.push(mIdx);
        } else {
          kindTag = 0;
          slotIdx = pushOtherAt(at);
        }
      } else {
        kindTag = 0;
        slotIdx = pushOtherAt(at);
      }

      seenEvents.set(id, packEventState(levelCode, reasonCode, kindTag, ruleIdx, slotIdx));
    },

    finish(): DailySummary {
      const totalEvents = seenEvents.size;
      const apps: Record<string, DailyAppStats> = Object.create(null) as Record<string, DailyAppStats>;
      let appSwitches = 0;
      let observedMs = 0;
      let pausedMs = 0;
      let notRunningMs = 0;

      // Build ordered activation index array
      let actValid = 0;
      let actSorted = true;
      let prevActAt = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < actCount; i++) {
        if (actApp[i] !== -1) {
          actValid++;
          const t = actAt[i];
          if (t < prevActAt) actSorted = false;
          prevActAt = t;
        }
      }
      const actIndices = new Int32Array(actValid);
      for (let i = 0, p = 0; i < actCount; i++) {
        if (actApp[i] !== -1) actIndices[p++] = i;
      }
      if (!actSorted && actValid > 1) {
        actIndices.sort((a, b) => actAt[a] - actAt[b] || a - b);
      }

      if (lifecycle.length > 0) {
        lifecycle.sort((a, b) => a.at - b.at);

        let otherValid = 0;
        let otherSorted = true;
        let prevOtherAt = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < otherCount; i++) {
          const t = otherAt[i];
          if (!Number.isNaN(t)) {
            otherValid++;
            if (t < prevOtherAt) otherSorted = false;
            prevOtherAt = t;
          }
        }
        const otherSortedArr = new Float64Array(otherValid);
        for (let i = 0, p = 0; i < otherCount; i++) {
          const t = otherAt[i];
          if (!Number.isNaN(t)) otherSortedArr[p++] = t;
        }
        if (!otherSorted && otherValid > 1) {
          otherSortedArr.sort();
        }

        const machine = createLifecycleMachine(bounds, options, apps);
        let lcPtr = 0;
        let actPtr = 0;
        let otherPtr = 0;
        while (lcPtr < lifecycle.length || actPtr < actValid || otherPtr < otherValid) {
          const lcTime = lcPtr < lifecycle.length ? clamp(lifecycle[lcPtr].at, startMs, endMs) : Infinity;
          const actTime = actPtr < actValid ? clamp(actAt[actIndices[actPtr]], startMs, endMs) : Infinity;
          const otherTime = otherPtr < otherValid ? clamp(otherSortedArr[otherPtr], startMs, endMs) : Infinity;
          if (lcTime <= actTime && lcTime <= otherTime) {
            machine.stepLifecycle(lifecycle[lcPtr++]);
          } else if (actTime <= otherTime) {
            const idx = actIndices[actPtr++];
            machine.stepActivation(actAt[idx], appNames[actApp[idx]]);
          } else {
            machine.stepOther(otherSortedArr[otherPtr++]);
          }
        }
        const cov = machine.finish();
        observedMs = cov.observedMs;
        pausedMs = cov.pausedMs;
        notRunningMs = cov.notRunningMs;
        appSwitches = cov.appSwitches;
      } else if (totalEvents > 0) {
        let minAt = Number.POSITIVE_INFINITY;
        let maxAt = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < actValid; i++) {
          const t = actAt[actIndices[i]];
          if (t < minAt) minAt = t;
          if (t > maxAt) maxAt = t;
        }
        for (let i = 0; i < otherCount; i++) {
          const t = otherAt[i];
          if (!Number.isNaN(t)) {
            if (t < minAt) minAt = t;
            if (t > maxAt) maxAt = t;
          }
        }
        for (let i = 0; i < emptyActAts.length; i++) {
          const t = emptyActAts[i];
          if (!Number.isNaN(t)) {
            if (t < minAt) minAt = t;
            if (t > maxAt) maxAt = t;
          }
        }
        const firstAt = clamp(minAt, startMs, endMs);
        const lastAt = clamp(maxAt, startMs, endMs);
        let currentApp: string | undefined;
        let appSince: number | undefined;
        for (let i = 0; i < actValid; i++) {
          const idx = actIndices[i];
          const appName = appNames[actApp[idx]];
          if (!appName) continue;
          const at = clamp(actAt[idx], startMs, endMs);
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

      // Release large temporary containers promptly for GC.
      seenEvents.clear();
      lifecycle.length = 0;
      emptyActAts.length = 0;
      actAt = new Float64Array(0);
      actApp = new Int32Array(0);
      otherAt = new Float64Array(0);

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
        totalEvents,
        ...(options.truncatedAtLimit ? { truncatedAtLimit: true } : {}),
      };
    },
  };
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

    const machine = createLifecycleMachine(bounds, options, apps);
    for (const entry of timeline) {
      if (entry.order === 0) machine.stepLifecycle(entry.item);
      else if (entry.order === 1) machine.stepActivation(entry.item.at, sanitizeAppName(entry.item.subject));
      else machine.stepOther(entry.at);
    }
    const cov = machine.finish();
    observedMs = cov.observedMs;
    pausedMs = cov.pausedMs;
    notRunningMs = cov.notRunningMs;
    appSwitches = cov.appSwitches;
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
      adjustDeliveryCounts(deliveries, isWake, isContext, suppressed, 1);
      const ruleKey = isNonEmptyString(ev.ruleId) ? ev.ruleId : '_none';
      const ruleCounts = getOrInit(deliveries.byRule, ruleKey, () => ({ wake: 0, context: 0, suppressed: 0 }));
      adjustDeliveryCounts(ruleCounts, isWake, isContext, suppressed, 1);
    }

    if (ev.kind === 'file.burst' || ev.kind === 'file.activity') {
      const isBurst = ev.kind === 'file.burst';
      const rawDir = extractDirRaw(ev.subject, ev.detail);
      adjustDirStats(
        isBurst ? fileBursts : fileActivity,
        sanitizeDirPath(rawDir),
        finiteCount(ev.detail?.created),
        finiteCount(ev.detail?.modified),
        finiteCount(ev.detail?.deleted),
        isBurst && ev.detail?.externalDeletionExceeded === true,
        1,
      );
    } else if (ev.kind === 'body.threshold' || ev.kind === 'body.rate' || ev.kind === 'body.anomaly') {
      const bodyInfo = extractBodyMetric(ev.id, ev.kind, ev.subject, ev.detail);
      if (!bodyInfo) continue;
      bodyAnomalies.total += 1;
      if (bodyInfo.bodyType === 0) bodyAnomalies.threshold += 1;
      else if (bodyInfo.bodyType === 1) bodyAnomalies.rate += 1;
      else bodyAnomalies.anomaly += 1;
      if (bodyInfo.metric) {
        bodyAnomalies.byMetric[bodyInfo.metric] = (bodyAnomalies.byMetric[bodyInfo.metric] ?? 0) + 1;
      }
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
