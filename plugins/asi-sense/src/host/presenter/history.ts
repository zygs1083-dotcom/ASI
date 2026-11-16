import { type Body, diskVolumeAt, type Fact, factStatusAt } from '@asi/sense-types';
import type { BodyHistory, MetricKey, MetricPoint } from '@asi/sense-ui/model';

const WINDOW = 300_000;
const thermal = { nominal: 0, fair: 1, serious: 2, critical: 3 } as const;

type Slot = { point: MetricPoint; mono: number; slot: number };
type Ring = { slots: Slot[]; start: number; size: number; capacity: number; interval: number; dirty: boolean };

export function createHistory(intervals: Partial<Record<MetricKey, number>> = {}) {
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
  };
  const rings = new Map<MetricKey, Ring>();
  function record(body: Body, now: number, mono = now): void {
    const add = (key: MetricKey, at: number, value: number | undefined) => {
      if (value === undefined || !Number.isFinite(value) || !Number.isFinite(at) || at < now - WINDOW) return;
      let ring = rings.get(key);
      if (!ring) {
        const fallback = key.startsWith('disk:') ? 10_000 : key === 'battery' ? 30_000 : 2_000;
        const requested = intervals[key];
        const interval = requested !== undefined && Number.isFinite(requested) && requested > 0 ? requested : fallback;
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
      const slot = Math.floor(mono / ring.interval);
      const entry = { point: { at, value }, mono, slot };
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
      if (factStatusAt(value, now) === 'ok' && value.value !== null) read(value.value);
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
      const d = diskVolumeAt(body.disks, volume, now);
      if (d.status === 'ok' && Number.isFinite(d.total) && d.total > 0 && d.free >= 0 && d.free <= d.total) {
        add(`disk:${d.mount}`, d.observedAt, (d.total - d.free) / d.total);
      }
    }
  }

  function snapshot(mono: number): BodyHistory {
    const next = { ...history };
    let changed = false;
    let disksChanged = false;
    for (const [key, ring] of rings) {
      while (ring.size && ring.slots[ring.start].mono < mono - WINDOW) {
        ring.start = (ring.start + 1) % ring.capacity;
        ring.size--;
        ring.dirty = true;
      }
      if (!ring.dirty) continue;
      const slots = Array.from({ length: ring.size }, (_, i) => ring.slots[(ring.start + i) % ring.capacity]);
      const points = slots.map((item) => item.point);
      ring.dirty = false;
      if (!ring.size) rings.delete(key);
      const disk = key.startsWith('disk:');
      const mount = disk ? key.slice(5) : '';
      changed = true;
      if (disk) {
        if (!disksChanged) next.disks = { ...history.disks };
        disksChanged = true;
        if (points.length)
          Object.defineProperty(next.disks, mount, { value: points, enumerable: true, configurable: true });
        else delete next.disks[mount];
      } else next[key as keyof Omit<BodyHistory, 'disks'>] = points;
    }
    if (changed) history = next;
    return history;
  }
  const update = (body: Body, now: number) => {
    record(body, now);
    return snapshot(now);
  };
  return { record, snapshot, update };
}
