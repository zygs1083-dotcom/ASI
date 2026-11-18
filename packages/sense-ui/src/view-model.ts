// 侧栏面板视图模型；事实骨架来自 @asi/sense-types（docs/DESIGN.md §2.2/§2.2b/§2.3），
// UI 侧只追加可选 reason、内存细分、token 生命体征与本地面板任务摘要投影。

import type {
  FactStatus,
  GlobalFileWatchValue,
  DisksFact as SharedDisksFact,
  DiskVolume as SharedDiskVolume,
  Fact as SharedFact,
  SourceRef,
  SystemStateValue,
} from '@asi/sense-types';
import type { TuningState } from './tuning-model';

export type {
  FactStatus,
  GlobalFileWatchStatus,
  GlobalFileWatchValue,
  SourceRef,
  SystemStateValue,
} from '@asi/sense-types';
export type { TuningEntry, TuningParam, TuningState } from './tuning-model';

/** UI 事实：共享 Fact 骨架 + 宿主可读原因（denied/unavailable 时展示）。 */
export type Fact<T> = SharedFact<T> & { reason?: string; staleInMs?: number };
export type DiskVolume = SharedDiskVolume & { staleInMs?: number };

/**
 * 磁盘事实：value 为各挂载点独立读数，父级状态只兜底缺省卷。
 * unavailableMounts 声明读不出的挂载点：即使 value 里带记录也一律不展示。
 */
export type DisksFact = Omit<SharedDisksFact, 'value'> & {
  value: DiskVolume[] | null;
  reason?: string;
  staleInMs?: number;
};

export interface Signal {
  id: string;
  kind: string;
  at: number;
  source: SourceRef;
  subject: string;
  data: Record<string, unknown>;
  cause?: 'agent' | 'user' | 'unknown';
}

export interface JobSummary {
  id: string;
  name: string;
  status: string;
  owner?: string;
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
    /** 内存细分（原始字节）；未提供时 UI 只画 used/free，不虚构比例。 */
    breakdown?: { app: number; wired: number; compressed: number; cached: number };
  }>;
  disks: DisksFact;
  battery: Fact<{ percent: number; charging: boolean; minutesLeft?: number } | null>;
  thermal: Fact<'nominal' | 'fair' | 'serious' | 'critical'>;
  network: Fact<{ online: boolean; rxBps: number; txBps: number }>;
  harnessProcess: Fact<{ rss: number; cpu: number; uptimeSec: number }>;
  tokens: Fact<TokenVitals>;
}

export interface TokenVitals {
  contextWindow?: number;
  /**
   * 上下文窗口来源：configured=用户配置 / catalog=模型目录 / fallback=宿主回退估值。
   * fallback=容量未确认：环与占用百分比淡显，不展示余量/填满估算、不参与阈值告警；
   * 缺省保持旧版行为（视为已确认）。
   */
  contextWindowSource?: 'configured' | 'catalog' | 'fallback';
  contextUsed?: number;
  contextProjected?: number;
  /** input 已包含 cacheRead（缓存命中率 = cacheRead / input）。 */
  sessionUsage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  balance?: { amount: number; currency: string; source: string };
  /** 自动压缩阈值（绝对 token 数），提供方给出才有，不虚构默认值 */
  compressionThreshold?: number;
  balanceStatus?: FactStatus;
  balanceReason?: string;
  /** 宿主投影的上下文增速（tokens/分钟）；未提供或为 0 时 UI 不估算填满时间。 */
  contextGrowthPerMinute?: number;
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
    frontApp: Fact<{ name: string; bundleId: string }>;
    focusedWindow: Fact<{ title: string }>;
    activeJobs: Fact<JobSummary[]>;
    watchedPaths: Fact<Record<string, { lastChange: number; changes: number }>>;
    globalFileWatch?: Fact<GlobalFileWatchValue>;
    system?: Fact<SystemStateValue>;
  };
  observation: {
    sources: Record<string, { status: FactStatus; lastSignalAt: number; error?: string }>;
  };
}

export type EventLevel = 'record' | 'context' | 'wake' | 'suppressed';

// 事件/detail 数值单位：基础单位 + 显式导数单位（/s、/min）。
// 网络 history 序列本来就是 B/s，旧版标注 'bytes' 一律按 bytes/s 解读。
type BaseUnit = 'bytes' | 'ratio' | 'tokens' | 'count';
type RateUnit = `${BaseUnit}/s` | `${BaseUnit}/min`;
export type DetailUnit = BaseUnit | RateUnit;

/**
 * 事件附加展示的宿主投影数据（结构化 detail）。
 * UI 只负责渲染，不从 Signal.data 猜测字段、不做任何估算。
 */
export type EventDetail =
  | {
      kind: 'body.rate';
      metric: string;
      windowMs: number;
      delta: number;
      unit: DetailUnit;
      timeToFloorMs?: number;
    }
  | {
      kind: 'body.anomaly';
      metric: string;
      current: number;
      baseline: number;
      deviation: number;
      unit: DetailUnit;
    }
  | {
      kind: 'file.burst';
      directory: string;
      windowMs: number;
      created: number;
      modified: number;
      deleted: number;
      excessiveDeletion: boolean;
      rolledUp?: boolean;
    }
  | {
      kind: 'file.activity';
      directory: string;
      windowMs: number;
      created: number;
      modified: number;
      deleted: number;
      files: string[];
      rolledUp?: number;
      degraded?: boolean;
    };

