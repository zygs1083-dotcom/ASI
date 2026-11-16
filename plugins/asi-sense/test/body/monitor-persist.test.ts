import type { BodyThresholdState } from '@asi/sense-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Baseline,
  BodyMonitor,
  type BodyPersistence,
  PersistScheduler,
  Tuner,
  type TunerActor,
} from '../../src/host/body/index.ts';
import { cpuBody, rssBody, freshSample as sample } from './helpers.ts';

const WEEK = 7 * 86_400_000;
const WALL = Date.UTC(2026, 0, 5, 10);
const port = () => ({
  data: undefined as string | undefined,
  saves: 0,
  async load() {
    return this.data;
  },
  async save(data: string) {
    this.data = data;
    this.saves++;
  },
});
afterEach(() => vi.useRealTimers());

describe('BodyMonitor persistence boundary', () => {
  it('coalesces slow in-flight saves instead of queueing back-to-back writes', async () => {
    vi.useFakeTimers();
    let mono = 0;
    let release = () => {};
    const writes: number[] = [];
    const scheduler = new PersistScheduler(
      async () => {
        writes.push(mono);
        if (writes.length === 1)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
      },
      () => mono,
    );
    scheduler.schedule();
    mono = 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    for (let i = 0; i < 3; i++) {
      mono += 10_000;
      scheduler.schedule();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toEqual([10_000, 40_000]);
    await scheduler.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('adopts the persisted timezone when the restoring host gives no override', async () => {
    const p = port();
    const seed = new Baseline({ installedAt: WALL, timeZone: 'America/New_York' });
    const a = new BodyMonitor({ baseline: seed, persistence: p });
    await a.restore();
    a.evaluate(sample(cpuBody(0.2), WALL - 1), sample(cpuBody(0.2), WALL), {});
    await a.close();
    const b = new BodyMonitor({ persistence: p });
    await b.restore();
    expect(b.baseline.timeZone).toBe('America/New_York');
    expect(b.baseline.read('cpu', WALL)?.count).toBe(1);
    await b.close();
  });

  it('restores baseline, counters, locks and ID lineage in one snapshot', async () => {
    const p = port();
    let actor: TunerActor = 'agent';
    const baseline = new Baseline({ installedAt: WALL - 2 * WEEK, timeZone: 'UTC' });
    for (const start of [WALL - 2 * WEEK, WALL - WEEK]) {
      for (let i = 0; i < 8; i++) baseline.observe('cpu', 0.2, start + i);
    }
    const create = () => {
      const tuner = new Tuner(
        { x: { value: 10 }, y: { value: 10 } },
        {
          actor: () => actor,
          clock: () => 0,
          wallClock: () => WALL,
        },
      );
      const monitor = new BodyMonitor({
        tuner,
        persistence: p,
        baseline,
        timeZone: 'UTC',
        clock: () => 0,
        wallClock: () => WALL,
      });
      return { tuner, monitor };
    };
    const a = create();
    expect(a.tuner.propose({ param: 'x', to: 11 }).reason).toBe('restore pending');
    await a.monitor.restore();
    const first = a.tuner.propose({ param: 'x', to: 11 });
    a.tuner.propose({ param: 'x', to: 10 });
    actor = 'user';
    a.tuner.lock('y');
    actor = 'agent';
    a.monitor.evaluate(sample(cpuBody(0.2), WALL - 1), sample(cpuBody(0.2), WALL), {});
    await a.monitor.close();
    const b = create();
    await b.monitor.restore();
    expect(b.tuner.tuningDisabled).toBeUndefined();
    expect(b.monitor.baseline.read('cpu', WALL)?.count).toBe(17);
    expect(b.tuner.propose({ param: 'x', to: 11 }).reason).toBe('hourly change limit');
    expect(b.tuner.unlock('y').applied).toBe(false);
    expect(b.tuner.propose({ param: 'y', to: 11 }).reason).toBe('param locked');
    expect(b.tuner.logs.at(-1)?.id).not.toBe(first.change.id);
    expect(b.tuner.logs[0]?.id.split('-').slice(0, -1)).toEqual(first.change.id.split('-').slice(0, -1));
    await b.monitor.close();
  });

  it.each(['{', '{"version":99}', '{"version":1,"latch":{},"history":{}}'])(
    'fails closed for malformed combined snapshot %s and stays disabled on restart',
    async (bad) => {
      const p = port();
      p.data = bad;
      const create = () => {
        const tuner = new Tuner({ x: { value: 10 } });
        const monitor = new BodyMonitor({ tuner, persistence: p });
        return { tuner, monitor };
      };
      const a = create();
      await a.monitor.restore();
      expect(a.monitor.tuningDisabled).toBe('restore-failed');
      expect(a.tuner.propose({ param: 'x', to: 11 }).applied).toBe(false);
      await a.monitor.close();
      const b = create();
      await b.monitor.restore();
      expect(b.tuner.tuningDisabled).toBe('restore-failed');
      await b.monitor.close();
    },
  );

  it('exposes restore failure without a tuner and clears baseline state', async () => {
    const p = port();
    p.data = '{';
    const monitor = new BodyMonitor({ persistence: p });
    await monitor.restore();
    expect(monitor.tuningDisabled).toBe('restore-failed');
    expect(monitor.baseline.read('cpu', WALL)).toBeUndefined();
    await monitor.close();
    expect(p.data).toContain('restore-failed');
  });

  it('does not overwrite storage before restore, even after evaluation and close', async () => {
    const p = port();
    p.data = '{';
    const monitor = new BodyMonitor({ persistence: p, clock: () => 0 });
    monitor.evaluate(sample(rssBody(0), 0), sample(rssBody(20), 1), {});
    await monitor.persist();
    await monitor.close();
    expect(p.data).toBe('{');
    expect(p.saves).toBe(0);
  });

  it('coalesces tuner-only mutations to 10s saves and flushes on exit', async () => {
    vi.useFakeTimers();
    const p = port();
    let mono = 0;
    const tuner = new Tuner(
      { x: { value: 10 } },
      {
        actor: () => 'user',
        clock: () => mono,
        wallClock: () => WALL,
      },
    );
    const monitor = new BodyMonitor({ tuner, persistence: p, clock: () => mono });
    await monitor.restore();
    tuner.propose({ param: 'x', to: 20 });
    tuner.lock('x');
    expect(p.saves).toBe(0);
    mono = 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(p.saves).toBe(1);
    tuner.unlock('x');
    mono = 15_000;
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.saves).toBe(1);
    await monitor.close();
    expect(p.saves).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects snapshot save failures and can retry the current state', async () => {
    let fail = true;
    let saved = '';
    const persistence: BodyPersistence = {
      load: async () => undefined,
      save: async (data) => {
        if (fail) throw new Error('fixture-save-failed');
        saved = data;
      },
    };
    const monitor = new BodyMonitor({ persistence });
    await monitor.restore();
    await expect(monitor.persist()).rejects.toThrow('fixture-save-failed');
    fail = false;
    await monitor.close();
    expect(JSON.parse(saved).version).toBe(1);
  });

  it('replays failed evaluator attempts from the same caller state without consuming samples', () => {
    const monitor = new BodyMonitor({ clock: () => 1000, wallClock: () => WALL });
    const prev = sample(rssBody(0), 0, undefined, 0);
    const next = sample(rssBody(1024 ** 3), 1000, undefined, 1000);
    const state: BodyThresholdState = {};
    const first = monitor.evaluate(prev, next, state);
    const retry = monitor.evaluate(prev, next, state);
    expect(retry.signals).toEqual(first.signals);
  });
});
