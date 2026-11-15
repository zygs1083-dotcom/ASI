import type { Fact, FactStatus, JobSummary, SenseState, Signal } from '@asi/sense-types';
import { FACT_PATHS, factAt, initialState, num, recomputeStatuses, str, ttlOf } from './facts.ts';

const FACT_STATUSES: ReadonlySet<string> = new Set(['ok', 'stale', 'denied', 'unsupported', 'unavailable', 'unknown']);
const ACTIVITIES: ReadonlySet<string> = new Set(['idle', 'thinking', 'tool', 'waiting-user']);
type Activity = 'idle' | 'thinking' | 'tool' | 'waiting-user';

/**
 * In-memory fact table (DESIGN §2.2). Pure TypeScript; the host feeds it
 * signals and reads snapshots.
 *
 * Signal contract (`signal.data`):
 * - `app.activated` `{name, bundleId?}` → `env.frontApp`
 * - `window.focused`/`window.title-changed` `{title}` → `env.focusedWindow`
 * - `file.changed` `data.path` or `subject` → `env.watchedPaths[path]` cumulative
 * - `job.started` `{command?, pid?, startedAt?}` → adds to `env.activeJobs`;
 *   `job.exited` removes it
 * - `agent.status` `{activity}` → `self.activity`
 * - `fact.updated` `{path, value, status?, ttlMs?}` → trusted internal write to
 *   a whitelisted full fact path ({@link FACT_PATHS})
 * - `source.status` `{status, error?}` → `observation.sources[source.id]`
 *   (`'error'` normalizes to `unavailable`, same as `source.error`)
 *
 * Every signal updates `observation.sources[source.id]`. Repeated
 * `signal.id`s are deduplicated (bounded to the last 1024) so broadcast or
 * retry cannot inflate cumulative counts; subscribers are notified only for
 * new, unique input. Signals older than a fact's `observedAt` (or a path's
 * `lastChange`) are ignored for that fact, so out-of-order delivery cannot
 * regress state; the guard applies only once a fact has a real (non-`unknown`)
 * observation, so a delayed first sample is still accepted. `data.ttlMs`
 * (finite, >=0) overrides the default TTL per update.
 */
export class StateStore {
  private static readonly DEDUP_MAX = 1024;
  private readonly clock: () => number;
  private readonly defaultTtlMs: number;
  private readonly listeners = new Set<(snapshot: SenseState) => void>();
  private readonly state: SenseState;
  private readonly seenIds = new Set<string>();
  private readonly seenOrder: string[] = [];

  constructor(clock: () => number = Date.now, defaultTtlMs = 60_000) {
    this.clock = clock;
    this.defaultTtlMs = defaultTtlMs;
    this.state = initialState(this.clock(), defaultTtlMs);
  }

  /**
   * Feeds one signal into the fact table and notifies subscribers. The
   * signal is deep-cloned on entry, so later caller mutation cannot corrupt
   * stored facts.
   */
  apply(signal: Signal): void {
    if (this.isDuplicate(signal.id)) return;
    const s = structuredClone(signal);
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
        this.noteJob(s);
        break;
      case 'job.exited':
        this.setFact(
          this.state.env.activeJobs,
          (this.state.env.activeJobs.value ?? []).filter((j) => j.id !== this.jobId(s)),
          s,
        );
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
    this.emit();
  }

  /** Returns an isolated deep-cloned snapshot with TTL statuses computed at `now`. */
  snapshot(now: number = this.clock()): SenseState {
    const clone = structuredClone(this.state);
    recomputeStatuses(clone, now);
    return clone;
  }

  /** Subscribes to post-apply snapshots; returns an unsubscribe function. */
  subscribe(listener: (snapshot: SenseState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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

  /** Each listener gets its own snapshot so one cannot corrupt another. */
  private emit(): void {
    for (const listener of this.listeners) listener(this.snapshot());
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

  private noteJob(signal: Signal): void {
    const fact = this.state.env.activeJobs;
    if (fact.status !== 'unknown' && signal.at < fact.observedAt) return;
    const job: JobSummary = {
      id: this.jobId(signal),
      startedAt: num(signal.data.startedAt) ?? signal.at,
      status: 'running',
    };
    if (typeof signal.data.command === 'string') job.command = signal.data.command;
    const pid = num(signal.data.pid);
    if (pid !== undefined) job.pid = pid;
    this.setFact(fact, [...(fact.value ?? []).filter((j) => j.id !== job.id), job], signal);
  }

  private applyFactUpdate(signal: Signal): void {
    const { path, value, status } = signal.data;
    if (typeof path !== 'string' || !FACT_PATHS.has(path)) return;
    // An absent `value` must not clobber a known fact with undefined.
    if (!Object.hasOwn(signal.data, 'value')) return;
    if (status !== undefined && (typeof status !== 'string' || !FACT_STATUSES.has(status))) return;
    const fact = factAt(this.state, path);
    if (fact.status !== 'unknown' && signal.at < fact.observedAt) return;
    fact.value = value;
    fact.status = (status as FactStatus | undefined) ?? 'ok';
    fact.source = signal.source;
    fact.observedAt = signal.at;
    fact.ttlMs = ttlOf(signal.data.ttlMs, this.defaultTtlMs);
  }

  private updateSource(signal: Signal): void {
    const sources = this.state.observation.sources;
    const cur = Object.hasOwn(sources, signal.source.id) ? sources[signal.source.id] : undefined;
    if (cur && signal.at < cur.lastSignalAt) return;
    const next: { status: FactStatus; lastSignalAt: number; error?: string } = {
      status: 'ok',
      lastSignalAt: signal.at,
    };
    if (signal.kind === 'source.status') {
      const s = signal.data.status;
      // 'error' is not a FactStatus; it normalizes to 'unavailable'.
      next.status =
        s === 'error' ? 'unavailable' : typeof s === 'string' && FACT_STATUSES.has(s) ? (s as FactStatus) : 'unknown';
      if (typeof signal.data.error === 'string') next.error = signal.data.error;
    } else if (signal.kind === 'source.error') {
      next.status = 'unavailable';
      if (typeof signal.data.error === 'string') next.error = signal.data.error;
    }
    sources[signal.source.id] = next;
  }
}
