// 合并后改为从 @asi/sense-types 导入（见 docs/DESIGN.md §2.2 / §2.2b）
// Until packages/sense-types exists, Fact and Body are kept verbatim from the
// design document here; only SourceRef is local to this package.

export interface SourceRef {
  id: string;   // 事实来源标识，例如 body-probe.memory
  api: string;  // 具体使用的系统接口，例如 /usr/bin/vm_stat
  host: string; // 采集所在主机 os.hostname()
}

export interface Fact<T> {
  value: T | null;
  status: 'ok' | 'stale' | 'denied' | 'unsupported' | 'unavailable' | 'unknown';
  source: SourceRef;       // 来自哪个接口
  observedAt: number;      // 什么时候获取
  ttlMs: number;           // 多久后视为过期（stale 由读取时计算，不靠定时器）
}

export interface Body {
  cpu: Fact<{ usage: number /* 0..1 */; perCore: number[]; load1: number; load5: number; load15: number }>;
  memory: Fact<{ total: number; used: number; pressure: 'normal' | 'warn' | 'critical'; swapUsed: number }>;
  disks: Fact<Array<{ mount: string; total: number; free: number }>>;   // 至少根卷 + 工作目录所在卷
  battery: Fact<{ percent: number; charging: boolean; minutesLeft?: number } | null>;  // 台式机为 null
  thermal: Fact<'nominal' | 'fair' | 'serious' | 'critical'>;           // ProcessInfo.thermalState，经 helper
  network: Fact<{ online: boolean; rxBps: number; txBps: number }>;
  harnessProcess: Fact<{ rss: number; cpu: number; uptimeSec: number }>; // DSH 自身进程
  tokens: Fact<{
    contextWindow?: number;      // ctx.llm.resolveModelInfo().context 或 contextPressure.contextWindow
    contextUsed?: number;        // ctx.tokenMeter.contextPressure(session).pressureTokens
    contextProjected?: number;   // projectedTokens：下一次请求的规模
    sessionUsage: { input: number; output: number; cacheRead: number; cacheWrite: number };  // tokenUsage 投影
    balance?: { amount: number; currency: string; source: string };  // 提供方余额，只有提供方有接口时（如 DeepSeek 官方 /user/balance）
  }>;
}

export type CpuValue = NonNullable<Body['cpu']['value']>;
export type MemoryValue = NonNullable<Body['memory']['value']>;
export type DisksValue = NonNullable<Body['disks']['value']>;
export type BatteryValue = NonNullable<Body['battery']['value']>;
export type ThermalValue = NonNullable<Body['thermal']['value']>;
export type NetworkValue = NonNullable<Body['network']['value']>;
export type ProcessValue = NonNullable<Body['harnessProcess']['value']>;
export type TokensValue = NonNullable<Body['tokens']['value']>;
export type BalanceValue = NonNullable<TokensValue['balance']>;

export type FactStatus = Fact<unknown>['status'];

export interface TokenSource {
  read(): Promise<Fact<Body['tokens']['value']>>;
}