export interface SenseEvent {
  signal: Signal;
  level: EventLevel;
  reason: string;
  cause: 'agent' | 'user' | 'unknown';
  count?: number;
  ruleName?: string;
  detail?: EventDetail;
  /** 用户对该事件的反馈，状态只由 model 决定（UI 不本地记忆）。 */
  feedback?: 'useful' | 'noise';
}

export interface SenseRule {
  id: string;
  name: string;
  enabled: boolean;
  confirmed: boolean;
  match: { kind: string; subject?: string; where?: Record<string, unknown> };
  level: 'record' | 'context' | 'wake';
  note?: string;
  createdBy: 'user' | 'agent';
  expiresAt?: number;
}

export interface MetricPoint {
  at: number;
  value: number;
}

export interface BodyHistory {
  cpu: MetricPoint[];
  memory: MetricPoint[];
  /** 电池电量百分比（0..100）；无电池时为空数组。 */
  battery: MetricPoint[];
  /** 温控档位序数：nominal 0 / fair 1 / serious 2 / critical 3。 */
  thermal: MetricPoint[];
  networkRx: MetricPoint[];
  networkTx: MetricPoint[];
  processCpu: MetricPoint[];
  processRss: MetricPoint[];
  tokens: MetricPoint[];
  disks: Record<string, MetricPoint[]>;
}

export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical';

export const THERMAL_ORDINAL: Record<ThermalState, number> = {
  nominal: 0,
  fair: 1,
  serious: 2,
  critical: 3,
};

export type ThresholdLayer = 'floor' | 'rate' | 'baseline';

export type MetricKey =
  | 'cpu'
  | 'memory'
  | 'battery'
  | 'thermal'
  | 'networkRx'
  | 'networkTx'
  | 'processCpu'
  | 'processRss'
  | 'tokens'
  | `disk:${string}`;

export interface MetricInsight {
  /** 与 history 同单位的学习基线区间；未提供则不画基线带。 */
  baseline?: { low: number; high: number };
  /**
   * 宿主提供的各层阈值。value 默认与 history 同单位；
   * unit 显式给出且与 history 单位不一致时 UI 只在明细中展示、不画线。
   */
  thresholds?: Partial<Record<ThresholdLayer, { value: number; source: string; unit?: DetailUnit }>>;
  sources: ThresholdLayer[];
  triggered: ThresholdLayer[];
  severity?: 'warn' | 'critical';
  /**
   * 宿主当前投影：ratePerMinute 方向 磁盘/电池负=耗尽、其余正=增长。
   * UI 只在 asOf ≤ now、now-asOf ≤ 2×间隔、速率为恶化方向时采用；
   * 更新的匹配 body.rate 信号使旧投影失效。
   */
  currentEta?: { asOf: number; sampleIntervalMs: number; timeToThresholdMs?: number; ratePerMinute: number };
}

/** 基线学习进度；UI 只展示，不推断截止时间与统计量。 */
export interface LearningState {
  status: 'learning' | 'ready';
  collectedMs: number;
  targetMs: number;
  confidence?: number;
}

/** 单日/单月应用前台使用统计。 */
export interface TimelineAppSummary {
  app: string;
  foregroundMs: number;
  switches: number;
}

/** 单日汇总摘要（由 runtime DailySummary / 实时累加器投影）。 */
export interface TimelineDaySummary {
  /** 本地日历日期（YYYY-MM-DD）。 */
  date: string;
  /** 前台时长 Top 5 应用（按 foregroundMs 降序）。 */
  topApps: TimelineAppSummary[];
  /** 唤醒投递次数（deliveries.wake）。 */
  wakeCount: number;
  /** 告警次数（bodyAnomalies.total）。 */
  alertCount: number;
  /** 文件 burst 次数（fileBursts.events 累计）。 */
  fileBurstCount: number;
  /** 系统睡眠次数。 */
  sleepCount: number;
  /** 系统睡眠累计时长（ms）。 */
  sleepDurationMs: number;
  /** 锁屏累计时长（ms）。 */
  lockDurationMs: number;
  /** 观测覆盖时长（ms）。 */
  observedMs: number;
}

/**
 * 24h 指标序列单位：
 * - `'ratio'`: `0..1` 比例（CPU 利用率、内存已用占比 `used / total`）。
 * - `'percent'`: `0..100` 百分比（电池电量）。
 * - `'bytes'`: 字节（磁盘可用空间 `diskFree`、缺内存总量时的已用字节回退）。
 */
export type TimelineMetricUnit = 'ratio' | 'percent' | 'bytes';
export type TimelineMetricKey = 'cpu' | 'memory' | 'disk' | 'battery';

