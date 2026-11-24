import type { FactStatus, Signal, SourceObservation } from '@asi/sense-types';

/** Statuses a source may report (also the `fact.updated` status whitelist). */
export const FACT_STATUSES: ReadonlySet<string> = new Set([
  'ok',
  'stale',
  'denied',
  'unsupported',
  'unavailable',
  'unknown',
]);

/**
 * Normalizes one signal into the source-health record: `source.error` and
 * `status: 'error'` become `unavailable`, valid `source.status` values pass
 * through, and every other successful signal marks the source `ok`.
 */
export function sourceObservation(signal: Signal, prev?: SourceObservation): SourceObservation {
  if (signal.kind === 'source.status' && signal.data.preserveStatus === true && prev) {
    return {
      status: prev.status,
      lastSignalAt: signal.at,
      ...(prev.error !== undefined ? { error: prev.error } : {}),
    };
  }
  const obs: SourceObservation = { status: 'ok', lastSignalAt: signal.at };
  if (signal.kind === 'source.status') {
    const s = signal.data.status;
    obs.status =
      s === 'error' ? 'unavailable' : typeof s === 'string' && FACT_STATUSES.has(s) ? (s as FactStatus) : 'unknown';
    if (typeof signal.data.error === 'string') obs.error = signal.data.error;
  } else if (signal.kind === 'source.error') {
    obs.status = 'unavailable';
    if (typeof signal.data.error === 'string') obs.error = signal.data.error;
  }
  return obs;
}
