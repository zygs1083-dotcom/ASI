import type { DeliveryLevel, EnvChange, EnvUpdate, Signal, WatchRule } from '@asi/sense-types';
import type { StateStore } from '../state/store.ts';
import { type Bucket, bucketChange, type SourceMark, upsertBucket } from './buckets.ts';
import { DEFAULT_RULES, isRuleApproved, selectRule } from './rules.ts';
import { classifyCause, type ToolWindow } from './selfcause.ts';

/** Per-session delivery context supplied by the host. */
export interface SessionContext {
  id: string;
  busy: boolean;
  /** True when the active turn was initiated by the user. */
  userInitiated: boolean;
  /** Agent tool-execution windows used for self-cause classification. */
  toolWindows?: ToolWindow[];
}

/**
 * A delivery instruction for the host adapter (M3 implements the transports).
 * `sessionId` routes the intent back to the session that produced it.
 */
export type DeliveryIntent =
  | { kind: 'inject'; sessionId: string; update: EnvUpdate }
  | { kind: 'followup'; sessionId: string; update: EnvUpdate }
  | {
      kind: 'send';
      sessionId: string;
      target: 'next-step';
      wakeup: true;
      update: EnvUpdate;
    };

/** Sink for delivery intents. Errors thrown by `deliver` propagate to the caller. */
export interface Deliverer {
  deliver(intent: DeliveryIntent): void;
}

/** Options for {@link AttentionPipeline}. */
export interface AttentionPipelineOptions {
  store: StateStore;
  deliverer: Deliverer;
  clock?: () => number;
  rules?: WatchRule[];
  /** Fixed merge window for non-file signals. @default 2000 */
  mergeWindowMs?: number;
  /** Fixed merge window for `file.changed`. @default 5000 */
  fileMergeWindowMs?: number;
}

interface SessionState {
  context: SessionContext;
  seenIds: Set<string>;
  seenOrder: string[];
  wakeTimes: number[];
  /** Per-session last source-health transition: `source.id` → mark. */
  srcStatus: Map<string, SourceMark>;
}

const WAKE_WINDOW_MS = 600_000;
const WAKE_MAX = 3;
const WAKE_MIN_GAP_MS = 60_000;
const DEDUP_MAX = 1024;

/** Deterministic change ordering: signal.at, then signal.id. */
const byAtId = (a: EnvChange, b: EnvChange): number =>
  a.signal.at - b.signal.at || (a.signal.id < b.signal.id ? -1 : 1);

/**
 * Host-driven pipeline (DESIGN §2.3): call {@link flush} at merge deadlines
 * and {@link preStep} before agent steps; there are no internal timers.
 * Refresh session → classify → update store → flush → dedupe → match → merge.
 * Wake budget is 3/600s with a 60s gap; excess becomes context.
 * Delivery errors propagate and retain pending input for explicit retry.
 */
export class AttentionPipeline {
  private readonly store: StateStore;
  private readonly deliverer: Deliverer;
  private readonly clock: () => number;
  private readonly rules: readonly WatchRule[];
  private readonly mergeWindowMs: number;
  private readonly fileMergeWindowMs: number;
  private readonly sessions = new Map<string, SessionState>();
  private readonly pending = new Map<string, Bucket>();
  private readonly readyContext = new Map<string, Bucket[]>();
  private suppressedCount = 0;

  constructor(options: AttentionPipelineOptions) {
    this.store = options.store;
    this.deliverer = options.deliverer;
    this.clock = options.clock ?? Date.now;
    this.rules = options.rules ?? DEFAULT_RULES;
    this.mergeWindowMs = options.mergeWindowMs ?? 2_000;
    this.fileMergeWindowMs = options.fileMergeWindowMs ?? 5_000;
  }

  /** Cumulative count of wake groups suppressed by the budget. */
  get suppressed(): number {
    return this.suppressedCount;
  }

  /** Updates the latest context for a session (e.g. busy flag) without a signal. */
  setSession(session: SessionContext): void {
    this.session(session.id).context = session;
  }

  /**
   * Feeds one signal and returns the normalized {@link EnvChange} for it
   * (`count: 1`, effective level, rule info and reason). The store is always
   * updated first — even when the result is `record` (`duplicate`,
   * `self-caused`, rule-less, or a repeated source status).
   */
  accept(signal: Signal, session: SessionContext): EnvChange {
    const s = this.session(session.id);
    s.context = session;
    const ev = structuredClone(signal);
    ev.cause = classifyCause(ev, session.toolWindows ?? []);
    this.store.apply(ev);
    const now = this.clock();
    this.flush(now);
    const change: EnvChange = { signal: ev, count: 1, level: 'record' };
    if (this.isDuplicate(s, ev.id)) {
      change.reason = 'duplicate';
      return change;
    }
    if (ev.cause === 'agent') {
      change.reason = 'self-caused';
      return change;
    }
    const rule = selectRule(this.rules, ev, now);
    let level: DeliveryLevel = rule?.level ?? 'record';
    let reason: string | undefined;
    if (level === 'wake' && rule && !isRuleApproved(rule)) {
      level = 'context';
      reason = 'rule-pending-approval';
    }
    if (ev.kind === 'source.status' || ev.kind === 'source.error') {
      if (this.sourceStatusSeen(s, ev)) level = 'record';
    }
    change.level = level;
    if (rule) {
      change.ruleId = rule.id;
      if (rule.note !== undefined) change.note = rule.note;
    }
    if (reason !== undefined) change.reason = reason;
    if (level !== 'record') {
      const win = ev.kind === 'file.changed' ? this.fileMergeWindowMs : this.mergeWindowMs;
      upsertBucket(this.pending, ev, session.id, level, rule, reason, now, win);
    }
    return structuredClone(change);
  }

