import type { Bucket } from './baseline-stat.ts';
import { formatter, slotOf } from './baseline-time.ts';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parseBucket(raw: unknown, index: number, savedFmt: Intl.DateTimeFormat, zone: string): Bucket {
  const s = raw as Record<string, unknown>;
  if (
    !s ||
    !finite(s.mean) ||
    !finite(s.median) ||
    !finite(s.mad) ||
    s.mad < 0 ||
    !Number.isSafeInteger(s.count) ||
    (s.count as number) <= 0 ||
    !finite(s.lastAt) ||
    Math.abs(s.lastAt) > 8.64e15 ||
    (s.zone !== undefined && typeof s.zone !== 'string') ||
    slotOf(s.zone === undefined ? savedFmt : formatter(s.zone as string), s.lastAt).index !== index ||
    !Array.isArray(s.dates) ||
    s.dates.length === 0 ||
    s.dates.length > 400 ||
    !s.dates.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 40) ||
    (s.warmup !== undefined &&
      (!Array.isArray(s.warmup) || s.warmup.length !== s.count || (s.count as number) >= 8 || !s.warmup.every(finite)))
  ) {
    throw new TypeError('invalid baseline bucket');
  }
  return {
    mean: s.mean,
    median: s.median,
    mad: s.mad,
    count: s.count as number,
    lastAt: s.lastAt,
    zone: typeof s.zone === 'string' ? s.zone : zone,
    dates: new Set(s.dates),
    warmup: s.warmup as number[] | undefined,
  };
}
