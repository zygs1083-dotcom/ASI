// 侧栏面板视图模型；事实骨架来自 @asi/sense-types（docs/DESIGN.md §2.2/§2.2b/§2.3），
// UI 侧只追加可选 reason、内存细分、token 生命体征与本地面板任务摘要投影。

import type {
  DisksFact as SharedDisksFact,
  Fact as SharedFact,
  FactStatus,
  SourceRef,
} from '@asi/sense-types'

export type { DiskVolume, FactStatus, SourceRef } from '@asi/sense-types'

/** UI 事实：共享 Fact 骨架 + 宿主可读原因（denied/unavailable 时展示）。 */
export type Fact<T> = SharedFact<T> & { reason?: string }

/**
 * 磁盘事实：value 为各挂载点独立读数，父级状态只兜底缺省卷（见 sense-types/disks.ts）。
 * unavailableMounts 声明读不出的挂载点：即使 value 里带记录也一律不展示。
 */
export type DisksFact = SharedDisksFact & { reason?: string }

export interface Signal {
  id: string
  kind: string
  at: number
  source: SourceRef
  subject: string
  data: Record<string, unknown>
  cause?: 'agent' | 'user' | 'unknown'
}

export interface JobSummary {
  id: string
  name: string
  status: string
}

export interface Body {
  cpu: Fact<{
    usage: number
    perCore: number[]
    load1: number
    load5: number
    load15: number
  }>
  memory: Fact<{
    total: number
    used: number
    pressure: 'normal' | 'warn' | 'critical'
    swapUsed: number
    /** 内存细分（原始字节）；未提供时 UI 只画 used/free，不虚构比例。 */
    breakdown?: { app: number; wired: number; compressed: number; cached: number }
  }>
  disks: DisksFact
  battery: Fact<{ percent: number; charging: boolean; minutesLeft?: number } | null>
  thermal: Fact<'nominal' | 'fair' | 'serious' | 'critical'>
  network: Fact<{ online: boolean; rxBps: number; txBps: number }>
  harnessProcess: Fact<{ rss: number; cpu: number; uptimeSec: number }>
  tokens: Fact<TokenVitals>
}

export interface TokenVitals {
  contextWindow?: number
  /**
   * 上下文窗口来源：configured=用户配置 / catalog=模型目录 / fallback=宿主回退估值。
   * fallback=容量未确认：环与占用百分比淡显，不展示余量/填满估算、不参与阈值告警；
   * 缺省保持旧版行为（视为已确认）。
   */
  contextWindowSource?: 'configured' | 'catalog' | 'fallback'
  contextUsed?: number
  contextProjected?: number
  /** input 已包含 cacheRead（缓存命中率 = cacheRead / input）。 */
  sessionUsage: { input: number; output: number; cacheRead: number; cacheWrite: number }
  balance?: { amount: number; currency: string; source: string }
  /** 自动压缩阈值（绝对 token 数），提供方给出才有，不虚构默认值 */
  compressionThreshold?: number
  balanceStatus?: FactStatus
  balanceReason?: string
  /** 宿主投影的上下文增速（tokens/分钟）；未提供或为 0 时 UI 不估算填满时间。 */
  contextGrowthPerMinute?: number
}

export interface SenseState {
  self: {
    activity: Fact<'idle' | 'thinking' | 'tool' | 'waiting-user'>
    pending: Fact<{ inbox: number; jobs: number }>
    tools: Fact<string[]>
    permissions: Fact<Record<string, 'granted' | 'denied' | 'unknown'>>
    body: Body
  }
  env: {
    where: {
      model: Fact<{ provider: string; endpoint: string; local: boolean }>
      harness: Fact<{ host: string; os: string; pid: number }>
      observed: Fact<{ host: string; userSession: string }>
      toolExec: Fact<{ host: string; cwd: string }>
    }
    frontApp: Fact<{ name: string; bundleId: string }>
    focusedWindow: Fact<{ title: string }>
    activeJobs: Fact<JobSummary[]>
    watchedPaths: Fact<Record<string, { lastChange: number; changes: number }>>
  }
  observation: {
    sources: Record<
      string,
      { status: FactStatus; lastSignalAt: number; error?: string }
    >
  }
}

export type EventLevel = 'record' | 'context' | 'wake' | 'suppressed'

// 事件/detail 数值单位：基础单位 + 显式导数单位（/s、/min）。
// 网络 history 序列本来就是 B/s，旧版标注 'bytes' 一律按 bytes/s 解读。
type BaseUnit = 'bytes' | 'ratio' | 'tokens' | 'count'
type RateUnit = `${BaseUnit}/s` | `${BaseUnit}/min`
export type DetailUnit = BaseUnit | RateUnit

