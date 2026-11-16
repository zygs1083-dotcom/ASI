import { BatterySampler } from './battery.js';
import { drainCommands } from './command.js';
import { CpuSampler } from './cpu.js';
import { DiskSampler } from './disks.js';
import * as fact from './fact.js';
import { MemorySampler } from './memory.js';
import { NetworkSampler } from './network.js';
import { ExternalProcessSampler, SelfProcessSampler } from './process.js';
import type {
  BatteryValue, Body, CpuValue, DisksFact, DisksValue, Fact, MemoryValue,
  NetworkValue, ProcessValue, ThermalValue, TokenSource, TokensValue,
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
  memoryMs: number;   // MemorySampler invocation period
  networkMs: number;  // NetworkSampler invocation period
  pressureMs: number; // sysctl kern.memorystatus_vm_pressure_level period
  swapMs: number;     // sysctl vm.swapusage period
  routeMs: number;    // /sbin/route probe period per address family
  batteryMs: number;  // BatterySampler (pmset) invocation period
  disksMs: number;    // DiskSampler invocation period
}

export interface StartOptions {
  intervalMs?: number;
  cadence?: Partial<SamplingCadence>;
  cwd?: string;
  pid?: number;
  tokenSource?: TokenSource;
}

export interface SamplePoint {
  at: number;   // wall clock of the sample
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

const HISTORY_WINDOW_MS = 300_000;
const TOKEN_READ_TIMEOUT_MS = 1000;
const DEFAULT_CADENCE: SamplingCadence = {
  memoryMs: 5000,
  networkMs: 5000,
  pressureMs: 5000,
  swapMs: 30_000,
  routeMs: 30_000,
  batteryMs: 30_000,
  disksMs: 10_000,
};

interface CacheMap {
  memory: MemoryValue;
  network: NetworkValue;
  disks: DisksValue;
  battery: BatteryValue | null;
}

interface RingPoint extends SamplePoint {
  mono: number; // private monotonic stamp; stripped from outward results
}

export class BodyProbe {
  private readonly collectors: ProbeCollectors;
  private readonly listeners = new Set<(body: Body) => void>();
  private readonly ring: RingPoint[] = [];
  private readonly clockNow: () => number;
  private readonly clockWall: () => number;
  private readonly customDisks: boolean;
  private readonly resetInner: () => void;
  private readonly stopInner: () => void;
  private timer: NodeJS.Timeout | undefined;
  private tickAbort: AbortController | undefined;
  private stopping: Promise<void> = Promise.resolve();
  private caches: { [K in keyof CacheMap]?: { at: number; fact: Fact<CacheMap[K]> } } = {};
  private running = false;
  private generation = 0;
  private intervalMs = 2000;
  private cadence: SamplingCadence = { ...DEFAULT_CADENCE };
  private capacity = Math.ceil(HISTORY_WINDOW_MS / 2000) + 1;
  private cwd = process.cwd();
  private pid = process.pid;
  private tokenSource: TokenSource | undefined;

  constructor(collectors: Partial<ProbeCollectors> = {}, clock: ProbeClock = {}) {
    this.clockNow = clock.now ?? (() => globalThis.performance.now());
    this.clockWall = clock.wall ?? (() => Date.now());
    const platform = clock.platform ?? process.platform;
    const cpu = new CpuSampler();
    const memory = new MemorySampler({ now: this.clockNow, wall: this.clockWall, platform });
    const disks = new DiskSampler({ now: this.clockNow, wall: this.clockWall });
    const battery = new BatterySampler({ platform });
    const network = new NetworkSampler({ now: this.clockNow, wall: this.clockWall, platform });
    const self = new SelfProcessSampler({ now: this.clockNow });
    const defaults: ProbeCollectors = {
      cpu: (ttl) => Promise.resolve(cpu.sample(ttl)),
      memory: (ttl, signal) => memory.sample(ttl, signal, {
        pressureMs: this.cadence.pressureMs,
        swapMs: this.cadence.swapMs,
      }),
      // The default disk collector runs every tick and resolves immediately:
      // DiskSampler enforces disksMs per volume internally and its background
      // jobs must outlive (never be bound to) the tick's abort signal.
      disks: (cwd, ttl) => disks.sample(cwd, ttl),
      battery: (ttl, signal) => battery.sample(ttl, signal),
      network: (ttl, signal) => network.sample(ttl, signal, { routeMs: this.cadence.routeMs }),
      process: (pid, ttl, signal) => (pid === process.pid
        ? Promise.resolve(self.sample(ttl))
        : new ExternalProcessSampler(pid, { now: this.clockNow }).sample(ttl, signal)),
    };
    this.collectors = { ...defaults, ...collectors };
    this.customDisks = collectors.disks !== undefined;
    this.resetInner = () => {
      memory.reset();
      network.reset();
    };
    this.stopInner = () => {
      memory.reset();
      network.reset();
      disks.stop();
    };
  }

