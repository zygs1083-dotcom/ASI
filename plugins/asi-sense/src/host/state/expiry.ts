import { effectiveDisks, type SenseState, type Signal } from '@asi/sense-types';

const metricPaths: Record<string, string> = {
  '/self/body/cpu': 'cpu',
  '/self/body/memory': 'memory',
  '/self/body/battery': 'battery',
  '/self/body/network': 'network.rx',
  '/self/body/harnessProcess': 'rss',
  '/self/body/tokens': 'context',
};

export class FactExpiry {
  private deadlines = new Map<
    string,
    {
      stamp: string;
      at: number;
      receivedMono: number;
      observedMono: number;
      wall: number;
      fired: boolean;
      volumeAt?: number;
    }
  >();
  private observationTimes?: Record<string, { wall: number; mono: number }>;
  constructor(private readonly clock: { mono(): number; wall?(): number }) {}
  withObservationTimes<T>(times: Record<string, { wall: number; mono: number }>, work: () => T): T {
    const previous = this.observationTimes;
    this.observationTimes = times;
    try {
      return work();
    } finally {
      this.observationTimes = previous;
    }
  }
  factMeta(path: string) {
    const entry = this.deadlines.get(path);
    return entry && { observedMono: entry.observedMono, deadlineMono: entry.at };
  }
  observe(state: SenseState, signals: Signal[] = []): void {
    const seen = new Set<string>();
    const deadlines = new Map(this.deadlines);
    const mono = this.clock.mono();
    const touched = new Map<string, Signal>();
    for (const signal of signals) {
      const path =
        signal.kind === 'fact.updated' && typeof signal.data.path === 'string'
          ? `/${signal.data.path.replaceAll('.', '/')}`
          : signal.kind === 'app.activated'
            ? '/env/frontApp'
            : signal.kind === 'window.focused' || signal.kind === 'window.title-changed'
              ? '/env/focusedWindow'
              : signal.kind === 'file.changed'
                ? '/env/watchedPaths'
                : signal.kind === 'job.started' || signal.kind === 'job.exited'
                  ? '/env/activeJobs'
                  : signal.kind === 'agent.status'
                    ? '/self/activity'
                    : signal.kind === 'system.sleep' ||
                        signal.kind === 'system.wake' ||
                        signal.kind === 'screen.locked' ||
                        signal.kind === 'screen.unlocked'
                      ? '/env/system'
                      : '';
      if (path) touched.set(path, signal);
    }
    const visit = (value: unknown, path: string, reference?: number): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) {
          const mount = item && typeof item === 'object' && 'mount' in item ? String(item.mount) : String(index);
          visit(item, `${path}/${mount}`, reference);
        }
        return;
      }
      const entry = value as Record<string, unknown>;
      if (
        typeof entry.status === 'string' &&
        typeof entry.observedAt === 'number' &&
        typeof entry.ttlMs === 'number' &&
        Number.isFinite(entry.observedAt) &&
        Number.isFinite(entry.ttlMs)
      ) {
        seen.add(path);
        const stamp = JSON.stringify([entry.status, entry.observedAt, entry.ttlMs, entry.source]);
        const source = entry.source as { id?: string } | undefined;
        const signal = touched.get(path);
        const received =
          !!signal &&
          source?.id === signal?.source.id &&
          (entry.observedAt === signal?.at || path === '/env/watchedPaths');
        if (received || deadlines.get(path)?.stamp !== stamp) {
          const previous = deadlines.get(path);
          const prefix = '/self/body/disks/value/';
          const metric = path.startsWith(prefix) ? `disk:${path.slice(prefix.length)}` : metricPaths[path];
          const observation = metric && this.observationTimes?.[metric];
          const deadline = mono + Math.max(0, entry.observedAt + entry.ttlMs - (reference ?? entry.observedAt));
          const volumeAt = path.startsWith(prefix)
            ? Math.min(previous?.wall === entry.observedAt ? (previous.volumeAt ?? Infinity) : Infinity, deadline)
            : undefined;
          deadlines.set(path, {
            stamp,
            at: entry.status === 'ok' ? (volumeAt ?? deadline) : Infinity,
            receivedMono: mono,
            observedMono:
              observation && observation.wall === entry.observedAt
                ? observation.mono
                : previous?.wall === entry.observedAt
                  ? previous.observedMono
                  : mono - Math.max(0, (this.clock.wall?.() ?? entry.observedAt) - entry.observedAt),
            wall: entry.observedAt,
            fired: false,
            ...(volumeAt === undefined ? {} : { volumeAt }),
          });
        }
      }
      for (const [key, child] of Object.entries(entry)) {
        if (path === '/self/body/disks' && key === 'value') {
          visit(
            effectiveDisks(state.self.body.disks, Number.NEGATIVE_INFINITY).value,
            `${path}/${key}`,
            state.self.body.disks.observedAt,
          );
        } else visit(child, `${path}/${key}`);
      }
    };
    visit(state, '');
    for (const key of deadlines.keys()) if (!seen.has(key)) deadlines.delete(key);
    const disk = deadlines.get('/self/body/disks');
    if (disk) {
      const volumes = effectiveDisks(state.self.body.disks, Number.NEGATIVE_INFINITY).value ?? [];
      const fresh = volumes.flatMap((volume) => {
        const deadline = deadlines.get(`/self/body/disks/value/${volume.mount}`);
        return volume.status === 'ok' && deadline && deadline.at > mono ? [deadline.at] : [];
      });
      const status = state.self.body.disks.status;
      deadlines.set('/self/body/disks', {
        ...disk,
        at: status !== 'denied' && status !== 'unsupported' && fresh.length ? Math.max(...fresh) : Infinity,
      });
    }
    this.deadlines = deadlines;
  }
  snapshot(state: SenseState): SenseState {
    const mono = this.clock.mono();
    state.self.body.disks = effectiveDisks(state.self.body.disks, Number.NEGATIVE_INFINITY);
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
      const deadline = this.deadlines.get(path);
      if (path !== '/self/body/disks' && entry.status === 'ok' && deadline && deadline.at <= mono)
        entry.status = 'stale';
      for (const [key, child] of Object.entries(entry)) visit(child, `${path}/${key}`);
    };
    visit(state, '');
    state.self.body.disks = effectiveDisks(state.self.body.disks, Number.NEGATIVE_INFINITY);
    return state;
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
