import {
  type AsiSleepServiceApi,
  type SleepMemoryQueryOptions,
  type SleepMemorySummary,
  sanitizeForModel,
} from '@asi/sense-types';
import type { Context } from '@deepseek-ai/cordis';
import { principalOf, Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { MEMORY_KINDS, type MemoryKind } from '../../shared/types.ts';
import type { SleepActionsApi, SleepRuntime } from '../runtime.ts';
import type { SleepFramesSource } from './frames.ts';
import { toWireSleepPanelModel } from './wire.ts';
import type {
  WireMemoryCreateInput,
  WireMemoryKind,
  WireMemoryUpdateInput,
  WireMemoryViewItem,
  WireSleepConsolidationRecord,
  WireSleepPanelModel,
} from './wire-types.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    asiSleep: AsiSleepRemote;
  }
}

function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export class AsiSleepRemote extends TypertRemoteService implements AsiSleepServiceApi {
  constructor(
    ctx: Context,
    private readonly actions: SleepActionsApi,
    private readonly framesSource: SleepFramesSource,
    private readonly readOnlyRuntime?: Pick<SleepRuntime, 'listMemories' | 'subscribeVault'>,
  ) {
    super(ctx, 'asiSleep');
  }

  listMemories(options?: SleepMemoryQueryOptions): SleepMemorySummary[] {
    return this.readOnlyRuntime?.listMemories(options) ?? [];
  }

  subscribe(listener: () => void): () => void {
    return this.readOnlyRuntime?.subscribeVault(listener) ?? (() => {});
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
  async *frames(signal: AbortSignal): AsyncIterable<WireSleepPanelModel> {
    this.checkUser();
    for await (const frame of this.framesSource(signal)) {
      yield toWireSleepPanelModel(frame);
    }
  }

  @Remote
  async consolidateNow(): Promise<WireSleepConsolidationRecord> {
    this.checkUser();
    return await this.userAction(() => this.actions.consolidateNow());
  }

  @Remote
  async setAutoSleepPaused(paused: boolean): Promise<void> {
    this.checkUser();
    if (typeof paused !== 'boolean') {
      throw new RemoteError('gateway/bad-request', 'paused must be a boolean', {});
    }
    await this.userAction(() => this.actions.setAutoSleepPaused(paused));
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
    return await this.userAction(() => this.actions.createMemory(input));
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
    return await this.userAction(() => this.actions.updateMemory(id, patch));
  }

  @Remote
  async togglePin(id: string, pinned: boolean): Promise<WireMemoryViewItem> {
    this.checkUser();
    if (typeof id !== 'string' || !id.trim() || typeof pinned !== 'boolean') {
      throw new RemoteError('gateway/bad-request', 'id and boolean pinned are required', {});
    }
    return await this.userAction(() => this.actions.togglePin(id, pinned));
  }

  @Remote
  async deleteMemory(id: string): Promise<void> {
    this.checkUser();
    if (typeof id !== 'string' || !id.trim()) {
      throw new RemoteError('gateway/bad-request', 'id is required', {});
    }
    await this.userAction(() => this.actions.deleteMemory(id));
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
    return await this.actions.searchMemories(query, kind);
  }
}
