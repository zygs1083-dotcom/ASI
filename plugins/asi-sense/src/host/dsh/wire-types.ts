import type { MetricInsight, SenseEvent, SensePanelModel, SenseRule, Signal, TuningState } from '@asi/sense-ui';

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
export interface WireTuningSuggestion extends Omit<NonNullable<TuningState['suggestions']>[number], 'metric'> {
  metric: string;
}
export interface WireTuningState extends Omit<TuningState, 'suggestions'> {
  suggestions?: WireTuningSuggestion[];
}
export interface WirePanelModel
  extends Omit<SensePanelModel, 'events' | 'rules' | 'sampleIntervalsMs' | 'insights' | 'tuning'> {
  events: WireSenseEvent[];
  rules: WireSenseRule[];
  sampleIntervalsMs?: Record<string, number>;
  insights?: Record<string, MetricInsight>;
  tuning?: WireTuningState;
}
