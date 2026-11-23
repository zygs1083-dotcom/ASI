import type { AsiDrivesServiceApi, AsiSenseServiceApi } from '@asi/sense-types';
import type { CareExecFn } from './command.js';
import type { CareSessionBrief } from './discovery.js';

export interface CareOrphanJobInfo {
  id: string;
  owner?: string;
  label?: string;
  pid?: number;
  startedAt?: number;
}

export interface CareDshJobsPort {
  /** Active DSH jobs whose owning session no longer exists in live/persisted DSH state. */
  listOrphanJobs(): CareOrphanJobInfo[];
  /** Active PIDs managed by DSH jobs (never classify as external orphan ports). */
  listProtectedJobPids(): number[];
  killOrphanJob(id: string, owner: string | undefined, reason: string): 'requested' | 'already-finished';
}

export interface CareClock {
  wall(): number;
  mono(): number;
}

export interface CareHostPorts {
  storageRoot: string;
  homeDir: string;
  sense: AsiSenseServiceApi;
  drives: AsiDrivesServiceApi;
  listWorkspacePaths(): string[];
  listSessions(): CareSessionBrief[];
  listInternalRoots(): string[];
  jobs: CareDshJobsPort;
  exec?: CareExecFn;
  killProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  clock?: CareClock;
}