/**
 * 事件附加展示的宿主投影数据（结构化 detail）。
 * UI 只负责渲染，不从 Signal.data 猜测字段、不做任何估算。
 */
export type EventDetail =
  | {
      kind: 'body.rate'
      metric: string
      windowMs: number
      delta: number
      unit: DetailUnit
      timeToFloorMs?: number
    }
  | {
      kind: 'body.anomaly'
      metric: string
      current: number
      baseline: number
      deviation: number
      unit: DetailUnit
    }
  | {
      kind: 'file.burst'
      directory: string
      windowMs: number
      created: number
      modified: number
      deleted: number
      excessiveDeletion: boolean
    }

export interface SenseEvent {
  signal: Signal
  level: EventLevel
  reason: string
  cause: 'agent' | 'user' | 'unknown'
  count?: number
  ruleName?: string
  detail?: EventDetail
  /** 用户对该事件的反馈，状态只由 model 决定（UI 不本地记忆）。 */
  feedback?: 'useful' | 'noise'
}

export interface SenseRule {
  id: string
  name: string
  enabled: boolean
  confirmed: boolean
  match: { kind: string; subject?: string; where?: Record<string, unknown> }
  level: 'record' | 'context' | 'wake'
  note?: string
  createdBy: 'user' | 'agent'
  expiresAt?: number
}

export interface MetricPoint {
  at: number
  value: number
}

export interface BodyHistory {
  cpu: MetricPoint[]
  memory: MetricPoint[]
  /** 电池电量百分比（0..100）；无电池时为空数组。 */
  battery: MetricPoint[]
  /** 温控档位序数：nominal 0 / fair 1 / serious 2 / critical 3。 */
  thermal: MetricPoint[]
  networkRx: MetricPoint[]
  networkTx: MetricPoint[]
  processCpu: MetricPoint[]
  processRss: MetricPoint[]
  tokens: MetricPoint[]
  disks: Record<string, MetricPoint[]>
}

export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical'

export const THERMAL_ORDINAL: Record<ThermalState, number> = {
  nominal: 0,
  fair: 1,
  serious: 2,
  critical: 3,
}

export type ThresholdLayer = 'floor' | 'rate' | 'baseline'

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
  | `disk:${string}`

export interface MetricInsight {
  /** 与 history 同单位的学习基线区间；未提供则不画基线带。 */
  baseline?: { low: number; high: number }
  /**
   * 宿主提供的各层阈值。value 默认与 history 同单位；
   * unit 显式给出且与 history 单位不一致时 UI 只在明细中展示、不画线。
   */
  thresholds?: Partial<
    Record<ThresholdLayer, { value: number; source: string; unit?: DetailUnit }>
  >
  sources: ThresholdLayer[]
  triggered: ThresholdLayer[]
  severity?: 'warn' | 'critical'
  /**
   * 宿主当前投影：ratePerMinute 方向 磁盘/电池负=耗尽、其余正=增长。
   * UI 只在 asOf ≤ now、now-asOf ≤ 2×间隔、速率为恶化方向时采用；
   * 更新的匹配 body.rate 信号使旧投影失效。
   */
  currentEta?: { asOf: number; sampleIntervalMs: number; timeToThresholdMs?: number; ratePerMinute: number }
}

/** 基线学习进度；UI 只展示，不推断截止时间与统计量。 */
export interface LearningState {
  status: 'learning' | 'ready'
  collectedMs: number
  targetMs: number
  confidence?: number
}

export interface TuningParam {
  key: string
  label: string
  value: number | string
  unit?: string
  locked: boolean
}

export interface TuningEntry {
  id: string
  paramKey: string
  previous: number | string
  next: number | string
  by: 'agent' | 'user' | 'auto'
  reason: string
  at: number
  reverted?: boolean
}

export interface TuningState {
  parameters: TuningParam[]
  log: TuningEntry[]
}

export interface SensePanelModel {
  state: SenseState
  events: SenseEvent[]
  rules: SenseRule[]
  paused: boolean
  sendTitles: boolean
  now: number
  history: BodyHistory
  insights?: Partial<Record<MetricKey, MetricInsight>>
  learning?: LearningState
  tuning?: TuningState
}

export interface SensePanelProps {
  model: SensePanelModel
  onToggleRule: (id: string, enabled: boolean) => void
  onConfirmRule: (id: string) => void
  onDeleteRule: (id: string) => void
  onPause: (paused: boolean) => void
  onToggleTitles: (enabled: boolean) => void
  onOpenPermissionSettings: () => void
  onRevertTuning: (id: string) => void
  onLockParam: (key: string, locked: boolean) => void
  onFeedback: (signalId: string, value: 'useful' | 'noise') => void
}
