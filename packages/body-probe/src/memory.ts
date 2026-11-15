import os from 'node:os';
import { performance } from 'node:perf_hooks';
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
  now?: () => number;
  src?: SourceRef;
}

export class MemorySampler {
  private swapCache: { at: number; value: number } | undefined;
  private pressureCache: { at: number; value: MemoryValue['pressure'] } | undefined;
  private readonly src: SourceRef;

  constructor(private readonly deps: MemoryDeps = {}) {
    this.src = deps.src ?? fact.source('memory', '/usr/bin/vm_stat + /usr/sbin/sysctl');
  }

  sample(ttlMs: number = fact.DEFAULT_TTL_MS, signal?: AbortSignal): Promise<Fact<MemoryValue>> {
    if ((this.deps.platform ?? process.platform) !== 'darwin') {
      return Promise.resolve(fact.fail('unavailable', this.src, ttlMs));
    }
    const run = this.deps.run ?? defaultRun;
    const totalmem = this.deps.totalmem ?? os.totalmem;
    const now = this.deps.now ?? (() => performance.now());
    return fact.collect(this.src, async () => {
      const swap = this.swapCache && now() - this.swapCache.at < SWAP_CACHE_MS ? this.swapCache : undefined;
      const pressure = this.pressureCache && now() - this.pressureCache.at < PRESSURE_CACHE_MS
        ? this.pressureCache : undefined;
      const [vmR, pressureR, swapR] = await Promise.allSettled([
        run('/usr/bin/vm_stat', [], signal),
        pressure ? Promise.resolve('') : run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], signal),
        swap ? Promise.resolve('') : run('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], signal),
      ]);
      // A fast failure still waits for the slower siblings: processes may be
      // lingering until here, so only map the error after all have settled.
      if (vmR.status === 'rejected') throw vmR.reason;
      if (pressureR.status === 'rejected') throw pressureR.reason;
      if (swapR.status === 'rejected') throw swapR.reason;
      if (signal?.aborted) throw signal.reason;
      const vm = parseVmStat(vmR.value);
      let swapUsed: number;
      if (swap) {
        swapUsed = swap.value;
      } else {
        swapUsed = parseSwapUsage(swapR.value);
        this.swapCache = { at: now(), value: swapUsed };
      }
      let level: MemoryValue['pressure'];
      if (pressure) {
        level = pressure.value;
      } else {
        level = parsePressureLevel(pressureR.value);
        this.pressureCache = { at: now(), value: level };
      }
      return {
        total: totalmem(),
        used: (Math.max(0, vm.anonymous - vm.purgeable) + vm.wired + vm.compressorOccupied) * vm.pageSize,
        cached: (vm.fileBacked + vm.purgeable) * vm.pageSize,
        pressure: level,
        swapUsed,
      };
    }, ttlMs);
  }
}
