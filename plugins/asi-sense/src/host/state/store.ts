import { performance } from 'node:perf_hooks';
import type { Fact, FactStatus, JobSummary, SenseState, Signal } from '@asi/sense-types';
import { FACT_PATHS, factAt, initialState, num, recomputeStatuses, str, ttlOf } from './facts.ts';
import { FACT_STATUSES, sourceObservation } from './source-health.ts';

const ACTIVITIES: ReadonlySet<string> = new Set(['idle', 'thinking', 'tool', 'waiting-user']);
type Activity = 'idle' | 'thinking' | 'tool' | 'waiting-user';

/** Per-job event tracking: jobs are independent even inside one aggregate fact. */
interface JobTrack {
  /** Latest accepted event time for this job; older/same-time input is ignored. */
  lastEventAt: number;
  /** True once `job.exited` landed — an exit tombstone that outlives the value entry. */
  exited: boolean;
  /** Store-clock receipt of the latest accepted event (tombstone retention). */
  receivedAt: number;
  job?: JobSummary;
}

/**
 * In-memory fact table (DESIGN §2.2); the host feeds it signals and reads
 * snapshots. `signal.data` contract: `app.activated`/`window.*` →
 * `env.frontApp`/`env.focusedWindow`, `file.changed` → cumulative
 * `env.watchedPaths[path]`, `job.*` → `env.activeJobs`, `agent.status` →
 * `self.activity`, `fact.updated` → trusted write to {@link FACT_PATHS},
 * `source.*` → `observation.sources`. Every signal also marks source health
 * via {@link sourceObservation}; ids dedup (last 1024); out-of-order input
 * is ignored per fact once observed; `data.ttlMs` overrides the TTL.
 *
 * Jobs track each id's latest event plus a {@link JOB_RETENTION_MS} exit
 * tombstone so out-of-order events cannot resurrect a job; `env.activeJobs`
 * rebuilds from tracking per accepted event while keeping the newest
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
  private readonly listeners = new Set<(snapshot: SenseState) => void>();
  private readonly state: SenseState;
  private readonly seenIds = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly jobs = new Map<string, JobTrack>();
  private readonly queue: { signal: Signal; afterApply?: () => void }[] = [];
  /** `signal.at` of the last accepted non-unknown `env.activeJobs` replacement. */
  private jobSnapshotAt = Number.NEGATIVE_INFINITY;
  /**
   * `signal.at` of the last accepted `env.activeJobs` report — EVERY accepted
   * one advances it, `unknown` included; orders reports only, never job events.
   */
  private jobsFactAt = Number.NEGATIVE_INFINITY;
  /**
   * Newest `signal.at` of an accepted job event or non-unknown report —
   * metadata ordering for {@link commitJobs} only; it never rejects input.
   */
  private jobObservedAt = Number.NEGATIVE_INFINITY;
  private processing = false;

  /**
   * `monotonicClock` (never `Date.now`) drives job-tombstone retention.
   */
  constructor(
    wallClock: () => number = Date.now,
    defaultTtlMs = 60_000,
    monotonicClock: () => number = () => performance.now(),
  ) {
    this.wallClock = wallClock;
    this.monotonic = monotonicClock;
    this.defaultTtlMs = defaultTtlMs;
    this.state = initialState(this.wallClock(), defaultTtlMs);
  }

  /**
   * Feeds one signal into the fact table and notifies subscribers. The
   * signal is deep-cloned on entry, so later caller mutation cannot corrupt
   * stored facts. A call made inside a subscriber only enqueues; the
   * outermost call drains the queue in order — each entry applies, emits
   * fixed snapshots, then runs `afterApply` (even on a duplicate); its
   * errors are collected and the first rethrown after the queue drains.
   */
  apply(signal: Signal, afterApply?: () => void): void {
    this.queue.push({ signal: structuredClone(signal), afterApply });
    if (this.processing) return;
    this.processing = true;
    const errors: unknown[] = [];
    try {
      let next = this.queue.shift();
      while (next !== undefined) {
        if (!this.isDuplicate(next.signal.id)) {
          this.applyOne(next.signal);
          this.emit();
        }
        if (next.afterApply !== undefined) {
          try {
            next.afterApply();
          } catch (e) {
            errors.push(e);
          }
        }
        next = this.queue.shift();
      }
    } finally {
      this.processing = false;
    }
    if (errors.length > 0) throw errors[0];
  }

  /** Returns an isolated deep-cloned snapshot with TTL statuses computed at `now`. */
  snapshot(now: number = this.wallClock()): SenseState {
    const clone = structuredClone(this.state);
    recomputeStatuses(clone, now);
    return clone;
  }

  /** Subscribes to post-apply snapshots; returns an unsubscribe function. */
  subscribe(listener: (snapshot: SenseState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private applyOne(s: Signal): void {
    this.updateSource(s);
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
        this.noteFile(s);
        break;
      case 'job.started':
        this.noteJobStart(s);
        break;
      case 'job.exited':
        this.noteJobExit(s);
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
    const snap = this.snapshot();
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
    if (fact.status !== 'unknown' && signal.at < fact.observedAt) return;
    fact.value = value;
    fact.status = 'ok';
    fact.source = signal.source;
    fact.observedAt = signal.at;
    fact.ttlMs = ttlOf(signal.data.ttlMs, this.defaultTtlMs);
  }

  private jobId(signal: Signal): string {
    return typeof signal.data.id === 'string' ? signal.data.id : signal.subject;
  }

  private noteFile(signal: Signal): void {
    const fact = this.state.env.watchedPaths;
    const path = typeof signal.data.path === 'string' ? signal.data.path : signal.subject;
    // Null-prototype map: '__proto__'/'constructor' paths write safely.
    const map: Record<string, { lastChange: number; changes: number }> = Object.assign(Object.create(null), fact.value);
    const entry = map[path];
    if (entry && signal.at < entry.lastChange) return;
    const c = num(signal.data.changes);
    map[path] = {
      lastChange: signal.at,
      changes: (entry?.changes ?? 0) + (c !== undefined && c > 0 ? Math.floor(c) : 1),
    };
    const observedAt = fact.status === 'unknown' ? signal.at : Math.max(fact.observedAt, signal.at);
    fact.value = map;
    fact.status = 'ok';
    fact.source = signal.source;
    fact.observedAt = observedAt;
    fact.ttlMs = ttlOf(signal.data.ttlMs, this.defaultTtlMs);
  }

  /** Drops exit tombstones past the retention window (monotonic clock). */
  private pruneJobs(): void {
    const now = this.monotonic();
    for (const [id, track] of this.jobs) {
      if (track.exited && now - track.receivedAt >= StateStore.JOB_RETENTION_MS) this.jobs.delete(id);
    }
  }

  /**
   * Rebuilds `env.activeJobs` from tracking after an accepted job event.
   * An older (but still accepted) event updates the value yet keeps the
   * newest observation's source/ttl/observedAt metadata — freshness is
   * judged against {@link jobObservedAt}, never reset by fact status.
   */
  private commitJobs(signal: Signal): void {
    const fact = this.state.env.activeJobs;
    const newest = signal.at >= this.jobObservedAt;
    fact.value = [...this.jobs.values()].flatMap((track) => (track.exited || !track.job ? [] : [track.job]));
    fact.status = 'ok';
    if (newest) {
      fact.source = signal.source;
      fact.observedAt = signal.at;
      fact.ttlMs = ttlOf(signal.data.ttlMs, this.defaultTtlMs);
      this.jobObservedAt = signal.at;
    }
  }

  private noteJobStart(signal: Signal): void {
    this.pruneJobs();
    const id = this.jobId(signal);
    const track = this.jobs.get(id);
    // Older input is ignored, and at an equal timestamp the exit tombstone
    // wins — only a genuinely newer start may reuse the id.
    if (track && signal.at <= track.lastEventAt) return;
    // pre-snapshot starts are ignored — the replacement answered for that time
    if (signal.at < this.jobSnapshotAt) return;
    const job: JobSummary = {
      id,
      startedAt: num(signal.data.startedAt) ?? signal.at,
      status: 'running',
    };
    if (typeof signal.data.command === 'string') job.command = signal.data.command;
    const pid = num(signal.data.pid);
    if (pid !== undefined) job.pid = pid;
    this.jobs.set(id, { lastEventAt: signal.at, exited: false, receivedAt: this.monotonic(), job });
    this.commitJobs(signal);
  }

  private noteJobExit(signal: Signal): void {
    this.pruneJobs();
    const id = this.jobId(signal);
    const track = this.jobs.get(id);
    // Exit wins equal timestamps over start; only an older exit is ignored.
    if (track && signal.at < track.lastEventAt) return;
    this.jobs.set(id, { lastEventAt: signal.at, exited: true, receivedAt: this.monotonic() });
    this.commitJobs(signal);
  }

  private applyFactUpdate(signal: Signal): void {
    const { path, value, status } = signal.data;
    if (typeof path !== 'string' || !FACT_PATHS.has(path)) return;
    // An absent `value` must not clobber a known fact with undefined.
    if (!Object.hasOwn(signal.data, 'value')) return;
    if (status !== undefined && (typeof status !== 'string' || !FACT_STATUSES.has(status))) return;
    const fact = factAt(this.state, path);
    if (path === 'env.activeJobs') {
      // A report older than the newest accepted one is dropped before ANY
      // mutation — fact, tracking, tombstones and the watermark untouched.
      if (signal.at < this.jobsFactAt) return;
      this.jobsFactAt = signal.at;
      // An unknown report marks ONLY the status — value, provenance,
      // freshness, jobs and tombstones are all preserved.
      if (status === 'unknown') {
        fact.status = 'unknown';
        return;
      }
    } else if (fact.status !== 'unknown' && signal.at < fact.observedAt) return;
    fact.value = value;
    fact.status = (status as FactStatus | undefined) ?? 'ok';
    fact.source = signal.source;
    fact.observedAt = signal.at;
    fact.ttlMs = ttlOf(signal.data.ttlMs, this.defaultTtlMs);
    if (path === 'env.activeJobs') {
      this.jobSnapshotAt = signal.at;
      this.jobObservedAt = Math.max(this.jobObservedAt, signal.at);
      // Merge per job id, newer event wins: a report clears running tracks
      // only at or below `at`, seeds listed jobs, rebuilds the value from
      // tracking; `null` survives only if no newer running job does.
      this.pruneJobs();
      for (const [id, track] of this.jobs) {
        if (!track.exited && track.lastEventAt <= signal.at) this.jobs.delete(id);
      }
      if (Array.isArray(value)) {
        for (const j of value as JobSummary[]) {
          if (!j || typeof j !== 'object' || typeof j.id !== 'string') continue;
          const track = this.jobs.get(j.id);
          if (track && track.lastEventAt > signal.at) continue; // a newer event wins
          const running = j.status !== 'exited';
          this.jobs.set(j.id, {
            lastEventAt: signal.at,
            exited: !running,
            receivedAt: this.monotonic(),
            ...(running ? { job: j } : {}),
          });
        }
      }
      const running = [...this.jobs.values()].flatMap((t) => (t.exited || !t.job ? [] : [t.job]));
      // the merged tracking is authoritative except a bare non-array report
      // (null) whose surviving newer running tracks keep it an array
      if (Array.isArray(value) || running.length > 0) fact.value = running;
    }
  }

  private updateSource(signal: Signal): void {
    const sources = this.state.observation.sources;
    const cur = Object.hasOwn(sources, signal.source.id) ? sources[signal.source.id] : undefined;
    if (cur && signal.at < cur.lastSignalAt) return;
    sources[signal.source.id] = sourceObservation(signal);
  }
}