  start(options: StartOptions = {}): void {
    const intervalMs = options.intervalMs ?? 2000;
    if (!Number.isFinite(intervalMs) || intervalMs < 1 || intervalMs > 2147483647) {
      throw new RangeError(`intervalMs must be finite in [1, 2147483647], got ${intervalMs}`);
    }
    const cadence = { ...DEFAULT_CADENCE, ...(options.cadence ?? {}) };
    for (const key of Object.keys(cadence) as (keyof SamplingCadence)[]) {
      const value = cadence[key];
      if (!Number.isFinite(value) || value < 1 || value > 2147483647) {
        throw new RangeError(`cadence.${key} must be finite in [1, 2147483647], got ${value}`);
      }
      // A slower tick can never poll faster than itself; effective period.
      cadence[key] = Math.max(intervalMs, value);
    }
    // Children can never poll faster than the parent that publishes them.
    cadence.pressureMs = Math.max(cadence.pressureMs, cadence.memoryMs);
    cadence.swapMs = Math.max(cadence.swapMs, cadence.memoryMs);
    cadence.routeMs = Math.max(cadence.routeMs, cadence.networkMs);
    if (this.running) return; // repeated start is a no-op; stop() before reconfiguring
    this.running = true;
    this.caches = {}; // a new run samples everything fresh
    this.resetInner();
    this.cadence = cadence;
    this.intervalMs = intervalMs;
    this.capacity = Math.ceil(HISTORY_WINDOW_MS / intervalMs) + 1;
    this.cwd = options.cwd ?? process.cwd();
    this.pid = options.pid ?? process.pid;
    this.tokenSource = options.tokenSource;
    this.launch(++this.generation);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.generation += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const controller = this.tickAbort;
    this.tickAbort = undefined;
    controller?.abort();
    // Outer + inner caches reset and disk generation jobs abort (I/O locks
    // stay held until the filesystem actually settles).
    this.caches = {};
    this.stopInner();
    // Drain only this generation's commands; chain after any earlier stop()
    // so repeated calls still serialize. Hung collectors never block stop().
    this.stopping = Promise.all([
      this.stopping,
      controller ? drainCommands(controller.signal) : Promise.resolve(),
    ]).then(() => {});
    await this.stopping;
  }

  onSample(listener: (body: Body) => void): () => void {
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  latest(): Body | null {
    const point = this.ring[this.ring.length - 1];
    if (!point) return null;
    const now = this.clockNow();
    const wall = this.clockWall();
    // Stale-mark the stored originals (fact.stale never mutates) so tracked
    // deadlines keyed by object identity survive; clone only afterwards.
    const body = {} as Record<keyof Body, Fact<unknown>>;
    for (const key of Object.keys(point.body) as (keyof Body)[]) {
      body[key] = structuredClone(fact.stale(point.body[key], now, wall));
    }
    return body as Body;
  }

  history(seconds = 300): SamplePoint[] {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new RangeError(`seconds must be a finite number > 0, got ${seconds}`);
    }
    const cutoff = this.clockNow() - Math.min(seconds * 1000, HISTORY_WINDOW_MS);
    return this.ring
      .filter((p) => p.mono >= cutoff)
      .map((p) => ({ at: p.at, body: structuredClone(p.body) }));
  }

  private launch(generation: number): void {
    void this.tick(generation).then(() => {
      // Only the live generation may arm the next tick; a stale continuation
      // (from a stop or restart) must never touch this.timer.
      if (generation === this.generation && this.running) {
        this.timer = setTimeout(() => this.launch(generation), this.intervalMs);
      }
    });
  }

