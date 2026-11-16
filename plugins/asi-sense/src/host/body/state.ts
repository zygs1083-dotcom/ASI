import type { BodyThresholdState, ThresholdSeverity } from '@asi/sense-types';
import { Baseline, type BaselineOptions } from './baseline.ts';

/**
 * Metadata key for evaluator-private, per-stream adaptive state (DESIGN
 * §2.2c). An own enumerable symbol: `{...state}` spreads carry it through
 * M1's latch threading untouched, while `Object.keys` never enumerates it,
 * so M1 consumers cannot mistake it for a latch key. Every history lives
 * here — evaluator objects hold none — so identical inputs always produce
 * identical outputs and replay/retry is safe.
 */
export const BODY_HISTORY: unique symbol = Symbol('asi.body.history');

/** One metric's monotonic-clock point window (rate layer). */
export interface RateWindow {
  points: { at: number; value: number }[];
  /** Monotonic stamp of the newest accepted point for the stream. */
  lastMono: number;
}

export interface RateHistory {
  /** Last accepted monotonic sample stamp (ordering gate). */
  lastMono?: number;
  windows: Record<string, RateWindow>;
  /**
   * Per-stream rule latches (`rate:<id>[:<metric>]`). The public state key
   * is only a projection of the stream evaluated last — the authoritative
   * latch lives here so interleaved streams sharing one caller state
   * cannot suppress each other.
   */
  latch: Record<string, 'normal' | 'warn'>;
}

export interface AnomalyHistory {
  /** Last accepted monotonic sample stamp (ordering gate, reset on restart). */
  lastAt?: number;
  streaks: Record<string, number>;
  /** Per-stream rule latches (`baseline:<id>`), projected into public keys. */
  latch: Record<string, 'normal' | 'warn'>;
  /** Forked, per-stream baseline trained by this stream's samples. */
  baseline?: Baseline;
}

/** Per-stream adaptive metadata keyed by `next.source.id`. */
export interface BodyStreamHistory {
  rate?: RateHistory;
  anomaly?: AnomalyHistory;
}

export type BodyHistory = Record<string, BodyStreamHistory>;

/** Caller-threaded evaluator state: M1 latch record plus symbol metadata. */
export type AdaptiveState = BodyThresholdState & { [BODY_HISTORY]?: BodyHistory };

/** Strict latch validation: known keys→severities only. */
export function validLatch(v: unknown): BodyThresholdState | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: BodyThresholdState = {};
  const sev: readonly ThresholdSeverity[] = ['normal', 'warn', 'critical'];
  for (const [k, s] of Object.entries(v)) {
    if (typeof k !== 'string' || !sev.includes(s as ThresholdSeverity)) return undefined;
    out[k] = s as ThresholdSeverity;
  }
  return out;
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * Snapshot-safe projection of {@link BodyHistory}: per stream only the
 * anomaly streaks, latches and serialized baseline are durable.
 * Monotonic ordering stamps and windows are intentionally dropped — a stamp is
 * meaningless across processes, so rate history always restarts cold.
 */
export function serializeHistory(history: BodyHistory | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [stream, h] of Object.entries(history ?? {})) {
    const a = h.anomaly;
    if (!a) continue;
    const entry: Record<string, unknown> = { streaks: { ...a.streaks }, latch: { ...a.latch } };
    if (a.baseline) entry.baseline = a.baseline.serialize();
    out[stream] = entry;
  }
  return out;
}

/**
 * Validates a serialized history projection back into metadata. Every
 * nested number must be finite; baselines restore through
 * {@link Baseline.deserialize} — a `restoreFailed` baseline fails the whole
 * parse. Returns undefined on any malformed piece (fail closed).
 */
export function parseHistory(v: unknown, options: BaselineOptions): BodyHistory | undefined {
  if (!isRec(v)) return undefined;
  const out: BodyHistory = {};
  for (const [stream, raw] of Object.entries(v)) {
    if (!isRec(raw)) return undefined;
    if (raw.lastAt !== undefined && !isNum(raw.lastAt)) return undefined;
    if (!isRec(raw.streaks)) return undefined;
    const streaks: Record<string, number> = {};
    for (const [rule, n] of Object.entries(raw.streaks)) {
      if (!isCount(n)) return undefined;
      streaks[rule] = n;
    }
    if (raw.latch !== undefined && !isRec(raw.latch)) return undefined;
    const latch: Record<string, 'normal' | 'warn'> = {};
    for (const [key, s] of Object.entries((raw.latch ?? {}) as Record<string, unknown>)) {
      if (s !== 'normal' && s !== 'warn') return undefined;
      latch[key] = s;
    }
    let baseline: Baseline | undefined;
    if (raw.baseline !== undefined) {
      if (typeof raw.baseline !== 'string') return undefined;
      baseline = Baseline.deserialize(raw.baseline, options);
      if (baseline.restoreFailed) return undefined;
    }
    out[stream] = {
      anomaly: { streaks, latch, baseline },
    };
  }
  return out;
}
