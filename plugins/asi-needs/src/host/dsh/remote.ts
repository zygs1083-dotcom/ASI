import type { Context } from '@deepseek-ai/cordis';
import { principalOf, Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { NeedsActions } from '../runtime.ts';
import type { FramesSource } from './frames.ts';
import { toWireNeedsPanelModel } from './wire.ts';
import type { WireNeedsPanelModel } from './wire-types.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    asiNeeds: AsiNeedsRemote;
  }
}

export class AsiNeedsRemote extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly actions: NeedsActions,
    private readonly framesSource: FramesSource,
  ) {
    super(ctx, 'asiNeeds');
  }

  private checkUser(): void {
    if (principalOf(this.ctx.invocation)) {
      throw new RemoteError('gateway/bad-request', 'User access required', {});
    }
  }

  private async userAction(action: () => Promise<void>): Promise<void> {
    this.checkUser();
    try {
      await action();
    } finally {
      this.framesSource.invalidate?.();
    }
  }

  @Remote({ mode: 'stream' })
  async *frames(signal: AbortSignal): AsyncIterable<WireNeedsPanelModel> {
    this.checkUser();
    for await (const frame of this.framesSource(signal)) {
      yield toWireNeedsPanelModel(frame);
    }
  }

  @Remote
  async pause(paused: boolean): Promise<void> {
    if (typeof paused !== 'boolean') {
      throw new RemoteError('gateway/bad-request', 'paused must be a boolean', {});
    }
    await this.userAction(() => this.actions.pause(paused));
  }

  @Remote
  async setSendTitles(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') {
      throw new RemoteError('gateway/bad-request', 'enabled must be a boolean', {});
    }
    await this.userAction(() => this.actions.setSendTitles(enabled));
  }

  @Remote
  async openPermissionSettings(): Promise<void> {
    await this.userAction(() => this.actions.openPermissionSettings());
  }

  @Remote
  async approveHelp(cardId: string): Promise<void> {
    if (typeof cardId !== 'string' || !cardId.trim()) {
      throw new RemoteError('gateway/bad-request', 'cardId is required', {});
    }
    await this.userAction(() => this.actions.approveHelp(cardId));
  }

  @Remote
  async dismissHelp(cardId: string): Promise<void> {
    if (typeof cardId !== 'string' || !cardId.trim()) {
      throw new RemoteError('gateway/bad-request', 'cardId is required', {});
    }
    await this.userAction(() => this.actions.dismissHelp(cardId));
  }

  @Remote
  async openMaintenanceSession(): Promise<string> {
    this.checkUser();
    try {
      return await this.actions.openMaintenanceSession();
    } finally {
      this.framesSource.invalidate?.();
    }
  }

  @Remote
  async triggerCheck(): Promise<void> {
    await this.userAction(() => this.actions.triggerCheck());
  }
}
