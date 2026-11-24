import type {
  AsiIntuitionServiceApi,
  FlashbackHitSummary,
  IntuitionScanOptions,
  IntuitionSnapshot,
  ProspectiveIntentionSummary,
  ProspectiveStatus,
} from '@asi/sense-types';
import { type Context, Service } from '@deepseek-ai/cordis';
import type { IntuitionRuntime } from '../runtime.js';

export class AsiIntuitionService extends Service implements AsiIntuitionServiceApi {
  constructor(
    ctx: Context,
    private readonly runtime: IntuitionRuntime,
  ) {
    super(ctx, 'asiIntuition');
  }

  snapshot(): IntuitionSnapshot {
    return this.runtime.serviceSnapshot();
  }

  scanFlashbacks(cueText: string, options?: IntuitionScanOptions): FlashbackHitSummary[] {
    return this.runtime.scanFlashbacks(cueText, options);
  }

  listIntentions(options?: { statuses?: readonly ProspectiveStatus[]; limit?: number }): ProspectiveIntentionSummary[] {
    return this.runtime.listIntentionSummaries(options);
  }

  subscribe(listener: () => void): () => void {
    return this.runtime.subscribe(listener);
  }
}
