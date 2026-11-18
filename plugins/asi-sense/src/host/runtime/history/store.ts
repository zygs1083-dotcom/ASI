import type { DeliveryLevel, SignalCause, SourceRef } from '@asi/sense-types';
import {
  parseDailySummary,
  parseHistoryLines,
  parseMonthlySummary,
  summarizeDay,
  synthesizeMonth,
} from './summarize.ts';
import { diffDays, LocalCalendar, parseDateKey, parseMonthKey, prevMonth } from './time.ts';
import {
  DAILY_SUMMARY_RETENTION_DAYS,
  type DailySummary,
  DEFAULT_HISTORY_LIMIT,
  HISTORY_HEARTBEAT_MS,
  HISTORY_RETENTION_DAYS,
  type HistoryEventLine,
  type HistoryLifecycleRecord,
  type HistoryQuery,
  type HistoryQueryResult,
  type HistoryStoragePort,
  isNonEmptyString,
  MAX_DAILY_EVENT_BYTES,
  MAX_HISTORY_LIMIT,
  MAX_QUERY_RANGE_MS,
  type MonthlySummary,
  type PersistedEventEntry,
  type SummaryQuery,
  type SummaryQueryResult,
  sanitizeAppName,
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
  detail?: Record<string, string | number | boolean>;
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
  emitSourceError: (error: string, extra?: Record<string, unknown>) => void;
  emitSourceOk: () => void;
  timeZone?: string;
  maxDailyBytes?: number;
  heartbeatIntervalMs?: number;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) throw new HistoryArgsError(`invalid ISO date/time string: ${value}`);
  return parsed;
}

export class HistoryManager {
  private readonly port?: HistoryStoragePort;
  private readonly clock: { wall(): number; mono(): number };
  private readonly isPaused: () => boolean;
  private readonly titlesAllowed: () => boolean;
  private readonly restoreEntries: (entries: PersistedEventEntry[]) => void;
  private readonly clearMemoryEntries: () => void;
  private readonly emitSourceError: (error: string, extra?: Record<string, unknown>) => void;
  private readonly emitSourceOk: () => void;
  private readonly calendar: LocalCalendar;
  private readonly maxDailyBytes: number;
  private readonly heartbeatIntervalMs: number;

  private tail: Promise<void> = Promise.resolve();
  private started = false;
  private stopped = false;
  private clearEpoch = 0;
  private currentDate?: string;
  private currentMonth?: string;
  private lastAliveAt = Number.NEGATIVE_INFINITY;
  private nextHeartbeatMono = Number.POSITIVE_INFINITY;
  private activeApp?: string;
  private readonly sizes = new Map<string, number>();
  private readonly cappedDates = new Set<string>();
  private readonly capErrorsEmitted = new Set<string>();
  private writeDegraded = false;
  private readonly eventDatesById = new Map<string, string>();
  private activeLifecycleOpen = false;

  constructor(options: HistoryManagerOptions) {
    this.port = options.port;
    this.clock = options.clock;
    this.isPaused = options.isPaused;
    this.titlesAllowed = options.titlesAllowed;
    this.restoreEntries = options.restoreEntries;
    this.clearMemoryEntries = options.clearMemoryEntries;
    this.emitSourceError = options.emitSourceError;
    this.emitSourceOk = options.emitSourceOk;
    this.calendar = new LocalCalendar(options.timeZone);
    this.maxDailyBytes = options.maxDailyBytes ?? MAX_DAILY_EVENT_BYTES;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HISTORY_HEARTBEAT_MS;
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

    if (!this.port) return;
    const epoch = this.clearEpoch;
    await this.enqueue(async () => {
      if (this.stopped || epoch !== this.clearEpoch) return;
      await this.startupMaintenance(today, month);
      if (this.stopped || epoch !== this.clearEpoch) return;
      const lifecycle: HistoryLifecycleRecord = {
        record: 'lifecycle',
        state: paused ? 'paused' : 'active',
        at: now,
        boot: true,
      };
      this.activeLifecycleOpen = true;
      await this.appendRawLine(today, `${JSON.stringify(lifecycle)}\n`, epoch);
    });
  }

