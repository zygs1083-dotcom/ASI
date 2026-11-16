import type { SenseState } from '@asi/sense-types';
import type { Clock } from './ports.ts';

export class FactExpiry {
  private readonly deadlines = new Map<string, { stamp: string; at: number; fired: boolean }>();
  constructor(private readonly clock: Clock) {}
  observe(state: SenseState): void {
    const seen = new Set<string>();
    const visit = (value: unknown, path: string): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) {
          const mount = item && typeof item === 'object' && 'mount' in item ? String(item.mount) : String(index);
          visit(item, `${path}/${mount}`);
        }
        return;
      }
      const entry = value as Record<string, unknown>;
      if (
        entry.status === 'ok' &&
        typeof entry.observedAt === 'number' &&
        typeof entry.ttlMs === 'number' &&
        Number.isFinite(entry.observedAt) &&
        Number.isFinite(entry.ttlMs)
      ) {
        seen.add(path);
        const stamp = JSON.stringify([entry.observedAt, entry.ttlMs, entry.source]);
        if (this.deadlines.get(path)?.stamp !== stamp) {
          this.deadlines.set(path, {
            stamp,
            at: this.clock.mono() + Math.max(0, entry.observedAt + entry.ttlMs - this.clock.wall()),
            fired: false,
          });
        }
      }
      for (const [key, child] of Object.entries(entry)) visit(child, `${path}/${key}`);
    };
    visit(state, '');
    for (const key of this.deadlines.keys()) if (!seen.has(key)) this.deadlines.delete(key);
  }
  next(): number | undefined {
    const values = [...this.deadlines.values()].filter((entry) => !entry.fired).map((entry) => entry.at);
    return values.length ? Math.min(...values) : undefined;
  }
  expire(): boolean {
    let changed = false;
    for (const entry of this.deadlines.values()) {
      if (!entry.fired && entry.at <= this.clock.mono()) {
        entry.fired = true;
        changed = true;
      }
    }
    return changed;
  }
}
