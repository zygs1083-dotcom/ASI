import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { DeliveryLevel, SignalCause, SourceRef } from '@asi/sense-types';
import {
  createDailySummaryAccumulator,
  parseDailySummary,
  parseMonthlySummary,
  type SummarizeDayOptions,
  synthesizeMonth,
  toPersistedEvent,
} from './summarize.ts';
import { addDays, diffDays, formatDate, LocalCalendar, parseDateKey, parseMonthKey, prevMonth } from './time.ts';
import {
  DAILY_SUMMARY_RETENTION_DAYS,
  type DailySummary,
  DEFAULT_HISTORY_LIMIT,
  defaultApiForSourceId,
  HISTORY_HEARTBEAT_MS,
  HISTORY_RETENTION_DAYS,
  type HistoryEventLine,
  type HistoryLifecycleRecord,
  type HistoryQuery,
  type HistoryQueryResult,
  type HistoryStoragePort,
  isNonEmptyString,
  MAX_DAILY_CRITICAL_EVENT_BYTES,
  MAX_DAILY_EVENT_BYTES,
  MAX_DAILY_FILE_EVENT_BYTES,
  MAX_DAILY_NON_FILE_EVENT_BYTES,
  MAX_HISTORY_LIMIT,
  MAX_HISTORY_TOTAL_BYTES,
  MAX_QUERY_RANGE_MS,
  type MonthlySummary,
  type PersistedEventEntry,
  type SummaryQuery,
  type SummaryQueryResult,
  sanitizeAppName,
  sanitizeDirPath,
} from './types.ts';

export class HistoryArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoryArgsError';
  }
}

export interface HistoryEventInput {
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
  detail?: Record<string, string | number | boolean | string[]>;
  currentEta?: { asOf: number; ratePerMinute: number; timeToThresholdMs?: number };
  feedback?: 'useful' | 'noise';
  feedbackAvailable?: boolean;
  restored?: boolean;
}

export interface HistoryManagerOptions {
  port?: HistoryStoragePort;
  clock: { wall(): number; mono(): number };
  isPaused: () => boolean;
  titlesAllowed: () => boolean;
  restoreEntries: (entries: PersistedEventEntry[]) => void;
  clearMemoryEntries: () => void;
  /** Snapshot of the in-memory event ring, restored when a clear fails. */
  snapshotMemoryEntries?: () => readonly PersistedEventEntry[];
  restoreMemoryEntries?: (entries: readonly PersistedEventEntry[]) => void;
  emitSourceError: (error: string, extra?: Record<string, unknown>) => void;
  restoreSourceError?: (error: string, extra?: Record<string, unknown>) => void;
  emitSourceOk: (extra?: Record<string, unknown>) => void;
  clearSourceCap?: () => void;
  timeZone?: string;
  maxDailyBytes?: number;
  maxFileDailyBytes?: number;
  maxNonFileDailyBytes?: number;
  maxCriticalDailyBytes?: number;
  maxTotalBytes?: number;
  heartbeatIntervalMs?: number;
  /** Extra `extensions` entries (e.g. metric buckets) for a day being summarized. */
  dayExtensions?: (date: string) => Record<string, unknown> | undefined;
  /** Called when background restore, rollover, or backfill updates today/yesterday summaries. */
  onSummaryChanged?: () => void;
}

function isEmptyDailySummary(summary: DailySummary): boolean {
  return (
    summary.totalEvents === 0 &&
    summary.coverage.observedMs === 0 &&
    Object.keys(summary.apps).length === 0 &&
    Object.keys(summary.fileBursts).length === 0 &&
    summary.deliveries.wake === 0 &&
    summary.bodyAnomalies.total === 0 &&
    (summary.system?.sleepCount ?? 0) === 0 &&
    (summary.system?.sleepDurationMs ?? 0) === 0 &&
    (summary.system?.lockDurationMs ?? 0) === 0
  );
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ]|$)/;
const MAX_BACKFILL_RETRIES = 3;
const PARTIAL_SUMMARY_NOTE =
  'Monthly summary is partial because daily backfill for some days is still pending or failed; retry later for complete data.';
const UNSAFE_FS_CODES = new Set(['ELOOP', 'EISDIR', 'ENOTDIR', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);
const VALID_LEVELS = new Set<DeliveryLevel>(['record', 'context', 'wake']);
const UUID_SEQ_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/i;
const BOOT_ID_RE = /^([a-z][0-9a-z]{3})-[0-9a-z]+$/;
const FILE_ACTIVITY_AGG_MS = 60_000;
const MAX_PENDING_ACTIVITY_BUCKETS = 4096;
const FLUSH_ACTIVITY_SLICE_MAX_BUCKETS = 16;
const FLUSH_ACTIVITY_SLICE_BUDGET_MS = 5;
const LATE_ROLLOVER_GRACE_MS = 120_000;
const LEVEL_RANK: Record<DeliveryLevel, number> = { record: 0, context: 1, wake: 2 };

interface PendingActivityBucket {
  key: string;
  date: string;
  diskId: string;
  dir: string;
  cause: SignalCause;
  source: SourceRef;
  level: DeliveryLevel;
  reason?: string;
  ruleId?: string;
  feedback?: 'useful' | 'noise';
  firstAt: number;
  latestAt: number;
  windowEndWall: number;
  flushMono: number;
  windowMsSum: number;
  created: number;
  modified: number;
  deleted: number;
  rolledUp: number;
  degraded: boolean;
  count: number;
  epoch: number;
  entryIds: string[];
}

function cloneActivityBucket(bucket: PendingActivityBucket, epoch = bucket.epoch): PendingActivityBucket {
  return {
    ...bucket,
    epoch,
    source: { ...bucket.source },
    entryIds: [...bucket.entryIds],
  };
}

function mergeActivityBuckets(
  base: PendingActivityBucket,
  extra: PendingActivityBucket,
  epoch: number,
): PendingActivityBucket {
  const preferExtraMeta = LEVEL_RANK[extra.level] > LEVEL_RANK[base.level];
  const mergedLevel = preferExtraMeta ? extra.level : base.level;
  const mergedReason = preferExtraMeta ? extra.reason : base.reason;
  const mergedRuleId = preferExtraMeta ? extra.ruleId : base.ruleId;
  const mergedFeedback = base.feedback ?? extra.feedback;
  return {
    key: base.key,
    date: base.date,
    diskId: base.diskId,
    dir: base.dir,
    cause: base.cause,
    source: { ...base.source },
    level: mergedLevel,
    ...(mergedReason !== undefined ? { reason: mergedReason } : {}),
    ...(mergedRuleId !== undefined ? { ruleId: mergedRuleId } : {}),
    ...(mergedFeedback !== undefined ? { feedback: mergedFeedback } : {}),
    firstAt: Math.min(base.firstAt, extra.firstAt),
    latestAt: Math.max(base.latestAt, extra.latestAt),
    windowEndWall: Math.max(base.windowEndWall, extra.windowEndWall),
    flushMono: Math.max(base.flushMono, extra.flushMono),
    windowMsSum: base.windowMsSum + extra.windowMsSum,
    created: base.created + extra.created,
    modified: base.modified + extra.modified,
    deleted: base.deleted + extra.deleted,
    rolledUp: base.rolledUp + extra.rolledUp,
    degraded: base.degraded || extra.degraded,
    count: base.count + extra.count,
    epoch,
    entryIds: [...base.entryIds, ...extra.entryIds],
  };
}

function finiteNonNeg(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function makeBootTag(): string {
  const bytes = randomBytes(4);
  const first = String.fromCharCode(97 + (bytes.readUInt8(0) % 26));
  const rest = (bytes.readUInt32BE(0) % (36 * 36 * 36)).toString(36).padStart(3, '0');
  return `${first}${rest}`;
}

function slimDetailForDisk(
  kind: string,
  subject: string,
  detail: Record<string, string | number | boolean | string[]> | undefined,
): Record<string, string | number | boolean | string[]> | undefined {
  if (!detail) return undefined;
  const out: Record<string, string | number | boolean | string[]> = {};
  let hasAny = false;
  for (const [key, val] of Object.entries(detail)) {
    if (kind === 'file.activity' && key === 'files') continue;
    if ((key === 'directory' || key === 'dir') && val === subject) continue;
    out[key] = Array.isArray(val) ? [...val] : val;
    hasAny = true;
  }
  return hasAny ? out : undefined;
}

function utcDateKey(ms: number): string {
  const d = new Date(ms);
  return formatDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unsafeFsCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && UNSAFE_FS_CODES.has(code) ? code : undefined;
}

function parseTimeBound(value: number | string, edge: 'start' | 'end', calendar: LocalCalendar): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new HistoryArgsError('from/to epoch timestamp must be a non-negative finite number');
    }
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) throw new HistoryArgsError('from/to string must not be empty');
  if (DATE_ONLY_RE.test(trimmed)) {
    if (!parseDateKey(trimmed)) throw new HistoryArgsError(`invalid calendar date: ${value}`);
    const bounds = calendar.dayBounds(trimmed);
    return edge === 'start' ? bounds.startMs : Math.max(bounds.startMs, bounds.endMs - 1);
  }
  const prefixMatch = ISO_DATE_PREFIX_RE.exec(trimmed);
  if (prefixMatch && !parseDateKey(prefixMatch[1])) {
    throw new HistoryArgsError(`invalid calendar date in ISO string: ${value}`);
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) throw new HistoryArgsError(`invalid ISO date/time string: ${value}`);
  return parsed;
}

function stripWindowEntry(entry: PersistedEventEntry): PersistedEventEntry {
  return {
    id: entry.id,
    kind: entry.kind,
    subject: '',
    level: entry.level,
    at: entry.at,
    source: { ...entry.source },
    ...(entry.cause !== undefined ? { cause: entry.cause } : {}),
    ...(entry.feedback !== undefined ? { feedback: entry.feedback } : {}),
  };
}

interface PendingPatch {
  level?: DeliveryLevel;
  reason?: string;
  feedback?: 'useful' | 'noise';
}

type BudgetTier = 'file' | 'nonFile';
type CapTier = BudgetTier | 'critical';

interface AppendOptions {
  tier?: BudgetTier;
  critical?: boolean;
}

interface DateByteUsage {
  total: number;
  file: number;
  nonFile: number;
  breakdownLoaded: boolean;
}

interface DayTierStats {
  fileBytes: number;
  nonFileBytes: number;
  fileLines: number;
  nonFileLines: number;
  maxFileLineBytes: number;
  maxNonFileLineBytes: number;
  sawCapError: boolean;
}

function createDayTierStats(): DayTierStats {
  return {
    fileBytes: 0,
    nonFileBytes: 0,
    fileLines: 0,
    nonFileLines: 0,
    maxFileLineBytes: 0,
    maxNonFileLineBytes: 0,
    sawCapError: false,
  };
}

function createReverseEventScanner() {
  const patches = new Map<string, PendingPatch>();
  const seenIds = new Set<string>();
  return {
    accept(line: string): PersistedEventEntry | undefined {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return undefined;
      }
      if (!isRecordObject(parsed)) return undefined;
      if (parsed.record === 'patch') {
        if (typeof parsed.id === 'string' && !seenIds.has(parsed.id)) {
          const p = patches.get(parsed.id) ?? {};
          if (p.level === undefined && VALID_LEVELS.has(parsed.level as DeliveryLevel)) {
            p.level = parsed.level as DeliveryLevel;
          }
          if (p.reason === undefined && typeof parsed.reason === 'string') p.reason = parsed.reason;
          if (p.feedback === undefined && (parsed.feedback === 'useful' || parsed.feedback === 'noise')) {
            p.feedback = parsed.feedback;
          }
          patches.set(parsed.id, p);
        }
        return undefined;
      }
      if (parsed.record !== 'event' && parsed.record !== undefined) return undefined;
      const ev = toPersistedEvent(parsed);
      if (!ev || seenIds.has(ev.id)) return undefined;
      seenIds.add(ev.id);
      const pendingPatch = patches.get(ev.id);
      if (pendingPatch) {
        if (pendingPatch.level !== undefined) ev.level = pendingPatch.level;
        if (pendingPatch.reason !== undefined) ev.reason = pendingPatch.reason;
        if (pendingPatch.feedback !== undefined) ev.feedback = pendingPatch.feedback;
        patches.delete(ev.id);
      }
      return ev;
    },
  };
}

export class HistoryManager {
  private readonly port?: HistoryStoragePort;
  private readonly clock: { wall(): number; mono(): number };
  private readonly isPaused: () => boolean;
  private readonly titlesAllowed: () => boolean;
  private readonly restoreEntries: (entries: PersistedEventEntry[]) => void;
  private readonly clearMemoryEntries: () => void;
  private readonly snapshotMemoryEntries?: () => readonly PersistedEventEntry[];
  private readonly restoreMemoryEntries?: (entries: readonly PersistedEventEntry[]) => void;
  private readonly emitSourceError: (error: string, extra?: Record<string, unknown>) => void;
  private readonly restoreSourceError?: (error: string, extra?: Record<string, unknown>) => void;
  private readonly emitSourceOk: (extra?: Record<string, unknown>) => void;
  private readonly clearSourceCap?: () => void;
  private readonly calendar: LocalCalendar;
  private readonly maxDailyBytes: number;
  private readonly maxFileDailyBytes: number;
  private readonly maxNonFileDailyBytes: number;
  private readonly maxCriticalDailyBytes: number;
  private readonly enforceTotalDailyCap: boolean;
  private readonly maxTotalBytes: number;
  private readonly heartbeatIntervalMs: number;
  private readonly dayExtensions?: (date: string) => Record<string, unknown> | undefined;
  private readonly onSummaryChanged?: () => void;

  private tail: Promise<void> = Promise.resolve();
  private started = false;
  private stopped = false;
  private stopPromise?: Promise<void>;
  private activeActivityFlush?: Promise<void>;
  private clearEpoch = 0;
  private clearFeedBuffer?: Array<{ date: string; raw: string }>;
  private currentDate?: string;
  private currentMonth?: string;
  private lastAliveAt = Number.NEGATIVE_INFINITY;
  private nextHeartbeatMono = Number.POSITIVE_INFINITY;
  private activeApp?: string;
  private readonly usageByDate = new Map<string, DateByteUsage>();
  private readonly cappedDates = new Set<string>();
  private readonly fileCappedDates = new Set<string>();
  private readonly nonFileCappedDates = new Set<string>();
  private readonly criticalCappedDates = new Set<string>();
  private readonly capErrorsEmitted = new Set<string>();
  private readonly reportedFileErrors = new Set<string>();
  private appendDegraded = false;
  private summaryDegraded = false;
  private bootTag = makeBootTag();
  private shortSeq = 0;
  private readonly usedBootTags = new Set<string>([this.bootTag]);
  private readonly uuidPrefixTag = new Map<string, string>();
  private readonly uuidLastDate = new Map<string, string>();
  private readonly eventMetaById = new Map<
    string,
    { date: string; diskId: string; isFile?: boolean; critical?: boolean }
  >();
  private readonly activityMetaById = new Map<
    string,
    { date: string; diskId: string; isFile?: boolean; critical?: boolean }
  >();
  private readonly pendingActivity = new Map<string, PendingActivityBucket>();
  private readonly pendingBucketByEntryId = new Map<string, PendingActivityBucket>();
  private activeLifecycleOpen = false;
  private readonly pendingBackfill = new Set<string>();
  private pendingBackfillEpoch = 0;
  private readonly backfillFailures = new Map<string, number>();
  private backfillTimer?: ReturnType<typeof setTimeout>;
  private backfillYieldWake?: () => void;
  private backfillCurrentMonth?: string;
  private activeBackfillStep?: Promise<void>;
  private activeQueries = 0;
  private summaryRevision = 0;
  private todayAcc?: ReturnType<typeof createDailySummaryAccumulator>;
  private cachedToday?: { revision: number; date: string; summary?: DailySummary };
  private yesterdayDate?: string;
  private yesterdaySummary?: DailySummary;
  private yesterdayLateState?: {
    date: string;
    acc: ReturnType<typeof createDailySummaryAccumulator>;
    rolloverOpts: SummarizeDayOptions;
    expiresMono: number;
    prevMonthKey: string;
    nextMonthKey: string;
    dirty: boolean;
  };
  private pendingTodayHydration?: { date: string; epoch: number; liveLines: string[] };
  private todayHydrationTimer?: ReturnType<typeof setTimeout>;
  private activeTodayHydration?: Promise<unknown>;

