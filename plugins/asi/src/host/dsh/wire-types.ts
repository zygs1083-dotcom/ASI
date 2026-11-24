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
  FlashbackFeedback,
  FlashbackMatch,
  FlashbackRecord,
  IntuitionPanelModel,
  ProspectiveCreateInput,
  ProspectiveIntention,
  ProspectiveResolveInput,
} from '../../intuition/shared/types.ts';
import type {
  MemoryCreateInput,
  MemoryKind,
  MemoryUpdateInput,
  MemoryViewItem,
  SleepConsolidationRecord,
  SleepPanelModel,
} from '../../sleep/shared/types.ts';
import type { PartnerOverrideInput, PartnerStateKind, TomPanelModel } from '../../tom/shared/types.ts';

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

export type WireFlashbackFeedback = FlashbackFeedback;
export type WireFlashbackMatch = FlashbackMatch;
export type WireFlashbackRecord = FlashbackRecord;
export type WireProspectiveCreateInput = ProspectiveCreateInput;
export type WireProspectiveResolveInput = ProspectiveResolveInput;
export type WireProspectiveIntention = ProspectiveIntention;
export type WireIntuitionPanelModel = IntuitionPanelModel;

export type WirePartnerStateKind = PartnerStateKind;
export type WirePartnerOverrideInput = PartnerOverrideInput;
export type WireTomPanelModel = TomPanelModel;

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
  intuition: IntuitionPanelModel;
  tom: TomPanelModel;
  dream: DreamPanelModel;
}

export interface WireAsiPanelModel {
  needs: WireNeedsPanelModel;
  sleep: WireSleepPanelModel;
  growth: WireGrowthPanelModel;
  intuition: WireIntuitionPanelModel;
  tom: WireTomPanelModel;
  dream: WireDreamPanelModel;
}
