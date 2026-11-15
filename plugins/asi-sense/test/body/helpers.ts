import type { Body, BodyThresholdSample, Fact, FactStatus, Signal } from '@asi/sense-types';
import { SRC } from '../helpers.ts';

export function f<T>(value: T | null, status: FactStatus = 'ok'): Fact<T> {
  return { value, status, source: SRC, observedAt: 0, ttlMs: 60_000 };
}

export const blank = (status: FactStatus = 'unknown'): Fact<never> => f<never>(null, status);

export function mkBody(over: Partial<Body> = {}): Body {
  return {
    cpu: blank(),
    memory: blank(),
    disks: blank(),
    battery: blank(),
    thermal: blank(),
    network: blank(),
    harnessProcess: blank(),
    tokens: blank(),
    ...over,
  };
}

export function sample(body: Body, at: number, state?: BodyThresholdSample['state']): BodyThresholdSample {
  return { body, at, source: SRC, ...(state ? { state } : {}) };
}

export const cpuBody = (usage: number) =>
  mkBody({ cpu: f({ usage, perCore: [usage], load1: 0, load5: 0, load15: 0 }) });
export const rssBody = (rss: number) => mkBody({ harnessProcess: f({ rss, cpu: 0, uptimeSec: 0 }) });
export const diskBody = (free: number, total = 1000, mount = '/') => mkBody({ disks: f([{ mount, total, free }]) });
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
