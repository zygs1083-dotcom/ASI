import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { BodyProbe } from '@asi/body-probe';
import type { Body, JobSummary, PowerMode } from '@asi/sense-types';

export type Unsubscribe = () => void;

export interface Clock {
  wall(): number;
  mono(): number;
}

export interface AgentEvent {
  type: 'created' | 'disposed' | 'pre-step' | 'post-step';
  sessionId: string;
  userInitiated?: boolean;
}

export interface ToolEvent {
  type: 'pre-execute' | 'post-execute';
  sessionId: string;
  toolCallId: string;
  pid?: number;
  ppid?: number;
  ancestors?: number[];
  cwd?: string;
  exitCode?: number;
  command?: string;
  at?: number;
}

export interface JobEvent {
  type: 'started' | 'exited';
  id: string;
  sessionId?: string;
  command?: string;
  pid?: number;
  ppid?: number;
  ancestors?: number[];
  cwd?: string;
  exitCode?: number;
  at?: number;
}

export type TokenSnapshot = NonNullable<Body['tokens']['value']> & {
  contextWindowSource?: 'configured' | 'catalog' | 'fallback';
};

export interface DshPort {
  onAgentEvent(cb: (event: AgentEvent) => Promise<void>): Unsubscribe;
  onTool(cb: (event: ToolEvent) => Promise<void>): Unsubscribe;
  onJob(cb: (event: JobEvent) => Promise<void>): Unsubscribe;
  tokenSnapshot(sessionId: string): Promise<TokenSnapshot | undefined>;
  modelJobs?(sessionId: string): JobSummary[];
  openPermissionSettings?(): Promise<void>;
}

export interface StoragePort {
  load(key: string): Promise<string | undefined>;
  save(key: string, json: string): Promise<void>;
}

export interface HelperSpawner {
  spawn(path: string): ChildProcessWithoutNullStreams | undefined;
}

export interface ProbeFactory {
  create(): Pick<BodyProbe, 'onSample' | 'start' | 'stop'>;
}

export interface SensePorts {
  dsh: DshPort;
  storage: StoragePort;
  helper: HelperSpawner;
  probe: ProbeFactory;
  clock: Clock;
}

export interface SenseOptions {
  platform?: string;
  helperPath?: string;
  intervalMs?: number;
  ecoIntervalMs?: number;
}

export type SenseActions = {
  pause(paused: boolean): Promise<void>;
  setSendTitles(enabled: boolean): Promise<void>;
  setPowerMode(mode: PowerMode, reason?: string): Promise<void>;
  openPermissionSettings(): Promise<void>;
};
