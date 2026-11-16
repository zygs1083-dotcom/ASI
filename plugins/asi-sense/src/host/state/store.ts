import { performance } from 'node:perf_hooks';
import type { Fact, FactStatus, JobSummary, SenseState, Signal } from '@asi/sense-types';
import { FactExpiry } from './expiry.ts';
import { FACT_PATHS, factAt, initialState, num, recomputeStatuses, str, ttlOf } from './facts.ts';
import { type ApplyResult, SignalIntake } from './intake.ts';
import { FactOrdering } from './ordering.ts';
import { FACT_STATUSES, sourceObservation } from './source-health.ts';
import { type JobTrack, jobOrder, mergeJobs, noteFile } from './updates.ts';

const ACTIVITIES: ReadonlySet<string> = new Set(['idle', 'thinking', 'tool', 'waiting-user']);
type Activity = 'idle' | 'thinking' | 'tool' | 'waiting-user';

/**
 * In-memory fact table (DESIGN §2.2); the host feeds it signals and reads
 * snapshots. `signal.data` contract: `app.activated`/`window.*` →
 * `env.frontApp`/`env.focusedWindow`, `file.changed` → cumulative
 * `env.watchedPaths[path]`, `job.*` → `env.activeJobs`, `agent.status` →
 * `self.activity`, `fact.updated` → trusted write to {@link FACT_PATHS},
 * `source.*` → `observation.sources`. Every signal also marks source health
 * via {@link sourceObservation}; ids dedup (last 1024); input is ordered
 * by receipt unless it carries a comparable `data.sequence`; `data.ttlMs` overrides the TTL.
 *
 * Jobs track each id's latest event plus a {@link JOB_RETENTION_MS} exit
 * tombstone so explicitly older sequenced events cannot resurrect a job; `env.activeJobs`
 * rebuilds from tracking per accepted event while keeping that
 * event's source/ttl/observedAt. `apply` deep-clones input, queues
 * reentrant calls, and emits one fixed snapshot cloned per listener —
 * listener exceptions are isolated and cannot starve the queue.
 */