  constructor(options: HistoryManagerOptions) {
    this.port = options.port;
    this.clock = options.clock;
    this.isPaused = options.isPaused;
    this.titlesAllowed = options.titlesAllowed;
    this.restoreEntries = options.restoreEntries;
    this.clearMemoryEntries = options.clearMemoryEntries;
    this.snapshotMemoryEntries = options.snapshotMemoryEntries;
    this.restoreMemoryEntries = options.restoreMemoryEntries;
    this.emitSourceError = options.emitSourceError;
    this.restoreSourceError = options.restoreSourceError;
    this.emitSourceOk = options.emitSourceOk;
    this.clearSourceCap = options.clearSourceCap;
    this.calendar = new LocalCalendar(options.timeZone);
    if (options.maxFileDailyBytes !== undefined || options.maxNonFileDailyBytes !== undefined) {
      this.maxFileDailyBytes = options.maxFileDailyBytes ?? MAX_DAILY_FILE_EVENT_BYTES;
      this.maxNonFileDailyBytes = options.maxNonFileDailyBytes ?? MAX_DAILY_NON_FILE_EVENT_BYTES;
      this.maxDailyBytes = options.maxDailyBytes ?? this.maxFileDailyBytes + this.maxNonFileDailyBytes;
      this.enforceTotalDailyCap = options.maxDailyBytes !== undefined;
    } else if (options.maxDailyBytes !== undefined) {
      this.maxDailyBytes = options.maxDailyBytes;
      this.maxFileDailyBytes = options.maxDailyBytes;
      this.maxNonFileDailyBytes = options.maxDailyBytes;
      this.enforceTotalDailyCap = true;
    } else {
      this.maxFileDailyBytes = MAX_DAILY_FILE_EVENT_BYTES;
      this.maxNonFileDailyBytes = MAX_DAILY_NON_FILE_EVENT_BYTES;
      this.maxDailyBytes = MAX_DAILY_EVENT_BYTES;
      this.enforceTotalDailyCap = false;
    }
    this.maxCriticalDailyBytes =
      options.maxCriticalDailyBytes ?? Math.max(MAX_DAILY_CRITICAL_EVENT_BYTES, this.maxDailyBytes);
    this.maxTotalBytes = options.maxTotalBytes ?? MAX_HISTORY_TOTAL_BYTES;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HISTORY_HEARTBEAT_MS;
    this.dayExtensions = options.dayExtensions;
    this.onSummaryChanged = options.onSummaryChanged;
  }

  async start(paused: boolean): Promise<void> {
    if (this.stopped) return;
    this.started = true;
    const now = this.clock.wall();
    const today = this.calendar.dateKey(now);
    const month = this.calendar.monthKey(now);
    this.currentDate = today;
    this.currentMonth = month;
    this.lastAliveAt = now;
    this.nextHeartbeatMono = this.clock.mono() + this.heartbeatIntervalMs;
    this.resetTodayAcc(today);

    if (!this.port) return;
    const epoch = this.clearEpoch;
    await this.enqueue(async () => {
      if (this.stopped || epoch !== this.clearEpoch) return;
      await this.startupMaintenance(today, month, epoch);
      if (this.stopped || epoch !== this.clearEpoch) return;
      const lifecycle: HistoryLifecycleRecord = {
        record: 'lifecycle',
        state: paused ? 'paused' : 'active',
        at: now,
        boot: true,
      };
      this.activeLifecycleOpen = true;
      const raw = JSON.stringify(lifecycle);
      this.feedTodayRaw(today, raw);
      await this.appendRawLine(today, `${raw}\n`, epoch);
      this.onSummaryChanged?.();
    });
  }

  setPaused(paused: boolean, at = this.clock.wall()): void {
    if (!this.port || !this.started || this.stopped) return;
    this.syncClockDate(at);
    this.enqueueLifecycle(paused ? 'paused' : 'active', at);
  }

  recordEvent(entry: HistoryEventInput, meta?: { bundleId?: string; title?: string }): void {
    if (!this.port || !this.started || this.stopped || entry.restored) return;
    const now = this.clock.wall();
    const date = this.calendar.dateKey(entry.at);
    const deferRollover =
      this.currentDate !== undefined && date === this.currentDate && this.calendar.dateKey(now) > this.currentDate;
    if (!deferRollover) {
      this.syncClockDate(now);
    }
    if (entry.kind === 'app.activated' && isNonEmptyString(entry.subject)) {
      this.activeApp = entry.subject;
    }
    if (entry.at > this.lastAliveAt) this.lastAliveAt = entry.at;

    if (entry.kind === 'file.activity') {
      this.bufferFileActivity(entry, date, now);
      if (deferRollover) {
        this.syncClockDate(now);
      }
      return;
    }

    const isFile = entry.kind.startsWith('file.');
    const critical = this.isCriticalEvent(entry.kind, entry.level);
    const diskId = this.shortDiskIdForNonAggregated(entry.id, date);
    this.rememberEventMeta(entry.id, date, diskId, isFile, critical);

    const raw = this.serializeEventLine(entry, diskId, meta);
    this.feedTodayRaw(date, raw);
    const epoch = this.clearEpoch;
    this.enqueue(() => this.appendRawLine(date, `${raw}\n`, epoch, { tier: isFile ? 'file' : 'nonFile', critical }));
    if (deferRollover) {
      this.syncClockDate(now);
    }
  }

  private bufferFileActivity(entry: HistoryEventInput, date: string, now: number): void {
    const d = entry.detail;
    const dir = typeof d?.directory === 'string' ? d.directory : typeof d?.dir === 'string' ? d.dir : entry.subject;
    const cause: SignalCause = entry.cause ?? 'unknown';
    const key = `${date}\0${cause}\0${dir}`;
    const created = finiteNonNeg(d?.created);
    const modified = finiteNonNeg(d?.modified);
    const deleted = finiteNonNeg(d?.deleted);
    const rolledUp = d?.rolledUp === true ? 1 : finiteNonNeg(d?.rolledUp);
    const windowMs = finiteNonNeg(d?.windowMs);
    const degraded = d?.degraded === true;

    const existing = this.pendingActivity.get(key);
    if (existing) {
      if (entry.at >= existing.windowEndWall || entry.at < existing.firstAt || existing.epoch !== this.clearEpoch) {
        this.flushActivityBucket(existing);
      } else {
        existing.latestAt = Math.max(existing.latestAt, entry.at);
        existing.created += created;
        existing.modified += modified;
        existing.deleted += deleted;
        existing.rolledUp += rolledUp;
        existing.windowMsSum += windowMs;
        existing.degraded = existing.degraded || degraded;
        existing.count += 1;
        if (LEVEL_RANK[entry.level] > LEVEL_RANK[existing.level]) {
          existing.level = entry.level;
          existing.ruleId = entry.ruleId;
          existing.reason = entry.reason;
        }
        if (entry.feedback !== undefined && existing.feedback === undefined) {
          existing.feedback = entry.feedback;
        }
        existing.entryIds.push(entry.id);
        this.rememberActivityMeta(entry.id, date, existing.diskId, true, false);
        this.pendingBucketByEntryId.set(entry.id, existing);
        this.cachedToday = undefined;
        this.summaryRevision += 1;
        return;
      }
    }

    if (this.pendingActivity.size >= MAX_PENDING_ACTIVITY_BUCKETS) {
      const oldest = this.pendingActivity.values().next().value;
      if (oldest) this.flushActivityBucket(oldest);
    }

    const diskId = this.nextShortId();
    const dayEnd = this.calendar.dayBounds(date).endMs;
    const windowEndWall = Math.min(entry.at + FILE_ACTIVITY_AGG_MS, dayEnd);
    const flushMono = this.clock.mono() + Math.min(FILE_ACTIVITY_AGG_MS, Math.max(0, dayEnd - now));
    const bucket: PendingActivityBucket = {
      key,
      date,
      diskId,
      dir,
      cause,
      source: { ...entry.source },
      level: entry.level,
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
      ...(entry.ruleId !== undefined ? { ruleId: entry.ruleId } : {}),
      ...(entry.feedback !== undefined ? { feedback: entry.feedback } : {}),
      firstAt: entry.at,
      latestAt: entry.at,
      windowEndWall,
      flushMono,
      windowMsSum: windowMs,
      created,
      modified,
      deleted,
      rolledUp,
      degraded,
      count: 1,
      epoch: this.clearEpoch,
      entryIds: [entry.id],
    };
    this.pendingActivity.set(key, bucket);
    this.rememberActivityMeta(entry.id, date, diskId, true, false);
    this.pendingBucketByEntryId.set(entry.id, bucket);
    this.cachedToday = undefined;
    this.summaryRevision += 1;
  }

  private bucketToDetail(
    bucket: PendingActivityBucket,
    includeDirectory: boolean,
  ): Record<string, string | number | boolean | string[]> {
    const windowMs = bucket.count === 1 ? bucket.windowMsSum : FILE_ACTIVITY_AGG_MS;
    return {
      ...(includeDirectory ? { directory: bucket.dir } : {}),
      windowMs,
      created: bucket.created,
      modified: bucket.modified,
      deleted: bucket.deleted,
      ...(bucket.rolledUp > 0 ? { rolledUp: bucket.rolledUp } : {}),
      ...(bucket.degraded ? { degraded: true } : {}),
    };
  }

  private bucketToPersistedEntry(bucket: PendingActivityBucket): PersistedEventEntry {
    return {
      id: bucket.diskId,
      kind: 'file.activity',
      subject: bucket.dir,
      level: bucket.level,
      ...(bucket.reason !== undefined ? { reason: bucket.reason } : {}),
      ...(bucket.ruleId !== undefined ? { ruleId: bucket.ruleId } : {}),
      cause: bucket.cause,
      at: bucket.latestAt,
      source: { ...bucket.source },
      detail: this.bucketToDetail(bucket, true),
      ...(bucket.feedback !== undefined ? { feedback: bucket.feedback } : {}),
    };
  }

  private serializeActivityBucket(bucket: PendingActivityBucket): string {
    return this.serializeEventLine(
      {
        id: bucket.diskId,
        kind: 'file.activity',
        subject: bucket.dir,
        level: bucket.level,
        reason: bucket.reason,
        ruleId: bucket.ruleId,
        cause: bucket.cause,
        at: bucket.latestAt,
        source: bucket.source,
        detail: this.bucketToDetail(bucket, false),
        ...(bucket.feedback !== undefined ? { feedback: bucket.feedback } : {}),
      },
      bucket.diskId,
    );
  }

  private detachActivityBucket(bucket: PendingActivityBucket): void {
    if (this.pendingActivity.get(bucket.key) === bucket) {
      this.pendingActivity.delete(bucket.key);
    }
    for (const eid of bucket.entryIds) {
      if (this.pendingBucketByEntryId.get(eid) === bucket) {
        this.pendingBucketByEntryId.delete(eid);
      }
    }
  }

  private detachMatchingActivityBuckets(
    predicate: (bucket: PendingActivityBucket) => boolean,
  ): PendingActivityBucket[] {
    if (this.pendingActivity.size === 0) return [];
    const epoch = this.clearEpoch;
    const out: PendingActivityBucket[] = [];
    for (const bucket of [...this.pendingActivity.values()]) {
      if (bucket.epoch !== epoch || !predicate(bucket)) continue;
      this.detachActivityBucket(bucket);
      out.push(bucket);
    }
    return out;
  }

  private consumeActivityBucket(
    bucket: PendingActivityBucket,
    expectedEpoch = this.clearEpoch,
  ): { date: string; raw: string; epoch: number } | undefined {
    this.detachActivityBucket(bucket);
    if (bucket.epoch !== expectedEpoch) return undefined;
    const raw = this.serializeActivityBucket(bucket);
    this.feedTodayRaw(bucket.date, raw);
    return { date: bucket.date, raw, epoch: bucket.epoch };
  }

  private flushActivityBucket(bucket: PendingActivityBucket): void {
    const item = this.consumeActivityBucket(bucket);
    if (!item) return;
    this.enqueue(() => this.appendRawLine(item.date, `${item.raw}\n`, item.epoch, { tier: 'file', critical: false }));
  }

  private async runActivityFlush(predicate: (bucket: PendingActivityBucket) => boolean): Promise<void> {
    while (this.activeActivityFlush) {
      await this.activeActivityFlush;
    }
    if (this.pendingActivity.size === 0) return;
    const run = this.flushPendingActivitySliced(predicate);
    this.activeActivityFlush = run;
    try {
      await run;
    } finally {
      if (this.activeActivityFlush === run) this.activeActivityFlush = undefined;
    }
  }

