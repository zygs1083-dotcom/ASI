import { defaultRun, type RunFn } from './command.js';
import * as fact from './fact.js';
import type { Fact, ProcessValue, SourceRef } from './types.js';

export function parseElapsed(etime: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) throw new Error(`ps etime: ${etime}`);
  const days = m[1] !== undefined ? Number(m[1]) : undefined;
  const hours = m[2] !== undefined ? Number(m[2]) : undefined;
  const minutes = Number(m[3]);
  const seconds = Number(m[4]);
  for (const n of [days, hours, minutes, seconds]) {
    if (n !== undefined && !(Number.isSafeInteger(n) && n >= 0)) throw new Error(`ps etime: ${etime}`);
  }
  if (seconds > 59 || minutes > 59) throw new Error(`ps etime: ${etime}`);
  if (days !== undefined && hours !== undefined && hours > 23) throw new Error(`ps etime: ${etime}`);
  const total = (days ?? 0) * 86400 + (hours ?? 0) * 3600 + minutes * 60 + seconds;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error(`ps etime: ${etime}`);
  return total;
}

export function parsePsRow(text: string): ProcessValue {
  const cols = text.trim().split(/\s+/);
  if (cols.length < 3) throw new Error('ps: short row');
  const rssKiB = Number(cols[0]);
  const cpuPct = Number(cols[1]);
  const uptimeSec = parseElapsed(cols[2]!);
  if (!Number.isSafeInteger(rssKiB) || rssKiB < 0 || !Number.isFinite(cpuPct) || cpuPct < 0) {
    throw new Error('ps: bad fields');
  }
  return { rss: rssKiB * 1024, cpu: cpuPct / 100, uptimeSec };
}

export interface ProcessDeps {
  run?: RunFn;
  now?: () => number;
  memoryUsage?: () => NodeJS.MemoryUsage;
  resourceUsage?: () => NodeJS.ResourceUsage;
  uptime?: () => number;
  src?: SourceRef;
}

export class SelfProcessSampler {
  private prev: { micros: number; at: number } | undefined;
  private readonly src: SourceRef;

  constructor(private readonly deps: ProcessDeps = {}) {
    this.src = deps.src ?? fact.source('harnessProcess', 'process.resourceUsage');
  }

  sample(ttlMs: number = fact.DEFAULT_TTL_MS): Fact<ProcessValue> {
    try {
      const ru = (this.deps.resourceUsage ?? (() => process.resourceUsage()))();
      const micros = ru.userCPUTime + ru.systemCPUTime;
      const at = (this.deps.now ?? (() => globalThis.performance.now()))();
      const rss = (this.deps.memoryUsage ?? (() => process.memoryUsage()))().rss;
      const uptimeSec = (this.deps.uptime ?? (() => process.uptime()))();
      if (
        !Number.isFinite(micros) ||
        micros < 0 ||
        !Number.isFinite(at) ||
        !Number.isFinite(rss) ||
        rss < 0 ||
        !Number.isFinite(uptimeSec) ||
        uptimeSec < 0
      ) {
        return fact.fail('unavailable', this.src, ttlMs);
      }
      const prev = this.prev;
      this.prev = { micros, at };
      if (!prev) return fact.fail('unknown', this.src, ttlMs);
      const elapsedMs = at - prev.at;
      const cpu = (micros - prev.micros) / (elapsedMs * 1000);
      // cpu is a fraction; it can exceed 1 on multi-core and is not clamped
      if (!(elapsedMs > 0) || !Number.isFinite(cpu) || cpu < 0) return fact.fail('unknown', this.src, ttlMs);
      return fact.ok({ rss, cpu, uptimeSec }, this.src, ttlMs);
    } catch (err) {
      this.prev = undefined;
      return fact.fail(fact.errorStatus(err), this.src, ttlMs);
    }
  }

  // Drops the previous CPU usage snapshot so a stop/restart re-baselines
  // instead of averaging across the stopped interval.
  reset(): void {
    this.prev = undefined;
  }
}

export class ExternalProcessSampler {
  private readonly src: SourceRef;

  constructor(
    private readonly pid: number,
    private readonly deps: ProcessDeps = {},
  ) {
    this.src = deps.src ?? fact.source('harnessProcess', '/bin/ps');
  }

  sample(ttlMs: number = fact.DEFAULT_TTL_MS, signal?: AbortSignal): Promise<Fact<ProcessValue>> {
    if (!Number.isInteger(this.pid) || this.pid <= 0) {
      return Promise.resolve(fact.fail('unavailable', this.src, ttlMs));
    }
    const run = this.deps.run ?? defaultRun;
    return fact.collect(
      this.src,
      async () => parsePsRow(await run('/bin/ps', ['-o', 'rss=,%cpu=,etime=', '-p', String(this.pid)], signal)),
      ttlMs,
    );
  }
}
