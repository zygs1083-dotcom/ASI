import { type Body, diskVolumeAt, type Fact, factStatusAt } from '@asi/sense-types';
import type { BodyHistory, MetricKey, MetricPoint } from '@asi/sense-ui/model';

const WINDOW = 300_000;
const thermal = { nominal: 0, fair: 1, serious: 2, critical: 3 } as const;

export function createHistory() {
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
  const seen = new Map<MetricKey, number>();
  const rates = new Map<MetricKey, MetricPoint[]>();

  function update(body: Body, now: number): BodyHistory {
    const readings = new Map<MetricKey, MetricPoint>();
    const raw = new Map<MetricKey, number>();
    const add = (key: MetricKey, at: number, value: number | undefined, rateValue?: number) => {
      if (value !== undefined && Number.isFinite(value) && Number.isFinite(at) && at >= now - WINDOW) {
        readings.set(key, { at, value });
        if (rateValue !== undefined && Number.isFinite(rateValue)) raw.set(key, rateValue);
      }
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
        (!('contextWindowSource' in v) || v.contextWindowSource !== 'fallback') &&
          v.contextWindow !== undefined &&
          v.contextWindow > 0 &&
          v.contextUsed !== undefined
          ? v.contextWindow - v.contextUsed
          : undefined,
      ),
    );
    for (const volume of body.disks.value ?? []) {
      const d = diskVolumeAt(body.disks, volume, now);
      if (d.status === 'ok' && Number.isFinite(d.total) && d.total > 0 && d.free >= 0 && d.free <= d.total) {
        add(`disk:${d.mount}`, d.observedAt, (d.total - d.free) / d.total, d.free);
      }
    }

    const next = { ...history };
    let changed = false;
    let disksChanged = false;
    const keys = new Set<MetricKey>([
      ...(Object.keys(history).filter((key) => key !== 'disks') as MetricKey[]),
      ...Object.keys(history.disks).map((mount): MetricKey => `disk:${mount}`),
      ...readings.keys(),
    ]);
    for (const key of keys) {
      const disk = key.startsWith('disk:');
      const mount = disk ? key.slice(5) : '';
      const old = disk ? (history.disks[mount] ?? []) : history[key as keyof Omit<BodyHistory, 'disks'>];
      const point = readings.get(key);
      const fresh = point && point.at > (seen.get(key) ?? Number.NEGATIVE_INFINITY);
      let points = old;
      if (old.length && old[0].at < now - WINDOW) points = old.filter((item) => item.at >= now - WINDOW);
      if (fresh) {
        seen.set(key, point.at);
        points = [...points, point];
      }
      if (disk || key === 'tokens') {
        let ratePoints = rates.get(key) ?? [];
        if (ratePoints.length && ratePoints[0].at < now - WINDOW)
          ratePoints = ratePoints.filter((item) => item.at >= now - WINDOW);
        if (fresh) {
          const value = raw.get(key);
          ratePoints = value === undefined ? [] : [...ratePoints, { at: point.at, value }];
        }
        if (ratePoints.length) rates.set(key, ratePoints);
        else rates.delete(key);
      }
      if (points !== old) {
        changed = true;
        if (disk) {
          if (!disksChanged) next.disks = { ...history.disks };
          disksChanged = true;
          if (points.length)
            Object.defineProperty(next.disks, mount, { value: points, enumerable: true, configurable: true });
          else {
            delete next.disks[mount];
            seen.delete(key);
          }
        } else next[key as keyof Omit<BodyHistory, 'disks'>] = points;
      }
    }
    if (changed) history = next;
    return history;
  }
  return { update, rates };
}
