import type { Fact, JobSummary, SenseState, Signal } from '@asi/sense-types';
import { num, ttlOf } from './facts.ts';

const pathCounts = new WeakMap<object, number>();
export type JobOrder = { source: string; sequence: number };
export function jobOrder(signal: Signal): JobOrder | undefined {
  const sequence = signal.data.sequence;
  return typeof sequence === 'number' && Number.isSafeInteger(sequence)
    ? { source: signal.source.id, sequence }
    : undefined;
}
export function earlierJob(a: JobOrder | undefined, b: JobOrder | undefined): boolean {
  return a !== undefined && b !== undefined && a.source === b.source && a.sequence < b.sequence;
}

/** Per-job event tracking: jobs are independent even inside one aggregate fact. */
export interface JobTrack {
  /** Comparable sequence of the latest accepted observation, when available. */
  order?: JobOrder;
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
  let count = pathCounts.get(map) ?? Object.keys(map).length;
  const c = num(signal.data.changes);
  const configured = Array.isArray(signal.data.watchedPaths)
    ? signal.data.watchedPaths.filter((item): item is string => typeof item === 'string')
    : [];
  for (const key of new Set([path, ...configured])) {
    const entry = map[key];
    if (entry) delete map[key];
    else count++;
    map[key] = {
      lastChange: signal.at,
      changes: (entry?.changes ?? 0) + (c !== undefined && c > 0 ? Math.floor(c) : 1),
    };
  }
  while (count > 5000) {
    delete map[Object.keys(map)[0] as string];
    count--;
  }
  pathCounts.set(map, count);
  fact.value = map;
  fact.status = 'ok';
  fact.source = signal.source;
  fact.observedAt = signal.at;
  fact.ttlMs = ttlOf(signal.data.ttlMs, defaultTtlMs);
}

export function mergeJobs(
  jobs: Map<string, JobTrack>,
  fact: Fact<unknown>,
  value: unknown,
  signal: Signal,
  monotonic: () => number,
): void {
  // Merge per job id: a report clears running tracks unless their comparable
  // sequence is newer, seeds listed jobs, and rebuilds the value from
  // tracking; `null` survives only if no newer running job does.
  for (const [id, track] of jobs) {
    if (!track.exited && !earlierJob(jobOrder(signal), track.order)) jobs.delete(id);
  }
  if (Array.isArray(value)) {
    for (const j of value as JobSummary[]) {
      if (!j || typeof j !== 'object' || typeof j.id !== 'string') continue;
      const track = jobs.get(j.id);
      if (track && earlierJob(jobOrder(signal), track.order)) continue; // a newer event wins
      const running = j.status !== 'exited';
      jobs.set(j.id, {
        order: jobOrder(signal),
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
