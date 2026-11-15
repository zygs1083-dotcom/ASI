import { BatterySampler } from './battery.js';
import { drainCommands } from './command.js';
import { CpuSampler } from './cpu.js';
import { DiskSampler } from './disks.js';
import * as fact from './fact.js';
import { MemorySampler } from './memory.js';
import { NetworkSampler } from './network.js';
import { ExternalProcessSampler, SelfProcessSampler } from './process.js';
import type {
  BatteryValue, Body, CpuValue, DisksValue, Fact, MemoryValue,
  NetworkValue, ProcessValue, ThermalValue, TokenSource, TokensValue,
} from './types.js';

export interface ProbeCollectors {
  cpu(ttlMs: number, signal?: AbortSignal): Promise<Fact<CpuValue>>;
  memory(ttlMs: number, signal?: AbortSignal): Promise<Fact<MemoryValue>>;
  disks(cwd: string, ttlMs: number, signal?: AbortSignal): Promise<Fact<DisksValue>>;
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
  at: number;
  body: Body;
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

export class BodyProbe {
  private readonly collectors: ProbeCollectors;
  private readonly listeners = new Set<(body: Body) => void>();
  private readonly ring: SamplePoint[] = [];
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

  constructor(collectors: Partial<ProbeCollectors> = {}) {
    const cpu = new CpuSampler();
    const memory = new MemorySampler();
    const disks = new DiskSampler();
    const battery = new BatterySampler();
    const network = new NetworkSampler();
    const self = new SelfProcessSampler();
    const defaults: ProbeCollectors = {
      cpu: (ttl) => Promise.resolve(cpu.sample(ttl)),
      memory: (ttl, signal) => memory.sample(ttl, signal, {
        pressureMs: this.cadence.pressureMs,
        swapMs: this.cadence.swapMs,
      }),
      disks: (cwd, ttl, signal) => disks.sample(cwd, ttl, signal),
      battery: (ttl, signal) => battery.sample(ttl, signal),
      network: (ttl, signal) => network.sample(ttl, signal, { routeMs: this.cadence.routeMs }),
      process: (pid, ttl, signal) => (pid === process.pid
        ? Promise.resolve(self.sample(ttl))
        : new ExternalProcessSampler(pid).sample(ttl, signal)),
    };
    this.collectors = { ...defaults, ...collectors };
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
    if (this.running) return; // repeated start is a no-op; stop() before reconfiguring
    this.running = true;
    this.caches = {}; // a new run samples everything fresh
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
    const body = structuredClone(point.body);
    const now = Date.now();
    for (const key of Object.keys(body) as (keyof Body)[]) {
      const f: Fact<unknown> = body[key];
      body[key] = fact.stale(f, now) as never;
    }
    return body;
  }

  history(seconds = 300): SamplePoint[] {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new RangeError(`seconds must be a finite number > 0, got ${seconds}`);
    }
    const cutoff = Date.now() - Math.min(seconds * 1000, HISTORY_WINDOW_MS);
    return this.ring
      .filter((p) => p.at >= cutoff)
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
        this.cached('disks', () => c.disks(this.cwd, this.cadence.disksMs * 3, signal), signal),
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
    this.push({ at: Date.now(), body });
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
  // entry's sampling-at, never the fact's composite observedAt.
  private cached<K extends keyof CacheMap>(
    key: K,
    invoke: () => Promise<Fact<CacheMap[K]>>,
    signal: AbortSignal,
  ): Promise<Fact<CacheMap[K]>> {
    const periodMs = this.cadence[`${key}Ms` as keyof SamplingCadence];
    const entry = this.caches[key];
    const now = Date.now();
    if (entry && now - entry.at < periodMs) {
      return Promise.resolve(fact.stale(entry.fact, now));
    }
    return this.call(invoke, key, periodMs * 3, signal).then((f) => {
      if (!signal.aborted) {
        (this.caches as Record<keyof CacheMap, { at: number; fact: Fact<unknown> } | undefined>)[key] =
          { at: Date.now(), fact: f };
      }
      return f;
    });
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

  private push(point: SamplePoint): void {
    const cutoff = point.at - HISTORY_WINDOW_MS;
    while (this.ring.length > 0 && this.ring[0]!.at < cutoff) this.ring.shift();
    this.ring.push(point);
    while (this.ring.length > this.capacity) this.ring.shift();
  }
}
