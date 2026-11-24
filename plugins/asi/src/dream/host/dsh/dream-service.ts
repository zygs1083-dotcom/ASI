import type { AsiDreamServiceApi, DreamInsightQueryOptions, DreamInsightSummary } from '@asi/sense-types';
import { type Context, Service } from '@deepseek-ai/cordis';
import type { DreamRuntime } from '../runtime.js';

export class AsiDreamService extends Service implements AsiDreamServiceApi {
  constructor(
    ctx: Context,
    private readonly runtime: Pick<DreamRuntime, 'listInsights' | 'subscribeInsights'>,
  ) {
    super(ctx, 'asiDream');
  }

  listInsights(options?: DreamInsightQueryOptions): DreamInsightSummary[] {
    return this.runtime.listInsights(options);
  }

  subscribe(listener: () => void): () => void {
    return this.runtime.subscribeInsights(listener);
  }
}
