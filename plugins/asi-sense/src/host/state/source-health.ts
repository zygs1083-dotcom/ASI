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
 * Normalizes one signal into the source-health record shared by
 * {@link StateStore} and {@link AttentionPipeline}, so both agree on what a
 * recovery is: `source.error` and `status: 'error'` become `unavailable`,
 * valid `source.status` values pass through, and every other successful
 * signal marks the source `ok`.
 */
export function sourceObservation(signal: Signal): SourceObservation {
  const obs: SourceObservation = { status: 'ok', lastSignalAt: signal.at };
  if (signal.kind === 'source.status') {
    const s = signal.data.status;
    // 'error' is not a FactStatus; it normalizes to 'unavailable'.
    obs.status =
      s === 'error' ? 'unavailable' : typeof s === 'string' && FACT_STATUSES.has(s) ? (s as FactStatus) : 'unknown';
    if (typeof signal.data.error === 'string') obs.error = signal.data.error;
  } else if (signal.kind === 'source.error') {
    obs.status = 'unavailable';
    if (typeof signal.data.error === 'string') obs.error = signal.data.error;
  }
  return obs;
}