  setPaused(paused: boolean, at = this.clock.wall()): void {
    if (!this.port || !this.started || this.stopped) return;
    this.enqueueLifecycle(paused ? 'paused' : 'active', at);
  }

  recordEvent(entry: HistoryEventInput, meta?: { bundleId?: string; title?: string }): void {
    if (!this.port || !this.started || this.stopped || entry.restored) return;
    const date = this.calendar.dateKey(entry.at);
    this.rememberEventDate(entry.id, date);
    if (entry.kind === 'app.activated' && isNonEmptyString(entry.subject)) {
      this.activeApp = entry.subject;
    }
    if (entry.at > this.lastAliveAt) this.lastAliveAt = entry.at;

    const now = this.clock.wall();
    const nowDate = this.calendar.dateKey(now);
    if (this.currentDate && nowDate > this.currentDate) {
      this.enqueueRollover(now);
    }

    const line: HistoryEventLine = {
      record: 'event',
      id: entry.id,
      kind: entry.kind,
      subject: entry.subject,
      level: entry.level,
      at: entry.at,
      source: { ...entry.source },
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
      ...(entry.ruleId !== undefined ? { ruleId: entry.ruleId } : {}),
      ...(entry.cause !== undefined ? { cause: entry.cause } : {}),
      ...(entry.restarts !== undefined ? { restarts: entry.restarts } : {}),
      ...(entry.detail !== undefined ? { detail: { ...entry.detail } } : {}),
      ...(entry.currentEta !== undefined ? { currentEta: { ...entry.currentEta } } : {}),
      ...(entry.feedback !== undefined ? { feedback: entry.feedback } : {}),
      ...(entry.feedbackAvailable !== undefined ? { feedbackAvailable: entry.feedbackAvailable } : {}),
      ...(meta?.bundleId !== undefined ? { bundleId: meta.bundleId } : {}),
      ...(meta?.title !== undefined ? { title: meta.title } : {}),
    };
    const epoch = this.clearEpoch;
    this.enqueue(() => this.appendRawLine(date, `${JSON.stringify(line)}\n`, epoch));
  }

  patchEvent(
    id: string,
    patch: { at?: number; level?: DeliveryLevel; reason?: string; feedback?: 'useful' | 'noise' },
  ): void {
    if (!this.port || !this.started || this.stopped) return;
    const date = patch.at !== undefined ? this.calendar.dateKey(patch.at) : this.eventDatesById.get(id);
    if (!date) return;
    const record = {
      record: 'patch' as const,
      id,
      ...(patch.level !== undefined ? { level: patch.level } : {}),
      ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
      ...(patch.feedback !== undefined ? { feedback: patch.feedback } : {}),
    };
    const epoch = this.clearEpoch;
    this.enqueue(() => this.appendRawLine(date, `${JSON.stringify(record)}\n`, epoch));
  }

  nextDeadline(): number | undefined {
    if (!this.port || !this.started || this.stopped || !this.currentDate) return undefined;
    const bounds = this.calendar.dayBounds(this.currentDate);
    const rolloverDelta = Math.max(0, bounds.endMs - this.clock.wall());
    const rolloverMono = this.clock.mono() + rolloverDelta;
    return Math.min(this.nextHeartbeatMono, rolloverMono);
  }

