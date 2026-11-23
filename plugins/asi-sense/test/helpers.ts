import type { Body, DisksFact, DiskVolume, Fact, Signal, SourceRef } from '@asi/sense-types';

export const SRC: SourceRef = { id: 'fs', api: 'test', host: 'local' };
export const SRC2: SourceRef = { id: 'ax', api: 'test', host: 'local' };

export function sig(partial: Partial<Signal> & Pick<Signal, 'id' | 'kind'>): Signal {
  return { at: 0, source: SRC, subject: 'sub', data: {}, ...partial };
}

export function jobExit(id: string, at: number, exitCode: number, subject = 'j1', extra: Partial<Signal> = {}): Signal {
  return sig({
    id,
    kind: 'job.exited',
    at,
    subject,
    data: { exitCode, command: 'pnpm test' },
    ...extra,
  });
}

export function f<T>(value: T | null, status: Fact<T>['status'] = 'ok', observedAt = 0, ttlMs = 30_000): Fact<T> {
  return {
    value,
    status,
    source: { id: 'probe', api: 'test', host: 'local' },
    observedAt,
    ttlMs,
  };
}

export function diskFact(
  volumes: DiskVolume[] | null,
  status: DisksFact['status'] = 'ok',
  observedAt = 0,
  ttlMs = 30_000,
  unavailableMounts?: string[],
): DisksFact {
  return {
    kind: 'disks',
    value: volumes,
    status,
    source: { id: 'probe', api: 'test', host: 'local' },
    observedAt,
    ttlMs,
    ...(unavailableMounts ? { unavailableMounts } : {}),
  };
}

export function mkBody(overrides: Partial<Body> = {}, observedAt = 0): Body {
  return {
    cpu: f({ usage: 0.2, perCore: [0.2], load1: 1, load5: 1, load15: 1 }, 'ok', observedAt),
    memory: f({ total: 16 * 1024 ** 3, used: 8 * 1024 ** 3, pressure: 'normal', swapUsed: 0 }, 'ok', observedAt),
    disks: diskFact([{ mount: '/', total: 100 * 1024 ** 3, free: 50 * 1024 ** 3 }], 'ok', observedAt),
    battery: f({ percent: 80, charging: true }, 'ok', observedAt),
    thermal: f('nominal', 'ok', observedAt),
    network: f({ online: true, rxBps: 100, txBps: 50 }, 'ok', observedAt),
    harnessProcess: f({ rss: 120 * 1024 ** 2, cpu: 0.01, uptimeSec: 60 }, 'ok', observedAt),
    tokens: f<NonNullable<Body['tokens']['value']>>(null, 'unknown', observedAt),
    ...overrides,
  };
}

/**
 * Two independent clocks: `now` is monotonic (deadlines, budgets) and `wall`
 * is the wall clock (display, timestamps). `advance` moves both so
 * existing tests stay deterministic; `jumpWall` moves only the wall clock.
 */
export class FakeClock {
  now = 0;
  wall = 0;
  advance(ms: number): void {
    this.now += ms;
    this.wall += ms;
  }
  jumpWall(ms: number): void {
    this.wall += ms;
  }
  time = (): number => this.now;
  wallTime = (): number => this.wall;
}
