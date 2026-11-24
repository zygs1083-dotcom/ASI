import type { AsiSleepServiceApi, SleepMemoryQueryOptions, SleepMemorySummary } from '@asi/sense-types';
import { type Context, Service } from '@deepseek-ai/cordis';
import type { SleepRuntime } from '../runtime.js';

export class AsiSleepService extends Service implements AsiSleepServiceApi {
  constructor(
    ctx: Context,
    private readonly runtime: Pick<SleepRuntime, 'listMemories' | 'subscribeVault'>,
  ) {
    super(ctx, 'asiSleep');
  }

  listMemories(options?: SleepMemoryQueryOptions): SleepMemorySummary[] {
    return this.runtime.listMemories(options);
  }

  subscribe(listener: () => void): () => void {
    return this.runtime.subscribeVault(listener);
  }
}
