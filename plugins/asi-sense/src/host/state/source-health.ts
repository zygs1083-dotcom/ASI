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

export function isHistoryDailyLimitSignal(signal: Signal): boolean {
  return (
    signal.kind === 'source.error' &&
    signal.subject === 'history' &&
    signal.data !== null &&
    typeof signal.data === 'object' &&
    signal.data.error === 'daily-limit-exceeded'
  );
}

/**
 * Normalizes one signal into the source-health record shared by
 * {@link StateStore} and {@link AttentionPipeline}, so both agree on what a
 * recovery is: `source.error` and `status: 'error'` become `unavailable`,
 * valid `source.status` values pass through, and every other successful
 * signal marks the source `ok`.
 *
 * `daily-limit-exceeded` is an expected budget throttle rather than source
 * unavailability: it sets `capped: true` while leaving `status` `'ok'` (or
 * preserving an active non-`ok` error status) so later real write failures
 * are not masked by repeated-status suppression.
 */
export function sourceObservation(signal: Signal, prev?: SourceObservation): SourceObservation {
  if (isHistoryDailyLimitSignal(signal)) {
    return {
      status: prev ? prev.status : 'ok',
      lastSignalAt: signal.at,
      ...(prev?.error !== undefined ? { error: prev.error } : {}),
      capped: true,
    };
  }
  if (signal.kind === 'source.status' && signal.data.preserveStatus === true && prev) {
    const obs: SourceObservation = {
      status: prev.status,
      lastSignalAt: signal.at,
      ...(prev.error !== undefined ? { error: prev.error } : {}),
    };
    if (signal.data.capped === true || (signal.data.capped !== false && prev.capped === true)) {
      obs.capped = true;
    }
    return obs;
  }
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
  if (signal.data.capped === true || (signal.data.capped !== false && prev?.capped === true)) {
    obs.capped = true;
  }
  return obs;
}
