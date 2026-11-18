export interface DayBounds {
  startMs: number;
  endMs: number;
  durationMs: number;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

interface ZoneFormatters {
  dateTime: Intl.DateTimeFormat;
  bounds: Map<string, DayBounds>;
}

export class LocalCalendar {
  private readonly formatters = new Map<string, ZoneFormatters>();
  private readonly fixedZone?: string;

  constructor(timeZone?: string) {
    if (timeZone !== undefined) {
      // Validate IANA timezone eagerly so misconfigurations fail cleanly.
      this.createFormatter(timeZone);
      this.fixedZone = timeZone;
    }
  }

  private zoneName(): string {
    return this.fixedZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  private createFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
    return new Intl.DateTimeFormat('en-US-u-nu-latn', {
      ...(timeZone ? { timeZone } : {}),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  }

  private zoneState(): ZoneFormatters {
    const zone = this.zoneName();
    let state = this.formatters.get(zone);
    if (!state) {
      state = { dateTime: this.createFormatter(zone), bounds: new Map() };
      this.formatters.set(zone, state);
    }
    return state;
  }

  parts(ms: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
    const { dateTime } = this.zoneState();
    let year = 0;
    let month = 0;
    let day = 0;
    let hour = 0;
    let minute = 0;
    let second = 0;
    for (const part of dateTime.formatToParts(ms)) {
      if (part.type === 'year') year = Number(part.value);
      else if (part.type === 'month') month = Number(part.value);
      else if (part.type === 'day') day = Number(part.value);
      else if (part.type === 'hour') hour = Number(part.value);
      else if (part.type === 'minute') minute = Number(part.value);
      else if (part.type === 'second') second = Number(part.value);
    }
    return { year, month, day, hour, minute, second };
  }

  dateKey(ms: number): string {
    const p = this.parts(ms);
    return formatDate(p.year, p.month, p.day);
  }

  monthKey(ms: number): string {
    const p = this.parts(ms);
    return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}`;
  }

  dayBounds(date: string): DayBounds {
    const parsed = parseDateKey(date);
    if (!parsed) throw new TypeError(`invalid date key: ${date}`);
    const state = this.zoneState();
    const cached = state.bounds.get(date);
    if (cached) return cached;
    const nextDate = addDays(date, 1);
    const nextParsed = parseDateKey(nextDate);
    if (!nextParsed) throw new TypeError(`invalid next date key: ${nextDate}`);
    const startMs = this.localDayStartMs(parsed.year, parsed.month, parsed.day, date);
    const endMs = this.localDayStartMs(nextParsed.year, nextParsed.month, nextParsed.day, nextDate);
    const bounds = { startMs, endMs: Math.max(startMs, endMs), durationMs: Math.max(0, endMs - startMs) };
    if (state.bounds.size > 512) {
      const oldest = state.bounds.keys().next().value;
      if (oldest !== undefined) state.bounds.delete(oldest);
    }
    state.bounds.set(date, bounds);
    return bounds;
  }

  private localDayStartMs(year: number, month: number, day: number, targetDate: string): number {
    const utcMidnight = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
    const p = this.parts(utcMidnight);
    const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
    const offset = localAsUtc - utcMidnight;
    const guess = utcMidnight - offset;
    if (this.dateKey(guess) === targetDate && this.dateKey(guess - 1) < targetDate) {
      return guess;
    }
    // Binary search across a ±6h window around the initial guess to locate the
    // exact millisecond when the local calendar date transitions (covers DST).
    let lo = guess - 6 * HOUR_MS;
    let hi = guess + 6 * HOUR_MS;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (this.dateKey(mid) >= targetDate) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }
}

export function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseDateKey(date: string): { year: number; month: number; day: number } | undefined {
  const m = DATE_RE.exec(date);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) {
    return undefined;
  }
  return { year, month, day };
}

export function parseMonthKey(month: string): { year: number; month: number } | undefined {
  const m = MONTH_RE.exec(month);
  if (!m) return undefined;
  const year = Number(m[1]);
  const num = Number(m[2]);
  if (num < 1 || num > 12) return undefined;
  return { year, month: num };
}

export function addDays(date: string, delta: number): string {
  const parsed = parseDateKey(date);
  if (!parsed) throw new TypeError(`invalid date key: ${date}`);
  const next = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + delta));
  return formatDate(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

export function diffDays(laterDate: string, earlierDate: string): number {
  const a = parseDateKey(laterDate);
  const b = parseDateKey(earlierDate);
  if (!a || !b) throw new TypeError(`invalid date key comparison: ${laterDate} vs ${earlierDate}`);
  return Math.round((Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day)) / DAY_MS);
}

export function daysInMonth(month: string): number {
  const parsed = parseMonthKey(month);
  if (!parsed) throw new TypeError(`invalid month key: ${month}`);
  return new Date(Date.UTC(parsed.year, parsed.month, 0)).getUTCDate();
}

export function datesInMonth(month: string): string[] {
  const parsed = parseMonthKey(month);
  if (!parsed) throw new TypeError(`invalid month key: ${month}`);
  const count = daysInMonth(month);
  const out: string[] = [];
  for (let d = 1; d <= count; d++) {
    out.push(formatDate(parsed.year, parsed.month, d));
  }
  return out;
}

export function prevMonth(month: string): string {
  const parsed = parseMonthKey(month);
  if (!parsed) throw new TypeError(`invalid month key: ${month}`);
  const d = new Date(Date.UTC(parsed.year, parsed.month - 2, 1));
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