/** 5 分钟桶聚合统计点（`at` 为桶起始 UTC 毫秒；数值单位见所属 TimelineMetricSeries.unit）。 */
export interface TimelineMetricBucket {
  at: number;
  min: number;
  avg: number;
  max: number;
}

export interface TimelineMetricSeries {
  unit: TimelineMetricUnit;
  /** 按时间升序排列的 5 分钟桶（24h 最多 288 点）。 */
  points: TimelineMetricBucket[];
}

export interface TimelineMetrics {
  /** CPU 利用率（unit: 'ratio'，0..1）。 */
  cpu?: TimelineMetricSeries;
  /** 内存占用占比（unit: 'ratio'，0..1；缺总量时回退为 unit: 'bytes'）。 */
  memory?: TimelineMetricSeries;
  /** 磁盘可用空间（unit: 'bytes'）。 */
  disk?: TimelineMetricSeries;
  /** 电池电量（unit: 'percent'，0..100）。 */
  battery?: TimelineMetricSeries;
}

/** 最近一次离开汇总。 */
export interface TimelineAwaySummary {
  awayFrom: number;
  returnAt: number;
  durationMs: number;
  hasAnomaly: boolean;
  /** 异常条目列表（无异常时为空数组）。 */
  anomalies: string[];
  /** 是否已推送给 agent（wake/context 投递）。 */
  pushed: boolean;
}

/** 侧栏「历史」区块时间线视图模型。 */
export interface TimelineState {
  today?: TimelineDaySummary;
  yesterday?: TimelineDaySummary;
  metrics?: TimelineMetrics;
  lastAway?: TimelineAwaySummary;
}

/** 月度总结摘要（按需通过 loadMonthly 拉取，不进入每帧）。 */
export interface MonthlySummaryView {
  month: string;
  coveredDays: number;
  daysInMonth: number;
  partial?: boolean;
  pendingDays?: string[];
  note?: string;
  topApps: TimelineAppSummary[];
  wakeCount: number;
  alertCount: number;
  fileBurstCount: number;
  sleepCount: number;
  sleepDurationMs: number;
  lockDurationMs: number;
  observedMs: number;
}

export type MonthlySummaryLoadResult =
  | { available: true; summary: MonthlySummaryView }
  | { available: false; reason: string };

export interface SensePanelModel {
  target?: {
    mode: 'auto' | 'pinned';
    sessionId?: string;
    sessions: { id: string; title: string; updatedAt: number; running: boolean }[];
    notice?: boolean;
    unavailable?: boolean;
  };
  state: SenseState;
  events: SenseEvent[];
  rules: SenseRule[];
  paused: boolean;
  sendTitles: boolean;
  now: number;
  sampleIntervalsMs?: Partial<Record<MetricKey, number>>;
  history: BodyHistory;
  insights?: Partial<Record<MetricKey, MetricInsight>>;
  learning?: LearningState;
  tuning?: TuningState;
  timeline?: TimelineState;
}

export interface SensePanelProps {
  model: SensePanelModel;
  onSelectTarget?: (id?: string) => Promise<void>;
  onDismissTargetNotice?: () => Promise<void>;
  targetCopy?: {
    label: string;
    auto: string;
    search: string;
    empty: string;
    untitled: string;
    running: string;
    unavailable: string;
    reset: string;
    dismiss: string;
    failed: string;
    locale: string;
  };
  onToggleRule: (id: string, enabled: boolean) => void;
  onConfirmRule: (id: string) => void;
  onDeleteRule: (id: string) => void;
  onPause: (paused: boolean) => void;
  onToggleTitles: (enabled: boolean) => void;
  onToggleGlobalFileWatch?: (enabled: boolean) => void;
  onRetryGlobalFileWatch?: () => void | Promise<void>;
  onAddFileExclusion?: (pattern: string) => Promise<void>;
  onRemoveFileExclusion?: (pattern: string) => Promise<void>;
  onOpenPermissionSettings: () => void;
  onRevertTuning: (id: string) => void;
  onLockParam: (key: string, locked: boolean) => void;
  onFeedback: (signalId: string, value: 'useful' | 'noise') => void;
  onResumeTuning: () => Promise<void>;
  onResetTuning: () => Promise<void>;
  onAcceptRebaseline: (id: string) => Promise<void>;
  onRetryTuningBackup?: () => Promise<void>;
  onDismissTuningBackup?: () => Promise<void>;
  onListMonths?: () => Promise<string[]>;
  onLoadMonthly?: (month: string) => Promise<MonthlySummaryLoadResult>;
  onClearHistory?: () => Promise<void>;
  tuningCopy?: {
    backupFailed: string;
    saveFailed: string;
    permission: string;
    noSpace: string;
    readOnly: string;
    snapshotChanged: string;
    backupUnavailable: string;
    unknown: string;
    retry: string;
    reset: string;
    backupCorrupt: string;
    backupUnknown: string;
    restored: string;
    dismissBackup: string;
    restoreUnknown: string;
    restoreCorrupt: string;
    confirmReset: string;
    cancel: string;
    resetMessage: string;
    processing: string;
    actionFailed: string;
    actionUnconfirmed: string;
  };
}
