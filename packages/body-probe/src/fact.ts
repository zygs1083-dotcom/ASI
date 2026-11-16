import os from 'node:os';
import { effectiveDisks, ttlStatusAt } from '@asi/sense-types';
import type { DisksFact, Fact, FactStatus, SourceRef } from './types.js';

export const DEFAULT_TTL_MS = 6000;

export function source(id: string, api: string): SourceRef {
  return { id: `body-probe.${id}`, api, host: os.hostname() };
}

export function ok<T>(
  value: T,
  src: SourceRef,
  ttlMs: number = DEFAULT_TTL_MS,
  observedAt: number = Date.now(),
): Fact<T> {
  return { value, status: 'ok', source: src, observedAt, ttlMs };
}

export interface FactMeta {
  observedAt: number; // wall clock when the constituent was observed
  periodMs: number;   // sampling period that produced the observation
  at?: number;        // monotonic clock reading for the same observation
}

// A composite fact (built from readings with different cadences) keeps the
// oldest constituent's observedAt and expires at the earliest absolute
// constituent deadline: ttlMs = min(observedAt + 3*periodMs) - observedAt.
// expiresAt is the same earliest deadline in monotonic time, taken over the
// parts that supply a monotonic `at`; consumers track it for wall-proof
// staleness checks.
export function oldestMeta(parts: readonly FactMeta[]): {
  observedAt: number;
  ttlMs: number;
  expiresAt?: number;
} {
  let observedAt = Number.POSITIVE_INFINITY;
  let expiry = Number.POSITIVE_INFINITY;
  let expiresAt = Number.POSITIVE_INFINITY;
  for (const p of parts) {
    observedAt = Math.min(observedAt, p.observedAt);
    expiry = Math.min(expiry, p.observedAt + p.periodMs * 3);
    if (p.at !== undefined) expiresAt = Math.min(expiresAt, p.at + p.periodMs * 3);
  }
  const meta = { observedAt, ttlMs: expiry - observedAt };
  return expiresAt === Number.POSITIVE_INFINITY ? meta : { ...meta, expiresAt };
}

// Monotonic absolute deadlines keyed by fact identity (never serialized).
// Producers attach real deadlines via trackDeadline; anything else gets its
// remaining wall TTL translated to monotonic once on first sight, so a
// wall-clock move can never freeze or revive a fact.
const deadlines = new WeakMap<object, number>();

export function trackDeadline(o: object, monoExpiry: number): void {
  deadlines.set(o, monoExpiry);
}

export function deadline(o: object): number | undefined {
  return deadlines.get(o);
}

interface FactLike {
  status: string;
  observedAt: number;
  ttlMs: number;
  value?: unknown;
}

function isFactLike(o: unknown): o is FactLike & object {
  if (typeof o !== 'object' || o === null) return false;
  const r = o as { status?: unknown; observedAt?: unknown; ttlMs?: unknown };
  return typeof r.status === 'string' && typeof r.observedAt === 'number'
    && typeof r.ttlMs === 'number';
}

function deadlineOf(o: FactLike & object, now: number, wall: number): number {
  let d = deadlines.get(o);
  if (d === undefined) deadlines.set(o, (d = now + (o.observedAt + o.ttlMs - wall)));
  return d;
}

// Registers deadlines for a fact arriving from outside and for fact-like
// records inside its value (disk volumes).
export function ingest(f: FactLike & object, now: number, wall: number): void {
  deadlineOf(f, now, wall);
  if (Array.isArray(f.value)) {
    for (const r of f.value) {
      if (isFactLike(r)) deadlineOf(r, now, wall);
      else if (r && typeof r === 'object' && 'mount' in r && !deadlines.has(r)) {
        const v = r as { observedAt?: number; ttlMs?: number };
        deadlines.set(r, now + ((v.observedAt ?? f.observedAt) + (v.ttlMs ?? f.ttlMs) - wall));
      }
    }
  }
}

export function disksAt(f: DisksFact, now: number, wall: number): DisksFact {
  const ttlMs = (o: object, observedAt: number, originalTtl: number) =>
    (deadlines.get(o) ?? now + observedAt + originalTtl - wall) - now + wall - observedAt;
  return effectiveDisks({
    ...f,
    ttlMs: ttlMs(f, f.observedAt, f.ttlMs),
    value: f.value?.map((v) => ({
      ...v,
      ttlMs: ttlMs(v, v.observedAt ?? f.observedAt, v.ttlMs ?? f.ttlMs),
    })) ?? null,
  }, wall);
}

const mark = <T extends FactLike>(o: T, now: number, wall: number): T =>
  o.status === 'ok' && ttlStatusAt({ status: 'ok', observedAt: deadlineOf(o, now, wall), ttlMs: 0 }, now) === 'stale'
    ? ({ ...o, status: 'stale' } as T) : o;

// Marks an ok fact stale once it outlives its tracked deadline (`now` is
// monotonic, `wall` the wall reading of the same instant), plus fact-like
// records inside an array value — without mutating the stored objects. A
// root copy created for changed records inherits the tracked deadline.
export function stale<T extends FactLike>(
  f: T,
  now: number = globalThis.performance.now(),
  wall: number = Date.now(),
): T {
  let out = mark(f, now, wall);
  const v = out.value;
  if (Array.isArray(v)) {
    let changed = false;
    const next = v.map((r) => {
      const m = isFactLike(r) ? mark(r, now, wall) : r;
      if (m !== r) changed = true;
      return m;
    });
    if (changed) {
      out = { ...out, value: next };
      const d = deadlines.get(f);
      if (d !== undefined) deadlines.set(out, d);
    }
  }
  return out;
}

export function fail<T>(status: FactStatus, src: SourceRef, ttlMs: number = DEFAULT_TTL_MS): Fact<T> {
  return { value: null, status, source: src, observedAt: Date.now(), ttlMs };
}

export function errorStatus(err: unknown): FactStatus {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM' ? 'denied' : 'unavailable';
}

export async function collect<T>(
  src: SourceRef,
  fn: () => T | Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<Fact<T>> {
  try {
    return ok(await fn(), src, ttlMs);
  } catch (err) {
    return fail(errorStatus(err), src, ttlMs);
  }
}
