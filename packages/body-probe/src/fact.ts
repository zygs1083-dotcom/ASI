import os from 'node:os';
import type { Fact, FactStatus, SourceRef } from './types.js';

export const DEFAULT_TTL_MS = 6000;

export function source(id: string, api: string): SourceRef {
  return { id: `body-probe.${id}`, api, host: os.hostname() };
}

export function ok<T>(value: T, src: SourceRef, ttlMs: number = DEFAULT_TTL_MS): Fact<T> {
  return { value, status: 'ok', source: src, observedAt: Date.now(), ttlMs };
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
