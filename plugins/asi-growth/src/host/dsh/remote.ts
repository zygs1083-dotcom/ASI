import { sanitizeForModel } from '@asi/sense-types';
import type { Context } from '@deepseek-ai/cordis';
import { principalOf, Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { SkillScope } from '../../shared/types.ts';
import type { GrowthActionsApi } from '../runtime.ts';
import type { GrowthFramesSource } from './frames.ts';
import { toWireGrowthPanelModel } from './wire.ts';
import type {
  WireArchivedSkillViewItem,
  WireGrowthPanelModel,
  WireGrowthSynthesisRecord,
  WireSkillCreateDraftInput,
  WireSkillDraftViewItem,
  WireSkillExportResult,
  WireSkillScopeUpdateInput,
  WireSkillUpdateMarkdownInput,
  WireSkillViewItem,
} from './wire-types.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    asiGrowth: AsiGrowthRemote;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isSkillScope(value: unknown): value is SkillScope {
  return value === 'global' || value === 'workspace';
}

export class AsiGrowthRemote extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly actions: GrowthActionsApi,
    private readonly framesSource: GrowthFramesSource,
  ) {
    super(ctx, 'asiGrowth');
  }

  private checkUser(): void {
    if (principalOf(this.ctx.invocation)) {
      throw new RemoteError('gateway/bad-request', 'User access required', {});
    }
  }

  private async userAction<T>(action: () => Promise<T>): Promise<T> {
    this.checkUser();
    const revBefore = this.framesSource.revision?.();
    try {
      return await action();
    } catch (err) {
      if (err instanceof RemoteError) throw err;
      const safeMessage = err instanceof Error ? sanitizeForModel(err.message) : 'Action failed';
      throw new RemoteError('gateway/bad-request', safeMessage || 'Action failed', {});
    } finally {
      this.framesSource.invalidate?.(revBefore);
    }
  }

  @Remote({ mode: 'stream' })
  async *frames(signal: AbortSignal): AsyncIterable<WireGrowthPanelModel> {
    this.checkUser();
    for await (const frame of this.framesSource(signal)) {
      yield toWireGrowthPanelModel(frame);
    }
  }

  @Remote
  async synthesizeNow(): Promise<WireGrowthSynthesisRecord> {
    this.checkUser();
    return await this.userAction(() => this.actions.synthesizeNow());
  }

  @Remote
  async setAutoGrowthPaused(paused: boolean): Promise<void> {
    this.checkUser();
    if (typeof paused !== 'boolean') {
      throw new RemoteError('gateway/bad-request', 'paused must be a boolean', {});
    }
    await this.userAction(() => this.actions.setAutoGrowthPaused(paused));
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
    return await this.userAction(() => this.actions.createManualDraft(input));
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
    return await this.userAction(() => this.actions.updateDraft(draftId, patch));
  }

  @Remote
  async approveDraft(draftId: string): Promise<WireSkillViewItem> {
    this.checkUser();
    if (typeof draftId !== 'string' || !draftId.trim()) {
      throw new RemoteError('gateway/bad-request', 'draftId is required', {});
    }
    return await this.userAction(() => this.actions.approveDraft(draftId));
  }

  @Remote
  async rejectDraft(draftId: string): Promise<void> {
    this.checkUser();
    if (typeof draftId !== 'string' || !draftId.trim()) {
      throw new RemoteError('gateway/bad-request', 'draftId is required', {});
    }
    await this.userAction(() => this.actions.rejectDraft(draftId));
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
    return await this.userAction(() => this.actions.updateSkill(name, patch));
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
    return await this.userAction(() => this.actions.setSkillScope(name, input));
  }

  @Remote
  async setSkillEnabled(name: string, enabled: boolean): Promise<WireSkillViewItem> {
    this.checkUser();
    if (typeof name !== 'string' || !name.trim() || typeof enabled !== 'boolean') {
      throw new RemoteError('gateway/bad-request', 'name and boolean enabled are required', {});
    }
    return await this.userAction(() => this.actions.setSkillEnabled(name, enabled));
  }

  @Remote
  async archiveSkill(name: string): Promise<WireArchivedSkillViewItem> {
    this.checkUser();
    if (typeof name !== 'string' || !name.trim()) {
      throw new RemoteError('gateway/bad-request', 'name is required', {});
    }
    return await this.userAction(() => this.actions.archiveSkill(name));
  }

  @Remote
  async restoreSkill(name: string): Promise<WireSkillViewItem> {
    this.checkUser();
    if (typeof name !== 'string' || !name.trim()) {
      throw new RemoteError('gateway/bad-request', 'name is required', {});
    }
    return await this.userAction(() => this.actions.restoreSkill(name));
  }

  @Remote
  async deleteArchivedSkill(name: string): Promise<void> {
    this.checkUser();
    if (typeof name !== 'string' || !name.trim()) {
      throw new RemoteError('gateway/bad-request', 'name is required', {});
    }
    await this.userAction(() => this.actions.deleteArchivedSkill(name));
  }

  @Remote
  async exportSkillToWorkspace(name: string, workspacePath: string): Promise<WireSkillExportResult> {
    this.checkUser();
    if (typeof name !== 'string' || !name.trim() || typeof workspacePath !== 'string' || !workspacePath.trim()) {
      throw new RemoteError('gateway/bad-request', 'name and workspacePath are required', {});
    }
    return await this.userAction(() => this.actions.exportSkillToWorkspace(name, workspacePath));
  }
}
