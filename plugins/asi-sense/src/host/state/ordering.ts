import type { Signal } from '@asi/sense-types';
import { FACT_PATHS } from './facts.ts';
import { FACT_STATUSES } from './source-health.ts';

export class FactOrdering {
  private readonly sequences = new Map<string, number>();
  private readonly jobs = new Map<string, number>();
  /** Comparable order of each source's last non-unknown `env.activeJobs` replacement. */
  private readonly snapshots = new Map<string, number>();

  snapshot(signal: Signal): void {
    const sequence = signal.data.sequence;
    this.snapshots.delete(signal.source.id);
    if (typeof sequence === 'number' && Number.isSafeInteger(sequence)) this.snapshots.set(signal.source.id, sequence);
    if (this.snapshots.size > 5_000) this.snapshots.delete(this.snapshots.keys().next().value as string);
  }

  earlierSnapshot(signal: Signal): boolean {
    const sequence = signal.data.sequence;
    const previous = this.snapshots.get(signal.source.id);
    return (
      typeof sequence === 'number' && Number.isSafeInteger(sequence) && previous !== undefined && sequence < previous
    );
  }

  earlierJob(signal: Signal): boolean {
    const sequence = signal.data.sequence;
    const previous = this.jobs.get(this.jobKey(signal));
    return (
      typeof sequence === 'number' && Number.isSafeInteger(sequence) && previous !== undefined && sequence < previous
    );
  }

  recordJob(signal: Signal): void {
    const key = this.jobKey(signal);
    const sequence = signal.data.sequence;
    this.jobs.delete(key);
    if (typeof sequence === 'number' && Number.isSafeInteger(sequence)) this.jobs.set(key, sequence);
    if (this.jobs.size > 5_000) this.jobs.delete(this.jobs.keys().next().value as string);
  }

  forgetJob(id: string): void {
    for (const key of this.jobs.keys()) if (JSON.parse(key)[1] === id) this.jobs.delete(key);
  }

  private jobKey(signal: Signal): string {
    return JSON.stringify([signal.source.id, typeof signal.data.id === 'string' ? signal.data.id : signal.subject]);
  }

  earlier(signal: Signal): boolean {
    if (signal.kind === 'job.started' || signal.kind === 'job.exited') return false;
    if (signal.kind === 'fact.updated') {
      const { path, status, unavailableMounts } = signal.data;
      if (
        typeof path !== 'string' ||
        !FACT_PATHS.has(path) ||
        !Object.hasOwn(signal.data, 'value') ||
        (status !== undefined && (typeof status !== 'string' || !FACT_STATUSES.has(status))) ||
        (path === 'self.body.disks' &&
          unavailableMounts !== undefined &&
          (!Array.isArray(unavailableMounts) || !unavailableMounts.every((mount) => typeof mount === 'string')))
      )
        return false;
    }
    const path =
      signal.kind === 'source.status' || signal.kind === 'source.error'
        ? 'source.health'
        : signal.kind === 'fact.updated'
          ? signal.data.path
          : signal.kind === 'app.activated'
            ? 'env.frontApp'
            : signal.kind === 'window.focused' || signal.kind === 'window.title-changed'
              ? 'env.focusedWindow'
              : signal.kind === 'file.changed'
                ? `file:${typeof signal.data.path === 'string' ? signal.data.path : signal.subject}`
                : signal.kind === 'agent.status'
                  ? 'self.activity'
                  : signal.kind === 'system.sleep' || signal.kind === 'system.wake'
                    ? 'env.system.power'
                    : signal.kind === 'screen.locked' || signal.kind === 'screen.unlocked'
                      ? 'env.system.lock'
                      : [signal.kind, signal.subject];
    const key = JSON.stringify([signal.source.id, path]);
    const sequence = signal.data.sequence;
    const previous = this.sequences.get(key);
    if (typeof sequence === 'number' && Number.isSafeInteger(sequence)) {
      if (previous !== undefined && sequence < previous) return true;
      this.sequences.delete(key);
      this.sequences.set(key, sequence);
      if (this.sequences.size > 5_000) this.sequences.delete(this.sequences.keys().next().value as string);
    } else this.sequences.delete(key);
    return false;
  }
}
