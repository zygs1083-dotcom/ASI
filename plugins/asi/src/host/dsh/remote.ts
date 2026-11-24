import { sanitizeForModel } from '@asi/sense-types';
import type { Context } from '@deepseek-ai/cordis';
import { principalOf, Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { GrowthActionsApi } from '../../growth/host/runtime.ts';
import type { SkillScope } from '../../growth/shared/types.ts';
import type { IntuitionActionsApi } from '../../intuition/host/runtime.ts';
import {
  type FlashbackFeedback,
  PROSPECTIVE_EVENT_KINDS,
  PROSPECTIVE_TRIGGER_KINDS,
  type ProspectiveEventKind,
  type ProspectiveResolveAction,
  type ProspectiveTriggerKind,
} from '../../intuition/shared/types.ts';
import type { NeedsActions } from '../../needs/host/runtime.ts';
import type { SleepActionsApi } from '../../sleep/host/runtime.ts';
import { MEMORY_KINDS, type MemoryKind } from '../../sleep/shared/types.ts';
import type { TomActionsApi } from '../../tom/host/runtime.ts';
import { PARTNER_STATE_KINDS, type PartnerStateKind } from '../../tom/shared/types.ts';
import type { AsiFramesSource } from './frames.ts';
import { toWireAsiPanelModel } from './wire.ts';
import type {
  WireArchivedSkillViewItem,
  WireAsiPanelModel,
  WireFlashbackFeedback,
  WireFlashbackMatch,
  WireGrowthSynthesisRecord,
  WireMemoryCreateInput,
  WireMemoryKind,
  WireMemoryUpdateInput,
  WireMemoryViewItem,
  WirePartnerOverrideInput,
  WireProspectiveCreateInput,
  WireProspectiveIntention,
  WireProspectiveResolveInput,
  WireSkillCreateDraftInput,
  WireSkillDraftViewItem,
  WireSkillExportResult,
  WireSkillScopeUpdateInput,
  WireSkillUpdateMarkdownInput,
  WireSkillViewItem,
  WireSleepConsolidationRecord,
  WireTomPanelModel,
} from './wire-types.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    asi: AsiRemote;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
}

function isSkillScope(value: unknown): value is SkillScope {
  return value === 'global' || value === 'workspace';
}

function isProspectiveTriggerKind(value: unknown): value is ProspectiveTriggerKind {
  return typeof value === 'string' && (PROSPECTIVE_TRIGGER_KINDS as readonly string[]).includes(value);
}

function isProspectiveEventKind(value: unknown): value is ProspectiveEventKind {
  return typeof value === 'string' && (PROSPECTIVE_EVENT_KINDS as readonly string[]).includes(value);
}

function isProspectiveResolveAction(value: unknown): value is ProspectiveResolveAction {
  return value === 'fulfill' || value === 'snooze' || value === 'cancel';
}

function isFlashbackFeedback(value: unknown): value is FlashbackFeedback {
  return value === 'helpful' || value === 'dismissed' || value === 'muted';
}

function isPartnerStateKind(value: unknown): value is PartnerStateKind {
  return typeof value === 'string' && (PARTNER_STATE_KINDS as readonly string[]).includes(value);
}

export interface AsiRemoteDeps {
  needsActions?: NeedsActions;
  sleepActions?: SleepActionsApi;
  growthActions?: GrowthActionsApi;
  intuitionActions?: IntuitionActionsApi;
  tomActions?: TomActionsApi;
  framesSource?: AsiFramesSource;
}

