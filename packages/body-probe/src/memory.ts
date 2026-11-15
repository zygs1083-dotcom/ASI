import os from 'node:os';
import { runCommand, type RunFn } from './command.js';
import * as fact from './fact.js';
import type { Fact, MemoryValue, SourceRef } from './types.js';

export interface VmStat {
  pageSize: number;
  active: number;
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
    active: requiredField(text, 'Pages active'),
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

export interface MemoryDeps {
  run?: RunFn;
  platform?: NodeJS.Platform;
  totalmem?: () => number;
  src?: SourceRef;
}

export class MemorySampler {
  private readonly src: SourceRef;

  constructor(private readonly deps: MemoryDeps = {}) {
    this.src = deps.src ?? fact.source('memory', '/usr/bin/vm_stat + /usr/sbin/sysctl');
  }

  sample(ttlMs: number = fact.DEFAULT_TTL_MS): Promise<Fact<MemoryValue>> {
    if ((this.deps.platform ?? process.platform) !== 'darwin') {
      return Promise.resolve(fact.fail('unavailable', this.src, ttlMs));
    }
    const run = this.deps.run ?? runCommand;
    const totalmem = this.deps.totalmem ?? os.totalmem;
    return fact.collect(this.src, async () => {
      const [vmText, pressureText, swapText] = await Promise.all([
        run('/usr/bin/vm_stat'),
        run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
        run('/usr/sbin/sysctl', ['-n', 'vm.swapusage']),
      ]);
      const vm = parseVmStat(vmText);
      return {
        total: totalmem(),
        used: (vm.active + vm.wired + vm.compressorOccupied) * vm.pageSize,
        pressure: parsePressureLevel(pressureText),
        swapUsed: parseSwapUsage(swapText),
      };
    }, ttlMs);
  }
}
