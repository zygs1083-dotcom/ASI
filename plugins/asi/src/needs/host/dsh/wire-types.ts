import type { NeedsPanelModel } from '@asi/sense-ui';

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface WireNeedsPanelModel extends Omit<NeedsPanelModel, 'sampleIntervalsMs'> {
  sampleIntervalsMs?: Record<string, number>;
}
