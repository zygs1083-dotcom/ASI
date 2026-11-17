import type { Body } from '@asi/sense-types';
import type { BodyHistory, MetricInsight, MetricKey, ThresholdLayer } from '@asi/sense-ui/model';
import type { Clock } from '../runtime/index.ts';
import type { Runtime } from './project.ts';

const natural: Record<string, string> = {
  cpu: 'cpu',
  memory: 'memory',
  battery: 'battery',
  thermal: 'thermal',
  networkRx: 'network.rx',
  networkTx: 'network.tx',
  processCpu: 'processCpu',
  processRss: 'rss',
  tokens: 'context',
};
const anomaly: Record<string, string> = {
  cpu: 'cpu',
  memory: 'memory',
  networkRx: 'network-rx',
  networkTx: 'network-tx',
};
const rate: Record<string, string> = { processRss: 'rss-surge', tokens: 'context-eta' };
const baseParam: Record<string, string> = {
  cpu: 'anomaly.cpu.sigma',
  memory: 'anomaly.memory.sigma',
  networkRx: 'anomaly.network.sigma',
  networkTx: 'anomaly.network.sigma',
};
const keys: MetricKey[] = [
  'cpu',
  'memory',
  'battery',
  'thermal',
  'networkRx',
  'networkTx',
  'processCpu',
  'processRss',
  'tokens',
];

function available(body: Body, key: MetricKey): boolean {
  if (key.startsWith('disk:')) {
    const disk = body.disks.value?.find((item) => item.mount === key.slice(5));
    return (
      !!disk &&
      (disk.status ?? body.disks.status) === 'ok' &&
      !body.disks.unavailableMounts?.includes(disk.mount) &&
      Number.isFinite(disk.total) &&
      disk.total > 0 &&
      Number.isFinite(disk.free) &&
      disk.free >= 0 &&
      disk.free <= disk.total
    );
  }
  const fact =
    key === 'networkRx' || key === 'networkTx'
      ? body.network
      : key === 'processCpu' || key === 'processRss'
        ? body.harnessProcess
        : body[key as 'cpu' | 'memory' | 'battery' | 'thermal' | 'tokens'];
  return fact.status === 'ok' && fact.value !== null;
}

function convert(key: MetricKey, value: number, body: Body): number | undefined {
  if (key.startsWith('disk:')) {
    const total = body.disks.value?.find((disk) => disk.mount === key.slice(5))?.total;
    return total && total > 0 ? 1 - value / total : undefined;
  }
  if (key === 'tokens') {
    const window = body.tokens.value?.contextWindow;
    return window && window > 0 ? window - value : undefined;
  }
  return value;
}

function etaFor(
  key: MetricKey,
  monitor: Runtime['body']['monitor'],
  body: Body,
  interval: number,
  at: (mono: number) => number,
  diskFloor: number,
): MetricInsight['currentEta'] {
  const metric = key.startsWith('disk:') ? key : natural[key];
  if (!metric || (!key.startsWith('disk:') && key !== 'tokens')) return undefined;
  const evidence = monitor.rateEvidence(metric);
  const last = evidence.points.at(-1);
  const loss = -(evidence.ratePerMinute ?? 0);
  if (!evidence.latched || evidence.points.length < 3 || !last || evidence.asOf === undefined || loss <= 0)
    return undefined;
  const total = key.startsWith('disk:') ? body.disks.value?.find((disk) => disk.mount === key.slice(5))?.total : 0;
  const floor = key === 'tokens' ? 0 : total !== undefined && total > 0 ? total * diskFloor : undefined;
  if (floor === undefined) return undefined;
  const timeToThresholdMs = (Math.max(0, last.value - floor) / loss) * 60_000;
  if (!Number.isFinite(timeToThresholdMs)) return undefined;
  return {
    asOf: at(last.mono),
    sampleIntervalMs: interval,
    ratePerMinute: key === 'tokens' ? loss : -loss,
    timeToThresholdMs,
  };
}

