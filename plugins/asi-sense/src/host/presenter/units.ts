import type { MetricKey } from '@asi/sense-ui/model';

export type SuggestionUnit = 'ratio' | 'percent' | 'bytes' | 'tokens' | 'bytes-per-second' | 'ordinal';

const keys: Record<string, MetricKey> = {
  cpu: 'cpu',
  memory: 'memory',
  battery: 'battery',
  thermal: 'thermal',
  rss: 'processRss',
  context: 'tokens',
  'network.rx': 'networkRx',
  'network.tx': 'networkTx',
};

export function suggestionMetric(metric: string): MetricKey | undefined {
  return metric.startsWith('disk:')
    ? `disk:${metric.slice(5)}`
    : Object.hasOwn(keys, metric)
      ? keys[metric]
      : undefined;
}

export function suggestionUnit(metric: MetricKey): SuggestionUnit {
  if (metric.startsWith('disk:') || metric === 'processRss') return 'bytes';
  if (metric === 'networkRx' || metric === 'networkTx') return 'bytes-per-second';
  if (metric === 'tokens') return 'tokens';
  if (metric === 'battery') return 'percent';
  if (metric === 'thermal') return 'ordinal';
  return 'ratio';
}
