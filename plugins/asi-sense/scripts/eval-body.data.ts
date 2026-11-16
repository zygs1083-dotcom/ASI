import type { Body, BodyThresholdSample, Fact, Signal } from '@asi/sense-types';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const GIB = 1024 ** 3;
export const START = Date.UTC(2026, 2, 6, 5);
export const SEEDS = [0x415349, 0x12345678, 0x6d2b79f5];
export const ROOT = '/fixture/work';
const source = { id: 'synthetic-body', api: 'offline-eval', host: 'fixture' };

// Workload values are fixtures, not functions of detector thresholds.
export const disturbances = [
  { name: 'disk drop', kind: 'body.rate', metric: 'disk:/', start: DAY + 2 * HOUR, duration: 8 * MINUTE },
  { name: 'RSS leak', kind: 'body.rate', metric: 'rss', start: 2 * DAY + 4 * HOUR, duration: 8 * MINUTE },
  { name: 'scattered deletion', kind: 'file.burst', metric: ROOT, start: 3 * DAY + HOUR, duration: 2 * MINUTE },
  { name: 'CPU anomaly', kind: 'body.anomaly', metric: 'cpu', start: 4 * DAY + 12 * HOUR, duration: 8 * MINUTE },
  { name: 'context drain', kind: 'body.rate', metric: 'context', start: 5 * DAY + 8 * HOUR, duration: 8 * MINUTE },
  { name: 'CPU sustained (2h)', kind: 'body.anomaly', metric: 'cpu', start: 6 * DAY + 12 * HOUR, duration: 2 * HOUR },
] as const;

export interface Frame {
  elapsed: number;
  wall: number;
  sample: BodyThresholdSample;
  files: Signal[];
}

function random(seed: number): () => number {
  let value = seed;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 2 ** 32;
  };
}

function active(name: string, elapsed: number, inject: boolean): number | undefined {
  if (!inject) return undefined;
  const disturbance = disturbances.find((d) => d.name === name);
  if (!disturbance) return undefined;
  const delta = elapsed - disturbance.start;
  return delta >= 0 && delta < disturbance.duration ? delta / 1000 : undefined;
}

function reading(
  elapsed: number,
  wall: number,
  index: number,
  rng: () => number,
  inject: boolean,
): BodyThresholdSample {
  const fact = <T>(value: T | null): Fact<T> => ({
    value,
    observedAt: wall,
    ttlMs: 2 * MINUTE,
    status: value === null ? 'unknown' : 'ok',
    source,
  });
  const jitter = () => 2 * rng() - 1;
  const boundary = elapsed >= 0 && elapsed % DAY >= 6 * HOUR && elapsed % DAY < 8 * HOUR;
  const highRss = index % 2 === 0;
  const elevated =
    active('CPU anomaly', elapsed, inject) !== undefined || active('CPU sustained (2h)', elapsed, inject) !== undefined;
  const cpu = elevated ? 0.99 : 0.5 + 0.16 * jitter();
  const rssBase = boundary ? (highRss ? 2.98 : 2) * GIB : (2.25 + 0.22 * jitter()) * GIB;
  const rss = rssBase + Math.min(3 * GIB, (active('RSS leak', elapsed, inject) ?? 0) * 16 * 1024 ** 2);
  const diskBase = boundary ? (highRss ? 58.02 : 60) * GIB : (60 + 0.005 * jitter()) * GIB;
  // The write load persists through outages; an entirely unobserved short
  // drop cannot establish a one-minute loss rate after a four-minute gap.
  const free = diskBase - (active('disk drop', elapsed, inject) ?? 0) * 80 * 1024 ** 2;
  const used =
    68_000 +
    ((((elapsed % MINUTE) + MINUTE) % MINUTE) / 1000) * 80 +
    Math.min(45_000, (active('context drain', elapsed, inject) ?? 0) * 250);
  const body: Body = {
    cpu: fact(index % 53 === 0 ? null : { usage: cpu, perCore: [cpu], load1: cpu, load5: cpu, load15: cpu }),
    memory: fact({ total: 16 * GIB, used: 5 * GIB, pressure: 'normal', swapUsed: 0 }),
    disks: fact([{ mount: '/', total: 100 * GIB, free }]),
    battery: fact(null),
    thermal: fact('nominal'),
    network: fact({ online: true, rxBps: 40_000 + 20_000 * jitter(), txBps: 8_000 + 4_000 * jitter() }),
    harnessProcess: fact(index % 37 === 0 ? null : { rss, cpu, uptimeSec: Math.max(0, elapsed / 1000) }),
    tokens: fact({
      contextWindow: 128_000,
      contextUsed: used,
      sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  };
  return { at: wall, monotonicAt: elapsed, body, source };
}

/**
 * Seven days cross New York's spring DST transition. A temporary +3h wall
 * jump and its rollback occur on day five; monotonic receipt time is intact.
 * Every 97th interval is a four-minute sampling outage, otherwise 35-53s.
 */
export function* trace(seed: number, options: { warmup?: boolean; inject?: boolean } = {}): Generator<Frame> {
  const rng = random(seed);
  const emitted = new Set<string>();
  const warmup = options.warmup ?? false;
  let elapsed = warmup ? -14 * DAY : 0;
  let index = 0;
  while (elapsed < (warmup ? 0 : 7 * DAY)) {
    const jump = !warmup && elapsed >= 4 * DAY && elapsed < 4 * DAY + 15 * MINUTE ? 3 * HOUR : 0;
    const wall = START + elapsed + jump;
    const files: Signal[] = [];
    const addFiles = (tag: string, count: number, change: string, cause: Signal['cause']) => {
      for (let j = 0; j < count; j++) {
        const path = `${ROOT}/branch-${j % 3}/${tag}-${j}.txt`;
        files.push({
          id: `${seed}:${index}:${tag}:${j}`,
          kind: 'file.changed',
          at: wall,
          source,
          subject: path,
          cause,
          data: { change, path },
        });
      }
    };
    if (!warmup) {
      addFiles('background', Math.floor(rng() * 4), index % 2 ? 'add' : 'modify', 'user');
      const block = Math.floor(elapsed / (3 * HOUR));
      if (!emitted.has(`boundary-${block}`)) {
        emitted.add(`boundary-${block}`);
        addFiles('boundary', block % 2 ? 49 : 50, 'delete', 'user');
      }
      if (index % 433 === 0) addFiles('agent', 120, index % 2 ? 'add' : 'modify', 'agent');
      if (active('scattered deletion', elapsed, options.inject ?? false) !== undefined && !emitted.has('delete')) {
        emitted.add('delete');
        addFiles('disturbance', 72, 'delete', 'user');
      }
    }
    yield { elapsed, wall, sample: reading(elapsed, wall, index, rng, options.inject ?? false), files };
    index++;
    elapsed += warmup ? 90_000 : index % 97 === 0 ? 4 * MINUTE : 35_000 + Math.floor(rng() * 18_000);
  }
}
