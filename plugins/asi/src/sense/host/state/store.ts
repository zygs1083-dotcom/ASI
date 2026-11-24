import { performance } from 'node:perf_hooks';
import type {
  Fact,
  FactStatus,
  JobSummary,
  SenseState,
  Signal,
  SourceObservation,
  SystemStateValue,
} from '@asi/sense-types';
import { FactExpiry } from './expiry.ts';
import { FACT_PATHS, factAt, initialState, num, recomputeStatuses, str, ttlOf } from './facts.ts';
import { type ApplyResult, SignalIntake } from './intake.ts';
import { FactOrdering } from './ordering.ts';
import { FACT_STATUSES, sourceObservation } from './source-health.ts';
import { type JobTrack, jobOrder, mergeJobs } from './updates.ts';

const ACTIVITIES: ReadonlySet<string> = new Set(['idle', 'thinking', 'tool', 'waiting-user']);
type Activity = 'idle' | 'thinking' | 'tool' | 'waiting-user';

/**
 * Pure sensory in-memory fact table. The host feeds it signals and reads
 * isolated snapshots.
 */
export class StateStore {
  private static readonly DEDUP_MAX = 1024;
  private static readonly JOB_RETENTION_MS = 600_000;
  private static readonly SYSTEM_MIN_TTL_MS = 86_400_000;
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
  private readonly ordering = new FactOrdering();
  private readonly intake = new SignalIntake(
    (signal) =>
      this.isDuplicate(signal.id)
        ? 'duplicate'
        : this.ordering.earlier(signal) || !this.applyOne(signal)
          ? 'older'
          : 'applied',
    (signals) => {
      this.expiry.observe(this.state, signals);
    },
    () => this.emit(),
  );

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

  apply(signal: Signal, afterApply?: (result: ApplyResult) => void, valid?: () => boolean): void {
    this.intake.apply(signal, afterApply, valid);
  }

  applyBatch(signals: readonly Signal[], afterAll?: (results: ApplyResult[]) => void, valid?: () => boolean): void {
    this.intake.applyBatch(signals, afterAll, valid);
  }

  sourceStatus(id: string): FactStatus | undefined {
    return this.state.observation.sources[id]?.status;
  }

  sourceObs(id: string): SourceObservation | undefined {
    return this.state.observation.sources[id];
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

  subscribe(listener: (snapshot: SenseState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private applyOne(s: Signal): boolean {
    const d = s.data;
    switch (s.kind) {
      case 'app.activated':
        this.setFact(
          this.state.env.frontApp,
          {
            name: str(d.name),
            bundleId: str(d.bundleId) || s.subject,
            ...(Number.isSafeInteger(d.pid) && (d.pid as number) > 0 ? { pid: d.pid as number } : {}),
            ...(Number.isSafeInteger(d.windowCount) && (d.windowCount as number) >= 0
              ? { windowCount: d.windowCount as number }
              : {}),
          },
          s,
        );
        break;
      case 'window.focused':
      case 'window.title-changed':
        this.setFact(this.state.env.focusedWindow, { title: str(d.title) }, s);
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
      case 'system.sleep':
      case 'system.wake':
      case 'screen.locked':
      case 'screen.unlocked':
        this.noteSystem(s);
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
    fact.value = value;
    fact.status = 'ok';
    fact.source = signal.source;
    fact.observedAt = signal.at;
    fact.ttlMs = ttlOf(signal.data.ttlMs, this.defaultTtlMs);
    delete fact.reason;
  }

  private noteSystem(signal: Signal): void {
    const fact = this.state.env.system;
    if (!fact) return;
    const prev: SystemStateValue = fact.value ? { ...fact.value } : { locked: false };
    const at = num(signal.data.at) ?? signal.at;
    if (signal.kind === 'system.sleep') prev.lastSleepAt = at;
    else if (signal.kind === 'system.wake') prev.lastWakeAt = at;
    else if (signal.kind === 'screen.locked') prev.locked = true;
    else if (signal.kind === 'screen.unlocked') prev.locked = false;
    fact.value = prev;
    fact.status = 'ok';
    fact.source = signal.source;
    fact.observedAt = signal.at;
    const explicitTtl = num(signal.data.ttlMs);
    fact.ttlMs =
      explicitTtl !== undefined && explicitTtl >= 0
        ? explicitTtl
        : Math.max(this.defaultTtlMs, StateStore.SYSTEM_MIN_TTL_MS);
    delete fact.reason;
  }

  private jobId(signal: Signal): string {
    return typeof signal.data.id === 'string' ? signal.data.id : signal.subject;
  }

  private pruneJobs(): void {
    const now = this.monotonic();
    for (const [id, track] of this.jobs) {
      if (track.exited && now - track.receivedAt >= StateStore.JOB_RETENTION_MS) {
        this.jobs.delete(id);
        this.ordering.forgetJob(id);
      }
    }
  }

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
    if (this.ordering.earlierJob(signal) || this.ordering.earlierSnapshot(signal)) return false;
    const job: JobSummary = {
      id,
      startedAt: num(signal.data.startedAt) ?? signal.at,
      status: 'running',
    };
    if (typeof signal.data.sessionId === 'string') job.owner = signal.data.sessionId;
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
    if (this.ordering.earlierJob(signal) || this.ordering.earlierSnapshot(signal)) return false;
    this.jobs.set(id, { order: jobOrder(signal), exited: true, receivedAt: this.monotonic() });
    this.ordering.recordJob(signal);
    this.commitJobs(signal);
    return true;
  }

  private applyFactUpdate(signal: Signal): void {
    const { path, value, status } = signal.data;
    if (typeof path !== 'string' || !FACT_PATHS.has(path)) return;
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
      if (status === 'unknown') {
        fact.status = 'unknown';
        if (typeof signal.data.reason === 'string') fact.reason = signal.data.reason;
        return;
      }
    }
    fact.value = value;
    fact.status = (status as FactStatus | undefined) ?? 'ok';
    fact.source = signal.source;
    fact.observedAt = signal.at;
    fact.ttlMs = ttlOf(signal.data.ttlMs, this.defaultTtlMs);
    if (typeof signal.data.reason === 'string') fact.reason = signal.data.reason;
    else delete fact.reason;
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
    sources[signal.source.id] = sourceObservation(signal, sources[signal.source.id]);
  }
}
