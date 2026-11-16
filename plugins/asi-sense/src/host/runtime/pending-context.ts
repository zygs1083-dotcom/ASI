import type { Signal } from '@asi/sense-types';

type Entry = { signal: Signal; count: number; other: boolean };

export class PendingContext {
  private readonly subjects = new Map<string, Map<string, Entry>>();
  private evicted = 0;

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
    kinds.set(key, { signal, count: (previous?.count ?? 0) + 1, other });
    return evicted;
  }

  take(): Entry | undefined {
    const first = this.subjects.entries().next().value;
    if (!first) return undefined;
    const [subject, kinds] = first;
    const [kind, entry] = kinds.entries().next().value as [string, Entry];
    kinds.delete(kind);
    if (!kinds.size) this.subjects.delete(subject);
    return entry;
  }
}
