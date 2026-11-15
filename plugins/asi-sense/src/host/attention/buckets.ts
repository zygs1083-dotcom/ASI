import type { DeliveryLevel, EnvChange, Signal, WatchRule } from '@asi/sense-types';
import { LEVEL_RANK } from './rules.ts';

/**
 * One kind's contribution inside a merge bucket: merged `count`, earliest
 * `signal.at`, and the representative — highest effective level, then newest
 * `at` (`id` breaks ties); rule/note/reason follow the representative.
 */
export interface BucketDetail {
  kind: string;
  level: DeliveryLevel;
  count: number;
  /** Earliest `signal.at` seen for this kind. */
  since: number;
  latest: Signal;
  /** Every merged signal id — the retry identity of the delivery. */
  ids: string[];
  ruleId?: string;
  note?: string;
  reason?: string;
}

/**
 * One merge bucket: every accepted signal sharing session+subject received
 * in the half-open window `[startedAt, deadline)` fixed by the first
 * signal's kind — a signal received at or after it opens a new generation,
 * so a retained failed delivery can never swallow fresh input. `details`
 * keeps each kind's own merge so one delivery carries every kind's change.
 */
export interface Bucket {
  id: number;
  sessionId: string;
  subject: string;
  /** Monotonic receipt time of the first signal in this generation. */
  startedAt: number;
  /** Monotonic completion deadline, `startedAt + window of first kind`. */
  deadline: number;
  details: Map<string, BucketDetail>;
  /** Set at the first delivery attempt — no further merges or splits. */
  sealed?: boolean;
  /** Wall-clock `EnvUpdate.at` frozen at the first delivery attempt. */
  frozenAt?: number;
  /** The mixed bucket this context-only split came from. */
  splitFrom?: Bucket;
  /** Signals already injected from this bucket via split context. */
  alreadyInjected?: number;
}

/** A bucket is a wake group iff any of its kind details is wake-level. */
export function bucketLevel(b: Bucket): DeliveryLevel {
  let level: DeliveryLevel = 'record';
  for (const d of b.details.values()) {
    if (LEVEL_RANK[d.level] > LEVEL_RANK[level]) level = d.level;
  }
  return level;
}

/** Earliest event time across all kind details. */
export function bucketSince(b: Bucket): number {
  let since = Number.POSITIVE_INFINITY;
  for (const d of b.details.values()) since = Math.min(since, d.since);
  return since;
}

/** Deterministic change ordering: representative `signal.at`, then `id`. */
export const byChangeAtId = (a: EnvChange, b: EnvChange): number =>
  a.signal.at - b.signal.at || (a.signal.id < b.signal.id ? -1 : 1);

/**
 * Inserts or merges one accepted signal into the open generation — the same
 * session+subject bucket whose `deadline` is still ahead of `now` — or
 * starts a fresh bucket with a fixed window via `nextId`.
 */
export function upsertBucket(
  pending: Map<number, Bucket>,
  signal: Signal,
  sessionId: string,
  level: DeliveryLevel,
  rule: WatchRule | undefined,
  reason: string | undefined,
  now: number,
  windowMs: number,
  nextId: () => number,
): void {
  let b: Bucket | undefined;
  for (const candidate of pending.values()) {
    if (
      !candidate.sealed &&
      candidate.sessionId === sessionId &&
      candidate.subject === signal.subject &&
      candidate.deadline > now
    ) {
      b = candidate;
      break;
    }
  }
  if (!b) {
    b = {
      id: nextId(),
      sessionId,
      subject: signal.subject,
      startedAt: now,
      deadline: now + windowMs,
      details: new Map(),
    };
    pending.set(b.id, b);
  }
  const d = b.details.get(signal.kind);
  if (!d) {
    const detail: BucketDetail = {
      kind: signal.kind,
      level,
      count: 1,
      since: signal.at,
      latest: signal,
      ids: [signal.id],
    };
    if (rule?.id !== undefined) detail.ruleId = rule.id;
    if (rule?.note !== undefined) detail.note = rule.note;
    if (reason !== undefined) detail.reason = reason;
    b.details.set(signal.kind, detail);
    return;
  }
  d.count++;
  d.ids.push(signal.id);
  d.since = Math.min(d.since, signal.at);
  const better =
    LEVEL_RANK[level] > LEVEL_RANK[d.level] ||
    (level === d.level && (signal.at > d.latest.at || (signal.at === d.latest.at && signal.id > d.latest.id)));
  if (better) {
    d.level = level;
    d.latest = signal;
    d.ruleId = rule?.id;
    d.note = rule?.note;
    d.reason = reason;
  }
}

/** Converts a completed bucket into one sorted {@link EnvChange} per kind. */
export function bucketChanges(b: Bucket): EnvChange[] {
  const changes: EnvChange[] = [];
  for (const d of b.details.values()) {
    const c: EnvChange = { signal: d.latest, count: d.count, level: d.level };
    if (d.ruleId !== undefined) c.ruleId = d.ruleId;
    if (d.note !== undefined) c.note = d.note;
    if (d.reason !== undefined) c.reason = d.reason;
    changes.push(c);
  }
  return changes.sort(byChangeAtId);
}