  /**
   * Completes every bucket whose fixed deadline passed. Buckets are removed
   * only after completion succeeds — a throwing deliverer keeps the event
   * queued for the next flush.
   */
  flush(now: number = this.clock()): void {
    for (const [key, bucket] of this.pending) {
      if (now < bucket.deadline) continue;
      this.complete(bucket, now);
      this.pending.delete(key);
    }
  }

  /**
   * Flushes expired buckets, then injects all ready context for `sessionId`
   * in one update. The ready list is cleared only after a successful
   * deliver, so a throwing deliverer retains the batch for a later step.
   */
  preStep(sessionId: string, now: number = this.clock()): void {
    this.flush(now);
    const ready = this.readyContext.get(sessionId);
    if (!ready || ready.length === 0) return;
    const changes = ready.map((b) => bucketChange(b)).sort(byAtId);
    this.deliverer.deliver({
      kind: 'inject',
      sessionId,
      update: {
        since: Math.min(...ready.map((b) => b.since)),
        at: now,
        changes,
        suppressed: changes.filter((ch) => ch.reason === 'wake-budget').length,
      },
    });
    this.readyContext.delete(sessionId);
  }

  private session(id: string): SessionState {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        context: { id, busy: false, userInitiated: false },
        seenIds: new Set(),
        seenOrder: [],
        wakeTimes: [],
        srcStatus: new Map(),
      };
      this.sessions.set(id, s);
    }
    return s;
  }

  private isDuplicate(s: SessionState, id: string): boolean {
    if (s.seenIds.has(id)) return true;
    s.seenIds.add(id);
    s.seenOrder.push(id);
    if (s.seenOrder.length > DEDUP_MAX) s.seenIds.delete(s.seenOrder.shift() as string);
    return false;
  }

  /**
   * Per-session source-health dedup, tracked by event time so out-of-order
   * notifications cannot regress it. Returns true when this signal is stale
   * or repeats the current status — only transitions notify. `error` and
   * `source.error` normalize to `unavailable` like the store.
   */
  private sourceStatusSeen(s: SessionState, ev: Signal): boolean {
    const raw = ev.kind === 'source.error' ? 'unavailable' : ev.data.status;
    let st = typeof raw === 'string' ? raw : 'unknown';
    if (st === 'error') st = 'unavailable';
    const prev = s.srcStatus.get(ev.source.id);
    if (!prev || ev.at >= prev.at) {
      s.srcStatus.set(ev.source.id, { status: st, at: ev.at });
    }
    return prev !== undefined && (ev.at < prev.at || prev.status === st);
  }

  private complete(b: Bucket, now: number): void {
    if (b.level === 'context') {
      this.pushReady(b);
      return;
    }
    const s = this.sessions.get(b.sessionId);
    if (s) s.wakeTimes = s.wakeTimes.filter((t) => now - t < WAKE_WINDOW_MS);
    const times = s?.wakeTimes ?? [];
    const last = times[times.length - 1];
    if (times.length >= WAKE_MAX || (last !== undefined && now - last < WAKE_MIN_GAP_MS)) {
      b.level = 'context';
      b.reason = 'wake-budget';
      this.suppressedCount++;
      this.pushReady(b);
      return;
    }
    const change = bucketChange(b);
    const update: EnvUpdate = {
      since: b.since,
      at: now,
      changes: [change],
      suppressed: 0,
    };
    if (s?.context.busy) {
      change.reason = s.context.userInitiated ? 'user-active' : 'agent-busy';
      this.deliverer.deliver({
        kind: 'send',
        sessionId: b.sessionId,
        target: 'next-step',
        wakeup: true,
        update,
      });
    } else {
      this.deliverer.deliver({
        kind: 'followup',
        sessionId: b.sessionId,
        update,
      });
    }
    // The wake budget is charged only after a successful deliver.
    s?.wakeTimes.push(now);
  }

  private pushReady(b: Bucket): void {
    const list = this.readyContext.get(b.sessionId) ?? [];
    list.push(b);
    this.readyContext.set(b.sessionId, list);
  }
}
