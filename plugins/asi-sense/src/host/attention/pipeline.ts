import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { EnvChange, Signal, WatchRule } from '@asi/sense-types';
import type { StateStore } from '../state/store.ts';
import { BucketDrain } from './drain.ts';
import type { InjectBatch } from './drain-transfer.ts';
import { intake } from './intake.ts';
import type { AttentionPipelineOptions, SessionContext, SessionState } from './pipeline-types.ts';
import { DEFAULT_RULES, validateRule } from './rules.ts';
import { classifyCause } from './selfcause.ts';

export type {
  AttentionPipelineOptions,
  Deliverer,
  DeliveryIntent,
  SessionContext,
  SessionState,
} from './pipeline-types.ts';
/** Thrown for flush/preStep calls in an active delivery's async context. */
export class ReentrantDeliveryError extends Error {
  constructor() {
    super('flush/preStep reject during an active adapter.deliver (awaited or not): return or reject instead');
    this.name = 'ReentrantDeliveryError';
  }
}

/**
 * Host-driven pipeline (DESIGN §2.3): no internal timers — `accept` is
 * intake only; the host calls {@link flush} at {@link nextDeadline} and
 * {@link preStep} before agent steps.
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
  private readonly disposed = new Map<string, number>();
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
      isCurrent: options.isCurrent,
    });
  }

  /** Cumulative count of wake groups suppressed by the budget. */
  get suppressed(): number {
    return this.drain.suppressed;
  }

  /** Updates the latest context for a session (e.g. busy flag) without a signal. */
  setSession(session: SessionContext): void {
    this.disposed.delete(session.id);
    this.session(session.id).context = session;
  }
  disposeSession(id: string): void {
    if (this.sessions.has(id)) this.disposed.set(id, this.clock() + 600_000);
  }
  retentionDeadline(): number | undefined {
    return this.disposed.size ? Math.min(...this.disposed.values()) : undefined;
  }
  pruneSessions(): void {
    for (const [id, at] of this.disposed) {
      if (at <= this.clock()) {
        this.disposed.delete(id);
        this.sessions.delete(id);
      }
    }
  }
  retarget(sessionId: string): Promise<void> {
    return this.enqueueDrain(async () => this.drain.retarget(sessionId));
  }
  confirm(id: string): Promise<void> {
    return this.enqueueDrain(async () => this.drain.confirm(id));
  }
  suspend(id: string): Promise<InjectBatch[]> {
    let batches: InjectBatch[] = [];
    return this.enqueueDrain(async () => {
      batches = this.drain.suspend(id);
    }).then(() => batches);
  }
  restore(id: string, batch: InjectBatch): Promise<void> {
    return this.enqueueDrain(async () => this.drain.restore(id, batch));
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
   * the store's apply callback (shared synchronous FIFO), so the signal is
   * durable before the promise resolves; no delivery is attempted or
   * awaited — inside an in-flight `deliver` it still completes.
   */
  async accept(signal: Signal, session: SessionContext, onIntake?: (change: EnvChange) => void): Promise<EnvChange> {
    return this.process(signal, session, 1, true, false, onIntake);
  }
  async acceptCount(signal: Signal, session: SessionContext, count: number, other = false): Promise<EnvChange> {
    return this.process(signal, session, count, false, other);
  }
  private async process(
    signal: Signal,
    session: SessionContext,
    count: number,
    apply: boolean,
    other = false,
    onIntake?: (change: EnvChange) => void,
  ): Promise<EnvChange> {
    const ev = structuredClone(signal);
    ev.cause = classifyCause(ev, session.toolWindows ?? [], 0, this.clock());
    if (!apply) return this.intake(ev, session, this.clock(), count, other);
    return await new Promise<EnvChange>((resolve, reject) => {
      this.store.apply(ev, (result) => {
        try {
          const change =
            result === 'older'
              ? { signal: ev, count: 1, level: 'record', reason: 'older-sequence' }
              : this.intake(ev, session, this.clock(), count);
          onIntake?.(change as EnvChange);
          resolve(change as EnvChange);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  private intake(ev: Signal, session: SessionContext, now: number, count: number, other = false): EnvChange {
    return intake(
      this.session(session.id),
      ev,
      session,
      now,
      count,
      other,
      this.rules,
      () => this.wallClock(),
      this.drain,
      this.mergeWindowMs,
      this.fileMergeWindowMs,
    );
  }

  /** Earliest pending merge deadline (monotonic) or `undefined` — the host's flush-timer hint. */
  nextDeadline(): number | undefined {
    return this.drain.nextDeadline();
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
        srcSequence: new Map(),
      };
      this.sessions.set(id, s);
    }
    return s;
  }
}
