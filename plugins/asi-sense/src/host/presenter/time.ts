import type { Clock } from '../runtime/index.ts';
import type { Runtime } from './project.ts';

export function createTimeline(runtime: Runtime, clock: Clock) {
  const wall = clock.wall();
  const origin = clock.mono();
  const at = (mono: number) => wall + mono - origin;
  const fromWall = (value: number) => at(clock.mono() + value - clock.wall());
  const cached = new Map<string, { wall: number; at: number }>();
  const stable = (key: string, value: number) => {
    const prior = cached.get(key);
    if (prior?.wall === value) return prior.at;
    const converted = fromWall(value);
    cached.set(key, { wall: value, at: converted });
    if (cached.size > 4096) cached.delete(cached.keys().next().value as string);
    return converted;
  };
  const state = () => {
    const result = runtime.state();
    const visit = (value: unknown, path: string) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) {
          const mount = item && typeof item === 'object' && 'mount' in item ? String(item.mount) : String(index);
          visit(item, `${path}/${mount}`);
        }
        return;
      }
      const entry = value as Record<string, unknown>;
      for (const key of ['lastSignalAt', 'lastChange', 'startedAt', 'retryAt']) {
        if (typeof entry[key] === 'number') entry[key] = stable(`${path}/${key}`, entry[key]);
      }
      if (typeof entry.observedAt === 'number') {
        const meta = runtime.factMeta(path);
        entry.observedAt = meta ? at(meta.observedMono) : stable(path, entry.observedAt);
        if (entry.status === 'ok' && meta && Number.isFinite(meta.deadlineMono))
          entry.staleInMs = Math.max(0, meta.deadlineMono - clock.mono());
      }
      for (const [key, child] of Object.entries(entry)) visit(child, `${path}/${key}`);
    };
    visit(result, '');
    const disks = result.self.body.disks;
    const fresh = (disks.value ?? []).filter((disk) => disk.status === 'ok');
    if (fresh.length) {
      disks.observedAt = Math.min(...fresh.map((disk) => disk.observedAt ?? disks.observedAt));
      const deadlines = fresh.map((disk) => (disk as { staleInMs?: number }).staleInMs).filter(Number.isFinite);
      if (disks.status === 'ok' && deadlines.length === fresh.length)
        (disks as { staleInMs?: number }).staleInMs = Math.max(...(deadlines as number[]));
      else delete (disks as { staleInMs?: number }).staleInMs;
    }
    return result;
  };
  return { at, fromWall, stable, state };
}
