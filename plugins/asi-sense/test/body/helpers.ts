import type {
  Body,
  BodyThresholdSample,
  DisksFact,
  DiskVolume,
  Fact,
  FactStatus,
  Signal,
  SourceRef,
} from '@asi/sense-types';
import { SRC } from '../helpers.ts';

export function f<T>(value: T | null, status: FactStatus = 'ok'): Fact<T> {
  return { value, status, source: SRC, observedAt: 0, ttlMs: 60_000 };
}

export function diskFact(value: DiskVolume[] | null, status: FactStatus = 'ok'): DisksFact {
  return {
    ...f(value?.map((volume) => ({ observedAt: 0, ttlMs: 60_000, ...volume })) ?? null, status),
    kind: 'disks',
  };
}

export const blank = (status: FactStatus = 'unknown'): Fact<never> => f<never>(null, status);

export const SRC2: SourceRef = { id: 'ax', api: 'test', host: 'local' };

export function mkBody(over: Partial<Body> = {}): Body {
  return {
    cpu: blank(),
    memory: blank(),
    disks: diskFact(null, 'unknown'),
    battery: blank(),
    thermal: blank(),
    network: blank(),
    harnessProcess: blank(),
    tokens: blank(),
    ...over,
  };
}

export function sample(
  body: Body,
  at: number,
  state?: BodyThresholdSample['state'],
  monotonicAt?: number,
): BodyThresholdSample {
  return {
    body,
    at,
    source: SRC,
    monotonicAt: monotonicAt ?? at,
    ...(state ? { state } : {}),
  };
}

/** Fresh sensor facts for wall-clock and multi-week replay tests. */
export function freshSample(
  body: Body,
  at: number,
  state?: BodyThresholdSample['state'],
  mono?: number,
): BodyThresholdSample {
  const fresh = Object.fromEntries(Object.entries(body).map(([k, fact]) => [k, { ...fact, observedAt: at }])) as Body;
  fresh.disks.value = fresh.disks.value?.map((volume) => ({ ...volume, observedAt: at })) ?? null;
  return sample(fresh, at, state, mono);
}

/** Same shape with a caller-chosen stream source. */
export function sampleSrc(source: SourceRef, body: Body, at: number, monotonicAt?: number): BodyThresholdSample {
  return { ...freshSample(body, at, undefined, monotonicAt), source };
}

export const cpuBody = (usage: number) =>
  mkBody({ cpu: f({ usage, perCore: [usage], load1: 0, load5: 0, load15: 0 }) });
export const rssBody = (rss: number) => mkBody({ harnessProcess: f({ rss, cpu: 0, uptimeSec: 0 }) });
export const diskBody = (free: number, total = 1000, mount = '/') =>
  mkBody({ disks: diskFact([{ mount, total, free }]) });
export const ctxBody = (window: number, used?: number) =>
  mkBody({
    tokens: f({
      contextWindow: window,
      ...(used !== undefined ? { contextUsed: used } : {}),
      contextProjected: 999_999, // must never be read
      sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  });
export const battBody = (percent: number | null, charging = false) =>
  mkBody({ battery: f(percent === null ? null : { percent, charging }) });
export const netBody = (rxBps: number, txBps: number) => mkBody({ network: f({ online: true, rxBps, txBps }) });
export const memBody = (used: number, total = 100) =>
  mkBody({ memory: f({ total, used, pressure: 'normal', swapUsed: 0 }) });

export function fileChanged(id: string, at: number, path: string, change: string, cause?: Signal['cause']): Signal {
  return {
    id,
    kind: 'file.changed',
    at,
    source: SRC,
    subject: path,
    data: { path, change },
    ...(cause ? { cause } : {}),
  };
}
