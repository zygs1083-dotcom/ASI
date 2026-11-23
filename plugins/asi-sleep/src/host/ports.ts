import type { AsiDrivesServiceApi, AsiSenseServiceApi } from '@asi/sense-types';
import type { ConversationTurnInput } from './consolidator.js';

export interface SleepClock {
  wall(): number;
  mono(): number;
}

export interface SleepConversationPort {
  /** Return completed ordinary user turns (strictly excluding subagent & internal sandbox sessions). */
  listCompletedOrdinaryTurns(): ConversationTurnInput[];
  /** True if any ordinary user conversation agent is currently running a turn. */
  anyOrdinarySessionRunning(): boolean;
  /** Subscribe to activity in ordinary user conversations; returns unsubscribe disposer. */
  onOrdinaryActivity(listener: () => void): () => void;
}

export interface SleepHostPorts {
  storageRoot: string;
  homeDir?: string;
  clock?: SleepClock;
  sense: AsiSenseServiceApi;
  drives: AsiDrivesServiceApi;
  conversations: SleepConversationPort;
  llmExtract?: (prompt: string, signal: AbortSignal) => Promise<string | undefined>;
}
