import type { DeliveryLevel, EnvChange, Signal, WatchRule } from '@asi/sense-types';
import { LEVEL_RANK } from './rules.ts';

export function isSessionContext(signal: Signal): boolean {
  return (
    (signal.kind === 'body.threshold' && signal.subject === 'context') ||
    (signal.kind === 'body.rate' && signal.data.metric === 'context')
  );
}

export function isSessionOwned(signal: Signal): boolean {
  return (
    isSessionContext(signal) ||
    (signal.source.id === 'dsh' && signal.kind.startsWith('job.') && typeof signal.data.sessionId === 'string')
  );
}

export function privateBucket(bucket: Bucket): boolean {
  return [...bucket.details.values()].some((detail) => isSessionOwned(detail.latest));
}

/**
 * One (kind, effective-level) pair's contribution inside a merge bucket:
 * merged `count`, earliest `signal.at`, and the representative — newest
 * `at` (`id` breaks ties); rule/note/reason follow the representative.
 */
export interface BucketDetail {
  kind: string;
  level: DeliveryLevel;
  count: number;
  /** Earliest `signal.at` seen for this (kind, level) pair. */
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
 * keeps each (kind, level) pair's own merge so one delivery carries every
 * pair's change.
 */
export interface Bucket {
  id: number;
  sessionId: string;
  subject: string;
  /** Monotonic receipt time of the first signal in this generation. */
  startedAt: number;
  /** Monotonic deadline, shortened to the earlier first-kind window when reconfigured. */
  deadline: number;
  fileWindow?: boolean;
  details: Map<string, BucketDetail>;
  /** Set at the first delivery attempt — no further merges or splits. */
  sealed?: boolean;
  /** Wall-clock `EnvUpdate.at` frozen at the first delivery attempt. */
  frozenAt?: number;
  /** The mixed bucket this context-only split came from. */
  splitFrom?: Bucket;
  /** Signals already injected from this bucket via split context. */
  alreadyInjected?: number;
  budgetSuppressed?: boolean;
  jobs?: {
    recent: Map<string, { id: string; kind: string; count: number; exitCode?: number }>;
    omitted: number;
  };
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
      privateBucket(candidate) === isSessionOwned(signal) &&
      (!isSessionOwned(signal) ||
        (bucketLevel(candidate) === level &&
          [...candidate.details.values()].every(
            (detail) => detail.latest.data.sessionToken === signal.data.sessionToken,
          ))) &&
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
      fileWindow: signal.kind === 'file.changed',
      details: new Map(),
    };
    pending.set(b.id, b);
  }
  // Detail key: the unambiguous (kind, effective-level) tuple, so the same
  // kind at different levels (e.g. a context vs a wake `job.exited`) merges
  // into separate details instead of one rank-promoted blob.
  const key = JSON.stringify([signal.kind, level]);
  const d = b.details.get(key);
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
    b.details.set(key, detail);
    return;
  }
  d.count++;
  d.ids.push(signal.id);
  d.since = Math.min(d.since, signal.at);
  // Same kind AND level inside a detail: the representative is simply the
  // newest signal (`id` breaks ties) — there is no rank to promote.
  if (signal.at > d.latest.at || (signal.at === d.latest.at && signal.id > d.latest.id)) {
    d.latest = signal;
    d.ruleId = rule?.id;
    d.note = rule?.note;
    d.reason = reason;
  }
}

export function upsertJobs(
  bucket: Bucket,
  signal: Signal,
  level: DeliveryLevel,
  rule: WatchRule | undefined,
  reason: string | undefined,
): void {
  let detail = bucket.details.get('jobs');
  if (!detail) {
    detail = { kind: signal.kind, level, count: 0, since: signal.at, latest: signal, ids: [] };
    bucket.details.set('jobs', detail);
  }
  detail.count++;
  detail.since = Math.min(detail.since, signal.at);
  detail.latest = signal;
  detail.ids.push(signal.id);
  if (detail.ids.length > 200) detail.ids.shift();
  if (LEVEL_RANK[level] >= LEVEL_RANK[detail.level]) {
    detail.level = level;
    detail.ruleId = rule?.id;
    detail.note = rule?.note;
    detail.reason = bucket.budgetSuppressed && level === 'context' ? 'wake-budget' : reason;
  }
  bucket.jobs ??= { recent: new Map(), omitted: 0 };
  const jobs = bucket.jobs;
  const id = typeof signal.data.id === 'string' ? signal.data.id : signal.subject;
  const key = JSON.stringify([id, signal.kind]);
  const prior = jobs.recent.get(key);
  jobs.recent.delete(key);
  jobs.recent.set(key, {
    id,
    kind: signal.kind,
    count: (prior?.count ?? 0) + 1,
    ...(signal.kind === 'job.exited' && typeof signal.data.exitCode === 'number'
      ? { exitCode: signal.data.exitCode }
      : {}),
  });
  if (jobs.recent.size > 20) {
    const oldest = jobs.recent.keys().next().value as string;
    jobs.omitted += jobs.recent.get(oldest)?.count ?? 0;
    jobs.recent.delete(oldest);
  }
}

/** Converts a completed bucket into one sorted {@link EnvChange} per (kind, level) detail. */
export function bucketChanges(b: Bucket): EnvChange[] {
  const changes: EnvChange[] = [];
  for (const d of b.details.values()) {
    const signal =
      b.jobs && d.count > 1
        ? {
            ...d.latest,
            data: {
              ...d.latest.data,
              jobSummary: { total: d.count, omitted: b.jobs.omitted, recent: [...b.jobs.recent.values()] },
            },
          }
        : d.latest;
    const c: EnvChange = { signal, count: d.count, level: d.level };
    if (d.ruleId !== undefined) c.ruleId = d.ruleId;
    if (d.note !== undefined) c.note = d.note;
    if (d.reason !== undefined) c.reason = d.reason;
    changes.push(c);
  }
  return changes.sort(byChangeAtId);
}
