import type { NeedsPanelModel } from '@asi/sense-ui';
import type {
  DreamAdoptMemoryInput,
  DreamAdoptResult,
  DreamCycleRecord,
  DreamInsightKind,
  DreamInsightStatus,
  DreamInsightViewItem,
  DreamPanelModel,
  DreamPromoteResult,
} from '../../dream/shared/types.ts';
import type {
  ArchivedSkillViewItem,
  GrowthPanelModel,
  GrowthSynthesisRecord,
  SkillCreateDraftInput,
  SkillDraftViewItem,
  SkillExportResult,
  SkillScope,
  SkillScopeUpdateInput,
  SkillUpdateMarkdownInput,
  SkillViewItem,
} from '../../growth/shared/types.ts';
import type {
  MemoryCreateInput,
  MemoryKind,
  MemoryUpdateInput,
  MemoryViewItem,
  SleepConsolidationRecord,
  SleepPanelModel,
} from '../../sleep/shared/types.ts';

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface WireNeedsPanelModel extends Omit<NeedsPanelModel, 'sampleIntervalsMs'> {
  sampleIntervalsMs?: Record<string, number>;
}

export type WireMemoryKind = MemoryKind;
export type WireMemoryViewItem = MemoryViewItem;
export type WireMemoryCreateInput = MemoryCreateInput;
export type WireMemoryUpdateInput = MemoryUpdateInput;
export type WireSleepConsolidationRecord = SleepConsolidationRecord;
export type WireSleepPanelModel = SleepPanelModel;

export type WireSkillScope = SkillScope;
export type WireSkillDraftViewItem = SkillDraftViewItem;
export type WireSkillViewItem = SkillViewItem;
export type WireArchivedSkillViewItem = ArchivedSkillViewItem;
export type WireSkillCreateDraftInput = SkillCreateDraftInput;
export type WireSkillUpdateMarkdownInput = SkillUpdateMarkdownInput;
export type WireSkillScopeUpdateInput = SkillScopeUpdateInput;
export type WireSkillExportResult = SkillExportResult;
export type WireGrowthSynthesisRecord = GrowthSynthesisRecord;
export type WireGrowthPanelModel = GrowthPanelModel;

export type WireDreamInsightKind = DreamInsightKind;
export type WireDreamInsightStatus = DreamInsightStatus;
export type WireDreamInsightViewItem = DreamInsightViewItem;
export type WireDreamAdoptMemoryInput = DreamAdoptMemoryInput;
export type WireDreamAdoptResult = DreamAdoptResult;
export type WireDreamPromoteResult = DreamPromoteResult;
export type WireDreamCycleRecord = DreamCycleRecord;
export type WireDreamPanelModel = DreamPanelModel;

export interface AsiPanelModel {
  needs: NeedsPanelModel;
  sleep: SleepPanelModel;
  growth: GrowthPanelModel;
  dream?: DreamPanelModel;
}

export interface WireAsiPanelModel {
  needs: WireNeedsPanelModel;
  sleep: WireSleepPanelModel;
  growth: WireGrowthPanelModel;
  dream?: WireDreamPanelModel;
}
