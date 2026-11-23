import type { AsiDrivesServiceApi, AsiDrivesSnapshot, DriveSourceRegistration } from '@asi/sense-types';
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
}
