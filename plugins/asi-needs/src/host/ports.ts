import type { AsiSenseServiceApi } from '@asi/sense-types';
import type { CryDeliveryMode } from './cry.js';
import type { EndpointProbe } from './instinct.js';
import type { CompactionPort, JobsPort } from './sandbox.js';

export interface MaintenanceSessionsPort {
  createMaintenanceSession(requestedId: string, cwd: string, title: string): Promise<string>;
  hasSession(sessionId: string): boolean;
  runMaintenanceTurn(sessionId: string, prompt: string, signal: AbortSignal): Promise<void>;
  deliverCryToUserSession(
    targetSessionId: string | undefined,
    excludeSessionIds: ReadonlySet<string>,
    content: string,
    mode: CryDeliveryMode,
  ): Promise<boolean>;
}

export interface ClockPort {
  wall(): number;
  mono(): number;
}

export interface NeedsHostPorts {
  storageRoot: string;
  sense: AsiSenseServiceApi;
  jobs: JobsPort;
  compaction: CompactionPort;
  sessions: MaintenanceSessionsPort;
  clock?: ClockPort;
  probeEndpoint?: EndpointProbe;
}
