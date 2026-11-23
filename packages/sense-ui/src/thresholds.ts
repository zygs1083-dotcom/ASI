/**
 * 指标显示参考底线（5 分钟走势图参考线）。
 */

import type { DetailUnit, MetricKey } from './view-model';

export interface SparkThreshold {
  value: number;
  sev: 'warn' | 'critical';
  direction: 'above' | 'below';
  label?: string;
  active?: boolean;
}

export function metricUnit(key: MetricKey): DetailUnit {
  if (key === 'tokens') return 'tokens';
  if (key === 'networkRx' || key === 'networkTx') return 'bytes/s';
  if (key === 'processRss' || key.startsWith('diskFree:')) return 'bytes';
  if (key === 'battery' || key === 'thermal') return 'count';
  return 'ratio';
}

const FLOOR_DEFAULTS: Record<string, { warn: number; critical: number; direction: 'above' | 'below' }> = {
  cpu: { warn: 0.75, critical: 0.9, direction: 'above' },
  memory: { warn: 0.85, critical: 0.95, direction: 'above' },
  'disk:*': { warn: 0.9, critical: 0.95, direction: 'above' },
  battery: { warn: 15, critical: 5, direction: 'below' },
  thermal: { warn: 2, critical: 3, direction: 'above' },
  processCpu: { warn: 0.75, critical: 0.9, direction: 'above' },
};

export function defaultFloors(key: MetricKey, tokenWindow?: number): SparkThreshold[] | null {
  if (key === 'tokens') {
    if (tokenWindow == null || !Number.isFinite(tokenWindow) || tokenWindow <= 0) {
      return null;
    }
    return [
      { value: tokenWindow * 0.85, sev: 'warn', direction: 'above' },
      { value: tokenWindow * 0.95, sev: 'critical', direction: 'above' },
    ];
  }
  const d = key.startsWith('disk:') ? FLOOR_DEFAULTS['disk:*'] : FLOOR_DEFAULTS[key];
  if (!d) return null;
  return [
    { value: d.warn, sev: 'warn', direction: d.direction },
    { value: d.critical, sev: 'critical', direction: d.direction },
  ];
}

export function chartThresholds(key: MetricKey, tokenWindow?: number): { lines: SparkThreshold[] } {
  const d = defaultFloors(key, tokenWindow);
  return { lines: d ? d.map((t) => ({ ...t, label: '显示底线' })) : [] };
}