export class StateStore {
  private static readonly DEDUP_MAX = 1024;
  private static readonly JOB_RETENTION_MS = 600_000;
  private readonly wallClock: () => number;
  private readonly monotonic: () => number;
  private readonly defaultTtlMs: number;
  private readonly expiry: FactExpiry;
  private readonly listeners = new Set<(snapshot: SenseState) => void>();
  private readonly state: SenseState;
  private batchState?: { raw: SenseState; projected: SenseState };
  private readonly seenIds = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly jobs = new Map<string, JobTrack>();
  /**
   * Comparable sequence watermarks for fact reports, including unknown
   * reports; sources without sequences are ordered by receipt.
   */
  private readonly ordering = new FactOrdering();
  /**
   * Serialized signal intake preserves receipt order during reentrant
   * subscriber and callback activity.
   */
  private readonly intake = new SignalIntake(
    (signal) =>
      this.isDuplicate(signal.id)
        ? 'duplicate'
        : this.ordering.earlier(signal) || !this.applyOne(signal)
          ? 'older'
          : 'applied',
    (signals) => this.expiry.observe(this.state, signals),
    () => this.emit(),
  );
  /**
   * `monotonicClock` (never `Date.now`) drives job-tombstone retention.
   */
  constructor(
    wallClock: () => number = Date.now,
    defaultTtlMs = 60_000,
    monotonicClock: () => number = () => performance.now(),
    expiry?: FactExpiry,
  ) {
    this.wallClock = wallClock;
    this.monotonic = monotonicClock;
    this.defaultTtlMs = defaultTtlMs;
    this.state = initialState(this.wallClock(), defaultTtlMs);
    this.expiry = expiry ?? new FactExpiry({ mono: monotonicClock });
    this.expiry.observe(this.state);
  }
  /**
   * Feeds one signal into the fact table and notifies subscribers. The
   * signal is deep-cloned on entry, so later caller mutation cannot corrupt
   * stored facts. A call made inside a subscriber only enqueues; the
   * outermost call drains the queue in order — each entry applies, emits
   * fixed snapshots, then runs `afterApply` (even on a duplicate); its
   * errors are collected and the first rethrown after the queue drains.
   */
  apply(signal: Signal, afterApply?: (result: ApplyResult) => void): void {
    this.intake.apply(signal, afterApply);
  }
  batch<T>(work: () => T, publish: () => void = () => {}): T {
    if (this.batchState) return work();
    this.batchState = { raw: structuredClone(this.state), projected: this.snapshot() };
    return this.intake.batch(work, () => {
      this.batchState = undefined;
      publish();
    });
  }
  /** Returns an isolated deep-cloned snapshot with TTL statuses computed at `now`. */
  snapshot(now?: number): SenseState {
    if (this.batchState) {
      const clone = structuredClone(now === undefined ? this.batchState.projected : this.batchState.raw);
      if (now !== undefined) recomputeStatuses(clone, now);
      return clone;
    }
    const clone = structuredClone(this.state);
    if (now === undefined) return this.expiry.snapshot(clone);
    recomputeStatuses(clone, now ?? this.wallClock());
    return clone;
  }
  /** Subscribes to post-apply snapshots; returns an unsubscribe function. */
  subscribe(listener: (snapshot: SenseState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private applyOne(s: Signal): boolean {
    const d = s.data;
    switch (s.kind) {
      case 'app.activated':
        this.setFact(this.state.env.frontApp, { name: str(d.name), bundleId: str(d.bundleId) || s.subject }, s);
        break;
      case 'window.focused':
      case 'window.title-changed':
        this.setFact(this.state.env.focusedWindow, { title: str(d.title) }, s);
        break;
      case 'file.changed':
        noteFile(this.state, s, this.defaultTtlMs);
        break;
      case 'job.started':
        if (!this.noteJobStart(s)) return false;
        break;
      case 'job.exited':
        if (!this.noteJobExit(s)) return false;
        break;
      case 'agent.status':
        if (typeof d.activity === 'string' && ACTIVITIES.has(d.activity)) {
          this.setFact(this.state.self.activity, d.activity as Activity, s);
        }
        break;
      case 'fact.updated':
        this.applyFactUpdate(s);
        break;
      default:
        break;
    }
    this.updateSource(s);
    return true;
  }
  private isDuplicate(id: string): boolean {
    if (this.seenIds.has(id)) return true;
    this.seenIds.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > StateStore.DEDUP_MAX) {
      this.seenIds.delete(this.seenOrder.shift() as string);
    }
    return false;
  }
  /**
   * One fixed snapshot per applied signal, cloned per listener so nobody can
   * corrupt another listener or the store. The listener set is iterated as
   * a copy: unsubscribing mid-emit is honored before invocation, listeners
   * added mid-emit fire on the next apply only, and a throwing listener is
   * isolated so it cannot starve the rest of the set or the queue.
   */
  private emit(): void {
    const snap = this.expiry.snapshot(structuredClone(this.state));
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue;
      try {
        listener(structuredClone(snap));
      } catch {
        // listener exceptions are isolated by contract
      }
    }
  }

  private setFact<T>(fact: Fact<T>, value: T, signal: Signal): void {
    // Only a real (non-unknown) observation sets a freshness baseline: a
    // delayed first sample with at < constructor clock is still accepted.
    fact.value = value;
    fact.status = 'ok';
    fact.source = signal.source;
    fact.observedAt = signal.at;
    fact.ttlMs = ttlOf(signal.data.ttlMs, this.defaultTtlMs);
  }

  private jobId(signal: Signal): string {
    return typeof signal.data.id === 'string' ? signal.data.id : signal.subject;
  }

  /** Drops exit tombstones past the retention window (monotonic clock). */
  private pruneJobs(): void {
    const now = this.monotonic();
    for (const [id, track] of this.jobs) {
      if (track.exited && now - track.receivedAt >= StateStore.JOB_RETENTION_MS) {
        this.jobs.delete(id);
        this.ordering.forgetJob(id);
      }
    }
  }

