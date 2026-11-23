import type { Fact, JobSummary, Signal } from '@asi/sense-types';

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

export function mergeJobs(
  jobs: Map<string, JobTrack>,
  fact: Fact<unknown>,
  value: unknown,
  signal: Signal,
  monotonic: () => number,
): void {
  for (const [id, track] of jobs) {
    if (!track.exited && !earlierJob(jobOrder(signal), track.order)) jobs.delete(id);
  }
  if (Array.isArray(value)) {
    for (const j of value as JobSummary[]) {
      if (!j || typeof j !== 'object' || typeof j.id !== 'string') continue;
      const track = jobs.get(j.id);
      if (track && earlierJob(jobOrder(signal), track.order)) continue;
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
  if (Array.isArray(value) || running.length > 0) fact.value = running;
}
