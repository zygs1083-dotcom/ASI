import type { Context } from '@deepseek-ai/cordis';
import { principalOf, Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { SenseActions } from '../runtime/ports.ts';
import type { FramesSource } from './frames.ts';
import { toWirePanelModel } from './wire.ts';
import type { WirePanelModel } from './wire-types.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    asiSense: AsiSenseRemote;
  }
}

export class AsiSenseRemote extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly actions: SenseActions,
    private readonly framesSource: FramesSource,
  ) {
    super(ctx, 'asiSense');
  }

  private checkUser(): void {
    if (principalOf(this.ctx.invocation)) throw new RemoteError('gateway/bad-request', 'User access required', {});
  }

  private async applied(result: Promise<unknown>): Promise<void> {
    const value = await result;
    if (value && typeof value === 'object' && 'applied' in value && value.applied === false) {
      const reason = 'reason' in value && typeof value.reason === 'string' ? value.reason : 'Action was not applied';
      throw new RemoteError('gateway/bad-request', reason, {});
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
  async *frames(signal: AbortSignal): AsyncIterable<WirePanelModel> {
    this.checkUser();
    for await (const frame of this.framesSource(signal)) yield toWirePanelModel(frame);
  }

  @Remote
  async toggleRule(id: string, enabled: boolean): Promise<void> {
    await this.userAction(() => this.actions.toggleRule(id, enabled));
  }

  @Remote
  async confirmRule(id: string): Promise<void> {
    await this.userAction(() => this.actions.confirmRule(id));
  }

  @Remote
  async deleteRule(id: string): Promise<void> {
    await this.userAction(() => this.actions.deleteRule(id));
  }

  @Remote
  async pause(paused: boolean): Promise<void> {
    await this.userAction(() => this.actions.pause(paused));
  }

  @Remote
  async setSendTitles(enabled: boolean): Promise<void> {
    await this.userAction(() => this.actions.setSendTitles(enabled));
  }

  @Remote
  async openPermissionSettings(): Promise<void> {
    await this.userAction(() => this.actions.openPermissionSettings());
  }

  @Remote
  async revertTuning(id: string): Promise<void> {
    await this.userAction(() => this.applied(this.actions.revertTuning(id)));
  }

  @Remote
  async lockParam(param: string, locked: boolean): Promise<void> {
    await this.userAction(() => this.applied(this.actions.lockParam(param, locked)));
  }

  @Remote
  async feedback(id: string, verdict: 'useful' | 'noise'): Promise<void> {
    await this.userAction(() => this.applied(this.actions.feedback(id, verdict)));
  }

  @Remote
  async acceptRebaseline(id: string): Promise<void> {
    await this.userAction(() => {
      if (typeof id !== 'string' || !id.trim()) {
        throw new RemoteError('gateway/bad-request', 'Rebaseline suggestion ID is required', {});
      }
      return this.applied(this.actions.acceptRebaseline(id));
    });
  }

  @Remote
  async resumeTuning(): Promise<void> {
    await this.userAction(() => this.actions.resumeTuning());
  }

  @Remote
  async resetTuning(): Promise<void> {
    await this.userAction(() => this.actions.resetTuning());
  }

  @Remote
  async retryTuningBackup(): Promise<void> {
    await this.userAction(() => this.actions.retryTuningBackup());
  }

  @Remote
  async dismissTuningBackup(): Promise<void> {
    await this.userAction(() => this.actions.dismissTuningBackup());
  }
}