export class AsiRemote extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly deps: AsiRemoteDeps,
  ) {
    super(ctx, 'asi');
  }

  bindNeedsActions(actions: NeedsActions | undefined): void {
    this.deps.needsActions = actions;
  }

  bindSleepActions(actions: SleepActionsApi | undefined): void {
    this.deps.sleepActions = actions;
  }

  bindGrowthActions(actions: GrowthActionsApi | undefined): void {
    this.deps.growthActions = actions;
  }

  bindIntuitionActions(actions: IntuitionActionsApi | undefined): void {
    this.deps.intuitionActions = actions;
  }

  bindTomActions(actions: TomActionsApi | undefined): void {
    this.deps.tomActions = actions;
  }

  private checkUser(): void {
    if (principalOf(this.ctx.invocation)) {
      throw new RemoteError('gateway/bad-request', 'User access required', {});
    }
  }

  private requireNeeds(): NeedsActions {
    if (!this.deps.needsActions) {
      throw new RemoteError('gateway/bad-request', 'Needs actions unavailable', {});
    }
    return this.deps.needsActions;
  }

  private requireSleep(): SleepActionsApi {
    if (!this.deps.sleepActions) {
      throw new RemoteError('gateway/bad-request', 'Sleep actions unavailable', {});
    }
    return this.deps.sleepActions;
  }

  private requireGrowth(): GrowthActionsApi {
    if (!this.deps.growthActions) {
      throw new RemoteError('gateway/bad-request', 'Growth actions unavailable', {});
    }
    return this.deps.growthActions;
  }

  private requireIntuition(): IntuitionActionsApi {
    if (!this.deps.intuitionActions) {
      throw new RemoteError('gateway/bad-request', 'Intuition actions unavailable', {});
    }
    return this.deps.intuitionActions;
  }

  private requireTom(): TomActionsApi {
    if (!this.deps.tomActions) {
      throw new RemoteError('gateway/bad-request', 'ToM actions unavailable', {});
    }
    return this.deps.tomActions;
  }

  private async userAction<T>(action: () => Promise<T>): Promise<T> {
    this.checkUser();
    const revBefore = this.deps.framesSource?.revision?.();
    try {
      return await action();
    } catch (err) {
      if (err instanceof RemoteError) throw err;
      const safeMessage = err instanceof Error ? sanitizeForModel(err.message) : 'Action failed';
      throw new RemoteError('gateway/bad-request', safeMessage || 'Action failed', {});
    } finally {
      this.deps.framesSource?.invalidate?.(revBefore);
    }
  }

  @Remote({ mode: 'stream' })
  async *frames(signal: AbortSignal): AsyncIterable<WireAsiPanelModel> {
    this.checkUser();
    if (!this.deps.framesSource) return;
    for await (const frame of this.deps.framesSource(signal)) {
      yield toWireAsiPanelModel(frame);
    }
  }

  // ---- L0/L1/L3 Homeostasis & Care Actions ----

  @Remote
  async pause(paused: boolean): Promise<void> {
    this.checkUser();
    if (typeof paused !== 'boolean') {
      throw new RemoteError('gateway/bad-request', 'paused must be a boolean', {});
    }
    await this.userAction(() => this.requireNeeds().pause(paused));
  }

  @Remote
  async setSendTitles(enabled: boolean): Promise<void> {
    this.checkUser();
    if (typeof enabled !== 'boolean') {
      throw new RemoteError('gateway/bad-request', 'enabled must be a boolean', {});
    }
    await this.userAction(() => this.requireNeeds().setSendTitles(enabled));
  }

  @Remote
  async openPermissionSettings(): Promise<void> {
    this.checkUser();
    await this.userAction(() => this.requireNeeds().openPermissionSettings());
  }

  @Remote
  async approveHelp(cardId: string): Promise<void> {
    this.checkUser();
    if (typeof cardId !== 'string' || !cardId.trim()) {
      throw new RemoteError('gateway/bad-request', 'cardId is required', {});
    }
    await this.userAction(() => this.requireNeeds().approveHelp(cardId));
  }

  @Remote
  async dismissHelp(cardId: string): Promise<void> {
    this.checkUser();
    if (typeof cardId !== 'string' || !cardId.trim()) {
      throw new RemoteError('gateway/bad-request', 'cardId is required', {});
    }
    await this.userAction(() => this.requireNeeds().dismissHelp(cardId));
  }

  @Remote
  async openMaintenanceSession(): Promise<string> {
    this.checkUser();
    return await this.userAction(() => this.requireNeeds().openMaintenanceSession());
  }

  @Remote
  async triggerCheck(): Promise<void> {
    this.checkUser();
    await this.userAction(() => this.requireNeeds().triggerCheck());
  }

  // ---- L2 Sleep & Memory Vault Actions ----

  @Remote
  async consolidateNow(): Promise<WireSleepConsolidationRecord> {
    this.checkUser();
    return await this.userAction(() => this.requireSleep().consolidateNow());
  }

  @Remote
  async setAutoSleepPaused(paused: boolean): Promise<void> {
    this.checkUser();
    if (typeof paused !== 'boolean') {
      throw new RemoteError('gateway/bad-request', 'paused must be a boolean', {});
    }
    await this.userAction(() => this.requireSleep().setAutoSleepPaused(paused));
  }

  @Remote
  async createMemory(input: WireMemoryCreateInput): Promise<WireMemoryViewItem> {
    this.checkUser();
    if (!isPlainRecord(input) || !isMemoryKind(input.kind)) {
      throw new RemoteError('gateway/bad-request', 'valid kind is required', {});
    }
    if (
      typeof input.title !== 'string' ||
      !input.title.trim() ||
      typeof input.content !== 'string' ||
      !input.content.trim()
    ) {
      throw new RemoteError('gateway/bad-request', 'title and content are required', {});
    }
    if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.some((t) => typeof t !== 'string'))) {
      throw new RemoteError('gateway/bad-request', 'tags must be an array of strings', {});
    }
    if (input.topicKey !== undefined && typeof input.topicKey !== 'string') {
      throw new RemoteError('gateway/bad-request', 'topicKey must be a string', {});
    }
    if (input.pinned !== undefined && typeof input.pinned !== 'boolean') {
      throw new RemoteError('gateway/bad-request', 'pinned must be a boolean', {});
    }
    return await this.userAction(() => this.requireSleep().createMemory(input));
  }

  @Remote
  async updateMemory(id: string, patch: WireMemoryUpdateInput): Promise<WireMemoryViewItem> {
    this.checkUser();
    if (typeof id !== 'string' || !id.trim()) {
      throw new RemoteError('gateway/bad-request', 'id is required', {});
    }
    if (!isPlainRecord(patch)) {
      throw new RemoteError('gateway/bad-request', 'patch must be an object', {});
    }
    if (patch.kind !== undefined && !isMemoryKind(patch.kind)) {
      throw new RemoteError('gateway/bad-request', 'invalid memory kind', {});
    }
    if (patch.title !== undefined && typeof patch.title !== 'string') {
      throw new RemoteError('gateway/bad-request', 'title must be a string', {});
    }
    if (patch.content !== undefined && typeof patch.content !== 'string') {
      throw new RemoteError('gateway/bad-request', 'content must be a string', {});
    }
    if (patch.tags !== undefined && (!Array.isArray(patch.tags) || patch.tags.some((t) => typeof t !== 'string'))) {
      throw new RemoteError('gateway/bad-request', 'tags must be an array of strings', {});
    }
    if (patch.topicKey !== undefined && typeof patch.topicKey !== 'string') {
      throw new RemoteError('gateway/bad-request', 'topicKey must be a string', {});
    }
    if (patch.pinned !== undefined && typeof patch.pinned !== 'boolean') {
      throw new RemoteError('gateway/bad-request', 'pinned must be a boolean', {});
    }
    return await this.userAction(() => this.requireSleep().updateMemory(id, patch));
  }

  @Remote
  async togglePin(id: string, pinned: boolean): Promise<WireMemoryViewItem> {
    this.checkUser();
    if (typeof id !== 'string' || !id.trim() || typeof pinned !== 'boolean') {
      throw new RemoteError('gateway/bad-request', 'id and boolean pinned are required', {});
    }
    return await this.userAction(() => this.requireSleep().togglePin(id, pinned));
  }

  @Remote
  async deleteMemory(id: string): Promise<void> {
    this.checkUser();
    if (typeof id !== 'string' || !id.trim()) {
      throw new RemoteError('gateway/bad-request', 'id is required', {});
    }
    await this.userAction(() => this.requireSleep().deleteMemory(id));
  }

  @Remote
  async searchMemories(query: string, kind?: WireMemoryKind): Promise<WireMemoryViewItem[]> {
    this.checkUser();
    if (typeof query !== 'string') {
      throw new RemoteError('gateway/bad-request', 'query must be a string', {});
    }
    if (kind !== undefined && !isMemoryKind(kind)) {
      throw new RemoteError('gateway/bad-request', 'invalid memory kind', {});
    }
    return await this.requireSleep().searchMemories(query, kind);
  }

  // ---- L4 Skill Studio & Procedural Self-Evolution Actions ----

  @Remote
  async synthesizeNow(): Promise<WireGrowthSynthesisRecord> {
    this.checkUser();
    return await this.userAction(() => this.requireGrowth().synthesizeNow());
  }

  @Remote
  async setAutoGrowthPaused(paused: boolean): Promise<void> {
    this.checkUser();
    if (typeof paused !== 'boolean') {
      throw new RemoteError('gateway/bad-request', 'paused must be a boolean', {});
    }
    await this.userAction(() => this.requireGrowth().setAutoGrowthPaused(paused));
  }

  @Remote
  async createManualDraft(input: WireSkillCreateDraftInput): Promise<WireSkillDraftViewItem> {
    this.checkUser();
    if (!isPlainRecord(input)) {
      throw new RemoteError('gateway/bad-request', 'input must be an object', {});
    }
    if (
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      typeof input.description !== 'string' ||
      !input.description.trim() ||
      typeof input.body !== 'string' ||
      !input.body.trim()
    ) {
      throw new RemoteError('gateway/bad-request', 'name, description, and body are required', {});
    }
    if (input.whenToUse !== undefined && typeof input.whenToUse !== 'string') {
      throw new RemoteError('gateway/bad-request', 'whenToUse must be a string', {});
    }
    if (input.scope !== undefined && !isSkillScope(input.scope)) {
      throw new RemoteError('gateway/bad-request', 'invalid scope', {});
    }
    if (input.workspacePath !== undefined && typeof input.workspacePath !== 'string') {
      throw new RemoteError('gateway/bad-request', 'workspacePath must be a string', {});
    }
    return await this.userAction(() => this.requireGrowth().createManualDraft(input));
  }

  @Remote
  async updateDraft(draftId: string, patch: WireSkillUpdateMarkdownInput): Promise<WireSkillDraftViewItem> {
    this.checkUser();
    if (typeof draftId !== 'string' || !draftId.trim()) {
      throw new RemoteError('gateway/bad-request', 'draftId is required', {});
    }
    if (!isPlainRecord(patch) || typeof patch.markdown !== 'string' || !patch.markdown.trim()) {
      throw new RemoteError('gateway/bad-request', 'markdown is required', {});
    }
    if (patch.scope !== undefined && !isSkillScope(patch.scope)) {
      throw new RemoteError('gateway/bad-request', 'invalid scope', {});
    }
    if (patch.workspacePath !== undefined && typeof patch.workspacePath !== 'string') {
      throw new RemoteError('gateway/bad-request', 'workspacePath must be a string', {});
    }
    return await this.userAction(() => this.requireGrowth().updateDraft(draftId, patch));
  }

  @Remote
  async approveDraft(draftId: string): Promise<WireSkillViewItem> {
    this.checkUser();
    if (typeof draftId !== 'string' || !draftId.trim()) {
      throw new RemoteError('gateway/bad-request', 'draftId is required', {});
    }
    return await this.userAction(() => this.requireGrowth().approveDraft(draftId));
  }

  @Remote
  async rejectDraft(draftId: string): Promise<void> {
    this.checkUser();
    if (typeof draftId !== 'string' || !draftId.trim()) {
      throw new RemoteError('gateway/bad-request', 'draftId is required', {});
    }
    await this.userAction(() => this.requireGrowth().rejectDraft(draftId));
  }

  @Remote
  async updateSkill(name: string, patch: WireSkillUpdateMarkdownInput): Promise<WireSkillViewItem> {
    this.checkUser();
    if (typeof name !== 'string' || !name.trim()) {
      throw new RemoteError('gateway/bad-request', 'name is required', {});
    }
    if (!isPlainRecord(patch) || typeof patch.markdown !== 'string' || !patch.markdown.trim()) {
      throw new RemoteError('gateway/bad-request', 'markdown is required', {});
    }
    if (patch.scope !== undefined && !isSkillScope(patch.scope)) {
      throw new RemoteError('gateway/bad-request', 'invalid scope', {});
    }
    if (patch.workspacePath !== undefined && typeof patch.workspacePath !== 'string') {
      throw new RemoteError('gateway/bad-request', 'workspacePath must be a string', {});
    }
    return await this.userAction(() => this.requireGrowth().updateSkill(name, patch));
  }

  @Remote
  async setSkillScope(name: string, input: WireSkillScopeUpdateInput): Promise<WireSkillViewItem> {
    this.checkUser();
    if (typeof name !== 'string' || !name.trim()) {
      throw new RemoteError('gateway/bad-request', 'name is required', {});
    }
    if (!isPlainRecord(input) || !isSkillScope(input.scope)) {
      throw new RemoteError('gateway/bad-request', 'valid scope is required', {});
    }
    if (input.workspacePath !== undefined && typeof input.workspacePath !== 'string') {
      throw new RemoteError('gateway/bad-request', 'workspacePath must be a string', {});
    }
    return await this.userAction(() => this.requireGrowth().setSkillScope(name, input));
  }

  @Remote
  async setSkillEnabled(name: string, enabled: boolean): Promise<WireSkillViewItem> {
    this.checkUser();
    if (typeof name !== 'string' || !name.trim() || typeof enabled !== 'boolean') {
      throw new RemoteError('gateway/bad-request', 'name and boolean enabled are required', {});
    }
    return await this.userAction(() => this.requireGrowth().setSkillEnabled(name, enabled));
  }

  @Remote
  async archiveSkill(name: string): Promise<WireArchivedSkillViewItem> {
    this.checkUser();
    if (typeof name !== 'string' || !name.trim()) {
      throw new RemoteError('gateway/bad-request', 'name is required', {});
    }
    return await this.userAction(() => this.requireGrowth().archiveSkill(name));
  }

  @Remote
  async restoreSkill(name: string): Promise<WireSkillViewItem> {
    this.checkUser();
    if (typeof name !== 'string' || !name.trim()) {
      throw new RemoteError('gateway/bad-request', 'name is required', {});
    }
    return await this.userAction(() => this.requireGrowth().restoreSkill(name));
  }

  @Remote
  async deleteArchivedSkill(name: string): Promise<void> {
    this.checkUser();
    if (typeof name !== 'string' || !name.trim()) {
      throw new RemoteError('gateway/bad-request', 'name is required', {});
    }
    await this.userAction(() => this.requireGrowth().deleteArchivedSkill(name));
  }

  @Remote
  async exportSkillToWorkspace(name: string, workspacePath: string): Promise<WireSkillExportResult> {
    this.checkUser();
    if (typeof name !== 'string' || !name.trim() || typeof workspacePath !== 'string' || !workspacePath.trim()) {
      throw new RemoteError('gateway/bad-request', 'name and workspacePath are required', {});
    }
    return await this.userAction(() => this.requireGrowth().exportSkillToWorkspace(name, workspacePath));
  }

  // ---- Prefrontal Intuition & Prospective Memory Actions ----

  @Remote
  async setAutoIntuitionPaused(paused: boolean): Promise<void> {
    this.checkUser();
    if (typeof paused !== 'boolean') {
      throw new RemoteError('gateway/bad-request', 'paused must be a boolean', {});
    }
    await this.userAction(() => this.requireIntuition().setAutoIntuitionPaused(paused));
  }

  @Remote
  async createProspectiveIntention(input: WireProspectiveCreateInput): Promise<WireProspectiveIntention> {
    this.checkUser();
    if (!isPlainRecord(input) || !isProspectiveTriggerKind(input.triggerKind)) {
      throw new RemoteError('gateway/bad-request', 'valid triggerKind is required', {});
    }
    if (
      typeof input.title !== 'string' ||
      !input.title.trim() ||
      typeof input.instruction !== 'string' ||
      !input.instruction.trim()
    ) {
      throw new RemoteError('gateway/bad-request', 'title and instruction are required', {});
    }
    if (input.priority !== undefined && input.priority !== 'normal' && input.priority !== 'high') {
      throw new RemoteError('gateway/bad-request', 'invalid priority', {});
    }
    if (input.eventKind !== undefined && !isProspectiveEventKind(input.eventKind)) {
      throw new RemoteError('gateway/bad-request', 'invalid eventKind', {});
    }
    return await this.userAction(() => this.requireIntuition().createIntention(input));
  }

  @Remote
  async resolveProspectiveIntention(input: WireProspectiveResolveInput): Promise<WireProspectiveIntention> {
    this.checkUser();
    if (
      !isPlainRecord(input) ||
      typeof input.id !== 'string' ||
      !input.id.trim() ||
      !isProspectiveResolveAction(input.action)
    ) {
      throw new RemoteError('gateway/bad-request', 'id and valid action are required', {});
    }
    return await this.userAction(() => this.requireIntuition().resolveIntention(input));
  }

  @Remote
  async deleteProspectiveIntention(id: string): Promise<void> {
    this.checkUser();
    if (typeof id !== 'string' || !id.trim()) {
      throw new RemoteError('gateway/bad-request', 'id is required', {});
    }
    await this.userAction(() => this.requireIntuition().deleteIntention(id));
  }

  @Remote
  async recordFlashbackFeedback(sourceId: string, feedback: WireFlashbackFeedback): Promise<void> {
    this.checkUser();
    if (typeof sourceId !== 'string' || !sourceId.trim() || !isFlashbackFeedback(feedback)) {
      throw new RemoteError('gateway/bad-request', 'sourceId and valid feedback are required', {});
    }
    await this.userAction(() => this.requireIntuition().recordFlashbackFeedback(sourceId, feedback));
  }

  @Remote
  async scanIntuitionFlashbacks(cueText: string): Promise<WireFlashbackMatch[]> {
    this.checkUser();
    if (typeof cueText !== 'string') {
      throw new RemoteError('gateway/bad-request', 'cueText must be a string', {});
    }
    return await this.requireIntuition().scanNow(cueText);
  }

  // ---- Direction B: Theory of Mind (Partner State & Tact) Actions ----

  @Remote
  async setTomEnabled(enabled: boolean): Promise<void> {
    this.checkUser();
    if (typeof enabled !== 'boolean') {
      throw new RemoteError('gateway/bad-request', 'enabled must be a boolean', {});
    }
    await this.userAction(() => this.requireTom().setEnabled(enabled));
  }

  @Remote
  async setPartnerOverride(input: WirePartnerOverrideInput): Promise<WireTomPanelModel> {
    this.checkUser();
    if (!isPlainRecord(input) || (input.state !== null && !isPartnerStateKind(input.state))) {
      throw new RemoteError('gateway/bad-request', 'valid partner state or null is required', {});
    }
    if (
      input.durationMinutes !== undefined &&
      (typeof input.durationMinutes !== 'number' || !Number.isFinite(input.durationMinutes))
    ) {
      throw new RemoteError('gateway/bad-request', 'durationMinutes must be a finite number', {});
    }
    return await this.userAction(() => this.requireTom().setManualOverride(input));
  }

  @Remote
  async resetTomBaseline(): Promise<WireTomPanelModel> {
    this.checkUser();
    return await this.userAction(() => this.requireTom().resetBaseline());
  }
}

export function ensureAsiRemote(ctx: Context): AsiRemote {
  const existing = (ctx as Context & { get(name: 'asi'): AsiRemote | undefined }).get('asi');
  if (existing) return existing;
  return new AsiRemote(ctx, {});
}
