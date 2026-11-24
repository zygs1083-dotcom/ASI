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
} from '../../shared/types.ts';

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

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
