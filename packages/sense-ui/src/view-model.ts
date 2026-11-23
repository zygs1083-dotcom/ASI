/**
 * `asi-needs` 统一侧栏视图模型：需求稳态张力、本能反射、后台自维护会话、求助卡、
 * 核心身体体征（含 5 分钟趋势环）与当前环境快照。
 */

import type {
  BodyHistory,
  FactStatus,
  HelpActionKind,
  HelpCard,
  HelpCardStatus,
  InstinctState,
  MaintenanceActor,
  MaintenanceOutcome,
  MaintenanceRecord,
  MaintenanceSessionStatus,
  MetricKey,
  MetricPoint,
  ModelConnectivity,
  NeedEvaluation,
  NeedKey,
  NeedZone,
  PowerMode,
  DisksFact as SharedDisksFact,
  DiskVolume as SharedDiskVolume,
  Fact as SharedFact,
  SourceRef,
  SystemStateValue,
  ThermalState,
} from '@asi/sense-types';
import { NEED_KEYS, THERMAL_ORDINAL } from '@asi/sense-types';

export type {
  BodyHistory,
  FactStatus,
  HelpActionKind,
  HelpCard,
  HelpCardStatus,
  InstinctState,
  MaintenanceActor,
  MaintenanceOutcome,
  MaintenanceRecord,
  MaintenanceSessionStatus,
  MetricKey,
  MetricPoint,
  ModelConnectivity,
  NeedEvaluation,
  NeedKey,
  NeedZone,
  PowerMode,
  SourceRef,
  SystemStateValue,
  ThermalState,
};
export { NEED_KEYS, THERMAL_ORDINAL };

/** UI 事实：共享 Fact 骨架 + 宿主可读原因与单调过期倒计时。 */
export type Fact<T> = SharedFact<T> & { reason?: string; staleInMs?: number };
export type DiskVolume = SharedDiskVolume & { staleInMs?: number };

export type DisksFact = Omit<SharedDisksFact, 'value'> & {
  value: DiskVolume[] | null;
  reason?: string;
  staleInMs?: number;
};

export interface JobSummary {
  id: string;
  name: string;
  status: string;
  owner?: string;
}

export interface TokenVitals {
  contextWindow?: number;
  contextWindowSource?: 'configured' | 'catalog' | 'fallback';
  contextUsed?: number;
  contextProjected?: number;
  sessionUsage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  balance?: { amount: number; currency: string; source: string };
  compressionThreshold?: number;
  balanceStatus?: FactStatus;
  balanceReason?: string;
  contextGrowthPerMinute?: number;
}

export interface Body {
  cpu: Fact<{
    usage: number;
    perCore: number[];
    load1: number;
    load5: number;
    load15: number;
  }>;
  memory: Fact<{
    total: number;
    used: number;
    pressure: 'normal' | 'warn' | 'critical';
    swapUsed: number;
    breakdown?: { app: number; wired: number; compressed: number; cached: number };
  }>;
  disks: DisksFact;
  battery: Fact<{
    percent: number;
    charging: boolean;
    minutesLeft?: number;
    powerState?: 'charging' | 'charged' | 'external' | 'battery';
    estimatePending?: boolean;
  } | null>;
  thermal: Fact<'nominal' | 'fair' | 'serious' | 'critical'>;
  network: Fact<{ online: boolean; rxBps: number; txBps: number }>;
  harnessProcess: Fact<{ rss: number; cpu: number; uptimeSec: number }>;
  tokens: Fact<TokenVitals>;
}

export interface SenseState {
  self: {
    activity: Fact<'idle' | 'thinking' | 'tool' | 'waiting-user'>;
    pending: Fact<{ inbox: number; jobs: number }>;
    tools: Fact<string[]>;
    permissions: Fact<Record<string, 'granted' | 'denied' | 'unknown'>>;
    body: Body;
  };
  env: {
    where: {
      model: Fact<{ provider: string; endpoint: string; local: boolean }>;
      harness: Fact<{ host: string; os: string; pid: number }>;
      observed: Fact<{ host: string; userSession: string }>;
      toolExec: Fact<{ host: string; cwd: string }>;
    };
    frontApp: Fact<{ name: string; bundleId: string; pid?: number; windowCount?: number }>;
    focusedWindow: Fact<{ title: string }>;
    activeJobs: Fact<JobSummary[]>;
    system?: Fact<SystemStateValue>;
  };
  observation: {
    sources: Record<string, { status: FactStatus; lastSignalAt: number; error?: string }>;
  };
}

type BaseUnit = 'bytes' | 'ratio' | 'tokens' | 'count';
type RateUnit = `${BaseUnit}/s` | `${BaseUnit}/min`;
export type DetailUnit = BaseUnit | RateUnit;

export interface NeedsPanelModel {
  now: number;
  paused: boolean;
  sendTitles: boolean;
  state: SenseState;
  history: BodyHistory;
  sampleIntervalsMs?: Partial<Record<MetricKey, number>>;
  needs: Record<NeedKey, NeedEvaluation>;
  overallZone: NeedZone;
  instinct: InstinctState;
  maintenanceSession: MaintenanceSessionStatus;
  helpCards: HelpCard[];
  recentMaintenance: MaintenanceRecord[];
}

export interface NeedsPanelProps {
  model: NeedsPanelModel;
  onPause: (paused: boolean) => void | Promise<void>;
  onToggleTitles: (enabled: boolean) => void | Promise<void>;
  onOpenPermissionSettings: () => void | Promise<void>;
  onApproveHelp: (cardId: string) => void | Promise<void>;
  onDismissHelp: (cardId: string) => void | Promise<void>;
  onOpenMaintenanceSession: () => void | Promise<void>;
  onTriggerCheck: () => void | Promise<void>;
}
