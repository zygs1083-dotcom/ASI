import type {
  MemoryCreateInput,
  MemoryKind,
  MemoryUpdateInput,
  MemoryViewItem,
  SleepConsolidationRecord,
  SleepPanelModel,
} from '../../shared/types.ts';

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type WireMemoryKind = MemoryKind;
export type WireMemoryViewItem = MemoryViewItem;
export type WireMemoryCreateInput = MemoryCreateInput;
export type WireMemoryUpdateInput = MemoryUpdateInput;
export type WireSleepConsolidationRecord = SleepConsolidationRecord;
export type WireSleepPanelModel = SleepPanelModel;
