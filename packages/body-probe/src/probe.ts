import { BatterySampler } from './battery.js';
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
  cpu(ttlMs: number): Promise<Fact<CpuValue>>;
  memory(ttlMs: number): Promise<Fact<MemoryValue>>;
  disks(cwd: string, ttlMs: number): Promise<Fact<DisksValue>>;
  battery(ttlMs: number): Promise<Fact<BatteryValue | null>>;
  network(ttlMs: number): Promise<Fact<NetworkValue>>;
  process(pid: number, ttlMs: number): Promise<Fact<ProcessValue>>;
}

export interface StartOptions {
  intervalMs?: number;
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
const STOP_BOUND_MS = 2500;

export class BodyProbe {
  private readonly collectors: ProbeCollectors;
  private readonly listeners = new Set<(body: Body) => void>();
  private readonly ring: SamplePoint[] = [];
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private running = false;
  private generation = 0;
  private intervalMs = 2000;
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
      memory: (ttl) => memory.sample(ttl),
      disks: (cwd, ttl) => disks.sample(cwd, ttl),
      battery: (ttl) => battery.sample(ttl),
      network: (ttl) => network.sample(ttl),
      process: (pid, ttl) => (pid === process.pid
        ? Promise.resolve(self.sample(ttl))
        : new ExternalProcessSampler(pid).sample(ttl)),
    };
    this.collectors = { ...defaults, ...collectors };
  }

  start(options: StartOptions = {}): void {
    const intervalMs = options.intervalMs ?? 2000;
    if (!Number.isFinite(intervalMs) || intervalMs < 1 || intervalMs > 2147483647) {
      throw new RangeError(`intervalMs must be finite in [1, 2147483647], got ${intervalMs}`);
    }
    if (this.running) return; // repeated start is a no-op; stop() before reconfiguring
    this.running = true;
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
    // Always wait the same pending work, even on a repeated stop while a
    // previous stop is still in progress.
    const inFlight = this.inFlight;
    if (inFlight) {
      let bound: NodeJS.Timeout | undefined;
      await Promise.race([
        inFlight,
        new Promise<void>((res) => { bound = setTimeout(res, STOP_BOUND_MS); }),
      ]);
      if (bound) clearTimeout(bound);
    }
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
      if (f.status === 'ok' && now - f.observedAt > f.ttlMs) f.status = 'stale';
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
    // Serialize generations: a new start waits for the previous generation's
    // pending tick before sampling, so ticks can never overlap.
    const previous = this.inFlight;
    const run = async () => {
      if (previous) {
        try {
          await previous;
        } catch {
          // previous generation's failure must not block this one
        }
      }
      if (generation !== this.generation || !this.running) return;
      const tick = this.tick(generation);
      this.inFlight = tick;
      await tick;
      if (generation === this.generation && this.running) {
        this.timer = setTimeout(() => this.launch(generation), this.intervalMs);
      }
    };
    this.inFlight = run();
  }

  private async tick(generation: number): Promise<void> {
    const ttl = this.intervalMs * 3;
    const c = this.collectors;
    const [cpu, memory, disks, battery, network, harnessProcess, tokens] = await Promise.all([
      this.call(() => c.cpu(ttl), 'cpu'),
      this.call(() => c.memory(ttl), 'memory'),
      this.call(() => c.disks(this.cwd, ttl), 'disks'),
      this.call(() => c.battery(ttl), 'battery'),
      this.call(() => c.network(ttl), 'network'),
      this.call(() => c.process(this.pid, ttl), 'harnessProcess'),
      this.readTokens(ttl),
    ]);
    if (generation !== this.generation || !this.running) return;
    const body: Body = {
      cpu, memory, disks, battery,
      thermal: fact.fail<ThermalValue>('unavailable', fact.source('thermal', 'ProcessInfo.thermalState'), ttl),
      network, harnessProcess, tokens,
    };
    this.push({ at: Date.now(), body });
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(body));
      } catch {
        // listener errors must not break sampling or other listeners
      }
    }
  }

  private async call<T>(fn: () => Promise<Fact<T>>, id: string): Promise<Fact<T>> {
    try {
      return await fn();
    } catch {
      return fact.fail('unavailable', fact.source(id, 'collector'), this.intervalMs * 3);
    }
  }

  private async readTokens(ttl: number): Promise<Fact<TokensValue>> {
    const source = this.tokenSource;
    const fallback = () => fact.fail<TokensValue>('unavailable', fact.source('tokens', 'TokenSource.read'), ttl);
    if (!source) return fallback();
    let timer: NodeJS.Timeout | undefined;
    try {
      const f = await Promise.race([
        Promise.resolve().then(() => source.read()),
        new Promise<never>((_res, rej) => {
          timer = setTimeout(() => rej(new Error('tokenSource read timeout')), TOKEN_READ_TIMEOUT_MS);
        }),
      ]);
      return f as Fact<TokensValue>;
    } catch {
      return fallback();
    } finally {
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
