import type { EnvUpdate, Signal, WatchRule } from '@asi/sense-types';
import { type Bucket, bucketChanges, bucketLevel, bucketSince, byChangeAtId, upsertBucket } from './buckets.ts';
import type { DeliveryIntent, SessionState } from './pipeline.ts';

const WAKE_WINDOW_MS = 600_000;
const WAKE_MAX = 3;
const WAKE_MIN_GAP_MS = 60_000;

/** Collaborators the drain needs from the pipeline. */
export interface DrainHooks {
  deliverer: { deliver(intent: DeliveryIntent): Promise<void> };
  sessions: Map<string, SessionState>;
  /** Monotonic clock for wake-budget checks and charges. */
  clock: () => number;
  /** Wall clock, used only for the `EnvUpdate.at` display timestamp. */
  wallClock: () => number;
}

function collectError(errors: unknown[], e: unknown): void {
  if (e instanceof AggregateError) errors.push(...e.errors);
  else errors.push(e);
}

function throwCollected(errors: unknown[], label: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, label);
}

/**
 * Merge buckets (pending) plus the ready context queue, delivered through
 * the host's deliverer. Attempts are independent: a bucket is removed only
 * after its delivery resolves, a rejection retains it uncharged, and one
 * failure never stops the remaining buckets — of any session — from being
 * tried. Intents are deep-cloned so a rejecting adapter that mutates them
 * cannot corrupt the retained retry.
 */
export class BucketDrain {
  private readonly pending = new Map<number, Bucket>();
  private readonly ready = new Map<string, Bucket[]>();
  private readonly deliverer: DrainHooks['deliverer'];
  private readonly sessions: DrainHooks['sessions'];
  private readonly clock: () => number;
  private readonly wallClock: () => number;
  private seq = 0;
  private suppressedGroups = 0;

  constructor(hooks: DrainHooks) {
    this.deliverer = hooks.deliverer;
    this.sessions = hooks.sessions;
    this.clock = hooks.clock;
    this.wallClock = hooks.wallClock;
  }

  /** Cumulative count of wake groups suppressed by the budget. */
  get suppressed(): number {
    return this.suppressedGroups;
  }

  /** Enqueues one classified signal into its session+subject merge window. */
  enqueue(
    signal: Signal,
    sessionId: string,
    level: 'record' | 'context' | 'wake',
    rule: WatchRule | undefined,
    reason: string | undefined,
    now: number,
    windowMs: number,
  ): void {
    upsertBucket(this.pending, signal, sessionId, level, rule, reason, now, windowMs, () => (this.seq += 1));
  }

  /**
   * Completes every bucket whose monotonic deadline passed (`now` is the
   * caller's due cutoff, not the budget clock). Successful completions are
   * removed; failures stay queued for retry.
   */
  async due(now: number): Promise<void> {
    const errors: unknown[] = [];
    for (const b of [...this.pending.values()]) {
      if (now < b.deadline) continue;
      try {
        await this.complete(b);
        this.pending.delete(b.id);
      } catch (e) {
        collectError(errors, e);
      }
    }
    throwCollected(errors, 'delivery failed');
  }

  /**
   * Pre-step drain (DESIGN §2.3): the session's pending context-level groups
   * close early — wake groups keep waiting for their deadline — due buckets
   * for every session drain next, and the session's ready context injects
   * last. Each step runs even when an earlier one failed.
   */
  async preStep(sessionId: string, now: number): Promise<void> {
    for (const b of [...this.pending.values()]) {
      if (b.sessionId === sessionId && bucketLevel(b) === 'context') {
        this.readyList(b.sessionId).push(b);
        this.pending.delete(b.id);
      }
    }
    const errors: unknown[] = [];
    try {
      await this.due(now);
    } catch (e) {
      collectError(errors, e);
    }
    try {
      await this.inject(sessionId);
    } catch (e) {
      collectError(errors, e);
    }
    throwCollected(errors, 'pre-step delivery failed');
  }

  /**
   * Completes one due bucket: context groups go to the ready queue; wake
   * groups check the per-session budget on a fresh monotonic sample — the
   * drain may have been queued long ago — and charge it once, on a second
   * fresh sample taken AFTER the delivery resolves.
   */
  private async complete(b: Bucket): Promise<void> {
    if (bucketLevel(b) !== 'wake') {
      this.readyList(b.sessionId).push(b);
      return;
    }
    const s = this.sessions.get(b.sessionId);
    const budgetAt = this.clock();
    if (s) s.wakeTimes = s.wakeTimes.filter((t) => budgetAt - t < WAKE_WINDOW_MS);
    const times = s?.wakeTimes ?? [];
    const last = times[times.length - 1];
    if (times.length >= WAKE_MAX || (last !== undefined && budgetAt - last < WAKE_MIN_GAP_MS)) {
      for (const d of b.details.values()) {
        if (d.level === 'wake') {
          d.level = 'context';
          d.reason = 'wake-budget';
        }
      }
      this.suppressedGroups++;
      this.readyList(b.sessionId).push(b);
      return;
    }
    const changes = bucketChanges(b);
    let intent: DeliveryIntent;
    if (s?.context.busy) {
      const reason = s.context.userInitiated ? 'user-active' : 'agent-busy';
      for (const ch of changes) if (ch.level === 'wake') ch.reason = reason;
      const update: EnvUpdate = { since: bucketSince(b), at: this.wallClock(), changes, suppressed: 0 };
      intent = { kind: 'send', sessionId: b.sessionId, target: 'next-step', wakeup: true, update };
    } else {
      const update: EnvUpdate = { since: bucketSince(b), at: this.wallClock(), changes, suppressed: 0 };
      intent = { kind: 'followup', sessionId: b.sessionId, update };
    }
    await this.deliverer.deliver(structuredClone(intent));
    s?.wakeTimes.push(this.clock());
  }

  /**
   * Injects the session's ready buckets in one update. On success exactly
   * the delivered batch is removed — anything appended during the awaited
   * delivery is retained — and on rejection nothing is dropped, so the next
   * step retries the same batch exactly once.
   */
  private async inject(sessionId: string): Promise<void> {
    const ready = this.ready.get(sessionId);
    if (!ready || ready.length === 0) return;
    const batch = [...ready];
    const changes = batch.flatMap((b) => bucketChanges(b)).sort(byChangeAtId);
    const intent: DeliveryIntent = {
      kind: 'inject',
      sessionId,
      update: {
        since: Math.min(...batch.map(bucketSince)),
        at: this.wallClock(),
        changes,
        // suppressed counts GROUPS, not the wake-budget details inside them
        suppressed: batch.filter((b) => [...b.details.values()].some((d) => d.reason === 'wake-budget')).length,
      },
    };
    await this.deliverer.deliver(structuredClone(intent));
    const delivered = new Set(batch);
    const remaining = (this.ready.get(sessionId) ?? []).filter((b) => !delivered.has(b));
    if (remaining.length === 0) this.ready.delete(sessionId);
    else this.ready.set(sessionId, remaining);
  }

  private readyList(sessionId: string): Bucket[] {
    let list = this.ready.get(sessionId);
    if (!list) {
      list = [];
      this.ready.set(sessionId, list);
    }
    return list;
  }
}
