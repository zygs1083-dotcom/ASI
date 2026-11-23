import type {
  AsiDrivesServiceApi,
  AsiDrivesSnapshot,
  DriveHelpCardProposal,
  DriveSourceRegistration,
  HelpCard,
} from '@asi/sense-types';
import { type Context, Service } from '@deepseek-ai/cordis';
import type { NeedsDrivesRuntimeApi } from '../runtime.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    asiDrives: AsiDrivesServiceApi;
  }
}

export class AsiDrivesService extends Service implements AsiDrivesServiceApi {
  constructor(
    ctx: Context,
    private readonly runtime: { readonly drives: NeedsDrivesRuntimeApi },
  ) {
    super(ctx, 'asiDrives');
  }

  snapshot(): AsiDrivesSnapshot {
    return this.runtime.drives.snapshot();
  }

  subscribe(listener: (snapshot: AsiDrivesSnapshot) => void): () => void {
    return this.runtime.drives.subscribe(listener);
  }

  registerSource(registration: DriveSourceRegistration): () => void {
    return this.runtime.drives.registerSource(registration);
  }

  notifySourceChanged(sourceId?: string): void {
    this.runtime.drives.notifySourceChanged(sourceId);
  }

  proposeHelpCard(sourceId: string, proposal: DriveHelpCardProposal): Promise<HelpCard> {
    return this.runtime.drives.proposeHelpCard(sourceId, proposal);
  }

  resolveHelpCards(
    sourceId: string,
    filter?: { driveKey?: string; actionTarget?: string; exceptActionTargets?: readonly string[] },
  ): Promise<number> {
    return this.runtime.drives.resolveHelpCards(sourceId, filter);
  }
}
