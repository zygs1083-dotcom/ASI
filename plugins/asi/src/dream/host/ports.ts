import type { AsiDrivesServiceApi, AsiSenseServiceApi, AsiSleepServiceApi, AsiTomServiceApi } from '@asi/sense-types';
import type { SkillCreateDraftInput, SkillDraftViewItem } from '../../growth/shared/types.js';
import type { MemoryCreateInput, MemoryViewItem } from '../../sleep/shared/types.js';

export interface DreamClock {
  wall(): number;
  mono(): number;
}

export interface DreamTurnTrajectoryInput {
  turnId: string;
  sessionId: string;
  sessionTitle?: string;
  cwd?: string;
  at: number;
  userText: string;
  assistantText: string;
  toolNames: string[];
  failedToolCount: number;
}

export interface DreamConversationPort {
  /** Return completed ordinary user turns across sessions (excluding subagent & internal sandbox sessions). */
  listCompletedOrdinaryTurns(): DreamTurnTrajectoryInput[];
  /** True if any ordinary user conversation agent is currently running a turn. */
  anyOrdinarySessionRunning(): boolean;
  /** Return known non-internal workspace paths from workspaceRegistry and ordinary sessions. */
  listKnownWorkspaces(): string[];
  /** Map ordinary `sessionId -> workspace cwd` (live and cold hydrated sessions). */
  listSessionWorkspaces(): ReadonlyMap<string, string>;
  /** Subscribe to activity in ordinary user conversations; returns unsubscribe disposer. */
  onOrdinaryActivity(listener: () => void): () => void;
  /** Optional cold-session hydration from persisted session corpus (`ctx.sessionQuery`) on startup. */
  warmColdSessions?(signal: AbortSignal): Promise<void>;
}

export interface DreamMemoryAdoptionBridge {
  createMemory(input: MemoryCreateInput): Promise<MemoryViewItem>;
}

export interface DreamSkillDraftBridge {
  createManualDraft(input: SkillCreateDraftInput): Promise<SkillDraftViewItem>;
}

export interface DreamHostPorts {
  storageRoot: string;
  homeDir?: string;
  excludedInternalRoots?: readonly (string | undefined)[];
  clock?: DreamClock;
  sense: AsiSenseServiceApi;
  drives: AsiDrivesServiceApi;
  getSleep: () => AsiSleepServiceApi | undefined;
  onSleepChanged?: (listener: () => void) => () => void;
  tom?: Pick<AsiTomServiceApi, 'shouldDeferProactiveWork' | 'subscribe'>;
  conversations: DreamConversationPort;
  memoryAdoption?: DreamMemoryAdoptionBridge;
  skillDrafts?: DreamSkillDraftBridge;
  llmDream?: (prompt: string, signal: AbortSignal) => Promise<string | undefined>;
}