  private async flushPendingActivitySliced(predicate: (bucket: PendingActivityBucket) => boolean): Promise<void> {
    if (this.pendingActivity.size === 0) return;
    const epoch = this.clearEpoch;
    const candidates = [...this.pendingActivity.values()];
    let idx = 0;
    while (idx < candidates.length && epoch === this.clearEpoch) {
      const sliceStart = performance.now();
      const sliceLines: Array<{ date: string; raw: string; epoch: number }> = [];
      let scannedInSlice = 0;
      while (idx < candidates.length) {
        const bucket = candidates[idx++];
        scannedInSlice += 1;
        if (bucket.epoch !== this.clearEpoch) continue;
        if (this.pendingActivity.get(bucket.key) !== bucket) continue;
        if (!predicate(bucket)) continue;
        const item = this.consumeActivityBucket(bucket, epoch);
        if (item) sliceLines.push(item);
        if (
          sliceLines.length >= FLUSH_ACTIVITY_SLICE_MAX_BUCKETS ||
          performance.now() - sliceStart >= FLUSH_ACTIVITY_SLICE_BUDGET_MS
        ) {
          break;
        }
      }
      if (sliceLines.length > 0 && epoch === this.clearEpoch) {
        this.enqueue(() => this.appendBatchedActivityLines(sliceLines));
      }
      if (idx >= candidates.length || epoch !== this.clearEpoch) break;
      if (scannedInSlice > 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  private async flushDetachedBucketsSliced(
    buckets: readonly PendingActivityBucket[],
    epoch: number,
    onRaw?: (raw: string) => void,
  ): Promise<void> {
    let idx = 0;
    while (idx < buckets.length && epoch === this.clearEpoch) {
      const sliceStart = performance.now();
      const sliceLines: Array<{ date: string; raw: string; epoch: number }> = [];
      while (idx < buckets.length) {
        const bucket = buckets[idx++];
        if (bucket.epoch !== epoch) continue;
        const raw = this.serializeActivityBucket(bucket);
        onRaw?.(raw);
        sliceLines.push({ date: bucket.date, raw, epoch });
        if (
          sliceLines.length >= FLUSH_ACTIVITY_SLICE_MAX_BUCKETS ||
          performance.now() - sliceStart >= FLUSH_ACTIVITY_SLICE_BUDGET_MS
        ) {
          break;
        }
      }
      if (sliceLines.length > 0 && epoch === this.clearEpoch) {
        await this.appendBatchedActivityLines(sliceLines);
      }
      if (idx < buckets.length && epoch === this.clearEpoch) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  private nextShortId(): string {
    return `${this.bootTag}-${(++this.shortSeq).toString(36)}`;
  }

  private serializeEventLine(
    entry: HistoryEventInput,
    diskId: string,
    meta?: { bundleId?: string; title?: string },
  ): string {
    const detail = slimDetailForDisk(entry.kind, entry.subject, entry.detail);
    const line: HistoryEventLine = {
      record: 'event',
      id: diskId,
      kind: entry.kind,
      subject: entry.subject,
      level: entry.level,
      at: entry.at,
      source:
        entry.source.host === 'local' && entry.source.api === defaultApiForSourceId(entry.source.id)
          ? entry.source.id
          : { ...entry.source },
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
      ...(entry.ruleId !== undefined ? { ruleId: entry.ruleId } : {}),
      ...(entry.cause !== undefined && entry.cause !== 'unknown' ? { cause: entry.cause } : {}),
      ...(entry.restarts !== undefined ? { restarts: entry.restarts } : {}),
      ...(detail !== undefined ? { detail } : {}),
      ...(entry.currentEta !== undefined ? { currentEta: { ...entry.currentEta } } : {}),
      ...(entry.feedback !== undefined ? { feedback: entry.feedback } : {}),
      ...(entry.feedbackAvailable !== undefined ? { feedbackAvailable: entry.feedbackAvailable } : {}),
      ...(meta?.bundleId !== undefined ? { bundleId: meta.bundleId } : {}),
      ...(meta?.title !== undefined ? { title: meta.title } : {}),
    };
    return JSON.stringify(line);
  }

  patchEvent(
    id: string,
    patch: { at?: number; level?: DeliveryLevel; reason?: string; feedback?: 'useful' | 'noise' },
  ): void {
    if (!this.port || !this.started || this.stopped) return;
    const pending = this.pendingBucketByEntryId.get(id);
    if (pending && pending.epoch === this.clearEpoch) {
      if (patch.level !== undefined) pending.level = patch.level;
      if (patch.reason !== undefined) pending.reason = patch.reason;
      if (patch.feedback !== undefined) pending.feedback = patch.feedback;
      this.cachedToday = undefined;
      this.summaryRevision += 1;
      return;
    }
    const mapped = this.lookupMetaForPatch(id);
    if (mapped) {
      const date = patch.at !== undefined ? this.calendar.dateKey(patch.at) : mapped.date;
      if (!date) return;
      const diskId = mapped.diskId;
      const isFile = mapped.isFile ?? false;
      const critical = !isFile && (patch.level === 'context' || patch.level === 'wake' || mapped.critical === true);
      const record = {
        record: 'patch' as const,
        id: diskId,
        ...(patch.level !== undefined ? { level: patch.level } : {}),
        ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
        ...(patch.feedback !== undefined ? { feedback: patch.feedback } : {}),
      };
      const raw = JSON.stringify(record);
      this.feedTodayRaw(date, raw);
      const epoch = this.clearEpoch;
      this.enqueue(() => this.appendRawLine(date, `${raw}\n`, epoch, { tier: isFile ? 'file' : 'nonFile', critical }));
      return;
    }

    const fallback = this.resolveEvictedPatchCandidates(id, patch.at);
    if (!fallback) return;
    const epoch = this.clearEpoch;
    this.enqueue(() => this.appendVerifiedPatch(fallback.date, fallback.candidates, patch, epoch));
  }

  nextDeadline(): number | undefined {
    if (!this.port || !this.started || this.stopped || !this.currentDate) return undefined;
    const bounds = this.calendar.dayBounds(this.currentDate);
    const rolloverDelta = Math.max(0, bounds.endMs - this.clock.wall());
    const rolloverMono = this.clock.mono() + rolloverDelta;
    let deadline = Math.min(this.nextHeartbeatMono, rolloverMono);
    for (const bucket of this.pendingActivity.values()) {
      if (bucket.epoch === this.clearEpoch && bucket.flushMono < deadline) {
        deadline = bucket.flushMono;
      }
    }
    return deadline;
  }

  async tick(): Promise<void> {
    if (!this.port || !this.started || this.stopped) return;
    const wall = this.clock.wall();
    const mono = this.clock.mono();
    const nowDate = this.syncClockDate(wall);
    await this.runActivityFlush((b) => mono >= b.flushMono || wall >= b.windowEndWall);
    if (this.stopped) return;
    if (mono >= this.nextHeartbeatMono) {
      this.nextHeartbeatMono = mono + this.heartbeatIntervalMs;
      this.lastAliveAt = Math.max(this.lastAliveAt, wall);
      const epoch = this.clearEpoch;
      const date = nowDate;
      const paused = this.isPaused();
      const heartbeat: HistoryLifecycleRecord = {
        record: 'lifecycle',
        state: 'heartbeat',
        at: wall,
        paused,
      };
      this.activeLifecycleOpen = true;
      const raw = JSON.stringify(heartbeat);
      this.feedTodayRaw(date, raw);
      this.enqueue(() => this.appendRawLine(date, `${raw}\n`, epoch));
      this.onSummaryChanged?.();
    }
    await this.tail;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.nextHeartbeatMono = Number.POSITIVE_INFINITY;
    this.cancelBackfill();
    this.stopPromise = this.runStop();
    return this.stopPromise;
  }

  private async runStop(): Promise<void> {
    await this.runActivityFlush(() => true);
    if (this.port && this.started && this.activeLifecycleOpen) {
      const now = this.clock.wall();
      const date = this.calendar.dateKey(now);
      const epoch = this.clearEpoch;
      const stoppedRecord: HistoryLifecycleRecord = { record: 'lifecycle', state: 'stopped', at: now };
      await this.enqueue(() => this.appendRawLine(date, `${JSON.stringify(stoppedRecord)}\n`, epoch));
    }
    if (this.activeBackfillStep) {
      await this.activeBackfillStep.catch(() => {});
    }
    if (this.activeTodayHydration) {
      await this.activeTodayHydration.catch(() => {});
    }
    await this.tail;
  }

  async clear(): Promise<void> {
    const epoch = ++this.clearEpoch;
    // Buffer events that arrive while clearAll() deletes files (todayAcc is
    // empty until the clear settles) and replay them afterwards; their disk
    // appends are queued behind this clear, so they outlive the deletion.
    const buffered: Array<{ date: string; raw: string }> = [];
    this.clearFeedBuffer = buffered;
    this.cancelBackfill();
    this.backfillCurrentMonth = undefined;
    // A failed clear must not lose pre-clear state: keep the in-memory values
    // so the catch branch can restore them alongside the hydrated summary.
    const previous = {
      todayAcc: this.todayAcc,
      yesterdayDate: this.yesterdayDate,
      yesterdaySummary: this.yesterdaySummary,
      yesterdayLateState: this.yesterdayLateState,
      eventMetaById: new Map(this.eventMetaById),
      activityMetaById: new Map(this.activityMetaById),
      usageByDate: new Map([...this.usageByDate].map(([date, usage]) => [date, { ...usage }])),
      cappedDates: new Set(this.cappedDates),
      fileCappedDates: new Set(this.fileCappedDates),
      nonFileCappedDates: new Set(this.nonFileCappedDates),
      criticalCappedDates: new Set(this.criticalCappedDates),
      capErrorsEmitted: new Set(this.capErrorsEmitted),
      reportedFileErrors: new Set(this.reportedFileErrors),
      pendingActivity: [...this.pendingActivity.values()].map((bucket) => cloneActivityBucket(bucket, epoch)),
      activeApp: this.activeApp,
      activeLifecycleOpen: this.activeLifecycleOpen,
      appendDegraded: this.appendDegraded,
      summaryDegraded: this.summaryDegraded,
      wasCapped: this.capErrorsEmitted.size > 0 || this.cappedDates.size > 0,
      memoryEntries: this.snapshotMemoryEntries?.() ?? [],
    };
    this.todayAcc = undefined;
    this.cachedToday = undefined;
    this.yesterdayDate = undefined;
    this.yesterdaySummary = undefined;
    this.yesterdayLateState = undefined;
    this.summaryRevision += 1;
    this.clearMemoryEntries();
    this.usageByDate.clear();
    this.cappedDates.clear();
    this.fileCappedDates.clear();
    this.nonFileCappedDates.clear();
    this.criticalCappedDates.clear();
    this.capErrorsEmitted.clear();
    this.reportedFileErrors.clear();
    this.eventMetaById.clear();
    this.activityMetaById.clear();
    this.pendingActivity.clear();
    this.pendingBucketByEntryId.clear();
    this.activeApp = undefined;
    this.activeLifecycleOpen = false;
    this.appendDegraded = false;
    this.summaryDegraded = false;
    if (!this.port) {
      if (this.clearFeedBuffer === buffered) this.clearFeedBuffer = undefined;
      this.onSummaryChanged?.();
      return;
    }
    const port = this.port;
    const run = this.tail.then(async () => {
      if (this.activeBackfillStep) {
        await this.activeBackfillStep.catch(() => {});
      }
      try {
        await port.clearAll();
      } catch (error) {
        if (this.clearFeedBuffer === buffered) {
          // A failed clear must leave the summary usable: rebuild todayAcc from
          // the day's on-disk raw events, replay buffered lines, and restore the
          // pre-clear yesterday summary / event-stream state before surfacing
          // the error for the UI's retry.
          if (this.started && !this.stopped && epoch === this.clearEpoch) {
            const now = this.clock.wall();
            const today = this.calendar.dateKey(now);
            this.currentDate = today;
            this.currentMonth = this.calendar.monthKey(now);
            this.yesterdayDate = previous.yesterdayDate;
            this.yesterdaySummary = previous.yesterdaySummary;
            this.yesterdayLateState = previous.yesterdayLateState;
            this.usageByDate.clear();
            for (const [date, usage] of previous.usageByDate) {
              this.usageByDate.set(date, { ...usage });
            }
            this.cappedDates.clear();
            for (const date of previous.cappedDates) this.cappedDates.add(date);
            this.fileCappedDates.clear();
            for (const date of previous.fileCappedDates) this.fileCappedDates.add(date);
            this.nonFileCappedDates.clear();
            for (const date of previous.nonFileCappedDates) this.nonFileCappedDates.add(date);
            this.criticalCappedDates.clear();
            for (const date of previous.criticalCappedDates) this.criticalCappedDates.add(date);
            this.capErrorsEmitted.clear();
            for (const date of previous.capErrorsEmitted) this.capErrorsEmitted.add(date);
            this.reportedFileErrors.clear();
            for (const key of previous.reportedFileErrors) this.reportedFileErrors.add(key);

            const liveMeta = new Map(this.eventMetaById);
            this.eventMetaById.clear();
            for (const [id, info] of previous.eventMetaById) this.eventMetaById.set(id, info);
            for (const [id, info] of liveMeta) this.eventMetaById.set(id, info);

            const liveActivityMeta = new Map(this.activityMetaById);
            this.activityMetaById.clear();
            for (const [id, info] of previous.activityMetaById) this.activityMetaById.set(id, info);
            for (const [id, info] of liveActivityMeta) this.activityMetaById.set(id, info);

            const livePending = new Map(this.pendingActivity);
            this.pendingActivity.clear();
            this.pendingBucketByEntryId.clear();
            for (const restoredBucket of previous.pendingActivity) {
              const liveBucket = livePending.get(restoredBucket.key);
              if (liveBucket) {
                livePending.delete(restoredBucket.key);
                const merged = mergeActivityBuckets(restoredBucket, liveBucket, epoch);
                this.pendingActivity.set(merged.key, merged);
                for (const eid of merged.entryIds) {
                  this.pendingBucketByEntryId.set(eid, merged);
                }
                for (const eid of liveBucket.entryIds) {
                  const meta = this.activityMetaById.get(eid);
                  if (meta) this.activityMetaById.set(eid, { ...meta, diskId: merged.diskId });
                }
              } else {
                const cloned = cloneActivityBucket(restoredBucket, epoch);
                this.pendingActivity.set(cloned.key, cloned);
                for (const eid of cloned.entryIds) {
                  this.pendingBucketByEntryId.set(eid, cloned);
                }
              }
            }
            for (const liveBucket of livePending.values()) {
              const bucket = liveBucket.epoch === epoch ? liveBucket : cloneActivityBucket(liveBucket, epoch);
              this.pendingActivity.set(bucket.key, bucket);
              for (const eid of bucket.entryIds) {
                this.pendingBucketByEntryId.set(eid, bucket);
              }
            }

            this.activeApp = previous.activeApp;
            this.activeLifecycleOpen = previous.activeLifecycleOpen;
            this.appendDegraded = previous.appendDegraded;
            this.summaryDegraded = previous.summaryDegraded;
            this.resetTodayAcc(today);
            const hydration = {
              date: today,
              epoch,
              liveLines: buffered.filter((item) => item.date === today).map((item) => item.raw),
            };
            this.pendingTodayHydration = hydration;
            const { hydrated } = await this.hydrateTodayFromDisk(today, epoch, false);
            if (this.pendingTodayHydration === hydration) this.pendingTodayHydration = undefined;
            if (this.clearFeedBuffer === buffered) this.clearFeedBuffer = undefined;
            if (!hydrated) {
              // No raw events on disk (or unreadable): fall back to the
              // pre-clear accumulator, then replay the buffered lines.
              if (previous.todayAcc) {
                this.todayAcc = previous.todayAcc;
                this.cachedToday = undefined;
              }
              for (const raw of hydration.liveLines) this.feedTodayRaw(today, raw);
            }
            this.cachedToday = undefined;
            this.summaryRevision += 1;
            this.restoreMemoryEntries?.(previous.memoryEntries);
            this.onSummaryChanged?.();
          } else if (this.clearFeedBuffer === buffered) {
            this.clearFeedBuffer = undefined;
          }
        }
        throw error;
      }
      if (this.started && !this.stopped && epoch === this.clearEpoch) {
        const now = this.clock.wall();
        const today = this.calendar.dateKey(now);
        const month = this.calendar.monthKey(now);
        this.currentDate = today;
        this.currentMonth = month;
        this.backfillCurrentMonth = month;
        this.lastAliveAt = now;
        this.nextHeartbeatMono = this.clock.mono() + this.heartbeatIntervalMs;
        if (this.clearFeedBuffer === buffered) this.clearFeedBuffer = undefined;
        this.resetTodayAcc(today);
        const lifecycle: HistoryLifecycleRecord = {
          record: 'lifecycle',
          state: this.isPaused() ? 'paused' : 'active',
          at: now,
          boot: true,
        };
        this.activeLifecycleOpen = true;
        const raw = JSON.stringify(lifecycle);
        this.feedTodayRaw(today, raw);
        for (const item of buffered) if (item.date === today) this.feedTodayRaw(item.date, item.raw);
        await this.appendRawLine(today, `${raw}\n`, epoch);
        if ((previous.wasCapped || previous.appendDegraded || previous.summaryDegraded) && epoch === this.clearEpoch) {
          this.safeEmitSourceOk({ capped: false });
        }
      } else if (this.clearFeedBuffer === buffered) {
        this.clearFeedBuffer = undefined;
      }
      this.onSummaryChanged?.();
    });
    this.tail = run.catch(() => {});
    return run;
  }

  async query(params: HistoryQuery = {}): Promise<HistoryQueryResult> {
    if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1)) {
      throw new HistoryArgsError('limit must be a positive integer');
    }
    if (
      params.kinds !== undefined &&
      (!Array.isArray(params.kinds) || !params.kinds.every((k) => typeof k === 'string'))
    ) {
      throw new HistoryArgsError('kinds must be an array of strings');
    }
    if (params.app !== undefined && typeof params.app !== 'string') {
      throw new HistoryArgsError('app must be a string');
    }

    const requestedLimit = params.limit ?? DEFAULT_HISTORY_LIMIT;
    const limitClamped = requestedLimit > MAX_HISTORY_LIMIT;
    const limit = Math.min(requestedLimit, MAX_HISTORY_LIMIT);

    const now = this.clock.wall();
    const toMs = params.to === undefined ? now : parseTimeBound(params.to, 'end', this.calendar);
    let fromMs =
      params.from === undefined
        ? Math.max(0, toMs - MAX_QUERY_RANGE_MS)
        : parseTimeBound(params.from, 'start', this.calendar);
    if (fromMs > toMs) {
      throw new HistoryArgsError('from must not be after to');
    }
    let rangeClamped = false;
    if (toMs - fromMs > MAX_QUERY_RANGE_MS) {
      fromMs = toMs - MAX_QUERY_RANGE_MS;
      rangeClamped = true;
    }

    if (!this.port) {
      return {
        available: false,
        reason: 'History storage is not configured.',
        from: fromMs,
        to: toMs,
        limit,
        total: 0,
        truncated: false,
        titlesAllowed: this.titlesAllowed(),
        events: [],
      };
    }

    await this.tail;

    this.activeQueries += 1;
    try {
      return await this.queryInternal(params, fromMs, toMs, limit, limitClamped, rangeClamped, false);
    } finally {
      this.activeQueries -= 1;
    }
  }

  private async queryInternal(
    params: HistoryQuery,
    fromMs: number,
    toMs: number,
    limit: number,
    limitClamped: boolean,
    rangeClamped: boolean,
    forceHideTitles: boolean,
  ): Promise<HistoryQueryResult> {
    if (!this.port) {
      return {
        available: false,
        reason: 'History storage is not configured.',
        from: fromMs,
        to: toMs,
        limit,
        total: 0,
        truncated: false,
        titlesAllowed: forceHideTitles ? false : this.titlesAllowed(),
        events: [],
      };
    }

    const startDate = addDays(utcDateKey(fromMs), -1);
    const endDate = addDays(utcDateKey(toMs), 1);
    let rawDates: string[];
    try {
      rawDates = await this.port.listEventDates();
    } catch (error) {
      const code = unsafeFsCode(error);
      if (code) {
        this.reportFileErrorOnce(`unsafe:events-dir:${code}`, 'history-unsafe-entry', { dir: 'events', code });
        return {
          available: false,
          reason: 'History storage is inaccessible.',
          from: fromMs,
          to: toMs,
          limit,
          total: 0,
          truncated: false,
          titlesAllowed: forceHideTitles ? false : this.titlesAllowed(),
          events: [],
        };
      }
      throw error;
    }

    const allDates = this.filterValidDates(rawDates, 'events')
      .filter((d) => d >= startDate && d <= endDate)
      .sort()
      .reverse();
    const kindsSet = params.kinds ? new Set(params.kinds) : undefined;
    const kindsArr = kindsSet ? [...kindsSet].map((k) => `"${k}"`) : undefined;
    const appLower = params.app !== undefined ? sanitizeAppName(params.app).toLowerCase() : undefined;

    const matched: PersistedEventEntry[] = [];
    const pendingMatched: PersistedEventEntry[] = [];
    if (appLower === undefined && (!kindsSet || kindsSet.has('file.activity'))) {
      for (const bucket of this.pendingActivity.values()) {
        if (bucket.epoch !== this.clearEpoch) continue;
        if (bucket.latestAt < fromMs || bucket.latestAt > toMs) continue;
        pendingMatched.push(this.bucketToPersistedEntry(bucket));
      }
    }
    let hasMore = false;

    for (const date of allDates) {
      if (matched.length >= limit && hasMore) break;
      try {
        const scanner = createReverseEventScanner();
        for await (const line of this.streamLinesDesc(date)) {
          if (!line.includes('"patch"') && !line.includes('\\u')) {
            if (kindsArr) {
              let kindHit = false;
              for (let i = 0; i < kindsArr.length; i++) {
                if (line.includes(kindsArr[i])) {
                  kindHit = true;
                  break;
                }
              }
              if (!kindHit) continue;
            }
            if (appLower !== undefined && !line.includes('"app.') && !line.includes('"window')) {
              continue;
            }
          }

          const ev = scanner.accept(line);
          if (!ev) continue;

          if (ev.at < fromMs || ev.at > toMs) continue;
          if (kindsSet && !kindsSet.has(ev.kind)) continue;
          if (appLower !== undefined) {
            const canSeeWindow = !forceHideTitles && this.titlesAllowed();
            if (ev.kind.startsWith('window') && !canSeeWindow) continue;
            const isAppOrWindow = ev.kind.startsWith('app.') || ev.kind.startsWith('window');
            if (!isAppOrWindow) continue;
            const subjectMatch = sanitizeAppName(ev.subject).toLowerCase() === appLower;
            const bundleMatch = ev.bundleId?.toLowerCase() === appLower;
            if (!subjectMatch && !bundleMatch) continue;
          }

          if (matched.length >= limit) {
            hasMore = true;
            break;
          }
          matched.push(ev);
        }
      } catch (error) {
        const code = unsafeFsCode(error);
        if (code) {
          this.reportFileErrorOnce(`unsafe:events:${date}:${code}`, 'history-unsafe-entry', {
            kind: 'events',
            date,
            code,
          });
          continue;
        }
        throw error;
      }
      if (hasMore) break;
    }

    // Read titlesAllowed AFTER all awaits immediately before constructing output.
    const titlesAllowed = forceHideTitles ? false : this.titlesAllowed();
    if (!titlesAllowed && appLower !== undefined && matched.some((ev) => ev.kind.startsWith('window'))) {
      return this.queryInternal(params, fromMs, toMs, limit, limitClamped, rangeClamped, true);
    }

    if (pendingMatched.length > 0) {
      matched.push(...pendingMatched);
    }

    matched.sort((a, b) => b.at - a.at);
    if (matched.length > limit) {
      hasMore = true;
      matched.length = limit;
    }
    const events = titlesAllowed
      ? matched
      : matched.map((ev) => (ev.kind.startsWith('window') ? stripWindowEntry(ev) : ev));

    return {
      available: true,
      from: fromMs,
      to: toMs,
      ...(rangeClamped
        ? {
            rangeClamped: true,
            note: 'Requested time range exceeded 30 days and was clamped to the most recent 30 days.',
          }
        : {}),
      limit,
      total: events.length,
      truncated: hasMore || limitClamped,
      titlesAllowed,
      events,
    };
  }

  async summary(params: SummaryQuery = {}): Promise<SummaryQueryResult> {
    const nowMonth = this.calendar.monthKey(this.clock.wall());
    const month = params.month ?? prevMonth(nowMonth);
    if (!parseMonthKey(month)) {
      throw new HistoryArgsError('month must be formatted as YYYY-MM');
    }
    if (!this.port) {
      return { available: false, month, reason: 'History storage is not configured.' };
    }

    await this.tail;

    const epoch = this.clearEpoch;
    if (month > nowMonth) {
      return { available: false, month, reason: `Month ${month} is in the future.` };
    }

    if (month === nowMonth) {
      return {
        available: false,
        month,
        reason: `Monthly summary for ${month} is generated after the month ends; use env_history for recent events.`,
      };
    }

    const pendingDays = this.pendingBackfillDatesForMonth(month);
    const hasPendingForMonth = pendingDays.length > 0;

    if (!hasPendingForMonth) {
      try {
        const existingRaw = await this.port.readMonthly(month);
        if (epoch !== this.clearEpoch) {
          return { available: false, month, reason: `No history data found for month ${month}.` };
        }
        if (existingRaw !== undefined) {
          const parsed = parseMonthlySummary(existingRaw);
          if (parsed) return { available: true, summary: parsed };
          this.reportFileErrorOnce(`corrupt:monthly:${month}`, 'corrupt-monthly-summary', { month });
        }
      } catch (error) {
        const code = unsafeFsCode(error);
        if (code) {
          this.reportFileErrorOnce(`unsafe:monthly:${month}:${code}`, 'history-unsafe-entry', {
            kind: 'monthly',
            month,
            code,
          });
        } else {
          throw error;
        }
      }
    }

    const synthesized = await this.synthesizeMonthFromDaily(month, undefined, false, hasPendingForMonth, epoch);
    if (epoch !== this.clearEpoch || !synthesized) {
      return { available: false, month, reason: `No history data found for month ${month}.` };
    }
    if (hasPendingForMonth) {
      synthesized.partial = true;
      return { available: true, partial: true, pendingDays, note: PARTIAL_SUMMARY_NOTE, summary: synthesized };
    }
    await this.enqueue(async () => {
      if (!this.port || this.isEpochStale(epoch) || this.hasPendingBackfillForMonth(month)) return;
      await this.persistMonthlySummary(month, synthesized, epoch);
    });
    return { available: true, summary: synthesized };
  }

  async listCompletedMonths(): Promise<string[]> {
    if (!this.port) return [];
    await this.tail;
    const nowMonth = this.calendar.monthKey(this.clock.wall());
    const months = new Set<string>();
    // Propagate read errors: [] would make the sidebar claim there are no
    // summaries instead of showing its retry error state.
    for (const month of await this.port.listMonthlyMonths()) {
      if (parseMonthKey(month) && month < nowMonth) months.add(month);
    }
    for (const date of this.filterValidDates(await this.port.listDailyDates(), 'daily')) {
      const month = date.slice(0, 7);
      if (parseMonthKey(month) && month < nowMonth) months.add(month);
    }
    return [...months].sort((a, b) => b.localeCompare(a));
  }

  timelineSnapshots(): { version: number; today?: DailySummary; yesterday?: DailySummary } {
    let today: DailySummary | undefined;
    if (this.currentDate && this.todayAcc) {
      if (
        this.cachedToday &&
        this.cachedToday.revision === this.summaryRevision &&
        this.cachedToday.date === this.currentDate
      ) {
        today = this.cachedToday.summary;
      } else {
        const finished = this.todayAcc.snapshot(
          this.cappedDates.has(this.currentDate) ? { truncatedAtLimit: true } : undefined,
        );
        this.foldPendingIntoDailySummary(finished, this.currentDate);
        this.applyDayExtensions(finished, this.currentDate);
        today = isEmptyDailySummary(finished) ? undefined : finished;
        this.cachedToday = { revision: this.summaryRevision, date: this.currentDate, summary: today };
      }
    }
    let yesterday = this.yesterdaySummary;
    if (yesterday && this.yesterdayDate) {
      let hasPendingYesterday = false;
      for (const bucket of this.pendingActivity.values()) {
        if (bucket.epoch === this.clearEpoch && bucket.date === this.yesterdayDate) {
          hasPendingYesterday = true;
          break;
        }
      }
      if (hasPendingYesterday) {
        const copy = structuredClone(yesterday);
        this.foldPendingIntoDailySummary(copy, this.yesterdayDate);
        this.applyDayExtensions(copy, this.yesterdayDate);
        yesterday = isEmptyDailySummary(copy) ? undefined : copy;
      }
    }
    return {
      version: this.summaryRevision,
      ...(today ? { today } : {}),
      ...(yesterday ? { yesterday } : {}),
    };
  }

  private applyActivityBucketToSummary(summary: DailySummary, bucket: PendingActivityBucket): void {
    summary.totalEvents += 1;
    const suppressed =
      bucket.reason === 'no-session' || bucket.reason === 'wake-budget' || bucket.reason === 'self-caused';
    const isWake = bucket.level === 'wake' && bucket.reason !== 'no-session';
    const isContext = bucket.level === 'context';
    if (isWake || isContext || suppressed) {
      if (isWake) summary.deliveries.wake += 1;
      if (isContext) summary.deliveries.context += 1;
      if (suppressed) summary.deliveries.suppressed += 1;
      const ruleKey = bucket.ruleId && bucket.ruleId.length > 0 ? bucket.ruleId : '_none';
      let rc = summary.deliveries.byRule[ruleKey];
      if (!rc) {
        rc = { wake: 0, context: 0, suppressed: 0 };
        summary.deliveries.byRule[ruleKey] = rc;
      }
      if (isWake) rc.wake += 1;
      if (isContext) rc.context += 1;
      if (suppressed) rc.suppressed += 1;
    }
    const dir = sanitizeDirPath(bucket.dir);
    const existing = summary.fileActivity[dir];
    if (existing) {
      existing.events += 1;
      existing.created += bucket.created;
      existing.modified += bucket.modified;
      existing.deleted += bucket.deleted;
    } else {
      summary.fileActivity[dir] = {
        events: 1,
        created: bucket.created,
        modified: bucket.modified,
        deleted: bucket.deleted,
      };
    }
  }

  private foldPendingIntoDailySummary(summary: DailySummary, date: string): void {
    for (const bucket of this.pendingActivity.values()) {
      if (bucket.epoch !== this.clearEpoch || bucket.date !== date) continue;
      this.applyActivityBucketToSummary(summary, bucket);
    }
  }

  private resetTodayAcc(date: string): void {
    this.yesterdayDate = addDays(date, -1);
    this.todayAcc = createDailySummaryAccumulator(date, this.calendar.dayBounds(date));
    this.cachedToday = undefined;
    this.summaryRevision += 1;
  }

  private feedTodayRaw(date: string, rawLine: string): void {
    if (this.clearFeedBuffer) {
      this.clearFeedBuffer.push({ date, raw: rawLine });
      return;
    }
    if (date === this.currentDate && this.todayAcc) {
      if (this.pendingTodayHydration && this.pendingTodayHydration.date === date) {
        this.pendingTodayHydration.liveLines.push(rawLine);
      }
      this.todayAcc.feed(rawLine);
      this.cachedToday = undefined;
      this.summaryRevision += 1;
      return;
    }
    if (this.yesterdayLateState && date === this.yesterdayLateState.date) {
      if (this.clock.mono() > this.yesterdayLateState.expiresMono) {
        this.yesterdayLateState = undefined;
        return;
      }
      this.yesterdayLateState.acc.feed(rawLine);
      this.yesterdayLateState.dirty = true;
      const updated = this.yesterdayLateState.acc.snapshot({
        ...this.yesterdayLateState.rolloverOpts,
        truncatedAtLimit: this.yesterdayLateState.rolloverOpts.truncatedAtLimit || this.cappedDates.has(date),
      });
      this.applyDayExtensions(updated, date);
      this.yesterdaySummary = isEmptyDailySummary(updated) ? undefined : updated;
      this.summaryRevision += 1;
      this.onSummaryChanged?.();
    }
  }

  private async syncYesterdayLateDailyIfNeeded(date: string, epoch: number): Promise<void> {
    const state = this.yesterdayLateState;
    if (!state || state.date !== date || !state.dirty || !this.port || this.isEpochStale(epoch)) return;
    if (this.clock.mono() > state.expiresMono) {
      this.yesterdayLateState = undefined;
      return;
    }
    state.dirty = false;
    const daily = state.acc.snapshot({
      ...state.rolloverOpts,
      truncatedAtLimit: state.rolloverOpts.truncatedAtLimit || this.cappedDates.has(state.date),
    });
    if (isEmptyDailySummary(daily)) return;
    this.applyDayExtensions(daily, state.date);
    try {
      await this.port.writeDaily(state.date, JSON.stringify(daily));
      if (this.isEpochStale(epoch)) return;
      if (this.yesterdayLateState === state) {
        this.yesterdaySummary = daily;
        this.summaryRevision += 1;
        this.onSummaryChanged?.();
      }
      this.clearSummaryDegraded();
      if (state.nextMonthKey !== state.prevMonthKey) {
        await this.synthesizeMonthFromDaily(state.prevMonthKey, undefined, true, false, epoch);
      }
    } catch (error) {
      if (this.isEpochStale(epoch)) return;
      const code = unsafeFsCode(error);
      if (code) {
        this.reportFileErrorOnce(`unsafe:daily:${state.date}:${code}`, 'history-unsafe-entry', {
          kind: 'daily',
          date: state.date,
          code,
        });
      } else {
        this.reportSummaryWriteFailure(state.date, 'history-write-failed');
      }
    }
  }

  private scheduleTodayHydration(today: string, epoch: number): void {
    if (this.isEpochStale(epoch) || this.todayHydrationTimer) return;
    this.pendingTodayHydration = { date: today, epoch, liveLines: [] };
    this.todayHydrationTimer = setTimeout(() => {
      this.todayHydrationTimer = undefined;
      const run = this.hydrateTodayFromDisk(today, epoch, true);
      this.activeTodayHydration = run;
      void run.finally(() => {
        if (this.activeTodayHydration === run) this.activeTodayHydration = undefined;
      });
    }, 50);
    this.todayHydrationTimer.unref?.();
  }

  private async hydrateTodayFromDisk(
    today: string,
    epoch: number,
    yieldSlices: boolean,
  ): Promise<{ hydrated: boolean; diskStats?: DayTierStats }> {
    if (!this.port || this.isEpochStale(epoch) || this.currentDate !== today) return { hydrated: false };
    try {
      const acc = createDailySummaryAccumulator(today, this.calendar.dayBounds(today));
      const diskStats = createDayTierStats();
      let sawLine = false;
      let sliceStart = performance.now();
      for await (const line of this.streamLinesForward(today)) {
        if (this.isEpochStale(epoch) || this.currentDate !== today) return { hydrated: false };
        this.observeTierLine(diskStats, line);
        acc.feed(line);
        sawLine = true;
        if (yieldSlices && performance.now() - sliceStart >= 10) {
          await this.waitBackfillTurn(epoch, 0);
          if (this.isEpochStale(epoch) || this.currentDate !== today) return { hydrated: false };
          sliceStart = performance.now();
        }
      }
      const live =
        this.pendingTodayHydration?.date === today && this.pendingTodayHydration.epoch === epoch
          ? this.pendingTodayHydration.liveLines
          : [];
      if (this.pendingTodayHydration?.date === today && this.pendingTodayHydration.epoch === epoch) {
        this.pendingTodayHydration = undefined;
      }
      if ((sawLine || live.length > 0) && this.currentDate === today && !this.isEpochStale(epoch)) {
        for (const raw of live) acc.feed(raw);
        this.todayAcc = acc;
        this.cachedToday = undefined;
        this.summaryRevision += 1;
        if (yieldSlices) this.onSummaryChanged?.();
        return { hydrated: true, ...(sawLine ? { diskStats } : {}) };
      }
      return { hydrated: false, ...(sawLine ? { diskStats } : {}) };
    } catch {
      if (this.pendingTodayHydration?.date === today && this.pendingTodayHydration.epoch === epoch) {
        this.pendingTodayHydration = undefined;
      }
      return { hydrated: false };
    }
  }

  private isEpochStale(epoch: number): boolean {
    return this.stopped || epoch !== this.clearEpoch;
  }

  private clearPendingForEpoch(epoch: number): void {
    if (this.pendingBackfillEpoch === epoch) {
      this.pendingBackfill.clear();
      this.backfillFailures.clear();
    }
  }

  private registerPendingBackfill(dates: readonly string[], epoch: number): boolean {
    if (this.isEpochStale(epoch)) {
      this.clearPendingForEpoch(epoch);
      return false;
    }
    this.pendingBackfill.clear();
    this.backfillFailures.clear();
    this.pendingBackfillEpoch = epoch;
    for (const date of dates) this.pendingBackfill.add(date);
    return true;
  }

  private pendingBackfillDatesForMonth(month: string): string[] {
    if (this.pendingBackfillEpoch !== this.clearEpoch) {
      this.pendingBackfill.clear();
      this.backfillFailures.clear();
      return [];
    }
    const dates: string[] = [];
    for (const date of this.pendingBackfill) {
      if (date.startsWith(`${month}-`)) dates.push(date);
    }
    dates.sort();
    return dates;
  }

  private hasPendingBackfillForMonth(month: string): boolean {
    if (this.pendingBackfillEpoch !== this.clearEpoch) {
      this.pendingBackfill.clear();
      this.backfillFailures.clear();
      return false;
    }
    for (const date of this.pendingBackfill) {
      if (date.startsWith(`${month}-`)) return true;
    }
    return false;
  }

  private pickNextBackfillDate(): string | undefined {
    for (const date of this.pendingBackfill) {
      if ((this.backfillFailures.get(date) ?? 0) < MAX_BACKFILL_RETRIES) return date;
    }
    return undefined;
  }

  private isCriticalEvent(kind: string, level: DeliveryLevel): boolean {
    return !kind.startsWith('file.') && (level === 'context' || level === 'wake');
  }

  private allocateBootTag(): string {
    let tag = makeBootTag();
    while (this.usedBootTags.has(tag)) tag = makeBootTag();
    this.usedBootTags.add(tag);
    return tag;
  }

  private shortDiskIdForNonAggregated(entryId: string, date: string): string {
    if (!UUID_SEQ_RE.test(entryId)) return entryId;
    const colon = entryId.lastIndexOf(':');
    const uuid = entryId.slice(0, colon);
    const seqStr = entryId.slice(colon + 1);
    let tag = this.uuidPrefixTag.get(uuid);
    if (!tag) {
      tag = this.allocateBootTag();
      this.uuidPrefixTag.set(uuid, tag);
    }
    this.uuidLastDate.set(uuid, date);
    const seqPart =
      !/^0\d+$/.test(seqStr) && Number.isSafeInteger(Number(seqStr)) ? Number(seqStr).toString(36) : seqStr;
    return `${tag}-${seqPart}`;
  }

  private rememberEventMeta(id: string, date: string, diskId: string, isFile = false, critical = false): void {
    if (this.eventMetaById.has(id)) this.eventMetaById.delete(id);
    this.eventMetaById.set(id, { date, diskId, isFile, critical });
    if (this.eventMetaById.size > 4096) {
      const oldest = this.eventMetaById.keys().next().value;
      if (oldest !== undefined) this.eventMetaById.delete(oldest);
    }
  }

  private rememberActivityMeta(id: string, date: string, diskId: string, isFile = true, critical = false): void {
    if (this.activityMetaById.has(id)) this.activityMetaById.delete(id);
    this.activityMetaById.set(id, { date, diskId, isFile, critical });
    if (this.activityMetaById.size > 4096) {
      const oldest = this.activityMetaById.keys().next().value;
      if (oldest !== undefined) this.activityMetaById.delete(oldest);
    }
  }

  private lookupMetaForPatch(
    id: string,
  ): { date: string; diskId: string; isFile?: boolean; critical?: boolean } | undefined {
    const ev = this.eventMetaById.get(id);
    if (ev) {
      this.eventMetaById.delete(id);
      this.eventMetaById.set(id, ev);
      return ev;
    }
    const act = this.activityMetaById.get(id);
    if (act) {
      this.activityMetaById.delete(id);
      this.activityMetaById.set(id, act);
      return act;
    }
    return undefined;
  }

  private resolveEvictedPatchCandidates(
    id: string,
    patchAt: number | undefined,
  ): { date: string; candidates: string[] } | undefined {
    if (UUID_SEQ_RE.test(id)) {
      const colon = id.lastIndexOf(':');
      const uuid = id.slice(0, colon);
      const seqStr = id.slice(colon + 1);
      const date = patchAt !== undefined ? this.calendar.dateKey(patchAt) : this.uuidLastDate.get(uuid);
      if (!date) return undefined;
      const tag = this.uuidPrefixTag.get(uuid);
      if (tag) {
        const seqPart =
          !/^0\d+$/.test(seqStr) && Number.isSafeInteger(Number(seqStr)) ? Number(seqStr).toString(36) : seqStr;
        return { date, candidates: [`${tag}-${seqPart}`, id] };
      }
      return { date, candidates: [id] };
    }
    if (patchAt === undefined) return undefined;
    return { date: this.calendar.dateKey(patchAt), candidates: [id] };
  }

  private async appendVerifiedPatch(
    date: string,
    candidateIds: readonly string[],
    patch: { at?: number; level?: DeliveryLevel; reason?: string; feedback?: 'useful' | 'noise' },
    epoch: number,
  ): Promise<void> {
    if (!this.port || epoch !== this.clearEpoch || candidateIds.length === 0) return;
    const candidateSet = new Set(candidateIds);
    let foundId: string | undefined;
    let foundIsFile = false;
    let foundLevel: DeliveryLevel = 'record';
    try {
      for await (const line of this.streamLinesDesc(date)) {
        if (epoch !== this.clearEpoch) return;
        let mayMatch = false;
        for (let i = 0; i < candidateIds.length; i++) {
          if (line.includes(candidateIds[i])) {
            mayMatch = true;
            break;
          }
        }
        if (!mayMatch) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isRecordObject(parsed)) continue;
        if (parsed.record !== 'event' && parsed.record !== undefined) continue;
        if (typeof parsed.id !== 'string' || !candidateSet.has(parsed.id)) continue;
        foundId = parsed.id;
        foundIsFile = typeof parsed.kind === 'string' && parsed.kind.startsWith('file.');
        foundLevel = VALID_LEVELS.has(parsed.level as DeliveryLevel) ? (parsed.level as DeliveryLevel) : 'record';
        break;
      }
    } catch {
      return;
    }
    if (!foundId || epoch !== this.clearEpoch) return;
    const critical =
      !foundIsFile &&
      (patch.level === 'context' || patch.level === 'wake' || foundLevel === 'context' || foundLevel === 'wake');
    const record = {
      record: 'patch' as const,
      id: foundId,
      ...(patch.level !== undefined ? { level: patch.level } : {}),
      ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
      ...(patch.feedback !== undefined ? { feedback: patch.feedback } : {}),
    };
    const raw = JSON.stringify(record);
    this.feedTodayRaw(date, raw);
    await this.appendRawLine(date, `${raw}\n`, epoch, { tier: foundIsFile ? 'file' : 'nonFile', critical });
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.tail.then(work).catch(() => {});
    this.tail = run;
    return run;
  }

  private syncClockDate(wall: number): string {
    const nowDate = this.calendar.dateKey(wall);
    if (!this.currentDate) return nowDate;
    if (nowDate > this.currentDate) {
      this.enqueueRollover(wall);
    } else if (nowDate < this.currentDate) {
      const detached = this.detachMatchingActivityBuckets(() => true);
      if (detached.length > 0) {
        const prevEpoch = this.clearEpoch;
        if (detached.length <= FLUSH_ACTIVITY_SLICE_MAX_BUCKETS) {
          const items: Array<{ date: string; raw: string; epoch: number }> = [];
          for (const b of detached) {
            const raw = this.serializeActivityBucket(b);
            this.feedTodayRaw(b.date, raw);
            items.push({ date: b.date, raw, epoch: prevEpoch });
          }
          if (items.length > 0) this.enqueue(() => this.appendBatchedActivityLines(items));
        } else {
          this.enqueue(() => this.flushDetachedBucketsSliced(detached, prevEpoch));
        }
      }
      this.currentDate = nowDate;
      this.currentMonth = this.calendar.monthKey(wall);
      this.lastAliveAt = wall;
      this.resetTodayAcc(nowDate);
      this.yesterdaySummary = undefined;
      this.yesterdayLateState = undefined;
      const paused = this.isPaused();
      const epoch = this.clearEpoch;
      const marker: HistoryLifecycleRecord = {
        record: 'lifecycle',
        state: paused ? 'paused' : 'active',
        at: wall,
      };
      this.activeLifecycleOpen = true;
      const raw = JSON.stringify(marker);
      this.feedTodayRaw(nowDate, raw);
      this.enqueue(() => this.appendRawLine(nowDate, `${raw}\n`, epoch));
      this.onSummaryChanged?.();
    }
    return nowDate;
  }

  private enqueueLifecycle(state: 'active' | 'paused', at: number): void {
    const date = this.calendar.dateKey(at);
    this.lastAliveAt = Math.max(this.lastAliveAt, at);
    const epoch = this.clearEpoch;
    const record: HistoryLifecycleRecord = { record: 'lifecycle', state, at };
    this.activeLifecycleOpen = true;
    const raw = JSON.stringify(record);
    this.feedTodayRaw(date, raw);
    this.enqueue(() => this.appendRawLine(date, `${raw}\n`, epoch));
  }

  private enqueueRollover(wall: number): void {
    const prevDate = this.currentDate;
    const prevMonthKey = this.currentMonth;
    const nextDate = this.calendar.dateKey(wall);
    const nextMonthKey = this.calendar.monthKey(wall);
    if (!prevDate || nextDate <= prevDate) return;

    const dueBuckets = this.detachMatchingActivityBuckets((b) => b.date < nextDate);
    let deferredRolloverBuckets: PendingActivityBucket[] = [];
    if (dueBuckets.length <= FLUSH_ACTIVITY_SLICE_MAX_BUCKETS) {
      const items: Array<{ date: string; raw: string; epoch: number }> = [];
      for (const b of dueBuckets) {
        const raw = this.serializeActivityBucket(b);
        this.feedTodayRaw(b.date, raw);
        items.push({ date: b.date, raw, epoch: b.epoch });
      }
      if (items.length > 0) {
        this.enqueue(() => this.appendBatchedActivityLines(items));
      }
    } else {
      deferredRolloverBuckets = dueBuckets;
    }

    const prevWasCapped = this.cappedDates.has(prevDate);
    let prevPendingHydration: { date: string; epoch: number; liveLines: string[] } | undefined;
    const prevEpoch = this.clearEpoch;
    if (this.pendingTodayHydration?.date === prevDate && this.pendingTodayHydration.epoch === prevEpoch) {
      prevPendingHydration = this.pendingTodayHydration;
      this.pendingTodayHydration = undefined;
      if (this.todayHydrationTimer) {
        clearTimeout(this.todayHydrationTimer);
        this.todayHydrationTimer = undefined;
      }
    }
    const prevAcc = !prevPendingHydration ? this.todayAcc : undefined;
    const prevProvisional =
      prevAcc && diffDays(nextDate, prevDate) === 1
        ? prevAcc.snapshot(prevWasCapped ? { truncatedAtLimit: true } : undefined)
        : undefined;
    if (prevProvisional) {
      if (deferredRolloverBuckets.length > 0) {
        for (const b of deferredRolloverBuckets) {
          if (b.date === prevDate) this.applyActivityBucketToSummary(prevProvisional, b);
        }
      }
      this.applyDayExtensions(prevProvisional, prevDate);
    }

    const prevAliveAt = this.lastAliveAt;
    const prevBoundsSync = this.calendar.dayBounds(prevDate);
    const continuousSync = diffDays(nextDate, prevDate) === 1 && prevBoundsSync.endMs - prevAliveAt <= 10 * 60_000;
    const carryApp = this.activeApp;
    const paused = this.isPaused();
    this.currentDate = nextDate;
    this.currentMonth = nextMonthKey;
    this.backfillCurrentMonth = nextMonthKey;
    this.lastAliveAt = wall;
    this.resetTodayAcc(nextDate);
    this.yesterdaySummary = prevProvisional && !isEmptyDailySummary(prevProvisional) ? prevProvisional : undefined;
    if (prevAcc && diffDays(nextDate, prevDate) === 1) {
      this.yesterdayLateState = {
        date: prevDate,
        acc: prevAcc,
        rolloverOpts: {
          isRunningAtEnd: continuousSync,
          liveEndMs: continuousSync ? prevBoundsSync.endMs : undefined,
          truncatedAtLimit: prevWasCapped,
        },
        expiresMono: this.clock.mono() + LATE_ROLLOVER_GRACE_MS,
        prevMonthKey: prevMonthKey ?? prevDate.slice(0, 7),
        nextMonthKey,
        dirty: false,
      };
    } else {
      this.yesterdayLateState = undefined;
    }
    const epoch = this.clearEpoch;

    this.enqueue(async () => {
      if (!this.port || this.isEpochStale(epoch)) return;
      if (deferredRolloverBuckets.length > 0) {
        await this.flushDetachedBucketsSliced(deferredRolloverBuckets, epoch, (raw) => {
          prevAcc?.feed(raw);
        });
        if (this.isEpochStale(epoch)) return;
      }
      const prevBounds = this.calendar.dayBounds(prevDate);
      const continuous = diffDays(nextDate, prevDate) === 1 && prevBounds.endMs - prevAliveAt <= 10 * 60_000;
      try {
        const size = await this.safeEventFileSize(prevDate);
        if (this.isEpochStale(epoch)) return;
        const truncatedAtLimit = prevWasCapped || this.cappedDates.has(prevDate) || size >= this.maxDailyBytes;
        const rolloverOpts = {
          isRunningAtEnd: continuous,
          liveEndMs: continuous ? prevBounds.endMs : undefined,
          truncatedAtLimit,
        };
        let daily: DailySummary | undefined;
        let finalAcc = prevAcc;
        if (prevAcc) {
          if (this.yesterdayLateState?.acc === prevAcc && this.yesterdayLateState.date === prevDate) {
            this.yesterdayLateState.rolloverOpts = rolloverOpts;
            this.yesterdayLateState.dirty = false;
          }
          if (prevAcc.hasRecords() || size > 0) {
            daily = diffDays(nextDate, prevDate) === 1 ? prevAcc.snapshot(rolloverOpts) : prevAcc.finish(rolloverOpts);
          }
        } else {
          const acc = createDailySummaryAccumulator(prevDate, prevBounds, rolloverOpts);
          const rolloverStats = createDayTierStats();
          let sawLine = false;
          for await (const line of this.streamLinesForward(prevDate)) {
            if (this.isEpochStale(epoch)) return;
            this.observeTierLine(rolloverStats, line);
            acc.feed(line);
            sawLine = true;
          }
          if (this.isEpochStale(epoch)) return;
          const liveLines = prevPendingHydration?.liveLines ?? [];
          for (const raw of liveLines) {
            acc.feed(raw);
            sawLine = true;
          }
          if (sawLine || size > 0) {
            const inferred = this.evaluateCappedFromStats(rolloverStats, size);
            const finalOpts = {
              ...rolloverOpts,
              truncatedAtLimit: rolloverOpts.truncatedAtLimit || inferred.anyCapped,
            };
            daily = diffDays(nextDate, prevDate) === 1 ? acc.snapshot(finalOpts) : acc.finish(finalOpts);
            if (diffDays(nextDate, prevDate) === 1) {
              finalAcc = acc;
              this.yesterdayLateState = {
                date: prevDate,
                acc: finalAcc,
                rolloverOpts: finalOpts,
                expiresMono: this.clock.mono() + LATE_ROLLOVER_GRACE_MS,
                prevMonthKey: prevMonthKey ?? prevDate.slice(0, 7),
                nextMonthKey,
                dirty: false,
              };
            }
          }
        }
        if (daily) {
          this.applyDayExtensions(daily, prevDate);
          await this.port.writeDaily(prevDate, JSON.stringify(daily));
          if (this.isEpochStale(epoch)) return;
          if (prevDate === this.yesterdayDate) {
            this.yesterdaySummary = isEmptyDailySummary(daily) ? undefined : daily;
            this.summaryRevision += 1;
          }
          if (this.pendingBackfillEpoch === epoch) {
            this.pendingBackfill.delete(prevDate);
            this.backfillFailures.delete(prevDate);
          }
          this.clearSummaryDegraded();
        }
        if (this.isEpochStale(epoch)) return;
        if (nextMonthKey !== prevMonthKey) {
          await this.synthesizeAllCompletedMonths(nextMonthKey, epoch);
        }
        if (this.isEpochStale(epoch)) return;
        await this.pruneExpired(nextDate, epoch);
      } catch (error) {
        if (this.isEpochStale(epoch)) return;
        const code = unsafeFsCode(error);
        if (code) {
          this.reportFileErrorOnce(`unsafe:events:${prevDate}:${code}`, 'history-unsafe-entry', {
            kind: 'events',
            date: prevDate,
            code,
          });
        } else {
          this.reportSummaryWriteFailure(prevDate, 'history-write-failed');
        }
      }
      if (this.isEpochStale(epoch)) return;
      if (this.cappedDates.has(prevDate)) {
        await this.port.writeCapState?.('').catch(() => {});
        if (!this.appendDegraded && !this.summaryDegraded) {
          this.safeEmitSourceOk({ capped: false });
        } else {
          this.safeClearSourceCap();
        }
      }
      const startAt = continuous ? prevBounds.endMs : wall;
      const boundary: HistoryLifecycleRecord = {
        record: 'lifecycle',
        state: paused ? 'paused' : 'active',
        at: startAt,
        ...(continuous && carryApp ? { app: carryApp } : {}),
      };
      this.activeLifecycleOpen = true;
      const rawBoundary = JSON.stringify(boundary);
      this.feedTodayRaw(nextDate, rawBoundary);
      await this.appendRawLine(nextDate, `${rawBoundary}\n`, epoch);
      this.onSummaryChanged?.();
    });
  }

  private filterValidDates(rawDates: readonly string[], kind: 'events' | 'daily'): string[] {
    const valid: string[] = [];
    for (const date of rawDates) {
      if (!parseDateKey(date)) {
        this.reportFileErrorOnce(`invalid-date:${kind}:${date}`, 'invalid-history-date', { kind, date });
        continue;
      }
      valid.push(date);
    }
    return valid;
  }

  private async safeEventFileSize(date: string): Promise<number> {
    if (!this.port) return 0;
    try {
      return await this.port.eventFileSize(date);
    } catch (error) {
      const code = unsafeFsCode(error);
      if (code) {
        this.reportFileErrorOnce(`unsafe:events:${date}:${code}`, 'history-unsafe-entry', {
          kind: 'events',
          date,
          code,
        });
        return 0;
      }
      throw error;
    }
  }

  private async startupMaintenance(today: string, currentMonth: string, epoch: number): Promise<void> {
    if (!this.port || this.isEpochStale(epoch)) {
      this.clearPendingForEpoch(epoch);
      return;
    }
    this.backfillCurrentMonth = currentMonth;
    try {
      const knownUnsafeEvents = new Set<string>();
      if (this.port.harden) {
        try {
          const unsafe = await this.port.harden();
          if (this.isEpochStale(epoch)) {
            this.clearPendingForEpoch(epoch);
            return;
          }
          for (const item of unsafe) {
            const keyName =
              item.kind === 'events'
                ? item.name.replace(/\.jsonl$/, '')
                : item.kind === 'daily' || item.kind === 'monthly'
                  ? item.name.replace(/\.json$/, '')
                  : item.name;
            if (item.kind === 'events') knownUnsafeEvents.add(keyName);
            this.reportFileErrorOnce(`unsafe:${item.kind}:${keyName}:${item.code}`, 'history-unsafe-entry', {
              kind: item.kind,
              name: item.name,
              code: item.code,
            });
          }
        } catch (error) {
          if (this.isEpochStale(epoch)) {
            this.clearPendingForEpoch(epoch);
            return;
          }
          const code = unsafeFsCode(error);
          if (code) {
            this.reportFileErrorOnce(`unsafe:harden:${code}`, 'history-unsafe-entry', { code });
            return;
          }
          throw error;
        }
      }
      if (this.isEpochStale(epoch)) {
        this.clearPendingForEpoch(epoch);
        return;
      }

      let rawEventDates: string[] = [];
      try {
        rawEventDates = await this.port.listEventDates();
      } catch (error) {
        if (this.isEpochStale(epoch)) {
          this.clearPendingForEpoch(epoch);
          return;
        }
        const code = unsafeFsCode(error);
        if (code) {
          this.reportFileErrorOnce(`unsafe:events-dir:${code}`, 'history-unsafe-entry', { dir: 'events', code });
        } else {
          throw error;
        }
      }
      if (this.isEpochStale(epoch)) {
        this.clearPendingForEpoch(epoch);
        return;
      }

      const eventDates = this.filterValidDates(rawEventDates, 'events').sort();
      const keptDates: string[] = [];
      for (const date of eventDates) {
        if (this.isEpochStale(epoch)) {
          this.clearPendingForEpoch(epoch);
          return;
        }
        if (knownUnsafeEvents.has(date)) continue;
        if (diffDays(today, date) > HISTORY_RETENTION_DAYS) {
          try {
            await this.port.deleteEventDate(date);
            if (this.isEpochStale(epoch)) {
              this.clearPendingForEpoch(epoch);
              return;
            }
          } catch (error) {
            if (this.isEpochStale(epoch)) {
              this.clearPendingForEpoch(epoch);
              return;
            }
            const code = unsafeFsCode(error);
            if (code) {
              this.reportFileErrorOnce(`unsafe:events:${date}:${code}`, 'history-unsafe-entry', {
                kind: 'events',
                date,
                code,
              });
            } else {
              throw error;
            }
          }
        } else {
          keptDates.push(date);
        }
      }
      if (this.isEpochStale(epoch)) {
        this.clearPendingForEpoch(epoch);
        return;
      }
      const retainedDates = await this.pruneEventDatesOverTotalCap(keptDates, today, epoch);
      if (this.isEpochStale(epoch)) {
        this.clearPendingForEpoch(epoch);
        return;
      }

      // Restore up to 200 most recent events starting from the latest day only.
      const collected: Array<{ date: string; ev: PersistedEventEntry }> = [];
      const seenTodayBootTags = new Set<string>();
      let seenTodayCapError = false;
      for (let i = retainedDates.length - 1; i >= 0 && collected.length < MAX_HISTORY_LIMIT; i--) {
        const date = retainedDates[i];
        try {
          const scanner = createReverseEventScanner();
          for await (const line of this.streamLinesDesc(date)) {
            if (this.isEpochStale(epoch)) {
              this.clearPendingForEpoch(epoch);
              return;
            }
            const ev = scanner.accept(line);
            if (!ev) continue;
            if (date === today) {
              const tag = BOOT_ID_RE.exec(ev.id)?.[1];
              if (tag) seenTodayBootTags.add(tag);
              if (ev.kind === 'source.error' && ev.subject === 'history' && ev.reason === 'daily-limit-exceeded') {
                seenTodayCapError = true;
              }
            }
            collected.push({ date, ev });
            if (collected.length >= MAX_HISTORY_LIMIT) break;
          }
        } catch (error) {
          if (this.isEpochStale(epoch)) {
            this.clearPendingForEpoch(epoch);
            return;
          }
          const code = unsafeFsCode(error);
          if (code) {
            knownUnsafeEvents.add(date);
            this.reportFileErrorOnce(`unsafe:events:${date}:${code}`, 'history-unsafe-entry', {
              kind: 'events',
              date,
              code,
            });
            continue;
          }
          throw error;
        }
      }
      if (this.isEpochStale(epoch)) {
        this.clearPendingForEpoch(epoch);
        return;
      }
      const todayHasEvents = retainedDates.includes(today) && !knownUnsafeEvents.has(today);
      const todayBytes = todayHasEvents ? await this.safeEventFileSize(today) : 0;
      if (this.isEpochStale(epoch)) {
        this.clearPendingForEpoch(epoch);
        return;
      }
      let hydratedTodayDiskStats: DayTierStats | undefined;
      if (todayHasEvents && todayBytes <= 512 * 1024) {
        const res = await this.hydrateTodayFromDisk(today, epoch, false);
        if (this.isEpochStale(epoch)) {
          this.clearPendingForEpoch(epoch);
          return;
        }
        hydratedTodayDiskStats = res.diskStats;
      }
      await this.restoreTodayCapState(
        today,
        seenTodayCapError,
        todayHasEvents,
        todayBytes,
        hydratedTodayDiskStats,
        epoch,
      );
      if (this.isEpochStale(epoch)) {
        this.clearPendingForEpoch(epoch);
        return;
      }
      while (seenTodayBootTags.has(this.bootTag)) {
        this.bootTag = makeBootTag();
        this.shortSeq = 0;
      }
      this.usedBootTags.add(this.bootTag);
      for (const tag of seenTodayBootTags) this.usedBootTags.add(tag);
      if (collected.length > 0) {
        collected.reverse();
        for (const item of collected) {
          if (item.ev.kind === 'file.activity') {
            this.rememberActivityMeta(item.ev.id, item.date, item.ev.id, true, false);
          } else {
            this.rememberEventMeta(
              item.ev.id,
              item.date,
              item.ev.id,
              item.ev.kind.startsWith('file.'),
              this.isCriticalEvent(item.ev.kind, item.ev.level),
            );
          }
        }
        this.restoreEntries(collected.map((item) => item.ev));
      }

      if (todayHasEvents && todayBytes > 512 * 1024) {
        this.scheduleTodayHydration(today, epoch);
      }

      // Prune daily summaries older than 400 days.
      const existingDailyDates = new Set<string>();
      try {
        const rawDailyDates = await this.port.listDailyDates();
        if (this.isEpochStale(epoch)) {
          this.clearPendingForEpoch(epoch);
          return;
        }
        for (const date of this.filterValidDates(rawDailyDates, 'daily')) {
          if (this.isEpochStale(epoch)) {
            this.clearPendingForEpoch(epoch);
            return;
          }
          if (diffDays(today, date) > DAILY_SUMMARY_RETENTION_DAYS) {
            try {
              await this.port.deleteDailyDate(date);
              if (this.isEpochStale(epoch)) {
                this.clearPendingForEpoch(epoch);
                return;
              }
            } catch (error) {
              if (this.isEpochStale(epoch)) {
                this.clearPendingForEpoch(epoch);
                return;
              }
              const code = unsafeFsCode(error);
              if (code) {
                this.reportFileErrorOnce(`unsafe:daily:${date}:${code}`, 'history-unsafe-entry', {
                  kind: 'daily',
                  date,
                  code,
                });
              } else {
                throw error;
              }
            }
          } else {
            existingDailyDates.add(date);
          }
        }
      } catch (error) {
        if (this.isEpochStale(epoch)) {
          this.clearPendingForEpoch(epoch);
          return;
        }
        const code = unsafeFsCode(error);
        if (code) {
          this.reportFileErrorOnce(`unsafe:daily-dir:${code}`, 'history-unsafe-entry', { dir: 'daily', code });
        } else {
          throw error;
        }
      }
      if (this.isEpochStale(epoch)) {
        this.clearPendingForEpoch(epoch);
        return;
      }

      // Determine missing daily summaries for past days with retained raw logs.
      const missingDailyDates: string[] = [];
      for (const date of retainedDates) {
        if (this.isEpochStale(epoch)) {
          this.clearPendingForEpoch(epoch);
          return;
        }
        if (date >= today || knownUnsafeEvents.has(date)) continue;
        if (!existingDailyDates.has(date)) {
          missingDailyDates.push(date);
          continue;
        }
        try {
          const existing = await this.port.readDaily(date);
          if (this.isEpochStale(epoch)) {
            this.clearPendingForEpoch(epoch);
            return;
          }
          if (existing !== undefined) {
            const parsed = parseDailySummary(existing);
            if (parsed) {
              if (date === this.yesterdayDate) {
                this.yesterdaySummary = isEmptyDailySummary(parsed) ? undefined : parsed;
                this.summaryRevision += 1;
              }
              continue;
            }
            this.reportFileErrorOnce(`corrupt:daily:${date}`, 'corrupt-daily-summary', { date });
          }
          missingDailyDates.push(date);
        } catch (error) {
          if (this.isEpochStale(epoch)) {
            this.clearPendingForEpoch(epoch);
            return;
          }
          const code = unsafeFsCode(error);
          if (code) {
            this.reportFileErrorOnce(`unsafe:daily:${date}:${code}`, 'history-unsafe-entry', {
              kind: 'daily',
              date,
              code,
            });
            continue;
          }
          throw error;
        }
      }

      if (!this.registerPendingBackfill(missingDailyDates, epoch)) {
        return;
      }

      // Synthesize completed months that have no pending backfill; months with
      // pending days are synthesized once background backfill completes.
      if (this.yesterdayDate && !this.yesterdaySummary && existingDailyDates.has(this.yesterdayDate)) {
        try {
          const rawYesterday = await this.port.readDaily(this.yesterdayDate);
          if (this.isEpochStale(epoch)) {
            this.clearPendingForEpoch(epoch);
            return;
          }
          if (rawYesterday !== undefined) {
            const parsedYesterday = parseDailySummary(rawYesterday);
            if (parsedYesterday && !isEmptyDailySummary(parsedYesterday)) {
              this.yesterdaySummary = parsedYesterday;
              this.summaryRevision += 1;
            }
          }
        } catch {
          // Handled via missingDailyDates or left empty.
        }
      }
      if (existingDailyDates.size > 0) {
        await this.synthesizeAllCompletedMonths(currentMonth, epoch, [...existingDailyDates]);
      }
      if (this.isEpochStale(epoch)) {
        this.clearPendingForEpoch(epoch);
        return;
      }

      if (this.pendingBackfill.size > 0) {
        this.scheduleBackfill(epoch);
      }
    } catch {
      if (this.isEpochStale(epoch)) {
        this.clearPendingForEpoch(epoch);
        return;
      }
      this.reportSummaryWriteFailure(today, 'history-startup-failed');
    }
  }

  private scheduleBackfill(epoch: number, delayMs = 50): void {
    if (
      this.backfillTimer ||
      this.isEpochStale(epoch) ||
      this.pendingBackfillEpoch !== epoch ||
      this.pendingBackfill.size === 0
    ) {
      return;
    }
    this.backfillTimer = setTimeout(() => {
      this.backfillTimer = undefined;
      const step = this.runBackfillStep(epoch);
      this.activeBackfillStep = step;
      void step.finally(() => {
        if (this.activeBackfillStep === step) this.activeBackfillStep = undefined;
      });
    }, delayMs);
    this.backfillTimer.unref?.();
  }

  private cancelBackfill(): void {
    if (this.backfillTimer) {
      clearTimeout(this.backfillTimer);
      this.backfillTimer = undefined;
    }
    if (this.todayHydrationTimer) {
      clearTimeout(this.todayHydrationTimer);
      this.todayHydrationTimer = undefined;
    }
    this.pendingTodayHydration = undefined;
    this.backfillYieldWake?.();
    this.backfillYieldWake = undefined;
    this.pendingBackfill.clear();
    this.backfillFailures.clear();
  }

  private waitBackfillTurn(epoch: number, delayMs = 0): Promise<void> {
    if (this.isEpochStale(epoch)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.backfillYieldWake === done) this.backfillYieldWake = undefined;
        resolve();
      };
      const timer = setTimeout(done, delayMs);
      timer.unref?.();
      this.backfillYieldWake = done;
    });
  }

  private async runBackfillStep(epoch: number): Promise<void> {
    if (!this.port || this.isEpochStale(epoch) || this.pendingBackfillEpoch !== epoch) {
      this.clearPendingForEpoch(epoch);
      return;
    }
    if (this.activeQueries > 0) {
      this.scheduleBackfill(epoch, 20);
      return;
    }
    const nextDate = this.pickNextBackfillDate();
    if (!nextDate) {
      const month = this.backfillCurrentMonth ?? this.calendar.monthKey(this.clock.wall());
      await this.enqueue(() => this.synthesizeAllCompletedMonths(month, epoch));
      return;
    }
    try {
      const size = await this.safeEventFileSize(nextDate);
      if (this.isEpochStale(epoch)) {
        this.clearPendingForEpoch(epoch);
        return;
      }
      const bounds = this.calendar.dayBounds(nextDate);
      const acc = createDailySummaryAccumulator(nextDate, bounds, {
        isRunningAtEnd: false,
        truncatedAtLimit: this.cappedDates.has(nextDate) || size >= this.maxDailyBytes,
      });
      const backfillStats = createDayTierStats();
      let sawLine = false;
      let sliceStart = performance.now();
      for await (const line of this.streamLinesForward(nextDate)) {
        if (this.isEpochStale(epoch)) {
          this.clearPendingForEpoch(epoch);
          return;
        }
        this.observeTierLine(backfillStats, line);
        acc.feed(line);
        sawLine = true;
        if (this.activeQueries > 0 || performance.now() - sliceStart >= 16) {
          await this.waitBackfillTurn(epoch, this.activeQueries > 0 ? 15 : 0);
          if (this.isEpochStale(epoch)) {
            this.clearPendingForEpoch(epoch);
            return;
          }
          sliceStart = performance.now();
        }
      }
      if (this.isEpochStale(epoch)) {
        this.clearPendingForEpoch(epoch);
        return;
      }
      if (sawLine || size > 0) {
        const inferred = this.evaluateCappedFromStats(backfillStats, size);
        const daily = acc.finish({
          isRunningAtEnd: false,
          truncatedAtLimit: this.cappedDates.has(nextDate) || inferred.anyCapped,
        });
        this.applyDayExtensions(daily, nextDate);
        const dailyJson = JSON.stringify(daily);
        if (this.isEpochStale(epoch)) {
          this.clearPendingForEpoch(epoch);
          return;
        }
        await this.enqueue(async () => {
          if (!this.port || this.isEpochStale(epoch)) {
            this.clearPendingForEpoch(epoch);
            return;
          }
          try {
            await this.port.writeDaily(nextDate, dailyJson);
            if (this.isEpochStale(epoch)) {
              this.clearPendingForEpoch(epoch);
              return;
            }
            if (nextDate === this.yesterdayDate) {
              this.yesterdaySummary = isEmptyDailySummary(daily) ? undefined : daily;
              this.summaryRevision += 1;
              this.onSummaryChanged?.();
            }
            this.pendingBackfill.delete(nextDate);
            this.backfillFailures.delete(nextDate);
            this.clearSummaryDegraded();
          } catch (writeError) {
            if (this.isEpochStale(epoch)) {
              this.clearPendingForEpoch(epoch);
              return;
            }
            const code = unsafeFsCode(writeError);
            if (code) {
              this.reportFileErrorOnce(`unsafe:daily:${nextDate}:${code}`, 'history-unsafe-entry', {
                kind: 'daily',
                date: nextDate,
                code,
              });
            } else {
              this.reportSummaryWriteFailure(nextDate, 'history-write-failed');
            }
            const failures = (this.backfillFailures.get(nextDate) ?? 0) + 1;
            this.backfillFailures.set(nextDate, failures);
            if (this.pendingBackfill.delete(nextDate)) {
              this.pendingBackfill.add(nextDate);
            }
          }
        });
      } else {
        this.pendingBackfill.delete(nextDate);
        this.backfillFailures.delete(nextDate);
      }
    } catch (error) {
      if (this.isEpochStale(epoch)) {
        this.clearPendingForEpoch(epoch);
        return;
      }
      const code = unsafeFsCode(error);
      if (code) {
        this.reportFileErrorOnce(`unsafe:events:${nextDate}:${code}`, 'history-unsafe-entry', {
          kind: 'events',
          date: nextDate,
          code,
        });
        this.pendingBackfill.delete(nextDate);
        this.backfillFailures.delete(nextDate);
      } else {
        this.reportSummaryWriteFailure(nextDate, 'history-write-failed');
        const failures = (this.backfillFailures.get(nextDate) ?? 0) + 1;
        this.backfillFailures.set(nextDate, failures);
        if (this.pendingBackfill.delete(nextDate)) {
          this.pendingBackfill.add(nextDate);
        }
      }
    }

    if (this.isEpochStale(epoch)) {
      this.clearPendingForEpoch(epoch);
      return;
    }
    const upcoming = this.pickNextBackfillDate();
    if (!upcoming) {
      const month = this.backfillCurrentMonth ?? this.calendar.monthKey(this.clock.wall());
      await this.enqueue(() => this.synthesizeAllCompletedMonths(month, epoch));
      return;
    }
    const failCount = this.backfillFailures.get(upcoming) ?? 0;
    const delayMs = failCount > 0 ? Math.min(200, failCount * 40) : 5;
    this.scheduleBackfill(epoch, delayMs);
  }

  private async synthesizeAllCompletedMonths(
    currentMonth: string,
    epoch: number,
    cachedDailyDates?: string[],
  ): Promise<void> {
    if (!this.port || this.isEpochStale(epoch)) {
      this.clearPendingForEpoch(epoch);
      return;
    }
    let rawDailyDates: string[];
    if (cachedDailyDates) {
      rawDailyDates = cachedDailyDates;
    } else {
      try {
        rawDailyDates = await this.port.listDailyDates();
      } catch (error) {
        if (this.isEpochStale(epoch)) {
          this.clearPendingForEpoch(epoch);
          return;
        }
        const code = unsafeFsCode(error);
        if (code) {
          this.reportFileErrorOnce(`unsafe:daily-dir:${code}`, 'history-unsafe-entry', { dir: 'daily', code });
          return;
        }
        throw error;
      }
      if (this.isEpochStale(epoch)) {
        this.clearPendingForEpoch(epoch);
        return;
      }
    }
    const dailyDates = this.filterValidDates(rawDailyDates, 'daily').sort();
    const completedMonths = new Set<string>();
    for (const date of dailyDates) {
      const month = date.slice(0, 7);
      if (month < currentMonth && !this.hasPendingBackfillForMonth(month)) {
        completedMonths.add(month);
      }
    }
    for (const month of [...completedMonths].sort()) {
      if (this.isEpochStale(epoch)) {
        this.clearPendingForEpoch(epoch);
        return;
      }
      if (this.hasPendingBackfillForMonth(month)) continue;
      try {
        const existing = await this.port.readMonthly(month);
        if (this.isEpochStale(epoch)) {
          this.clearPendingForEpoch(epoch);
          return;
        }
        if (existing !== undefined) {
          if (parseMonthlySummary(existing)) continue;
          this.reportFileErrorOnce(`corrupt:monthly:${month}`, 'corrupt-monthly-summary', { month });
        }
      } catch (error) {
        if (this.isEpochStale(epoch)) {
          this.clearPendingForEpoch(epoch);
          return;
        }
        const code = unsafeFsCode(error);
        if (code) {
          this.reportFileErrorOnce(`unsafe:monthly:${month}:${code}`, 'history-unsafe-entry', {
            kind: 'monthly',
            month,
            code,
          });
          continue;
        }
        throw error;
      }
      await this.synthesizeMonthFromDaily(month, dailyDates, true, false, epoch);
    }
  }

  private async persistMonthlySummary(month: string, monthly: MonthlySummary, epoch?: number): Promise<void> {
    if (!this.port || (epoch !== undefined && this.isEpochStale(epoch))) return;
    try {
      await this.port.writeMonthly(month, JSON.stringify(monthly));
      this.clearSummaryDegraded();
    } catch (error) {
      if (epoch !== undefined && this.isEpochStale(epoch)) return;
      const code = unsafeFsCode(error);
      if (code) {
        this.reportFileErrorOnce(`unsafe:monthly:${month}:${code}`, 'history-unsafe-entry', {
          kind: 'monthly',
          month,
          code,
        });
      } else {
        this.reportSummaryWriteFailure(month, 'history-write-failed');
      }
    }
  }

  private async synthesizeMonthFromDaily(
    month: string,
    cachedDates?: string[],
    persist = true,
    allowEmpty = false,
    epoch?: number,
  ): Promise<MonthlySummary | undefined> {
    if (!this.port || (epoch !== undefined && this.isEpochStale(epoch))) return undefined;
    let sourceDates: string[];
    if (cachedDates) {
      sourceDates = cachedDates;
    } else {
      try {
        sourceDates = this.filterValidDates(await this.port.listDailyDates(), 'daily');
      } catch (error) {
        const code = unsafeFsCode(error);
        if (code) {
          this.reportFileErrorOnce(`unsafe:daily-dir:${code}`, 'history-unsafe-entry', { dir: 'daily', code });
          return undefined;
        }
        throw error;
      }
    }
    if (epoch !== undefined && this.isEpochStale(epoch)) return undefined;
    const dailyDates = sourceDates.filter((d) => d.startsWith(`${month}-`)).sort();
    if (dailyDates.length === 0 && !allowEmpty) return undefined;
    const dailies: DailySummary[] = [];
    for (const date of dailyDates) {
      if (epoch !== undefined && this.isEpochStale(epoch)) return undefined;
      try {
        const raw = await this.port.readDaily(date);
        if (epoch !== undefined && this.isEpochStale(epoch)) return undefined;
        if (raw === undefined) continue;
        const parsed = parseDailySummary(raw);
        if (parsed) {
          dailies.push(parsed);
        } else {
          this.reportFileErrorOnce(`corrupt:daily:${date}`, 'corrupt-daily-summary', { date });
        }
      } catch (error) {
        const code = unsafeFsCode(error);
        if (code) {
          this.reportFileErrorOnce(`unsafe:daily:${date}:${code}`, 'history-unsafe-entry', {
            kind: 'daily',
            date,
            code,
          });
          continue;
        }
        throw error;
      }
    }
    if (dailies.length === 0 && !allowEmpty) return undefined;
    if (epoch !== undefined && this.isEpochStale(epoch)) return undefined;
    const monthly = synthesizeMonth(month, dailies, this.clock.wall());
    if (persist) {
      await this.persistMonthlySummary(month, monthly, epoch);
    }
    return monthly;
  }

  private async pruneExpired(today: string, epoch: number): Promise<void> {
    if (!this.port || this.isEpochStale(epoch)) return;
    try {
      const eventDates = this.filterValidDates(await this.port.listEventDates(), 'events').sort();
      if (this.isEpochStale(epoch)) return;
      const keptDates: string[] = [];
      for (const date of eventDates) {
        if (this.isEpochStale(epoch)) return;
        if (diffDays(today, date) > HISTORY_RETENTION_DAYS) {
          try {
            await this.port.deleteEventDate(date);
            this.usageByDate.delete(date);
            this.cappedDates.delete(date);
            this.fileCappedDates.delete(date);
            this.nonFileCappedDates.delete(date);
            this.criticalCappedDates.delete(date);
            this.capErrorsEmitted.delete(date);
          } catch (error) {
            const code = unsafeFsCode(error);
            if (code) {
              this.reportFileErrorOnce(`unsafe:events:${date}:${code}`, 'history-unsafe-entry', {
                kind: 'events',
                date,
                code,
              });
            } else {
              throw error;
            }
          }
        } else {
          keptDates.push(date);
        }
      }
      await this.pruneEventDatesOverTotalCap(keptDates, today, epoch);
    } catch (error) {
      const code = unsafeFsCode(error);
      if (code) {
        this.reportFileErrorOnce(`unsafe:events-dir:${code}`, 'history-unsafe-entry', { dir: 'events', code });
      } else {
        throw error;
      }
    }
    if (this.isEpochStale(epoch)) return;
    try {
      const dailyDates = this.filterValidDates(await this.port.listDailyDates(), 'daily');
      if (this.isEpochStale(epoch)) return;
      for (const date of dailyDates) {
        if (this.isEpochStale(epoch)) return;
        if (diffDays(today, date) > DAILY_SUMMARY_RETENTION_DAYS) {
          try {
            await this.port.deleteDailyDate(date);
          } catch (error) {
            const code = unsafeFsCode(error);
            if (code) {
              this.reportFileErrorOnce(`unsafe:daily:${date}:${code}`, 'history-unsafe-entry', {
                kind: 'daily',
                date,
                code,
              });
            } else {
              throw error;
            }
          }
        }
      }
    } catch (error) {
      const code = unsafeFsCode(error);
      if (code) {
        this.reportFileErrorOnce(`unsafe:daily-dir:${code}`, 'history-unsafe-entry', { dir: 'daily', code });
      } else {
        throw error;
      }
    }
  }

  private async *streamLinesForward(date: string): AsyncIterable<string> {
    if (!this.port) return;
    if (this.port.readEventLines) {
      yield* this.port.readEventLines(date);
      return;
    }
    const raw = await this.port.readEvents(date);
    if (raw === undefined) return;
    let start = 0;
    while (start < raw.length) {
      const nl = raw.indexOf('\n', start);
      const line = (nl < 0 ? raw.slice(start) : raw.slice(start, nl)).trim();
      if (line) yield line;
      if (nl < 0) break;
      start = nl + 1;
    }
  }

  private async *streamLinesDesc(date: string): AsyncIterable<string> {
    if (!this.port) return;
    if (this.port.readEventLinesDesc) {
      yield* this.port.readEventLinesDesc(date);
      return;
    }
    const raw = await this.port.readEvents(date);
    if (raw === undefined) return;
    let end = raw.length;
    while (end > 0) {
      const nl = raw.lastIndexOf('\n', end - 1);
      const line = raw.slice(nl + 1, end).trim();
      if (line) yield line;
      if (nl < 0) break;
      end = nl;
    }
  }

  private async pruneEventDatesOverTotalCap(
    keptDates: readonly string[],
    today: string,
    epoch: number,
  ): Promise<string[]> {
    if (!this.port || this.maxTotalBytes <= 0 || keptDates.length <= 1) return [...keptDates];
    const sorted = [...keptDates].sort();
    const entries: Array<{ date: string; size: number }> = [];
    let totalBytes = 0;
    for (const date of sorted) {
      if (this.isEpochStale(epoch)) return sorted;
      const size = await this.safeEventFileSize(date);
      totalBytes += size;
      entries.push({ date, size });
    }
    if (totalBytes <= this.maxTotalBytes) return sorted;

    const deleted = new Set<string>();
    for (const entry of entries) {
      if (totalBytes <= this.maxTotalBytes) break;
      if (entry.date >= today) continue;
      if (this.isEpochStale(epoch)) break;
      try {
        await this.port.deleteEventDate(entry.date);
        this.usageByDate.delete(entry.date);
        this.cappedDates.delete(entry.date);
        this.fileCappedDates.delete(entry.date);
        this.nonFileCappedDates.delete(entry.date);
        this.criticalCappedDates.delete(entry.date);
        this.capErrorsEmitted.delete(entry.date);
        deleted.add(entry.date);
        totalBytes -= entry.size;
      } catch (error) {
        const code = unsafeFsCode(error);
        if (code) {
          this.reportFileErrorOnce(`unsafe:events:${entry.date}:${code}`, 'history-unsafe-entry', {
            kind: 'events',
            date: entry.date,
            code,
          });
        } else {
          throw error;
        }
      }
    }
    return deleted.size === 0 ? sorted : sorted.filter((d) => !deleted.has(d));
  }

  private classifyLineTier(rawLine: string): BudgetTier {
    if (!rawLine.includes('"file.')) return 'nonFile';
    try {
      const parsed = JSON.parse(rawLine);
      if (isRecordObject(parsed) && typeof parsed.kind === 'string' && parsed.kind.startsWith('file.')) {
        return 'file';
      }
    } catch {}
    return 'nonFile';
  }

  private async loadDateTierBreakdown(date: string, reportedTotal: number): Promise<DateByteUsage> {
    let file = 0;
    let nonFile = 0;
    for await (const rawLine of this.streamLinesForward(date)) {
      const bytes = Buffer.byteLength(rawLine, 'utf8') + 1;
      if (this.classifyLineTier(rawLine) === 'file') file += bytes;
      else nonFile += bytes;
    }
    if (file + nonFile === 0 && reportedTotal > 0) {
      // Mocked StoragePorts may return a synthetic byte size while readEvents returns undefined.
      return { total: reportedTotal, file: reportedTotal, nonFile: reportedTotal, breakdownLoaded: true };
    }
    return {
      total: Math.max(reportedTotal, file + nonFile),
      file,
      nonFile,
      breakdownLoaded: true,
    };
  }

  private minCapThresholdBytes(): number {
    return Math.min(this.maxFileDailyBytes, this.maxNonFileDailyBytes, this.maxDailyBytes, this.maxCriticalDailyBytes);
  }

  private async triggerDailyCap(
    date: string,
    capKind: CapTier | 'total',
    tier: CapTier,
    maxBytes: number,
    epoch: number,
  ): Promise<void> {
    if (epoch !== this.clearEpoch) return;
    this.cappedDates.add(date);
    if (capKind === 'total') {
      this.fileCappedDates.add(date);
      this.nonFileCappedDates.add(date);
    } else if (capKind === 'critical') {
      this.nonFileCappedDates.add(date);
      this.criticalCappedDates.add(date);
    } else if (capKind === 'file') {
      this.fileCappedDates.add(date);
    } else {
      this.nonFileCappedDates.add(date);
    }
    await this.persistCapStateForDate(date, epoch);
    if (epoch !== this.clearEpoch) return;
    if (!this.capErrorsEmitted.has(date)) {
      this.capErrorsEmitted.add(date);
      this.safeEmitSourceError('daily-limit-exceeded', {
        date,
        tier,
        maxBytes,
      });
    }
  }

  private async appendRawLine(date: string, line: string, epoch: number, options: AppendOptions = {}): Promise<void> {
    if (!this.port || epoch !== this.clearEpoch) return;
    const tier: BudgetTier = options.tier ?? 'nonFile';
    const critical = options.critical === true;
    if (critical) {
      if (this.criticalCappedDates.has(date)) return;
    } else {
      if (tier === 'file' && this.fileCappedDates.has(date)) return;
      if (tier === 'nonFile' && this.nonFileCappedDates.has(date)) return;
    }
    try {
      let usage = this.usageByDate.get(date);
      if (!usage) {
        const total = await this.port.eventFileSize(date);
        if (epoch !== this.clearEpoch) return;
        usage = { total, file: 0, nonFile: 0, breakdownLoaded: total === 0 };
        this.usageByDate.set(date, usage);
      }
      const lineBytes = Buffer.byteLength(line, 'utf8');
      const minTierLimit = this.minCapThresholdBytes();
      if (!usage.breakdownLoaded && usage.total + lineBytes > minTierLimit) {
        const loaded = await this.loadDateTierBreakdown(date, usage.total);
        if (epoch !== this.clearEpoch) return;
        usage = loaded;
        this.usageByDate.set(date, usage);
      }
      if (!critical) {
        const tierLimit = tier === 'file' ? this.maxFileDailyBytes : this.maxNonFileDailyBytes;
        const tierUsed = usage.breakdownLoaded ? (tier === 'file' ? usage.file : usage.nonFile) : usage.total;
        const overTier = tierUsed + lineBytes > tierLimit;
        const overTotal = this.enforceTotalDailyCap && usage.total + lineBytes > this.maxDailyBytes;
        if (overTier || overTotal) {
          await this.triggerDailyCap(
            date,
            overTotal ? 'total' : tier,
            tier,
            overTotal ? this.maxDailyBytes : tierLimit,
            epoch,
          );
          return;
        }
      } else {
        const nonFileUsed = usage.breakdownLoaded ? usage.nonFile : usage.total;
        if (nonFileUsed + lineBytes > this.maxCriticalDailyBytes) {
          await this.triggerDailyCap(date, 'critical', 'critical', this.maxCriticalDailyBytes, epoch);
          return;
        }
      }
      if (epoch !== this.clearEpoch) return;
      await this.port.appendEvent(date, line);
      if (epoch !== this.clearEpoch) return;
      usage.total += lineBytes;
      if (usage.breakdownLoaded) {
        if (tier === 'file') usage.file += lineBytes;
        else usage.nonFile += lineBytes;
      }
      this.clearAppendDegradedIfNeeded();
    } catch (error) {
      if (epoch !== this.clearEpoch) return;
      // Drop cached usage after write failure so a partial write (e.g. ENOSPC) is re-stat'd.
      this.usageByDate.delete(date);
      const code = unsafeFsCode(error);
      if (code) {
        this.reportFileErrorOnce(`unsafe:events:${date}:${code}`, 'history-unsafe-entry', {
          kind: 'events',
          date,
          code,
        });
        return;
      }
      this.reportAppendWriteFailure(date, 'history-write-failed');
    } finally {
      await this.syncYesterdayLateDailyIfNeeded(date, epoch);
    }
  }

  private async appendBatchedActivityLines(
    items: ReadonlyArray<{ date: string; raw: string; epoch: number }>,
  ): Promise<void> {
    const dirtyDates = new Map<string, number>();
    let i = 0;
    while (i < items.length) {
      const { date, epoch } = items[i];
      if (!this.port || epoch !== this.clearEpoch) return;
      dirtyDates.set(date, epoch);
      let end = i + 1;
      while (end < items.length && items[end].date === date && items[end].epoch === epoch) {
        end++;
      }
      if (this.fileCappedDates.has(date)) {
        i = end;
        continue;
      }
      let usage = this.usageByDate.get(date);
      if (!usage) {
        try {
          const total = await this.port.eventFileSize(date);
          if (epoch !== this.clearEpoch) return;
          usage = { total, file: 0, nonFile: 0, breakdownLoaded: total === 0 };
          this.usageByDate.set(date, usage);
        } catch {
          for (let k = i; k < end; k++) {
            await this.appendRawLine(date, `${items[k].raw}\n`, epoch, { tier: 'file', critical: false });
          }
          i = end;
          continue;
        }
      }
      const firstBytes = Buffer.byteLength(items[i].raw, 'utf8') + 1;
      const minTierLimit = this.minCapThresholdBytes();
      if (!usage.breakdownLoaded && usage.total + firstBytes > minTierLimit) {
        try {
          usage = await this.loadDateTierBreakdown(date, usage.total);
          if (epoch !== this.clearEpoch) return;
          this.usageByDate.set(date, usage);
        } catch {
          for (let k = i; k < end; k++) {
            await this.appendRawLine(date, `${items[k].raw}\n`, epoch, { tier: 'file', critical: false });
          }
          i = end;
          continue;
        }
      }

      const fileUsed = usage.breakdownLoaded ? usage.file : usage.total;
      const fileRoom = this.maxFileDailyBytes - fileUsed;
      const totalRoom = this.enforceTotalDailyCap ? this.maxDailyBytes - usage.total : Number.POSITIVE_INFINITY;
      const room = Math.min(fileRoom, totalRoom);

      let batchCount = 0;
      let batchBytes = 0;
      const lines: string[] = [];
      while (i + batchCount < end) {
        const line = `${items[i + batchCount].raw}\n`;
        const lineBytes = Buffer.byteLength(line, 'utf8');
        if (!usage.breakdownLoaded && usage.total + batchBytes + lineBytes > minTierLimit) {
          break;
        }
        if (batchBytes + lineBytes > room) {
          break;
        }
        lines.push(line);
        batchBytes += lineBytes;
        batchCount += 1;
      }

      if (batchCount > 0) {
        const payload = lines.join('');
        try {
          await this.port.appendEvent(date, payload);
          if (epoch !== this.clearEpoch) return;
          usage.total += batchBytes;
          if (usage.breakdownLoaded) usage.file += batchBytes;
          this.clearAppendDegradedIfNeeded();
          i += batchCount;
          continue;
        } catch {
          this.usageByDate.delete(date);
          await this.appendRawLine(date, `${items[i].raw}\n`, epoch, { tier: 'file', critical: false });
          i += 1;
          continue;
        }
      }

      await this.appendRawLine(date, `${items[i].raw}\n`, epoch, { tier: 'file', critical: false });
      i += 1;
    }
    for (const [date, epoch] of dirtyDates) {
      await this.syncYesterdayLateDailyIfNeeded(date, epoch);
    }
  }

  private clearAppendDegradedIfNeeded(): void {
    if (!this.appendDegraded) return;
    this.appendDegraded = false;
    if (!this.summaryDegraded) {
      const capped = this.currentDate !== undefined && this.cappedDates.has(this.currentDate);
      this.safeEmitSourceOk({ capped });
    }
  }

  private reportAppendWriteFailure(date: string, errorCode: string): void {
    if (this.appendDegraded) return;
    this.appendDegraded = true;
    this.safeEmitSourceError(errorCode, { date });
  }

  private reportSummaryWriteFailure(date: string, errorCode: string): void {
    if (this.summaryDegraded) return;
    this.summaryDegraded = true;
    this.safeEmitSourceError(errorCode, { date });
  }

  private applyDayExtensions(daily: DailySummary, date: string): void {
    if (!this.dayExtensions) return;
    let extra: Record<string, unknown> | undefined;
    try {
      extra = this.dayExtensions(date);
    } catch {
      return;
    }
    if (!extra || Object.keys(extra).length === 0) return;
    daily.extensions = { ...(daily.extensions ?? {}), ...extra };
  }

  private clearSummaryDegraded(): void {
    if (!this.summaryDegraded) return;
    this.summaryDegraded = false;
    if (!this.appendDegraded) {
      const capped = this.currentDate !== undefined && this.cappedDates.has(this.currentDate);
      this.safeEmitSourceOk({ capped });
    }
    if (
      this.pendingBackfill.size > 0 &&
      this.pendingBackfillEpoch === this.clearEpoch &&
      !this.stopped &&
      !this.backfillTimer &&
      !this.activeBackfillStep
    ) {
      this.backfillFailures.clear();
      this.scheduleBackfill(this.clearEpoch, 50);
    }
  }

  private reportFileErrorOnce(dedupKey: string, errorCode: string, extra?: Record<string, unknown>): void {
    if (this.reportedFileErrors.has(dedupKey)) return;
    this.reportedFileErrors.add(dedupKey);
    this.safeEmitSourceError(errorCode, extra);
  }

  private observeTierLine(stats: DayTierStats, rawLine: string): void {
    const bytes = Buffer.byteLength(rawLine, 'utf8') + 1;
    if (this.classifyLineTier(rawLine) === 'file') {
      stats.fileBytes += bytes;
      stats.fileLines += 1;
      if (bytes > stats.maxFileLineBytes) stats.maxFileLineBytes = bytes;
    } else {
      stats.nonFileBytes += bytes;
      stats.nonFileLines += 1;
      if (bytes > stats.maxNonFileLineBytes) stats.maxNonFileLineBytes = bytes;
    }
    if (!stats.sawCapError && rawLine.includes('"daily-limit-exceeded"')) {
      try {
        const parsed = JSON.parse(rawLine);
        if (
          isRecordObject(parsed) &&
          parsed.kind === 'source.error' &&
          parsed.subject === 'history' &&
          parsed.reason === 'daily-limit-exceeded'
        ) {
          stats.sawCapError = true;
        }
      } catch {}
    }
  }

  private isTierUsageCapped(used: number, lineCount: number, maxLineBytes: number, limit: number): boolean {
    if (used >= limit) return true;
    if (lineCount === 0 || limit <= 0) return false;
    const slack = limit >= 4096 ? Math.max(maxLineBytes, 1024) : Math.max(maxLineBytes, Math.floor(limit * 0.25));
    return used + slack > limit;
  }

  private evaluateCappedFromStats(
    stats: DayTierStats,
    reportedSize: number,
  ): {
    fileCapped: boolean;
    nonFileCapped: boolean;
    criticalCapped: boolean;
    totalCapped: boolean;
    sawCapError: boolean;
    anyCapped: boolean;
  } {
    const totalSize = Math.max(reportedSize, stats.fileBytes + stats.nonFileBytes);
    const syntheticOnly = stats.fileBytes + stats.nonFileBytes === 0 && reportedSize > 0;
    const fileCapped = syntheticOnly
      ? reportedSize >= this.maxFileDailyBytes
      : this.isTierUsageCapped(stats.fileBytes, stats.fileLines, stats.maxFileLineBytes, this.maxFileDailyBytes);
    const nonFileCapped = syntheticOnly
      ? reportedSize >= this.maxNonFileDailyBytes
      : this.isTierUsageCapped(
          stats.nonFileBytes,
          stats.nonFileLines,
          stats.maxNonFileLineBytes,
          this.maxNonFileDailyBytes,
        );
    const criticalCapped = syntheticOnly
      ? reportedSize >= this.maxCriticalDailyBytes
      : this.isTierUsageCapped(
          stats.nonFileBytes,
          stats.nonFileLines,
          stats.maxNonFileLineBytes,
          this.maxCriticalDailyBytes,
        );
    const maxLineOverall = Math.max(stats.maxFileLineBytes, stats.maxNonFileLineBytes);
    const totalLinesOverall = stats.fileLines + stats.nonFileLines;
    const totalCapped = syntheticOnly
      ? reportedSize >= this.maxDailyBytes
      : totalSize >= this.maxDailyBytes ||
        (this.enforceTotalDailyCap &&
          this.isTierUsageCapped(totalSize, totalLinesOverall, maxLineOverall, this.maxDailyBytes));
    const sawCapError = stats.sawCapError;
    const anyCapped = fileCapped || nonFileCapped || criticalCapped || totalCapped || sawCapError;
    return { fileCapped, nonFileCapped, criticalCapped, totalCapped, sawCapError, anyCapped };
  }

  private async inferTierStatsFromDisk(date: string, epoch: number): Promise<DayTierStats | undefined> {
    if (!this.port || this.isEpochStale(epoch)) return undefined;
    const stats = createDayTierStats();
    try {
      for await (const rawLine of this.streamLinesForward(date)) {
        if (this.isEpochStale(epoch)) return undefined;
        this.observeTierLine(stats, rawLine);
      }
      return stats;
    } catch {
      return undefined;
    }
  }

  private async restoreTodayCapState(
    today: string,
    seenInLog: boolean,
    todayHasEvents: boolean,
    todayBytes: number,
    hydratedDiskStats: DayTierStats | undefined,
    epoch: number,
  ): Promise<void> {
    if (!this.port || this.isEpochStale(epoch)) return;
    let restored = seenInLog;
    let hasValidCapState = false;
    if (this.port.readCapState) {
      try {
        const raw = await this.port.readCapState();
        if (this.isEpochStale(epoch)) return;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (isRecordObject(parsed) && parsed.date === today && Array.isArray(parsed.tiers)) {
            hasValidCapState = true;
            restored = true;
            for (const t of parsed.tiers) {
              if (t === 'file') this.fileCappedDates.add(today);
              else if (t === 'nonFile') this.nonFileCappedDates.add(today);
              else if (t === 'critical') {
                this.criticalCappedDates.add(today);
                this.nonFileCappedDates.add(today);
              }
            }
          }
        }
      } catch {}
    }

    if (hydratedDiskStats) {
      this.usageByDate.set(today, {
        total: Math.max(todayBytes, hydratedDiskStats.fileBytes + hydratedDiskStats.nonFileBytes),
        file: hydratedDiskStats.fileBytes,
        nonFile: hydratedDiskStats.nonFileBytes,
        breakdownLoaded: true,
      });
    }

    if (!hasValidCapState && todayHasEvents && !this.isEpochStale(epoch)) {
      let stats = hydratedDiskStats;
      const minLimit = this.minCapThresholdBytes();
      const combinedLimit = this.enforceTotalDailyCap
        ? Math.min(this.maxDailyBytes, this.maxFileDailyBytes + this.maxNonFileDailyBytes)
        : this.maxFileDailyBytes + this.maxNonFileDailyBytes;
      if (!stats && todayBytes > 0) {
        if (todayBytes >= combinedLimit) {
          restored = true;
        } else if (todayBytes + 16_384 > minLimit) {
          stats = await this.inferTierStatsFromDisk(today, epoch);
          if (this.isEpochStale(epoch)) return;
          if (stats) {
            this.usageByDate.set(today, {
              total: Math.max(todayBytes, stats.fileBytes + stats.nonFileBytes),
              file: stats.fileBytes,
              nonFile: stats.nonFileBytes,
              breakdownLoaded: true,
            });
          }
        }
      }
      if (stats && (stats.fileLines > 0 || stats.nonFileLines > 0 || stats.sawCapError)) {
        const inferred = this.evaluateCappedFromStats(stats, todayBytes);
        if (inferred.fileCapped) this.fileCappedDates.add(today);
        if (inferred.nonFileCapped) this.nonFileCappedDates.add(today);
        if (inferred.criticalCapped) {
          this.criticalCappedDates.add(today);
          this.nonFileCappedDates.add(today);
        }
        if (inferred.totalCapped) {
          this.fileCappedDates.add(today);
          this.nonFileCappedDates.add(today);
        }
        if (inferred.anyCapped) restored = true;
      }
    }

    if (!restored || this.isEpochStale(epoch)) return;
    this.cappedDates.add(today);
    this.capErrorsEmitted.add(today);
    this.cachedToday = undefined;
    this.summaryRevision += 1;
    this.safeRestoreSourceError('daily-limit-exceeded', { date: today });
    if (
      !hasValidCapState &&
      (this.fileCappedDates.has(today) || this.nonFileCappedDates.has(today) || this.criticalCappedDates.has(today))
    ) {
      await this.persistCapStateForDate(today, epoch);
    }
  }

  private async persistCapStateForDate(date: string, epoch: number): Promise<void> {
    if (!this.port?.writeCapState || epoch !== this.clearEpoch || date !== this.currentDate) return;
    const tiers: CapTier[] = [];
    if (this.fileCappedDates.has(date)) tiers.push('file');
    if (this.nonFileCappedDates.has(date)) tiers.push('nonFile');
    if (this.criticalCappedDates.has(date)) tiers.push('critical');
    try {
      await this.port.writeCapState(JSON.stringify({ date, tiers }));
    } catch {}
  }

  private safeEmitSourceError(error: string, extra?: Record<string, unknown>): void {
    try {
      this.emitSourceError(error, extra);
    } catch {}
  }

  private safeRestoreSourceError(error: string, extra?: Record<string, unknown>): void {
    if (!this.restoreSourceError) return;
    try {
      this.restoreSourceError(error, extra);
    } catch {}
  }

  private safeEmitSourceOk(extra?: Record<string, unknown>): void {
    try {
      this.emitSourceOk(extra);
    } catch {}
  }

  private safeClearSourceCap(): void {
    if (!this.clearSourceCap) return;
    try {
      this.clearSourceCap();
    } catch {}
  }
}
