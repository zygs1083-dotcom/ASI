import type { DeliveryLevel, Signal } from '@asi/sense-types';
import { confirmBatch, type InjectBatch, type InjectOutcome, injectOutcomes } from '../attention/drain-transfer.ts';
import type { AttentionPipeline, DeliveryIntent } from '../attention/pipeline.ts';

type Entry = { signal?: Signal; ids?: string[]; count: number; other: boolean; batches: InjectBatch[] };
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
  private readonly reported = new Set<string>();
  private readonly staged = new Map<string, InjectOutcome[]>();
  private readonly merged = new Map<string, string[]>();
  private readonly recentIds: { id: string; ids: string[] }[] = [];
  private transfers = Promise.resolve();

  constructor(
    private readonly mark: (id: string, reason?: string, level?: DeliveryLevel) => void,
    private readonly retained: (id: string) => boolean = () => true,
  ) {}

  stage(intent: DeliveryIntent): void {
    if (!intent.deliveryId) return;
    const key = JSON.stringify([intent.sessionId, intent.deliveryId]);
    const outcomes = injectOutcomes(intent).map((outcome) => ({
      ...outcome,
      ids: outcome.ids
        .flatMap((id) => this.merged.get(id) ?? [id])
        .filter((id) => this.retained(id) && !this.reported.has(id)),
    }));
    if (outcomes.some((outcome) => outcome.ids.length)) this.staged.set(key, outcomes);
  }

  forget(id: string | undefined): void {
    if (id === undefined) return;
    this.reported.delete(id);
    for (const [key, ids] of this.merged) {
      const index = ids.indexOf(id);
      if (index >= 0) ids.splice(index, 1);
      if (!ids.length) this.merged.delete(key);
    }
    for (const [key, outcomes] of this.staged) {
      for (const outcome of outcomes) outcome.ids = outcome.ids.filter((item) => item !== id);
      if (outcomes.every((outcome) => !outcome.ids.length)) this.staged.delete(key);
    }
  }

  committed(session: string, id: string, pipeline: AttentionPipeline): void {
    const key = id.replace(/^asi-sense:/, '');
    const stagedKey = JSON.stringify([session, key]);
    const outcomes = this.staged.get(stagedKey) ?? [];
    this.staged.delete(stagedKey);
    for (const outcome of outcomes) {
      for (const signalId of outcome.ids) {
        if (this.reported.has(signalId)) continue;
        this.forget(signalId);
        if (!this.retained(signalId)) continue;
        this.reported.add(signalId);
        this.mark(signalId, outcome.reason, outcome.level);
      }
    }
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
    const ids = previous?.ids ?? [];
    ids.push(signal.id);
    this.recentIds.push({ id: signal.id, ids });
    if (this.recentIds.length > 200) {
      const oldest = this.recentIds.shift();
      if (oldest) oldest.ids.splice(oldest.ids.indexOf(oldest.id), 1);
    }
    kinds.set(key, {
      signal,
      ids,
      count: (previous?.count ?? 0) + 1,
      other,
      batches: previous?.batches ?? [],
    });
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
    if (!batch && entry.signal && entry.ids) {
      const ids = entry.ids.filter(this.retained);
      if (ids.length) this.merged.set(entry.signal.id, ids);
    }
    if (batch) {
      const bucket = batch.buckets[0];
      for (const [key, other] of kinds) {
        const index = other.batches.findIndex(
          (candidate) =>
            candidate.intent.deliveryId === batch.intent.deliveryId && candidate.buckets[0]?.id === bucket?.id,
        );
        if (index < 0) continue;
        const [part] = other.batches.splice(index, 1);
        if (bucket && part?.buckets[0]) {
          for (const [detailKey, detail] of part.buckets[0].details) bucket.details.set(detailKey, detail);
        }
        if (key !== kind && !other.batches.length && !other.signal) kinds.delete(key);
      }
    }
    const pending = batch ? { batch } : { signal: entry.signal as Signal, count: entry.count, other: entry.other };
    if (!batch || (!entry.batches.length && !entry.signal)) kinds.delete(kind);
    if (!kinds.size) this.subjects.delete(subject);
    return pending;
  }
}
