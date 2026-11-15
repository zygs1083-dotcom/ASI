import os from 'node:os';
import type { Fact, FactStatus, SourceRef } from './types.js';

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
}

// A composite fact (built from readings with different cadences) keeps the
// oldest constituent's observedAt and 3x that constituent's period as ttlMs;
// equal observedAt picks the smallest period.
export function oldestMeta(parts: readonly FactMeta[]): { observedAt: number; ttlMs: number } {
  let best = parts[0]!;
  for (const p of parts) {
    if (p.observedAt < best.observedAt
      || (p.observedAt === best.observedAt && p.periodMs < best.periodMs)) {
      best = p;
    }
  }
  return { observedAt: best.observedAt, ttlMs: best.periodMs * 3 };
}

// Marks an ok fact stale once it outlives its ttl; applied on reads and on
// republished cached samples. observedAt is never refreshed for republishing.
export function stale<T>(f: Fact<T>, now: number = Date.now()): Fact<T> {
  return f.status === 'ok' && now - f.observedAt > f.ttlMs ? { ...f, status: 'stale' } : f;
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
