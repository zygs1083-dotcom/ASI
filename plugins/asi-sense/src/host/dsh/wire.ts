import type { MetricKey, SensePanelModel } from '@asi/sense-ui';
import { isRemoteJsonValue, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type { JsonObject, WirePanelModel } from './wire-types.ts';

function jsonObject(value: Record<string, unknown>): JsonObject {
  if (!isRemoteJsonValue(value)) throw new RemoteError('gateway/internal', 'Frame data is not lossless JSON', {});
  return value as JsonObject;
}

function definedValues<T>(source: Partial<Record<MetricKey, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(source).filter((entry): entry is [string, T] => entry[1] !== undefined));
}

export function toWirePanelModel(model: SensePanelModel): WirePanelModel {
  const { sampleIntervalsMs, insights, ...rest } = model;
  return {
    ...rest,
    ...(sampleIntervalsMs === undefined ? {} : { sampleIntervalsMs: definedValues(sampleIntervalsMs) }),
    ...(insights === undefined ? {} : { insights: definedValues(insights) }),
    events: model.events.map((event) => ({
      ...event,
      signal: { ...event.signal, data: jsonObject(event.signal.data) },
    })),
    rules: model.rules.map((rule) => {
      const { where, ...match } = rule.match;
      return { ...rule, match: { ...match, ...(where === undefined ? {} : { where: jsonObject(where) }) } };
    }),
  };
}
