import type { EnvUpdate, Signal, WatchRule } from '@asi/sense-types';
import {
  type Bucket,
  type BucketDetail,
  bucketChanges,
  bucketLevel,
  bucketSince,
  byChangeAtId,
  upsertBucket,
} from './buckets.ts';
import {
  confirmBatch,
  type DrainHooks,
  deliveryId,
  type InjectBatch,
  retargetBuckets,
  throwCollected,
} from './drain-transfer.ts';
import type { DeliveryIntent } from './pipeline.ts';

const WAKE_WINDOW_MS = 600_000;
const WAKE_MAX = 3;
const WAKE_MIN_GAP_MS = 60_000;
export class DeliveryFailure extends Error {
  constructor(
    readonly kind: 'deferred' | 'exhausted' | 'unknown',
    readonly retryAt = 0,
    cause?: unknown,
  ) {
    super(`delivery ${kind}`, cause === undefined ? undefined : { cause });
  }
}
/**
 * Merge buckets (pending) plus the ready context queue, delivered through
 * the host's deliverer. Attempts are independent and isolated: a bucket is
 * detached and sealed BEFORE its awaited delivery, so a rejection retains
 * it for a same-payload retry while fresh same-subject input opens a new
 * bucket, and one failure never stops the remaining buckets — of any
 * session — from being tried. Intents are deep-cloned so a rejecting
 * adapter that mutates them cannot corrupt the retained retry.
 */
