import { AsyncLocalStorage } from 'node:async_hooks';
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
 * `deliveryId` is the stable SHA-256 idempotency key the host dedups
 * at-least-once deliveries by (README).
 */
export type DeliveryIntent =
  | { kind: 'inject'; sessionId: string; update: EnvUpdate; deliveryId?: string }
  | { kind: 'followup'; sessionId: string; update: EnvUpdate; deliveryId?: string }
  | {
      kind: 'send';
      sessionId: string;
      target: 'next-step';
      wakeup: true;
      update: EnvUpdate;
      deliveryId?: string;
    };

/** Thrown for accept/flush/preStep calls in an active delivery's async context. */
export class ReentrantDeliveryError extends Error {
  constructor() {
    super(
      'accept/flush/preStep all reject during an active adapter.deliver (awaited or not): return or reject instead',
    );
    this.name = 'ReentrantDeliveryError';
  }
}

/**
 * Sink for delivery intents. The returned promise is awaited before any
 * bucket is dropped or the wake budget charged; a rejection retains the
 * queued input and propagates to the caller. While a delivery is in flight
 * every pipeline API call inside its async context rejects with
 * {@link ReentrantDeliveryError}; work it schedules for later runs free.
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
  /**
   * Per-delivery token: `active` is true only while THAT delivery is in
   * flight, so work scheduled inside it (a `setImmediate` callback, a
   * detached promise) inherits the context yet may call pipeline APIs once
   * the delivery settles — while any call made during an in-flight
   * delivery still rejects.
   */
  private readonly deliveryContext = new AsyncLocalStorage<{ active: boolean }>();
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
      deliverer: {
        deliver: (intent) => {
          const token = { active: true };
          return this.deliveryContext.run(token, async () => {
            try {
              await options.deliverer.deliver(intent);
            } finally {
              token.active = false;
            }
          });
        },
      },
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
   * refresh, clone/classify, store apply, dedup/match/enqueue — runs inside
   * the store's apply callback before the first await, so a rejected drain
   * keeps the signal. A reentrant `accept` queues behind the outer intake;
   * during an in-flight `deliver` it rejects with
   * {@link ReentrantDeliveryError}.
   */
  async accept(signal: Signal, session: SessionContext): Promise<EnvChange> {
    if (this.deliveryContext.getStore()?.active) {
      throw new ReentrantDeliveryError();
    }
    const ev = structuredClone(signal);
    ev.cause = classifyCause(ev, session.toolWindows ?? []);
    return await new Promise<EnvChange>((resolve, reject) => {
      this.store.apply(ev, () => {
        try {
          const now = this.clock();
          const result = this.intake(ev, session, now);
          this.enqueueDrain(() => this.drain.due(now)).then(() => resolve(result), reject);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /** All mutable accept intake — runs inside the store's apply callback (FIFO). */
  private intake(ev: Signal, session: SessionContext, now: number): EnvChange {
    const s = this.session(session.id);
    s.context = session;
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
    return structuredClone(change);
  }

  /**
   * Completes every bucket whose monotonic deadline passed (awaited). `now`
   * must be a timestamp of the injected MONOTONIC clock (never `Date.now` or
   * a future value — a later cutoff is clamped to the current clock, and a
   * non-finite one is a `TypeError`); omit it for the normal case.
   */
  flush(now: number = this.clock()): Promise<void> {
    if (this.deliveryContext.getStore()?.active) return Promise.reject(new ReentrantDeliveryError());
    const cutoff = this.cutoff(now);
    return this.enqueueDrain(() => this.drain.due(cutoff));
  }

  /**
   * Injects the session's ready context — including its pending
   * context-level groups closed early for this step — then drains due
   * buckets. `now` follows the same monotonic-clock contract as
   * {@link flush}.
   */
  preStep(sessionId: string, now: number = this.clock()): Promise<void> {
    if (this.deliveryContext.getStore()?.active) return Promise.reject(new ReentrantDeliveryError());
    const cutoff = this.cutoff(now);
    return this.enqueueDrain(() => this.drain.preStep(sessionId, cutoff));
  }

  /** Validates/clamps a caller-supplied due cutoff to the injected clock. */
  private cutoff(now: number): number {
    if (!Number.isFinite(now)) throw new TypeError('drain cutoff must be a finite monotonic timestamp');
    return Math.min(now, this.clock());
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
