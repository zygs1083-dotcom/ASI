import { performance } from 'node:perf_hooks';
import type { DeliveryLevel, EnvChange, EnvUpdate, Signal, SourceObservation, WatchRule } from '@asi/sense-types';
import { sourceObservation } from '../state/source-health.ts';
import type { StateStore } from '../state/store.ts';
import { BucketDrain } from './drain.ts';
import { DEFAULT_RULES, isRuleApproved, selectRule, validateRule } from './rules.ts';
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

/**
 * Sink for delivery intents. The returned promise is awaited before any
 * bucket is dropped or the wake budget charged; a rejection retains the
 * queued input and propagates to the caller.
 */
export interface Deliverer {
  deliver(intent: DeliveryIntent): Promise<void>;
}

/** Options for {@link AttentionPipeline}. */
export interface AttentionPipelineOptions {
  store: StateStore;
  deliverer: Deliverer;
  /** Injected MONOTONIC time for merge deadlines and the wake budget. */
  clock?: () => number;
  /**
   * Wall clock used only for rule expiry and `EnvUpdate.at` display.
   * `Signal.at` and `ToolWindow` bounds remain event wall timestamps.
   */
  wallClock?: () => number;
  rules?: WatchRule[];
  /** Fixed merge window for non-file signals. @default 2000 */
  mergeWindowMs?: number;
  /** Fixed merge window for `file.changed`. @default 5000 */
  fileMergeWindowMs?: number;
}

export interface SessionState {
  context: SessionContext;
  seenIds: Set<string>;
  seenOrder: string[];
  /** Charged wake deliveries as monotonic timestamps. */
  wakeTimes: number[];
  /** Per-session last source-health mark: `source.id` → observation. */
  srcStatus: Map<string, SourceObservation>;
}

const DEDUP_MAX = 1024;

/**
 * Host-driven pipeline (DESIGN §2.3): no internal timers — the host calls
 * {@link flush} at merge deadlines and {@link preStep} before agent steps.
 * `accept`/`flush`/`preStep` are async; intake is durable before the first
 * await, so a rejected drain keeps the signal — retry `flush`/`preStep`,
 * not `accept`. Drains serialize on a recovered promise tail and attempt
 * every eligible bucket independently. Wake budget: 3/600s monotonic with
 * a 60s gap, charged at delivery completion.
 */
export class AttentionPipeline {
  private readonly store: StateStore;
  private readonly drain: BucketDrain;
  private readonly clock: () => number;
  private readonly wallClock: () => number;
  private readonly rules: WatchRule[];
  private readonly mergeWindowMs: number;
  private readonly fileMergeWindowMs: number;
  private readonly sessions = new Map<string, SessionState>();
  private tail: Promise<void> = Promise.resolve();

  constructor(options: AttentionPipelineOptions) {
    this.store = options.store;
    this.clock = options.clock ?? (() => performance.now());
    this.wallClock = options.wallClock ?? Date.now;
    this.rules = (options.rules ?? DEFAULT_RULES).map((r) => {
      const errors = validateRule(r);
      if (errors.length > 0) {
        throw new TypeError(`invalid watch rule ${JSON.stringify(r?.id)}: ${errors.join('; ')}`);
      }
      return structuredClone(r);
    });
    this.mergeWindowMs = options.mergeWindowMs ?? 2_000;
    this.fileMergeWindowMs = options.fileMergeWindowMs ?? 5_000;
    this.drain = new BucketDrain({
      deliverer: options.deliverer,
      sessions: this.sessions,
      clock: this.clock,
      wallClock: this.wallClock,
    });
  }

  /** Cumulative count of wake groups suppressed by the budget. */
  get suppressed(): number {
    return this.drain.suppressed;
  }

  /** Updates the latest context for a session (e.g. busy flag) without a signal. */
  setSession(session: SessionContext): void {
    this.session(session.id).context = session;
  }

