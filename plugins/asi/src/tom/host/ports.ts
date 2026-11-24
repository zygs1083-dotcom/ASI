/**
 * Hexagonal host ports for ASI Theory of Mind (`src/tom/`).
 */

import type { AsiDrivesServiceApi, AsiSenseServiceApi, AsiSleepServiceApi } from '@asi/sense-types';

export interface OrdinaryPromptSignal {
  sessionId: string;
  at: number;
  charCount: number;
}

export interface OrdinaryTurnSignal {
  sessionId: string;
  at: number;
  outcome: 'completed' | 'interrupted' | 'aborted' | 'error';
}

export interface OrdinaryApprovalSignal {
  sessionId: string;
  at: number;
  latencyMs: number;
}

export interface TomSessionSignalsPort {
  hasActiveOrdinarySession(): boolean;
  onUserPrompt(cb: (signal: OrdinaryPromptSignal) => void): () => void;
  onTurnSettled(cb: (signal: OrdinaryTurnSignal) => void): () => void;
  onApprovalResolved(cb: (signal: OrdinaryApprovalSignal) => void): () => void;
}

export interface TomHostPorts {
  storageRoot: string;
  now?: () => number;
  sense: Pick<AsiSenseServiceApi, 'snapshot' | 'subscribe' | 'recentSignals'>;
  drives?: Pick<AsiDrivesServiceApi, 'snapshot' | 'subscribe' | 'registerSource' | 'notifySourceChanged'>;
  sleep?: Pick<AsiSleepServiceApi, 'listMemories' | 'subscribe'>;
  sessions: TomSessionSignalsPort;
}
