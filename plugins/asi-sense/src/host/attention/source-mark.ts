import type { Signal } from '@asi/sense-types';
import { sourceObservation } from '../state/source-health.ts';
import type { SessionState } from './pipeline-types.ts';

/**
 * Updates the session's source mark on ANY nonduplicate signal via the
 * shared {@link sourceObservation} normalization — an ordinary success is
 * a recovery — and reports whether this signal is a stale/repeated status
 * notification (comparable sequence guard). Callers apply the verdict only to
 * `source.status`/`source.error` kinds.
 */
export function sourceMarkSeen(s: SessionState, ev: Signal): boolean {
  if (ev.data.preserveSourceStatus === true) return false;
  const prev = s.srcStatus.get(ev.source.id);
  const next = sourceObservation(ev);
  const sequence = ev.data.sequence;
  const previous = s.srcSequence.get(ev.source.id);
  if (
    (ev.kind === 'source.status' || ev.kind === 'source.error') &&
    typeof sequence === 'number' &&
    Number.isSafeInteger(sequence)
  ) {
    if (previous !== undefined && sequence < previous) return true;
    s.srcSequence.set(ev.source.id, sequence);
  } else s.srcSequence.delete(ev.source.id);
  const seen = prev?.status === next.status;
  s.srcStatus.set(ev.source.id, next);
  return seen;
}