  /**
   * Adds or replaces a rule by id. Invalid input throws `TypeError` and a
   * stored clone keeps later caller mutation from widening the rule.
   */
  addRule(rule: WatchRule): void {
    const errors = validateRule(rule);
    if (errors.length > 0) throw new TypeError(`invalid watch rule: ${errors.join('; ')}`);
    const clone = structuredClone(rule);
    const i = this.rules.findIndex((r) => r.id === clone.id);
    if (i >= 0) this.rules[i] = clone;
    else this.rules.push(clone);
  }

  /** Removes a rule by id; a non-string id throws `TypeError`. */
  removeRule(id: string): boolean {
    if (typeof id !== 'string') throw new TypeError('rule id must be a string');
    const i = this.rules.findIndex((r) => r.id === id);
    if (i < 0) return false;
    this.rules.splice(i, 1);
    return true;
  }

  /**
   * Feeds one signal and resolves to its normalized {@link EnvChange}
   * (`count: 1`, effective level, rule info, reason). All intake — session
   * refresh, clone/classify, store apply, dedup/match/enqueue — completes
   * before the first await, so a rejected drain keeps the signal.
   */
  async accept(signal: Signal, session: SessionContext): Promise<EnvChange> {
    const s = this.session(session.id);
    s.context = session;
    const ev = structuredClone(signal);
    ev.cause = classifyCause(ev, session.toolWindows ?? []);
    this.store.apply(ev);
    const now = this.clock();
    const change: EnvChange = { signal: ev, count: 1, level: 'record' };
    if (this.isDuplicate(s, ev.id)) {
      change.reason = 'duplicate';
    } else {
      const repeatedStatus = this.sourceMarkSeen(s, ev);
      if (ev.cause === 'agent') {
        change.reason = 'self-caused';
      } else {
        const rule = selectRule(this.rules, ev, this.wallClock());
        let level: DeliveryLevel = rule?.level ?? 'record';
        let reason: string | undefined;
        if (level === 'wake' && rule && !isRuleApproved(rule)) {
          level = 'context';
          reason = 'rule-pending-approval';
        }
        if ((ev.kind === 'source.status' || ev.kind === 'source.error') && repeatedStatus) {
          level = 'record';
        }
        change.level = level;
        if (rule) {
          change.ruleId = rule.id;
          if (rule.note !== undefined) change.note = rule.note;
        }
        if (reason !== undefined) change.reason = reason;
        if (level !== 'record') {
          const win = ev.kind === 'file.changed' ? this.fileMergeWindowMs : this.mergeWindowMs;
          this.drain.enqueue(ev, session.id, level, rule, reason, now, win);
        }
      }
    }
    const result = structuredClone(change);
    await this.enqueueDrain(() => this.drain.due(now));
    return result;
  }

  /** Completes every bucket whose monotonic deadline passed (awaited). */
  flush(now: number = this.clock()): Promise<void> {
    return this.enqueueDrain(() => this.drain.due(now));
  }

  /**
   * Drains due buckets, then injects the session's ready context — including
   * its pending context-level groups closed early for this step.
   */
  preStep(sessionId: string, now: number = this.clock()): Promise<void> {
    return this.enqueueDrain(() => this.drain.preStep(sessionId, now));
  }

  /** Serializes drains on a promise tail; a rejected run cannot stall the next one. */
  private enqueueDrain(work: () => Promise<void>): Promise<void> {
    const run = this.tail.then(work);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
   * Updates the session's source mark on ANY nonduplicate signal via the
   * shared {@link sourceObservation} normalization — an ordinary success is
   * a recovery — and reports whether this signal is a stale/repeated status
   * notification (event-time guard). Callers apply the verdict only to
   * `source.status`/`source.error` kinds.
   */
  private sourceMarkSeen(s: SessionState, ev: Signal): boolean {
    const prev = s.srcStatus.get(ev.source.id);
    const next = sourceObservation(ev);
    const seen = prev !== undefined && (ev.at < prev.lastSignalAt || prev.status === next.status);
    if (!prev || ev.at >= prev.lastSignalAt) s.srcStatus.set(ev.source.id, next);
    return seen;
  }
}
