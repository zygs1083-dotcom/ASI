import type { MetricInsight, SenseEvent, SensePanelModel, SenseRule, Signal } from '@asi/sense-ui';

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}
export interface WireSignal extends Omit<Signal, 'data'> {
  data: JsonObject;
}
export interface WireSenseEvent extends Omit<SenseEvent, 'signal'> {
  signal: WireSignal;
}
export interface WireSenseRule extends Omit<SenseRule, 'match'> {
  match: Omit<SenseRule['match'], 'where'> & { where?: JsonObject };
}
export interface WirePanelModel extends Omit<SensePanelModel, 'events' | 'rules' | 'sampleIntervalsMs' | 'insights'> {
  events: WireSenseEvent[];
  rules: WireSenseRule[];
  sampleIntervalsMs?: Record<string, number>;
  insights?: Record<string, MetricInsight>;
}