export function projectInsights(
  runtime: Runtime,
  history: BodyHistory,
  clock: Clock,
  intervals: Partial<Record<MetricKey, number>>,
  body: Body,
  at: (mono: number) => number,
): { insights: Partial<Record<MetricKey, MetricInsight>>; learning: SenseLearning } {
  const monitor = runtime.body.monitor;
  const tuner = runtime.body.tuner;
  const baseline = monitor.baseline.clone();
  baseline.advance(clock.mono());
  const latches = monitor.restoredState ?? {};
  const now = clock.wall();
  const insights: Partial<Record<MetricKey, MetricInsight>> = {};
  const all = [...keys, ...Object.keys(history.disks).map((mount): MetricKey => `disk:${mount}`)];
  for (const key of all) {
    if (!available(body, key)) continue;
    const token = body.tokens.value;
    const fallback = token && 'contextWindowSource' in token && token.contextWindowSource === 'fallback';
    if (key === 'tokens' && fallback) continue;
    const raw = key.startsWith('disk:') ? key : natural[key];
    const sources: ThresholdLayer[] = [];
    const triggered: ThresholdLayer[] = [];
    let severity: 'warn' | 'critical' | undefined;
    const disk = key.startsWith('disk:');
    const floorKey = disk ? key : key === 'tokens' ? 'context' : key;
    if (disk || key === 'tokens' || key === 'battery' || key === 'memory' || key === 'thermal') {
      sources.push('floor');
      const latched = latches[floorKey];
      if (latched === 'warn' || latched === 'critical') {
        triggered.push('floor');
        severity = latched;
      }
    }
    const rateKey = disk ? `rate:disk-drop:${key}` : rate[key] ? `rate:${rate[key]}` : undefined;
    if (rateKey) {
      sources.push('rate');
      if (latches[rateKey] === 'warn') {
        triggered.push('rate');
        severity ??= 'warn';
      }
    }
    const baselineKey = anomaly[key];
    if (baselineKey) {
      sources.push('baseline');
      if (latches[`baseline:${baselineKey}`] === 'warn') {
        triggered.push('baseline');
        severity ??= 'warn';
      }
    }
    const item: MetricInsight = { sources, triggered, ...(severity ? { severity } : {}) };
    const stat = raw ? baseline.read(raw, now) : undefined;
    if (stat) {
      const low = convert(key, stat.mean - stat.scale, body);
      const high = convert(key, stat.mean + stat.scale, body);
      if (low !== undefined && high !== undefined)
        item.baseline = { low: Math.min(low, high), high: Math.max(low, high) };
      if (baselineKey && stat.count >= 8 && stat.dates >= 2 && baseline.mature(clock.mono())) {
        const limit = stat.mean + tuner.number(baseParam[key], 3) * (2 - stat.confidence) * stat.scale;
        const value = convert(key, limit, body);
        if (value !== undefined) item.thresholds = { baseline: { value, source: 'baseline' } };
      }
    }
    const floor = disk ? 'disk' : key === 'tokens' ? 'context' : key === 'battery' ? 'battery' : undefined;
    if (floor) {
      const threshold = tuner.get(`floor.${floor}.${severity === 'critical' ? 'critical' : 'warn'}`);
      if (typeof threshold === 'number') {
        const value =
          key === 'battery'
            ? threshold * 100
            : key === 'tokens'
              ? (token?.contextWindow ?? 0) * (1 - threshold)
              : 1 - threshold;
        if (key !== 'tokens' || (token?.contextWindow ?? 0) > 0) {
          item.thresholds = { ...item.thresholds, floor: { value, source: 'floor' } };
        }
      }
    }
    if (key === 'thermal') {
      item.thresholds = {
        ...item.thresholds,
        floor: { value: severity === 'critical' ? 3 : 2, source: 'thermal', unit: 'count' },
      };
    }
    if (disk || key === 'processRss') {
      const param = disk ? 'rate.disk.maxDelta' : 'rate.rss.maxRatio';
      const value = tuner.get(param);
      if (typeof value === 'number') {
        item.thresholds = { ...item.thresholds, rate: { value, source: param, unit: disk ? 'bytes' : 'ratio' } };
      }
    }
    const defaultInterval = disk ? 10_000 : key === 'battery' ? 30_000 : 2_000;
    const interval = intervals[key] ?? defaultInterval;
    const eta = etaFor(
      key, monitor, body, Number.isFinite(interval) && interval > 0 ? interval : defaultInterval, at,
      tuner.number('floor.disk.critical', 0.05),
    );
    if (eta) item.currentEta = eta;
    insights[key] = item;
  }
  const collectedMs = baseline.elapsed;
  return {
    insights,
    learning: { collectedMs, targetMs: 86_400_000, status: collectedMs >= 86_400_000 ? 'ready' : 'learning' },
  };
}

type SenseLearning = NonNullable<import('@asi/sense-ui/model').SensePanelModel['learning']>;
