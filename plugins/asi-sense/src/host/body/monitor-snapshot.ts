import type { BodyThresholdSample, BodyThresholdState } from '@asi/sense-types';
import type { Baseline } from './baseline.ts';
import type { BackupNotice } from './persistence.ts';
import { type AdaptiveState, BODY_HISTORY, serializeHistory } from './state.ts';
import type { Tuner } from './tuner.ts';

export function serializeMonitor(
  seed: Baseline,
  clock: () => number,
  tuner: Tuner | undefined,
  latest: AdaptiveState | undefined,
  disabled: 'restore-failed' | 'storage-failed' | undefined,
  tunerSnapshot?: string,
  rebaseline?: unknown,
  backupNotice?: BackupNotice,
  restoreKind?: BackupNotice['kind'],
): string {
  const current = seed.clone();
  current.advance(clock());
  const latch: BodyThresholdState = {};
  for (const k of Object.keys(latest ?? {})) if (!k.startsWith('context@')) latch[k] = (latest as AdaptiveState)[k];
  return JSON.stringify({
    version: 1,
    disabled: tunerSnapshot === undefined ? (disabled ?? tuner?.tuningDisabled) : JSON.parse(tunerSnapshot).disabled,
    tuner: tunerSnapshot ?? tuner?.serialize(),
    baseline: current.serialize(),
    latch,
    history: serializeHistory(latest?.[BODY_HISTORY]),
    rebaseline,
    ...(backupNotice ? { backupNotice } : {}),
    ...(restoreKind ? { restoreKind } : {}),
  });
}

/** Requires finite monotonic receipt times on both samples. */
export function validateSamples(
  prev: BodyThresholdSample,
  next: BodyThresholdSample,
): [BodyThresholdSample, BodyThresholdSample] {
  if (!Number.isFinite(prev.monotonicAt) || !Number.isFinite(next.monotonicAt) || !Number.isFinite(next.at)) {
    throw new TypeError('monitor: clocks must be finite');
  }
  return [prev, next];
}
