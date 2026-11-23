import type { Body, BodyHistory, Fact, MetricKey, MetricPoint } from '@asi/sense-types';

const WINDOW = 300_000;
const thermal = { nominal: 0, fair: 1, serious: 2, critical: 3 } as const;

type Slot = { point: MetricPoint; mono: number; slot: number };
type Ring = { slots: Slot[]; start: number; size: number; capacity: number; interval: number; dirty: boolean };

/**
 * Bounded 5-minute short-term vitals trend ring (in-memory only, zero disk writes).
 */
export function createRingHistory(intervals: Partial<Record<MetricKey, number>> = {}) {
  let history: BodyHistory = {
    cpu: [],
    memory: [],
    battery: [],
    thermal: [],
    networkRx: [],
    networkTx: [],
    processCpu: [],
    processRss: [],
    tokens: [],
    disks: {},
    diskFree: {},
  };
  const rings = new Map<MetricKey, Ring>();

  function resolveInterval(key: MetricKey): number {
    const fallback =
      key.startsWith('disk:') || key.startsWith('diskFree:') ? 10_000 : key === 'battery' ? 30_000 : 2_000;
    const requested = intervals[key];
    return requested !== undefined && Number.isFinite(requested) && requested > 0
      ? Math.max(1_000, requested)
      : fallback;
  }

  function record(body: Body, now: number, mono = now): void {
    const add = (key: MetricKey, at: number, value: number | undefined) => {
      if (value === undefined || !Number.isFinite(value) || !Number.isFinite(at) || at < now - WINDOW) return;
      let ring = rings.get(key);
      if (!ring) {
        const interval = resolveInterval(key);
        ring = {
          slots: [],
          start: 0,
          size: 0,
          capacity: Math.min(300, Math.ceil(WINDOW / interval)),
          interval,
          dirty: false,
        };
        rings.set(key, ring);
      }
      const lastIndex = (ring.start + ring.size - 1 + ring.capacity) % ring.capacity;
      const last = ring.size ? ring.slots[lastIndex] : undefined;
      if (last && last.point.at === at && last.point.value === value) return;
      const observedMono = mono - (now - at);
      const slot = Math.floor(observedMono / ring.interval);
      const entry = { point: { at, value }, mono: observedMono, slot };
      if (last && last.slot === slot) ring.slots[lastIndex] = entry;
      else if (ring.size < ring.capacity) {
        ring.slots[(ring.start + ring.size) % ring.capacity] = entry;
        ring.size++;
      } else {
        ring.slots[ring.start] = entry;
        ring.start = (ring.start + 1) % ring.capacity;
      }
      ring.dirty = true;
    };

    const fact = <T>(value: Fact<T>, read: (v: T) => void) => {
      if (value.status === 'ok' && value.value !== null) read(value.value);
    };

    fact(body.cpu, (v) => add('cpu', body.cpu.observedAt, v.usage >= 0 && v.usage <= 1 ? v.usage : undefined));
    fact(body.memory, (v) =>
      add(
        'memory',
        body.memory.observedAt,
        v.total > 0 && v.used >= 0 && v.used <= v.total ? v.used / v.total : undefined,
      ),
    );
    fact(body.battery, (v) => {
      if (v) add('battery', body.battery.observedAt, v.percent >= 0 && v.percent <= 100 ? v.percent : undefined);
    });
    fact(body.thermal, (v) => add('thermal', body.thermal.observedAt, thermal[v]));
    fact(body.network, (v) => {
      add('networkRx', body.network.observedAt, v.rxBps >= 0 ? v.rxBps : undefined);
      add('networkTx', body.network.observedAt, v.txBps >= 0 ? v.txBps : undefined);
    });
    fact(body.harnessProcess, (v) => {
      add('processCpu', body.harnessProcess.observedAt, v.cpu >= 0 ? v.cpu : undefined);
      add('processRss', body.harnessProcess.observedAt, v.rss >= 0 ? v.rss : undefined);
    });
    fact(body.tokens, (v) =>
      add(
        'tokens',
        body.tokens.observedAt,
        v.contextUsed !== undefined && v.contextUsed >= 0 ? v.contextUsed : undefined,
      ),
    );
    for (const volume of body.disks.value ?? []) {
      if (
        (volume.status ?? body.disks.status) === 'ok' &&
        !body.disks.unavailableMounts?.includes(volume.mount) &&
        Number.isFinite(volume.total) &&
        volume.total > 0 &&
        volume.free >= 0 &&
        volume.free <= volume.total
      ) {
        const stamp = volume.observedAt ?? body.disks.observedAt;
        add(`disk:${volume.mount}`, stamp, (volume.total - volume.free) / volume.total);
        add(`diskFree:${volume.mount}`, stamp, volume.free);
      }
    }
  }

  function snapshot(mono: number): BodyHistory {
    const next: BodyHistory = { ...history };
    let changed = false;
    let disksChanged = false;
    let diskFreeChanged = false;
    for (const [key, ring] of rings) {
      while (ring.size && (ring.slots[ring.start]?.mono ?? Infinity) < mono - WINDOW) {
        ring.start = (ring.start + 1) % ring.capacity;
        ring.size--;
        ring.dirty = true;
      }
      if (!ring.dirty) continue;
      const points: MetricPoint[] = [];
      for (let i = 0; i < ring.size; i++) {
        const item = ring.slots[(ring.start + i) % ring.capacity];
        if (item) points.push(item.point);
      }
      ring.dirty = false;
      if (!ring.size) rings.delete(key);
      changed = true;
      if (key.startsWith('disk:')) {
        const mount = key.slice(5);
        if (!disksChanged) next.disks = { ...history.disks };
        disksChanged = true;
        if (points.length)
          Object.defineProperty(next.disks, mount, { value: points, enumerable: true, configurable: true });
        else delete next.disks[mount];
      } else if (key.startsWith('diskFree:')) {
        const mount = key.slice(9);
        if (!diskFreeChanged) next.diskFree = { ...(history.diskFree ?? {}) };
        diskFreeChanged = true;
        if (points.length && next.diskFree)
          Object.defineProperty(next.diskFree, mount, { value: points, enumerable: true, configurable: true });
        else if (next.diskFree) delete next.diskFree[mount];
      } else {
        next[key as keyof Omit<BodyHistory, 'disks' | 'diskFree'>] = points;
      }
    }
    if (changed) history = next;
    return structuredClone(history);
  }

  return { record, snapshot };
}
