import type { DeliveryLevel, EnvChange, Signal, WatchRule } from '@asi/sense-types';
import { LEVEL_RANK } from './rules.ts';

/**
 * One merge bucket: a group of signals sharing session+kind+subject, closed
 * at a fixed deadline anchored on first receipt. `latest` is the
 * representative signal — the highest effective level in the group, and
 * among equal levels the newest `signal.at` (`id` is the deterministic tie).
 */
export interface Bucket {
  sessionId: string;
  kind: string;
  subject: string;
  level: DeliveryLevel;
  /** Earliest `signal.at` seen in the group. */
  since: number;
  deadline: number;
  latest: Signal;
  count: number;
  ruleId?: string;
  note?: string;
  reason?: string;
}

/** Last source-health transition observed for one source id. */
export interface SourceMark {
  status: string;
  at: number;
}

/** Collision-safe bucket key (subjects may contain newlines). */
export function bucketKey(sessionId: string, kind: string, subject: string): string {
  return JSON.stringify([sessionId, kind, subject]);
}

/**
 * Inserts or merges one accepted signal into `pending`. A new bucket starts
 * a fixed window at `now + windowMs`; merging bumps `count`, keeps the
 * earliest `since`, and re-elects the representative — rule/note/reason
 * always follow the current representative (a stale `reason` is cleared when
 * the new representative carries none).
 */
export function upsertBucket(
  pending: Map<string, Bucket>,
  signal: Signal,
  sessionId: string,
  level: DeliveryLevel,
  rule: WatchRule | undefined,
  reason: string | undefined,
  now: number,
  windowMs: number,
): void {
  const key = bucketKey(sessionId, signal.kind, signal.subject);
  const b = pending.get(key);
  if (!b) {
    const fresh: Bucket = {
      sessionId,
      kind: signal.kind,
      subject: signal.subject,
      level,
      since: signal.at,
      deadline: now + windowMs,
      latest: signal,
      count: 1,
    };
    if (rule?.id !== undefined) fresh.ruleId = rule.id;
    if (rule?.note !== undefined) fresh.note = rule.note;
    if (reason !== undefined) fresh.reason = reason;
    pending.set(key, fresh);
    return;
  }
  b.count++;
  b.since = Math.min(b.since, signal.at);
  const better =
    LEVEL_RANK[level] > LEVEL_RANK[b.level] ||
    (level === b.level && (signal.at > b.latest.at || (signal.at === b.latest.at && signal.id > b.latest.id)));
  if (better) {
    b.level = level;
    b.latest = signal;
    b.ruleId = rule?.id;
    b.note = rule?.note;
    b.reason = reason;
  }
}

/** Converts a completed bucket into a deliverable {@link EnvChange}. */
export function bucketChange(b: Bucket): EnvChange {
  const c: EnvChange = { signal: b.latest, count: b.count, level: b.level };
  if (b.ruleId !== undefined) c.ruleId = b.ruleId;
  if (b.note !== undefined) c.note = b.note;
  if (b.reason !== undefined) c.reason = b.reason;
  return c;
}