  private async tick(generation: number): Promise<void> {
    // Aborting the superseded controller also clears its readTokens timeout.
    const controller = new AbortController();
    this.tickAbort?.abort();
    this.tickAbort = controller;
    const signal = controller.signal;
    const ttl = this.intervalMs * 3;
    const c = this.collectors;
    const aborted = new Promise<null>((res) => {
      signal.addEventListener('abort', () => res(null), { once: true });
    });
    const facts = await Promise.race([
      Promise.all([
        this.call(() => c.cpu(ttl, signal), 'cpu', ttl, signal),
        this.cached('memory', () => c.memory(this.cadence.memoryMs * 3, signal), signal),
        this.disksFact(signal),
        this.cached('battery', () => c.battery(this.cadence.batteryMs * 3, signal), signal),
        this.cached('network', () => c.network(this.cadence.networkMs * 3, signal), signal),
        this.call(() => c.process(this.pid, ttl, signal), 'harnessProcess', ttl, signal),
        this.readTokens(ttl, signal),
      ]),
      aborted,
    ]);
    if (!facts || generation !== this.generation || !this.running) return;
    const [cpu, memory, disks, battery, network, harnessProcess, tokens] = facts;
    const body: Body = {
      cpu, memory, disks, battery,
      thermal: fact.fail<ThermalValue>('unavailable', fact.source('thermal', 'ProcessInfo.thermalState'), ttl),
      network, harnessProcess, tokens,
    };
    const mono = this.clockNow();
    const wall = this.clockWall();
    for (const key of Object.keys(body) as (keyof Body)[]) {
      fact.ingest(body[key], mono, wall); // fix monotonic deadlines once
    }
    this.push({ at: wall, mono, body });
    for (const listener of this.listeners) {
      // A listener may stop/restart mid-dispatch, making this sample stale.
      if (!this.running || generation !== this.generation) return;
      try {
        listener(structuredClone(body));
      } catch {
        // listener errors must not break sampling or other listeners
      }
    }
  }

  // Slow collectors run at most once per effective cadence; between runs the
  // fact is republished as-is (stale-marked past its ttl). Scheduling uses the
  // entry's monotonic sampling-at, never the fact's composite observedAt.
  private cached<K extends keyof CacheMap>(
    key: K,
    invoke: () => Promise<Fact<CacheMap[K]>>,
    signal: AbortSignal,
  ): Promise<Fact<CacheMap[K]>> {
    const periodMs = this.cadence[`${key}Ms` as keyof SamplingCadence];
    const entry = this.caches[key];
    const now = this.clockNow();
    if (entry && now - entry.at < periodMs) {
      return Promise.resolve(fact.stale(entry.fact, now, this.clockWall()));
    }
    return this.call(invoke, key, periodMs * 3, signal).then((f) => {
      if (!signal.aborted) {
        const at = this.clockNow();
        fact.ingest(f, at, this.clockWall());
        (this.caches as Record<keyof CacheMap, { at: number; fact: Fact<unknown> } | undefined>)[key] =
          { at, fact: f };
      }
      return f;
    });
  }

  // The default DiskSampler is nonblocking and enforces disksMs per volume,
  // so it is queried every tick; its background jobs never see the tick
  // signal (it dies with the next tick — stopInner aborts generations). An
  // injected disks collector keeps the whole-group cached cadence instead.
  private disksFact(signal: AbortSignal): Promise<DisksFact> {
    const ttl = this.cadence.disksMs * 3;
    if (this.customDisks) {
      return this.cached('disks', () => this.collectors.disks(this.cwd, ttl, signal), signal);
    }
    return this.call(() => this.collectors.disks(this.cwd, ttl), 'disks', ttl, signal);
  }

  private async call<T>(
    fn: () => Promise<Fact<T>>,
    id: string,
    ttlMs: number,
    signal: AbortSignal,
  ): Promise<Fact<T>> {
    // An earlier collector may synchronously stop the probe mid-tick; once
    // the tick's signal is aborted no later collector may start.
    if (signal.aborted) return fact.fail('unavailable', fact.source(id, 'collector'), ttlMs);
    try {
      return await fn();
    } catch {
      return fact.fail('unavailable', fact.source(id, 'collector'), ttlMs);
    }
  }

  private async readTokens(ttl: number, signal: AbortSignal): Promise<Fact<TokensValue>> {
    const source = this.tokenSource;
    const fallback = () => fact.fail<TokensValue>('unavailable', fact.source('tokens', 'TokenSource.read'), ttl);
    if (!source || signal.aborted) return fallback(); // abort may predate this call
    let timer: NodeJS.Timeout | undefined;
    let rejectAbort!: (e: unknown) => void;
    const aborted = new Promise<never>((_res, rej) => { rejectAbort = rej; });
    const onAbort = () => rejectAbort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const f = await Promise.race([
        Promise.resolve().then(() => source.read()),
        aborted,
        new Promise<never>((_res, rej) => {
          timer = setTimeout(() => rej(new Error('tokenSource read timeout')), TOKEN_READ_TIMEOUT_MS);
        }),
      ]);
      return f as Fact<TokensValue>;
    } catch {
      return fallback();
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
    }
  }

  private push(point: RingPoint): void {
    const cutoff = point.mono - HISTORY_WINDOW_MS;
    while (this.ring.length > 0 && this.ring[0]!.mono < cutoff) this.ring.shift();
    this.ring.push(point);
    while (this.ring.length > this.capacity) this.ring.shift();
  }
}