export class BucketDrain {
  private readonly pending = new Map<number, Bucket>();
  private readonly ready = new Map<string, Bucket[]>();
  private readonly batches = new Map<string, InjectBatch[]>();
  private readonly deliverer: DrainHooks['deliverer'];
  private readonly sessions: DrainHooks['sessions'];
  private readonly clock: () => number;
  private readonly wallClock: () => number;
  private readonly isCurrent: () => (sessionId: string) => boolean;
  private seq = 0;
  private suppressedGroups = 0;
  constructor(hooks: DrainHooks) {
    this.deliverer = hooks.deliverer;
    this.sessions = hooks.sessions;
    this.clock = hooks.clock;
    this.wallClock = hooks.wallClock;
    this.isCurrent = hooks.isCurrent ?? (() => () => true);
  }
  /** Cumulative count of wake groups suppressed by the budget. */
  get suppressed(): number {
    return this.suppressedGroups;
  }
  /** Earliest pending merge deadline — retained failures included; `undefined` when none. */
  nextDeadline(): number | undefined {
    let min: number | undefined;
    for (const b of this.pending.values()) {
      if (min === undefined || b.deadline < min) min = b.deadline;
    }
    return min;
  }
  retarget(sessionId: string): void {
    if (!this.isCurrent()(sessionId)) return;
    for (const b of this.pending.values()) if (b.sessionId !== sessionId && b.sealed) b.deadline = this.clock();
    this.suppressedGroups -= retargetBuckets(this.pending, this.ready, this.batches, sessionId, (id, buckets, at) =>
      this.buildInjectBatch(id, buckets, at),
    );
  }
  confirm(id: string): void {
    confirmBatch(this.batches, id);
  }
  suspend(id: string): InjectBatch[] {
    const batches = this.batches.get(id) ?? [];
    this.batches.delete(id);
    return batches;
  }
  restore(sessionId: string, batch: InjectBatch): void {
    const next = this.buildInjectBatch(sessionId, batch.buckets, batch.intent.update.at);
    next.aliases = [...(batch.aliases ?? []), ...(batch.intent.deliveryId ? [batch.intent.deliveryId] : [])];
    for (const bucket of next.buckets) bucket.sessionId = sessionId;
    this.list(this.batches, sessionId).push(next);
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
    count = 1,
  ): void {
    upsertBucket(this.pending, signal, sessionId, level, rule, reason, now, windowMs, () => (this.seq += 1));
    if (count > 1) {
      for (const bucket of this.pending.values()) {
        for (const detail of bucket.details.values()) {
          if (detail.ids.includes(signal.id)) detail.count += count - 1;
        }
      }
    }
  }
  /**
   * Completes every bucket whose monotonic deadline passed (`now` is the
   * caller's due cutoff, not the budget clock). Successful completions are
   * removed; failures stay queued for retry.
   */
  async due(now: number): Promise<void> {
    const errors: unknown[] = [];
    await this.attemptDue(now, errors, this.isCurrent());
    throwCollected(errors, 'delivery failed');
  }
  /**
   * Pre-step drain (DESIGN §2.3): the session's context ships FIRST — pure
   * context groups close early and context details split out of still-open
   * mixed buckets — then ready context injects, due buckets for every
   * session drain, and anything the due pass made ready injects too.
   */
  async preStep(sessionId: string, now: number): Promise<void> {
    const current = this.isCurrent();
    if (!current(sessionId)) return;
    for (const b of [...this.pending.values()]) {
      if (b.sessionId !== sessionId || b.sealed) continue;
      if (bucketLevel(b) === 'context') {
        this.pending.delete(b.id);
        this.list(this.ready, sessionId).push(b);
        continue;
      }
      // Mixed bucket: split context details into ready context; the wake
      // remainder keeps the ORIGINAL deadline pending.
      const ctx = new Map<string, BucketDetail>();
      for (const [kind, d] of b.details) {
        if (d.level === 'context') ctx.set(kind, d);
      }
      if (ctx.size === 0) continue;
      for (const kind of ctx.keys()) b.details.delete(kind);
      this.seq += 1;
      this.list(this.ready, sessionId).push({
        id: this.seq,
        sessionId: b.sessionId,
        subject: b.subject,
        startedAt: b.startedAt,
        deadline: b.deadline,
        details: ctx,
        splitFrom: b,
      });
    }
    const errors: unknown[] = [];
    const attempted = new Set<InjectBatch>();
    if (current(sessionId)) await this.attemptInject(sessionId, errors, attempted, current);
    if (current(sessionId)) await this.attemptDue(now, errors, current);
    // due-pass downgrades also inject THIS step; failed batches wait for the next
    if (current(sessionId)) await this.attemptInject(sessionId, errors, attempted, current);
    throwCollected(errors, 'pre-step delivery failed');
  }
  /** Due buckets attempted independently; failures restore the sealed bucket for a same-payload retry. */
  private async attemptDue(now: number, errors: unknown[], current: (id: string) => boolean): Promise<void> {
    for (const b of [...this.pending.values()]) {
      if (!current(b.sessionId)) break;
      if (now < b.deadline) continue;
      this.pending.delete(b.id);
      b.sealed = true;
      try {
        await this.complete(b);
      } catch (e) {
        if (!(e instanceof DeliveryFailure) || e.cause !== undefined)
          errors.push(e instanceof DeliveryFailure ? e.cause : e);
        if (!(e instanceof DeliveryFailure) || e.kind === 'deferred') {
          if (e instanceof DeliveryFailure) b.deadline = e.retryAt;
          this.pending.set(b.id, b); // sealed: retry only, never a merge target
        }
      }
    }
  }
  /**
   * Completes one due bucket: context groups go to the ready queue; wake
   * groups check the per-session budget on a fresh monotonic sample — the
   * drain may have been queued long ago — and charge it once, on a second
   * fresh sample taken AFTER the delivery resolves. `at`/`deliveryId`
   * freeze at the FIRST attempt and survive retries.
   */
  private async complete(b: Bucket): Promise<void> {
    if (bucketLevel(b) !== 'wake') {
      this.list(this.ready, b.sessionId).push(b);
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
      if (b.frozenAt === undefined) {
        this.list(this.ready, b.sessionId).push(b); // never attempted: aggregates
      } else {
        // previously attempted wake: inject separately, keeping its
        // original display time and identity — never join a fresh batch
        this.list(this.batches, b.sessionId).push(this.buildInjectBatch(b.sessionId, [b], b.frozenAt));
      }
      return;
    }
    if (b.frozenAt === undefined) b.frozenAt = this.wallClock();
    const changes = bucketChanges(b);
    const update: EnvUpdate = { since: bucketSince(b), at: b.frozenAt, changes, suppressed: 0 };
    if ((b.alreadyInjected ?? 0) > 0) update.alreadyInjected = b.alreadyInjected;
    let intent: DeliveryIntent;
    if (s?.context.busy) {
      const reason = s.context.userInitiated ? 'user-active' : 'agent-busy';
      for (const ch of changes) if (ch.level === 'wake') ch.reason = reason;
      intent = { kind: 'send', sessionId: b.sessionId, target: 'next-step', wakeup: true, update };
    } else {
      intent = { kind: 'followup', sessionId: b.sessionId, update };
    }
    intent.deliveryId = deliveryId(b.sessionId, [b]);
    await this.deliverer.deliver(structuredClone(intent));
    s?.wakeTimes.push(this.clock());
  }
  /**
   * Freezes loose ready buckets into a fresh batch, then attempts every
   * frozen batch in order, skipping batches already tried this step.
   * Success marks split parents `alreadyInjected`; a rejection retains the
   * batch unchanged.
   */
  private async attemptInject(
    sessionId: string,
    errors: unknown[],
    attempted: Set<InjectBatch>,
    current: (id: string) => boolean,
  ): Promise<void> {
    const loose = this.ready.get(sessionId);
    if (loose !== undefined && loose.length > 0) {
      this.ready.delete(sessionId);
      this.list(this.batches, sessionId).push(this.buildInjectBatch(sessionId, loose));
    }
    const batches = this.batches.get(sessionId);
    if (batches === undefined) return;
    for (const batch of [...batches]) {
      if (!current(sessionId)) break;
      if (attempted.has(batch)) continue;
      attempted.add(batch);
      try {
        await this.deliverer.deliver(structuredClone(batch.intent));
      } catch (e) {
        if (!(e instanceof DeliveryFailure) || e.cause !== undefined)
          errors.push(e instanceof DeliveryFailure ? e.cause : e);
        if (e instanceof DeliveryFailure && e.kind !== 'deferred') batches.splice(batches.indexOf(batch), 1);
        continue;
      }
      for (const b of batch.buckets) {
        if (b.splitFrom !== undefined) {
          const n = [...b.details.values()].reduce((sum, d) => sum + d.count, 0);
          b.splitFrom.alreadyInjected = (b.splitFrom.alreadyInjected ?? 0) + n;
        }
      }
      batches.splice(batches.indexOf(batch), 1);
    }
    if (batches.length === 0) this.batches.delete(sessionId);
  }
  /** Builds the immutable inject intent: sorted changes, earliest `since`,
   * suppressed-group count, summed `alreadyInjected`, stable `deliveryId`. */
  private buildInjectBatch(sessionId: string, buckets: Bucket[], at?: number): InjectBatch {
    const alreadyInjected = buckets.reduce((n, b) => n + (b.alreadyInjected ?? 0), 0);
    const update: EnvUpdate = {
      since: Math.min(...buckets.map(bucketSince)),
      at: at ?? this.wallClock(),
      changes: buckets.flatMap((b) => bucketChanges(b)).sort(byChangeAtId),
      // suppressed counts GROUPS, not the wake-budget details inside them
      suppressed: buckets.filter((b) => [...b.details.values()].some((d) => d.reason === 'wake-budget')).length,
    };
    if (alreadyInjected > 0) update.alreadyInjected = alreadyInjected;
    return { buckets, intent: { kind: 'inject', sessionId, update, deliveryId: deliveryId(sessionId, buckets) } };
  }
  private list<T>(map: Map<string, T[]>, sessionId: string): T[] {
    let list = map.get(sessionId);
    if (!list) {
      list = [];
      map.set(sessionId, list);
    }
    return list;
  }
}
