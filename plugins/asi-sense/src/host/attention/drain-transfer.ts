import { createHash } from 'node:crypto';
import type { Bucket } from './buckets.ts';
import type { DeliveryIntent, SessionState } from './pipeline-types.ts';

/** Collaborators the drain needs from the pipeline. */
export interface DrainHooks {
  deliverer: { deliver(intent: DeliveryIntent): Promise<void> };
  sessions: Map<string, SessionState>;
  /** Monotonic clock for wake-budget checks and charges. */
  clock: () => number;
  /** Wall clock, used only for the `EnvUpdate.at` display timestamp. */
  wallClock: () => number;
  isCurrent?: () => (sessionId: string) => boolean;
}

function throwCollected(errors: unknown[], label: string): void {
  // raw rejections propagate unchanged — even an empty AggregateError
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, label);
}

/** Idempotency key: session + SORTED original signal ids — same payload ⇒ same id on retry. */
function deliveryId(sessionId: string, buckets: Bucket[]): string {
  const ids = buckets.flatMap((b) => [...b.details.values()].flatMap((d) => d.ids)).sort();
  return createHash('sha256')
    .update(JSON.stringify([sessionId, ids]))
    .digest('hex');
}

export { deliveryId, throwCollected };

/** A frozen inject delivery: the built intent retries verbatim on failure. */
export interface InjectBatch {
  buckets: Bucket[];
  intent: DeliveryIntent;
  aliases?: string[];
}

export function confirmBatch(batches: Map<string, InjectBatch[]>, id: string): void {
  for (const [session, entries] of batches) {
    for (const batch of [...entries]) {
      if (batch.intent.deliveryId !== id && !batch.aliases?.includes(id)) continue;
      for (const bucket of batch.buckets) {
        if (bucket.splitFrom) {
          const count = [...bucket.details.values()].reduce((sum, detail) => sum + detail.count, 0);
          bucket.splitFrom.alreadyInjected = (bucket.splitFrom.alreadyInjected ?? 0) + count;
        }
      }
      entries.splice(entries.indexOf(batch), 1);
    }
    if (!entries.length) batches.delete(session);
  }
}

export function retargetBuckets(
  pending: Map<number, Bucket>,
  ready: Map<string, Bucket[]>,
  batches: Map<string, InjectBatch[]>,
  sessionId: string,
  build: (sessionId: string, buckets: Bucket[], at: number) => InjectBatch,
): number {
  let restored = 0;
  const restore = (bucket: Bucket): boolean => {
    let wake = false;
    for (const detail of bucket.details.values()) {
      if (detail.reason === 'wake-budget') {
        detail.level = 'wake';
        detail.reason = undefined;
        wake = true;
      }
    }
    if (wake) restored++;
    return wake;
  };
  const append = <T>(map: Map<string, T[]>, value: T): void => {
    const entries = map.get(sessionId) ?? [];
    entries.push(value);
    map.set(sessionId, entries);
  };
  for (const bucket of pending.values()) bucket.sessionId = sessionId;
  for (const [old, buckets] of ready) {
    if (old === sessionId) continue;
    ready.delete(old);
    for (const bucket of buckets) {
      bucket.sessionId = sessionId;
      if (restore(bucket)) pending.set(bucket.id, bucket);
      else append(ready, bucket);
    }
  }
  for (const [old, entries] of batches) {
    if (old === sessionId) continue;
    batches.delete(old);
    for (const batch of entries) {
      const context: Bucket[] = [];
      for (const bucket of batch.buckets) {
        bucket.sessionId = sessionId;
        if (restore(bucket)) pending.set(bucket.id, bucket);
        else context.push(bucket);
      }
      if (context.length) {
        const next = build(sessionId, context, batch.intent.update.at);
        next.aliases = [...(batch.aliases ?? []), ...(batch.intent.deliveryId ? [batch.intent.deliveryId] : [])];
        append(batches, next);
      }
    }
  }
  return restored;
}