  /**
   * Rebuilds `env.activeJobs` from tracking after an accepted job event.
   * Each accepted event supplies the observation's source/ttl/observedAt;
   * its wall timestamp does not order the observations.
   */
  private commitJobs(signal: Signal): void {
    const fact = this.state.env.activeJobs;
    fact.value = [...this.jobs.values()].flatMap((track) => (track.exited || !track.job ? [] : [track.job]));
    fact.status = 'ok';
    fact.source = signal.source;
    fact.observedAt = signal.at;
    fact.ttlMs = ttlOf(signal.data.ttlMs, this.defaultTtlMs);
  }

  private noteJobStart(signal: Signal): boolean {
    this.pruneJobs();
    const id = this.jobId(signal);
    // Explicitly earlier comparable input is ignored; without a sequence
    // a later-received start may reuse the id.
    if (this.ordering.earlierJob(signal)) return false;
    // Explicitly pre-snapshot starts are ignored when their sequences are comparable.
    if (this.ordering.earlierSnapshot(signal)) return false;
    const job: JobSummary = {
      id,
      startedAt: num(signal.data.startedAt) ?? signal.at,
      status: 'running',
    };
    if (typeof signal.data.command === 'string') job.command = signal.data.command;
    const pid = num(signal.data.pid);
    if (pid !== undefined) job.pid = pid;
    this.jobs.set(id, {
      order: jobOrder(signal),
      exited: false,
      receivedAt: this.monotonic(),
      job,
    });
    this.ordering.recordJob(signal);
    this.commitJobs(signal);
    return true;
  }

  private noteJobExit(signal: Signal): boolean {
    this.pruneJobs();
    const id = this.jobId(signal);
    // Only an explicitly earlier comparable exit is ignored.
    if (this.ordering.earlierJob(signal) || this.ordering.earlierSnapshot(signal)) return false;
    this.jobs.set(id, { order: jobOrder(signal), exited: true, receivedAt: this.monotonic() });
    this.ordering.recordJob(signal);
    this.commitJobs(signal);
    return true;
  }

  private applyFactUpdate(signal: Signal): void {
    const { path, value, status } = signal.data;
    if (typeof path !== 'string' || !FACT_PATHS.has(path)) return;
    // An absent `value` must not clobber a known fact with undefined.
    if (!Object.hasOwn(signal.data, 'value')) return;
    if (status !== undefined && (typeof status !== 'string' || !FACT_STATUSES.has(status))) return;
    const unavailable = signal.data.unavailableMounts;
    if (
      path === 'self.body.disks' &&
      unavailable !== undefined &&
      (!Array.isArray(unavailable) || !unavailable.every((mount) => typeof mount === 'string'))
    )
      return;
    const fact = factAt(this.state, path);
    if (path === 'env.activeJobs') {
      // Explicitly earlier comparable reports are dropped before ANY
      // mutation by FactOrdering — fact, tracking and tombstones stay untouched.
      // An unknown report marks ONLY the status — value, provenance,
      // freshness, jobs and tombstones are all preserved.
      if (status === 'unknown') {
        fact.status = 'unknown';
        return;
      }
    }
    fact.value = value;
    fact.status = (status as FactStatus | undefined) ?? 'ok';
    fact.source = signal.source;
    fact.observedAt = signal.at;
    fact.ttlMs = ttlOf(signal.data.ttlMs, this.defaultTtlMs);
    if (path === 'self.body.disks') {
      if (unavailable === undefined) delete this.state.self.body.disks.unavailableMounts;
      else this.state.self.body.disks.unavailableMounts = unavailable as string[];
    }
    if (path === 'env.activeJobs') {
      this.ordering.snapshot(signal);
      this.pruneJobs();
      mergeJobs(this.jobs, fact, value, signal, this.monotonic);
    }
  }

  private updateSource(signal: Signal): void {
    if (signal.data.preserveSourceStatus === true) return;
    const sources = this.state.observation.sources;
    sources[signal.source.id] = sourceObservation(signal);
  }
}
