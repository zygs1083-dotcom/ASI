import os from 'node:os';
import type { CpuValue, Fact, SourceRef } from './types.js';
import * as fact from './fact.js';

export interface CoreTimes {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}

export function snapshotTimes(cpus: readonly os.CpuInfo[]): CoreTimes[] {
  return cpus.map((c) => ({ ...c.times }));
}

const FIELDS: readonly (keyof CoreTimes)[] = ['user', 'nice', 'sys', 'idle', 'irq'];

export function deltaUsage(prev: readonly CoreTimes[], next: readonly CoreTimes[]): {
  perCore: number[];
  overall: number;
} | null {
  if (prev.length === 0 || prev.length !== next.length) return null;
  const perCore: number[] = [];
  let busySum = 0;
  let totalSum = 0;
  for (let i = 0; i < next.length; i += 1) {
    const a = prev[i]!;
    const b = next[i]!;
    let dTotal = 0;
    for (const f of FIELDS) {
      const d = b[f] - a[f];
      // Any counter decrease or non-finite value means the counters are not
      // comparable; rebasing is required even if the aggregate still rises.
      if (!Number.isFinite(d) || d < 0) return null;
      dTotal += d;
    }
    const dIdle = b.idle - a.idle;
    const dBusy = dTotal - dIdle;
    if (!(dTotal > 0)) return null;
    perCore.push(dBusy / dTotal);
    busySum += dBusy;
    totalSum += dTotal;
  }
  if (!(totalSum > 0)) return null;
  return { perCore, overall: busySum / totalSum };
}

export interface CpuDeps {
  cpus?: () => os.CpuInfo[];
  loadavg?: () => number[];
  src?: SourceRef;
}

export class CpuSampler {
  private prev: CoreTimes[] | undefined;
  private readonly src: SourceRef;

  constructor(private readonly deps: CpuDeps = {}) {
    this.src = deps.src ?? fact.source('cpu', 'os.cpus');
  }

  sample(ttlMs: number = fact.DEFAULT_TTL_MS): Fact<CpuValue> {
    try {
      const next = snapshotTimes((this.deps.cpus ?? os.cpus)());
      const prev = this.prev;
      this.prev = next;
      const delta = prev ? deltaUsage(prev, next) : null;
      if (!delta) return fact.fail('unknown', this.src, ttlMs);
      const [load1, load5, load15] = (this.deps.loadavg ?? os.loadavg)();
      if (![load1, load5, load15].every((n) => Number.isFinite(n))) {
        return fact.fail('unavailable', this.src, ttlMs);
      }
      return fact.ok({ usage: delta.overall, perCore: delta.perCore, load1: load1!, load5: load5!, load15: load15! }, this.src, ttlMs);
    } catch (err) {
      this.prev = undefined;
      return fact.fail(fact.errorStatus(err), this.src, ttlMs);
    }
  }

  // Drops the previous CPU tick snapshot so a stop/restart re-baselines instead
  // of averaging across the stopped interval.
  reset(): void {
    this.prev = undefined;
  }
}
