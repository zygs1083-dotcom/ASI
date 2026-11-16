import type { Signal } from '@asi/sense-types';
import { confirmBatch, type InjectBatch } from '../attention/drain-transfer.ts';
import type { AttentionPipeline } from '../attention/pipeline.ts';

type Entry = { signal?: Signal; count: number; other: boolean; batches: InjectBatch[] };
type Pending = { signal: Signal; count: number; other: boolean } | { batch: InjectBatch };

export function withoutTitles(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTitles);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'title')
      .map(([key, child]) => [key, withoutTitles(child)]),
  );
}

export class PendingContext {
  private readonly subjects = new Map<string, Map<string, Entry>>();
  private evicted = 0;
  private readonly confirmed = new Set<string>();
  private transfers = Promise.resolve();

  committed(id: string, pipeline: AttentionPipeline): void {
    const key = id.replace(/^asi-sense:/, '');
    this.confirmed.add(key);
    if (this.confirmed.size > 1024) this.confirmed.delete(this.confirmed.values().next().value as string);
    this.confirm(key);
    void pipeline.confirm(key);
  }

  suspend(id: string, pipeline: AttentionPipeline): void {
    this.transfers = this.transfers.then(async () => {
      for (const batch of await pipeline.suspend(id)) {
        const confirmed = [batch.intent.deliveryId, ...(batch.aliases ?? [])].find(
          (key) => key && this.confirmed.has(key),
        );
        if (confirmed) confirmBatch(new Map([['', [batch]]]), confirmed);
        else this.addBatch(batch);
      }
    });
  }

  settled(): Promise<void> {
    return this.transfers;
  }

  add(signal: Signal): number | undefined {
    let kinds = this.subjects.get(signal.subject);
    let evicted: number | undefined;
    if (!kinds) {
      if (this.subjects.size >= 200) {
        this.subjects.delete(this.subjects.keys().next().value as string);
        evicted = ++this.evicted;
      }
      kinds = new Map();
      this.subjects.set(signal.subject, kinds);
    }
    const other = !kinds.has(signal.kind) && kinds.size >= 15;
    const key = other ? '\0other' : signal.kind;
    const previous = kinds.get(key);
    kinds.set(key, { signal, count: (previous?.count ?? 0) + 1, other, batches: previous?.batches ?? [] });
    return evicted;
  }

  addBatch(batch: InjectBatch): void {
    for (const bucket of batch.buckets) {
      let kinds = this.subjects.get(bucket.subject);
      if (!kinds) {
        if (this.subjects.size >= 200) {
          this.subjects.delete(this.subjects.keys().next().value as string);
          this.evicted++;
        }
        kinds = new Map();
        this.subjects.set(bucket.subject, kinds);
      }
      const details = new Map<string, typeof bucket.details>();
      const names = new Set(kinds.keys());
      for (const [key, detail] of bucket.details) {
        const name = names.has(detail.kind) || names.size < 15 ? detail.kind : '\0other';
        names.add(name);
        const group = details.get(name) ?? new Map();
        group.set(key, detail);
        details.set(name, group);
      }
      for (const [kind, group] of details) {
        const entry = kinds.get(kind) ?? { count: 0, other: kind === '\0other', batches: [] };
        entry.batches.push({ ...batch, buckets: [{ ...bucket, details: group }] });
        kinds.set(kind, entry);
      }
    }
  }

  confirm(id: string): void {
    for (const [subject, kinds] of this.subjects) {
      for (const [key, entry] of kinds) {
        confirmBatch(new Map([['', entry.batches]]), id);
        if (!entry.signal && !entry.batches.length) kinds.delete(key);
      }
      if (!kinds.size) this.subjects.delete(subject);
    }
  }

  take(): Pending | undefined {
    const first = this.subjects.entries().next().value;
    if (!first) return undefined;
    const [subject, kinds] = first;
    const [kind, entry] = kinds.entries().next().value as [string, Entry];
    const batch = entry.batches.shift();
    const pending = batch ? { batch } : { signal: entry.signal as Signal, count: entry.count, other: entry.other };
    if (!batch || (!entry.batches.length && !entry.signal)) kinds.delete(kind);
    if (!kinds.size) this.subjects.delete(subject);
    return pending;
  }
}
