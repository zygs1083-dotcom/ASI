import type { Fact, JobSummary, SenseState, Signal } from '@asi/sense-types';
import { num, ttlOf } from './facts.ts';

const pathCounts = new WeakMap<object, number>();

/** Per-job event tracking: jobs are independent even inside one aggregate fact. */
export interface JobTrack {
  /** Latest accepted event time for this job; older/same-time input is ignored. */
  lastEventAt: number;
  /** True once `job.exited` landed — an exit tombstone that outlives the value entry. */
  exited: boolean;
  /** Store-clock receipt of the latest accepted event (tombstone retention). */
  receivedAt: number;
  job?: JobSummary;
}

export function noteFile(state: SenseState, signal: Signal, defaultTtlMs: number): void {
  const fact = state.env.watchedPaths;
  const path = typeof signal.data.path === 'string' ? signal.data.path : signal.subject;
  // Null-prototype map: '__proto__'/'constructor' paths write safely.
  const map: Record<string, { lastChange: number; changes: number }> =
    fact.value && Object.getPrototypeOf(fact.value) === null
      ? fact.value
      : Object.assign(Object.create(null), fact.value);
  const entry = map[path];
  if (entry && signal.at < entry.lastChange) return;
  if (entry) delete map[path];
  let count = pathCounts.get(map) ?? Object.keys(map).length;
  if (!entry) count++;
  while (count > 5000) {
    delete map[Object.keys(map)[0] as string];
    count--;
  }
  pathCounts.set(map, count);
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
  fact.ttlMs = ttlOf(signal.data.ttlMs, defaultTtlMs);
}

export function mergeJobs(
  jobs: Map<string, JobTrack>,
  fact: Fact<unknown>,
  value: unknown,
  at: number,
  monotonic: () => number,
): void {
  // Merge per job id, newer event wins: a report clears running tracks
  // only at or below `at`, seeds listed jobs, rebuilds the value from
  // tracking; `null` survives only if no newer running job does.
  for (const [id, track] of jobs) {
    if (!track.exited && track.lastEventAt <= at) jobs.delete(id);
  }
  if (Array.isArray(value)) {
    for (const j of value as JobSummary[]) {
      if (!j || typeof j !== 'object' || typeof j.id !== 'string') continue;
      const track = jobs.get(j.id);
      if (track && track.lastEventAt > at) continue; // a newer event wins
      const running = j.status !== 'exited';
      jobs.set(j.id, {
        lastEventAt: at,
        exited: !running,
        receivedAt: monotonic(),
        ...(running ? { job: j } : {}),
      });
    }
  }
  const running = [...jobs.values()].flatMap((t) => (t.exited || !t.job ? [] : [t.job]));
  // the merged tracking is authoritative except a bare non-array report
  // (null) whose surviving newer running tracks keep it an array
  if (Array.isArray(value) || running.length > 0) fact.value = running;
}
