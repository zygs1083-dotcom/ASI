import type { MetricKey, NeedsPanelModel } from '@asi/sense-ui';
import type { WireNeedsPanelModel } from './wire-types.ts';

function definedValues<T>(source: Partial<Record<MetricKey, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(source).filter((entry): entry is [string, T] => entry[1] !== undefined));
}

export function toWireNeedsPanelModel(model: NeedsPanelModel): WireNeedsPanelModel {
  const { sampleIntervalsMs, ...rest } = model;
  return {
    ...rest,
    ...(sampleIntervalsMs === undefined ? {} : { sampleIntervalsMs: definedValues(sampleIntervalsMs) }),
  };
}
