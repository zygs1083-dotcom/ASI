/**
 * Host Dependency-Injection Ports for `src/intuition` (`ports.ts`).
 */

import type { AsiDrivesServiceApi, AsiSenseServiceApi, AsiSleepServiceApi } from '@asi/sense-types';

export interface UserPreStepCue {
  sessionId: string;
  cwd?: string;
  promptText: string;
}

export interface ToolPreExecuteCue {
  sessionId: string;
  cwd?: string;
  toolName: string;
  targetText: string;
}

export interface ToolResultCue {
  sessionId: string;
  cwd?: string;
  toolName: string;
  targetText: string;
  failed: boolean;
  errorSummary?: string;
}

export interface JobFinishedCue {
  jobId: string;
  ownerSessionId?: string;
  label?: string;
  status: string;
}

export interface IntuitionSessionsPort {
  /** Return ordinary active user session IDs (excluding internal ASI daemons, subagents, and archived sessions). */
  listOrdinarySessionIds(): string[];
  /** Return validated working directory for an ordinary user session, if known. */
  getSessionCwd(sessionId: string): string | undefined;
  /**
   * Park or coalesce a message at the tail of an ordinary session's `next-turn` inbox
   * WITHOUT waking an idle agent (`wakeup = false`), preserving 100% prefix Prompt Cache.
   */
  enqueueNextTurn(sessionId: string | undefined, content: string): boolean;
  /**
   * Queue model-facing context for the nearest next step boundary (`agent.inject`)
   * during an active multi-step tool loop, without waking idle drivers.
   */
  injectNextStep(sessionId: string, content: string): boolean;
}

export interface IntuitionEventsPort {
  onSessionCreated(cb: (ev: { sessionId: string; cwd?: string }) => void): () => void;
  onSessionTurnClaimed(cb: (sessionId: string) => void): () => void;
  onUserPreStep(cb: (cue: UserPreStepCue) => Promise<string | null> | string | null): () => void;
  onToolPreExecute(cb: (cue: ToolPreExecuteCue) => Promise<void> | void): () => void;
  onToolResult(cb: (cue: ToolResultCue) => void): () => void;
  onJobFinished(cb: (cue: JobFinishedCue) => void): () => void;
  onSleepConsolidationCompleted?(cb: () => void): () => void;
}

export interface IntuitionHostPorts {
  storageRoot: string;
  now?: () => number;
  sense: AsiSenseServiceApi;
  drives?: AsiDrivesServiceApi;
  sleep?: AsiSleepServiceApi;
  sessions: IntuitionSessionsPort;
  events: IntuitionEventsPort;
}
