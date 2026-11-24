import type { AsiDrivesServiceApi, AsiSenseServiceApi, AsiSleepServiceApi } from '@asi/sense-types';
import type { OrdinaryTurnTrajectoryInput } from './evidence.js';

export interface GrowthClock {
  wall(): number;
  mono(): number;
}

export interface SkillTurnLifecycleEvent {
  sessionId: string;
  skillNames: readonly string[];
  completed: boolean;
  at: number;
}

export interface GrowthConversationPort {
  listCompletedOrdinaryTurns(): OrdinaryTurnTrajectoryInput[];
  anyOrdinarySessionRunning(): boolean;
  listKnownWorkspaces(): string[];
  listSessionWorkspaces?(): ReadonlyMap<string, string>;
  onOrdinaryActivity(listener: () => void): () => void;
  onSkillTurnCompleted?(listener: (ev: SkillTurnLifecycleEvent) => void): () => void;
  warmColdSessions?(signal: AbortSignal): Promise<void>;
}

export interface GrowthHostPorts {
  storageRoot: string;
  homeDir?: string;
  excludedInternalRoots?: readonly string[];
  clock?: GrowthClock;
  sense: AsiSenseServiceApi;
  drives: AsiDrivesServiceApi;
  getSleep?: () => AsiSleepServiceApi | undefined;
  onSleepChanged?: (listener: () => void) => () => void;
  conversations: GrowthConversationPort;
  llmSynthesize?: (prompt: string, signal: AbortSignal) => Promise<string | undefined>;
}
