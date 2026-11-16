import type { Bucket } from './buckets.ts';
import type { DeliveryIntent } from './pipeline-types.ts';

/** A frozen inject delivery: the built intent retries verbatim on failure. */
export interface InjectBatch {
  buckets: Bucket[];
  intent: DeliveryIntent;
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
      if (context.length) append(batches, build(sessionId, context, batch.intent.update.at));
    }
  }
  return restored;
}