  async tick(): Promise<void> {
    if (!this.port || !this.started || this.stopped) return;
    const wall = this.clock.wall();
    const mono = this.clock.mono();
    const nowDate = this.calendar.dateKey(wall);
    if (this.currentDate && nowDate > this.currentDate) {
      this.enqueueRollover(wall);
    }
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
      this.enqueue(() => this.appendRawLine(date, `${JSON.stringify(heartbeat)}\n`, epoch));
    }
    await this.tail;
  }

  async stop(): Promise<void> {
    if (this.stopped) return this.tail;
    this.stopped = true;
    this.nextHeartbeatMono = Number.POSITIVE_INFINITY;
    if (this.port && this.started && this.activeLifecycleOpen) {
      const now = this.clock.wall();
      const date = this.calendar.dateKey(now);
      const epoch = this.clearEpoch;
      const stoppedRecord: HistoryLifecycleRecord = { record: 'lifecycle', state: 'stopped', at: now };
      await this.enqueue(() => this.appendRawLine(date, `${JSON.stringify(stoppedRecord)}\n`, epoch));
    }
    await this.tail;
  }

  async clear(): Promise<void> {
    const epoch = ++this.clearEpoch;
    this.clearMemoryEntries();
    this.sizes.clear();
    this.cappedDates.clear();
    this.capErrorsEmitted.clear();
    this.eventDatesById.clear();
    this.activeApp = undefined;
    this.activeLifecycleOpen = false;
    if (!this.port) return;
    const port = this.port;
    const run = this.tail.then(async () => {
      await port.clearAll();
      if (this.started && !this.stopped && epoch === this.clearEpoch) {
        const now = this.clock.wall();
        this.currentDate = this.calendar.dateKey(now);
        this.currentMonth = this.calendar.monthKey(now);
        this.lastAliveAt = now;
        this.nextHeartbeatMono = this.clock.mono() + this.heartbeatIntervalMs;
      }
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

    const titlesAllowed = this.titlesAllowed();
    if (!this.port) {
      return {
        available: false,
        reason: 'History storage is not configured.',
        from: fromMs,
        to: toMs,
        limit,
        total: 0,
        truncated: false,
        titlesAllowed,
        events: [],
      };
    }

    await this.tail;

    const startDate = this.calendar.dateKey(fromMs);
    const endDate = this.calendar.dateKey(toMs);
    const allDates = (await this.port.listEventDates())
      .filter((d) => d >= startDate && d <= endDate)
      .sort()
      .reverse();
    const kindsSet = params.kinds ? new Set(params.kinds) : undefined;
    const appLower = params.app !== undefined ? sanitizeAppName(params.app).toLowerCase() : undefined;

    const matched: PersistedEventEntry[] = [];
    for (const date of allDates) {
      const raw = await this.port.readEvents(date);
      if (raw === undefined) continue;
      const { events } = parseHistoryLines(raw);
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (ev.at < fromMs || ev.at > toMs) continue;
        if (kindsSet && !kindsSet.has(ev.kind)) continue;
        if (appLower !== undefined) {
          if (ev.kind.startsWith('window') && !titlesAllowed) continue;
          const isAppOrWindow = ev.kind.startsWith('app.') || ev.kind.startsWith('window');
          if (!isAppOrWindow) continue;
          const subjectMatch = sanitizeAppName(ev.subject).toLowerCase() === appLower;
          const bundleMatch = ev.bundleId?.toLowerCase() === appLower;
          if (!subjectMatch && !bundleMatch) continue;
        }
        matched.push(ev);
      }
    }

    matched.sort((a, b) => b.at - a.at);
    const sliced = matched.slice(0, limit);
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
      total: matched.length,
      truncated: matched.length > limit || limitClamped,
      titlesAllowed,
      events: sliced,
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

    if (month > nowMonth) {
      return { available: false, month, reason: `Month ${month} is in the future.` };
    }

    const existingRaw = await this.port.readMonthly(month);
    if (existingRaw !== undefined) {
      const parsed = parseMonthlySummary(existingRaw);
      if (parsed) return { available: true, summary: parsed };
    }

    if (month === nowMonth) {
      return {
        available: false,
        month,
        reason: `Monthly summary for ${month} is generated after the month ends; use env_history for recent events.`,
      };
    }

    const synthesized = await this.synthesizeMonthFromDaily(month);
    if (!synthesized) {
      return { available: false, month, reason: `No history data found for month ${month}.` };
    }
    return { available: true, summary: synthesized };
  }

  private rememberEventDate(id: string, date: string): void {
    if (this.eventDatesById.has(id)) this.eventDatesById.delete(id);
    this.eventDatesById.set(id, date);
    if (this.eventDatesById.size > 2048) {
      const oldest = this.eventDatesById.keys().next().value;
      if (oldest !== undefined) this.eventDatesById.delete(oldest);
    }
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.tail.then(work).catch(() => {});
    this.tail = run;
    return run;
  }

  private enqueueLifecycle(state: 'active' | 'paused', at: number): void {
    const date = this.calendar.dateKey(at);
    this.lastAliveAt = Math.max(this.lastAliveAt, at);
    const epoch = this.clearEpoch;
    const record: HistoryLifecycleRecord = { record: 'lifecycle', state, at };
    this.activeLifecycleOpen = true;
    this.enqueue(() => this.appendRawLine(date, `${JSON.stringify(record)}\n`, epoch));
  }

  private enqueueRollover(wall: number): void {
    const prevDate = this.currentDate;
    const prevMonthKey = this.currentMonth;
    const nextDate = this.calendar.dateKey(wall);
    const nextMonthKey = this.calendar.monthKey(wall);
    if (!prevDate || nextDate <= prevDate) return;

    const prevAliveAt = this.lastAliveAt;
    const carryApp = this.activeApp;
    const paused = this.isPaused();
    this.currentDate = nextDate;
    this.currentMonth = nextMonthKey;
    this.lastAliveAt = wall;
    const epoch = this.clearEpoch;

    this.enqueue(async () => {
      if (!this.port || epoch !== this.clearEpoch) return;
      const prevBounds = this.calendar.dayBounds(prevDate);
      const continuous = diffDays(nextDate, prevDate) === 1 && prevBounds.endMs - prevAliveAt <= 10 * 60_000;
      const rawPrev = await this.port.readEvents(prevDate);
      if (epoch !== this.clearEpoch) return;
      if (rawPrev !== undefined) {
        const parsed = parseHistoryLines(rawPrev);
        const daily = summarizeDay(prevDate, parsed, prevBounds, {
          isRunningAtEnd: continuous,
          liveEndMs: continuous ? prevBounds.endMs : undefined,
          truncatedAtLimit: this.cappedDates.has(prevDate),
        });
        await this.port.writeDaily(prevDate, JSON.stringify(daily));
      }
      if (epoch !== this.clearEpoch) return;
      if (nextMonthKey !== prevMonthKey) {
        await this.synthesizeAllCompletedMonths(nextMonthKey);
      }
      await this.pruneExpired(nextDate);
      if (epoch !== this.clearEpoch || this.stopped) return;
      const startAt = continuous ? prevBounds.endMs : wall;
      const boundary: HistoryLifecycleRecord = {
        record: 'lifecycle',
        state: paused ? 'paused' : 'active',
        at: startAt,
        ...(continuous && carryApp ? { app: carryApp } : {}),
      };
      this.activeLifecycleOpen = true;
      await this.appendRawLine(nextDate, `${JSON.stringify(boundary)}\n`, epoch);
    });
  }

  private async startupMaintenance(today: string, currentMonth: string): Promise<void> {
    if (!this.port) return;
    try {
      const eventDates = (await this.port.listEventDates()).sort();
      const keptDates: string[] = [];
      for (const date of eventDates) {
        if (diffDays(today, date) > HISTORY_RETENTION_DAYS) {
          await this.port.deleteEventDate(date);
        } else {
          keptDates.push(date);
        }
      }

      // Backfill missing daily summaries only for days whose raw event log still exists.
      for (const date of keptDates) {
        if (date >= today) continue;
        const existing = await this.port.readDaily(date);
        if (existing !== undefined && parseDailySummary(existing)) continue;
        const raw = await this.port.readEvents(date);
        if (raw === undefined) continue;
        const parsed = parseHistoryLines(raw);
        const bounds = this.calendar.dayBounds(date);
        const daily = summarizeDay(date, parsed, bounds, { isRunningAtEnd: false });
        await this.port.writeDaily(date, JSON.stringify(daily));
      }

      // Synthesize missing monthly summaries strictly from daily summaries before pruning daily.
      await this.synthesizeAllCompletedMonths(currentMonth);

      // Prune daily summaries older than 400 days.
      const dailyDates = await this.port.listDailyDates();
      for (const date of dailyDates) {
        if (diffDays(today, date) > DAILY_SUMMARY_RETENTION_DAYS) {
          await this.port.deleteDailyDate(date);
        }
      }

      // Restore up to 200 most recent events into memory ring buffer.
      const collected: PersistedEventEntry[] = [];
      for (let i = keptDates.length - 1; i >= 0 && collected.length < MAX_HISTORY_LIMIT; i--) {
        const date = keptDates[i];
        const raw = await this.port.readEvents(date);
        if (raw === undefined) continue;
        const { events } = parseHistoryLines(raw);
        for (let j = events.length - 1; j >= 0 && collected.length < MAX_HISTORY_LIMIT; j--) {
          collected.push(events[j]);
        }
      }
      if (collected.length > 0) {
        collected.reverse();
        this.restoreEntries(collected);
      }
    } catch {
      this.reportWriteFailure(today, 'history-startup-failed');
    }
  }

  private async synthesizeAllCompletedMonths(currentMonth: string): Promise<void> {
    if (!this.port) return;
    const dailyDates = (await this.port.listDailyDates()).sort();
    const completedMonths = new Set<string>();
    for (const date of dailyDates) {
      const month = date.slice(0, 7);
      if (month < currentMonth) completedMonths.add(month);
    }
    for (const month of [...completedMonths].sort()) {
      const existing = await this.port.readMonthly(month);
      if (existing !== undefined && parseMonthlySummary(existing)) continue;
      await this.synthesizeMonthFromDaily(month, dailyDates);
    }
  }

  private async synthesizeMonthFromDaily(month: string, cachedDates?: string[]): Promise<MonthlySummary | undefined> {
    if (!this.port) return undefined;
    const dailyDates = (cachedDates ?? (await this.port.listDailyDates()))
      .filter((d) => d.startsWith(`${month}-`))
      .sort();
    if (dailyDates.length === 0) return undefined;
    const dailies: DailySummary[] = [];
    for (const date of dailyDates) {
      const raw = await this.port.readDaily(date);
      if (raw === undefined) continue;
      const parsed = parseDailySummary(raw);
      if (parsed) dailies.push(parsed);
    }
    if (dailies.length === 0) return undefined;
    const monthly = synthesizeMonth(month, dailies, this.clock.wall());
    await this.port.writeMonthly(month, JSON.stringify(monthly));
    return monthly;
  }

  private async pruneExpired(today: string): Promise<void> {
    if (!this.port) return;
    for (const date of await this.port.listEventDates()) {
      if (diffDays(today, date) > HISTORY_RETENTION_DAYS) {
        await this.port.deleteEventDate(date);
        this.sizes.delete(date);
        this.cappedDates.delete(date);
        this.capErrorsEmitted.delete(date);
      }
    }
    for (const date of await this.port.listDailyDates()) {
      if (diffDays(today, date) > DAILY_SUMMARY_RETENTION_DAYS) {
        await this.port.deleteDailyDate(date);
      }
    }
  }

  private async appendRawLine(date: string, line: string, epoch: number): Promise<void> {
    if (!this.port || epoch !== this.clearEpoch) return;
    if (this.cappedDates.has(date)) return;
    try {
      let size = this.sizes.get(date);
      if (size === undefined) {
        size = await this.port.eventFileSize(date);
        this.sizes.set(date, size);
      }
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (size + lineBytes > this.maxDailyBytes) {
        this.cappedDates.add(date);
        if (!this.capErrorsEmitted.has(date)) {
          this.capErrorsEmitted.add(date);
          this.safeEmitSourceError('daily-limit-exceeded', { date, maxBytes: this.maxDailyBytes });
        }
        return;
      }
      await this.port.appendEvent(date, line);
      this.sizes.set(date, size + lineBytes);
      if (this.writeDegraded) {
        this.writeDegraded = false;
        this.safeEmitSourceOk();
      }
    } catch {
      this.reportWriteFailure(date, 'history-write-failed');
    }
  }

  private reportWriteFailure(date: string, errorCode: string): void {
    if (this.writeDegraded) return;
    this.writeDegraded = true;
    this.safeEmitSourceError(errorCode, { date });
  }

  private safeEmitSourceError(error: string, extra?: Record<string, unknown>): void {
    try {
      this.emitSourceError(error, extra);
    } catch {}
  }

  private safeEmitSourceOk(): void {
    try {
      this.emitSourceOk();
    } catch {}
  }
}
