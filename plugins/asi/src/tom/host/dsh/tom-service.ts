import type { AsiTomServiceApi, PartnerStateSnapshot, TactGuidance } from '@asi/sense-types';
import { type Context, Service } from '@deepseek-ai/cordis';
import type { TomRuntime } from '../runtime.js';

export class AsiTomService extends Service implements AsiTomServiceApi {
  constructor(
    ctx: Context,
    private readonly runtime: Pick<TomRuntime, 'snapshot' | 'tactGuidance' | 'shouldDeferProactiveWork' | 'subscribe'>,
  ) {
    super(ctx, 'asiTom');
  }

  snapshot(): PartnerStateSnapshot {
    return this.runtime.snapshot();
  }

  tactGuidance(): TactGuidance {
    return this.runtime.tactGuidance();
  }

  shouldDeferProactiveWork(): boolean {
    return this.runtime.shouldDeferProactiveWork();
  }

  subscribe(listener: (snapshot: PartnerStateSnapshot) => void): () => void {
    return this.runtime.subscribe(listener);
  }
}
