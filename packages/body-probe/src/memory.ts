import os from 'node:os';
import { defaultRun, type RunFn } from './command.js';
import * as fact from './fact.js';
import type { Fact, MemoryValue, SourceRef } from './types.js';

export interface VmStat {
  pageSize: number;
  anonymous: number;
  purgeable: number;
  fileBacked: number;
  wired: number;
  compressorOccupied: number;
}

function requiredField(text: string, name: string): number {
  const m = new RegExp(`^${name}:\\s+(\\d+)\\.\\s*$`, 'm').exec(text);
  if (!m) throw new Error(`vm_stat: missing "${name}"`);
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) throw new Error(`vm_stat: bad "${name}"`);
  return n;
}

export function parseVmStat(text: string): VmStat {
  const header = /page size of (\d+) bytes/i.exec(text);
  if (!header) throw new Error('vm_stat: no page size header');
  const pageSize = Number(header[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) throw new Error('vm_stat: bad page size');
  return {
    pageSize,
    anonymous: requiredField(text, 'Anonymous pages'),
    purgeable: requiredField(text, 'Pages purgeable'),
    fileBacked: requiredField(text, 'File-backed pages'),
    wired: requiredField(text, 'Pages wired down'),
    compressorOccupied: requiredField(text, 'Pages occupied by compressor'),
  };
}

const SWAP_UNITS: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

export function parseSwapUsage(text: string): number {
  const m = /used\s*=\s*(\d+(?:\.\d+)?)\s*([BKMGT])\b/.exec(text);
  if (!m) throw new Error('swapusage: no used field');
  const n = Number(m[1]) * SWAP_UNITS[m[2]!]!;
  if (!Number.isFinite(n) || n < 0) throw new Error('swapusage: bad used value');
  return n;
}

export function parsePressureLevel(text: string): MemoryValue['pressure'] {
  const n = Number(text.trim());
  if (n === 1) return 'normal';
  if (n === 2) return 'warn';
  if (n === 4) return 'critical';
  throw new Error(`memorystatus_vm_pressure_level: unknown code ${text.trim()}`);
}

const SWAP_CACHE_MS = 30_000;
const PRESSURE_CACHE_MS = 5_000;

export interface MemoryDeps {
  run?: RunFn;
  platform?: NodeJS.Platform;
  totalmem?: () => number;
  now?: () => number; // monotonic clock for cache eligibility
  wall?: () => number; // wall clock stamped on cache entries and facts
  src?: SourceRef;
}

export interface MemoryPeriods {
  pressureMs?: number;
  swapMs?: number;
}

interface Cached<T> {
  at: number; // monotonic stamp used for expiry
  observedAt: number; // wall stamp of the cached observation
  value: T;
}

export class MemorySampler {
  private swapCache: Cached<number> | undefined;
  private pressureCache: Cached<MemoryValue['pressure']> | undefined;
  private readonly src: SourceRef;

  constructor(private readonly deps: MemoryDeps = {}) {
    this.src = deps.src ?? fact.source('memory', '/usr/bin/vm_stat + /usr/sbin/sysctl');
  }

  async sample(
    ttlMs: number = fact.DEFAULT_TTL_MS,
    signal?: AbortSignal,
    periods: MemoryPeriods = {},
  ): Promise<Fact<MemoryValue>> {
    if ((this.deps.platform ?? process.platform) !== 'darwin') {
      return fact.fail('unavailable', this.src, ttlMs);
    }
    const run = this.deps.run ?? defaultRun;
    const totalmem = this.deps.totalmem ?? os.totalmem;
    const now = this.deps.now ?? (() => globalThis.performance.now());
    const wall = this.deps.wall ?? (() => Date.now());
    // A child can never poll faster than the parent that publishes it.
    const swapMs = Math.max(periods.swapMs ?? SWAP_CACHE_MS, ttlMs / 3);
    const pressureMs = Math.max(periods.pressureMs ?? PRESSURE_CACHE_MS, ttlMs / 3);
    try {
      const swap = this.swapCache && now() - this.swapCache.at < swapMs ? this.swapCache : undefined;
      const pressure =
        this.pressureCache && now() - this.pressureCache.at < pressureMs ? this.pressureCache : undefined;
      // Simultaneously-due sysctl OIDs share one invocation; output lines
      // come back in argument order.
      const sysctlKeys = [
        ...(pressure ? [] : ['kern.memorystatus_vm_pressure_level']),
        ...(swap ? [] : ['vm.swapusage']),
      ];
      const stamp = (value: string) => ({ value, observedAt: wall(), at: now() });
      const [vmR, sysctlR] = await Promise.allSettled([
        run('/usr/bin/vm_stat', [], signal).then(stamp),
        sysctlKeys.length
          ? run('/usr/sbin/sysctl', ['-n', ...sysctlKeys], signal).then(stamp)
          : Promise.resolve(undefined),
      ]);
      // A fast failure still waits for the slower sibling: the process may be
      // lingering until here, so only map the error after all have settled.
      if (vmR.status === 'rejected') throw vmR.reason;
      if (sysctlR.status === 'rejected') throw sysctlR.reason;
      if (signal?.aborted) throw signal.reason;
      const sysctlLines = (sysctlR.value?.value ?? '').trim().split('\n');
      const pressureText = pressure ? '' : (sysctlLines.shift() ?? '');
      const swapText = swap ? '' : (sysctlLines.shift() ?? '');
      const { observedAt: wallNow, at: monoNow } = sysctlR.value ?? vmR.value;
      // The fact uses the vm reading's wall time and expires at the earliest
      // absolute constituent deadline (vm's period is ttl/3).
      const parts: fact.FactMeta[] = [{ observedAt: vmR.value.observedAt, periodMs: ttlMs / 3, at: vmR.value.at }];
      const vm = parseVmStat(vmR.value.value);
      let swapUsed: number;
      if (swap) {
        swapUsed = swap.value;
        parts.push({ observedAt: swap.observedAt, periodMs: swapMs, at: swap.at });
      } else {
        swapUsed = parseSwapUsage(swapText);
        this.swapCache = { at: monoNow, observedAt: wallNow, value: swapUsed };
        parts.push({ observedAt: wallNow, periodMs: swapMs, at: monoNow });
      }
      let level: MemoryValue['pressure'];
      if (pressure) {
        level = pressure.value;
        parts.push({ observedAt: pressure.observedAt, periodMs: pressureMs, at: pressure.at });
      } else {
        level = parsePressureLevel(pressureText);
        this.pressureCache = { at: monoNow, observedAt: wallNow, value: level };
        parts.push({ observedAt: wallNow, periodMs: pressureMs, at: monoNow });
      }
      const meta = fact.oldestMeta(parts);
      const f = fact.ok(
        {
          total: totalmem(),
          used: (Math.max(0, vm.anonymous - vm.purgeable) + vm.wired + vm.compressorOccupied) * vm.pageSize,
          cached: (vm.fileBacked + vm.purgeable) * vm.pageSize,
          pressure: level,
          swapUsed,
        },
        this.src,
        Math.max(0, meta.expiresAt! - vmR.value.at),
        vmR.value.observedAt,
      );
      if (meta.expiresAt !== undefined) fact.trackDeadline(f, meta.expiresAt);
      return f;
    } catch (err) {
      return fact.fail(fact.errorStatus(err), this.src, ttlMs);
    }
  }

  // Drops the inner pressure/swap caches so a restart re-reads them; called
  // by BodyProbe on stop and start. Aborted in-flight reads already check
  // their signal before writing, so a pending older generation stays safe.
  reset(): void {
    this.swapCache = undefined;
    this.pressureCache = undefined;
  }
}
