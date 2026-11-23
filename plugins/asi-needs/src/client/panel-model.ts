import type { MetricKey, NeedsPanelModel } from '@asi/sense-ui/model';
import type { WireNeedsPanelModel } from '../host/dsh/wire-types.ts';

function isMetricKey(value: string): value is MetricKey {
  return (
    ['cpu', 'memory', 'battery', 'thermal', 'networkRx', 'networkTx', 'processCpu', 'processRss', 'tokens'].includes(
      value,
    ) ||
    value.startsWith('disk:') ||
    value.startsWith('diskFree:')
  );
}

export function panelModel(frame: WireNeedsPanelModel): NeedsPanelModel {
  const { sampleIntervalsMs, ...rest } = frame;
  if (!sampleIntervalsMs) return rest;
  const intervals: Partial<Record<MetricKey, number>> = {};
  for (const [k, v] of Object.entries(sampleIntervalsMs)) {
    if (isMetricKey(k) && typeof v === 'number') {
      intervals[k] = v;
    }
  }
  return { ...rest, sampleIntervalsMs: intervals };
}
