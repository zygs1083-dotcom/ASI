import type {
  BatteryValue,
  Body,
  CpuValue,
  DisksFact,
  DisksValue,
  Fact,
  MemoryValue,
  NetworkValue,
  ProcessValue,
  TokenSource,
} from './types.js';

export interface ProbeCollectors {
  cpu(ttlMs: number, signal?: AbortSignal): Promise<Fact<CpuValue>>;
  memory(ttlMs: number, signal?: AbortSignal): Promise<Fact<MemoryValue>>;
  disks(cwd: string, ttlMs: number, signal?: AbortSignal): Promise<DisksFact>;
  battery(ttlMs: number, signal?: AbortSignal): Promise<Fact<BatteryValue | null>>;
  network(ttlMs: number, signal?: AbortSignal): Promise<Fact<NetworkValue>>;
  process(pid: number, ttlMs: number, signal?: AbortSignal): Promise<Fact<ProcessValue>>;
}

export interface SamplingCadence {
  memoryMs: number; // MemorySampler invocation period
  networkMs: number; // NetworkSampler invocation period
  pressureMs: number; // sysctl kern.memorystatus_vm_pressure_level period
  swapMs: number; // sysctl vm.swapusage period
  routeMs: number; // /sbin/route probe period per address family
  batteryMs: number; // BatterySampler (pmset) invocation period
  disksMs: number; // DiskSampler invocation period
}

export interface StartOptions {
  intervalMs?: number;
  cadence?: Partial<SamplingCadence>;
  cwd?: string;
  pid?: number;
  tokenSource?: TokenSource;
}

export interface SamplePoint {
  at: number; // wall clock of the sample
  body: Body;
}

// Optional clocks: `now` is monotonic (cadence, staleness, history window);
// `wall` stamps observations. Both default to the process clocks.
// `platform` overrides the OS gate of the built-in macOS samplers.
export interface ProbeClock {
  now?: () => number;
  wall?: () => number;
  platform?: NodeJS.Platform;
}

export const HISTORY_WINDOW_MS = 300_000;
export const TOKEN_READ_TIMEOUT_MS = 1000;
export const DEFAULT_CADENCE: SamplingCadence = {
  memoryMs: 5000,
  networkMs: 5000,
  pressureMs: 5000,
  swapMs: 30_000,
  routeMs: 30_000,
  batteryMs: 30_000,
  disksMs: 10_000,
};

export interface CacheMap {
  memory: MemoryValue;
  network: NetworkValue;
  disks: DisksValue;
  battery: BatteryValue | null;
}

export interface RingPoint extends SamplePoint {
  mono: number; // private monotonic stamp; stripped from outward results
}
