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
  it('waits for an in-flight tuner transaction before shutdown returns', async () => {
    const p = port();
    const save = p.save.bind(p);
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    p.save = async (data) => {
      if (!release && (JSON.parse(data) as { tuner?: string }).tuner?.includes('["x",11]')) {
        started?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      await save(data);
    };
    const tuner = new Tuner({ x: { value: 10 } });
    const monitor = new BodyMonitor({ tuner, persistence: p });
    await monitor.restore();
    const change = tuner.propose({ param: 'x', to: 11 });
    let closed = false;
    const closing = monitor.close().then(() => {
      closed = true;
    });
    await began;
    if (!release) throw new Error('save did not start');
    try {
      expect(closed).toBe(false);
    } finally {
      release();
    }
    expect((await change).applied).toBe(true);
    await closing;
    expect((JSON.parse(p.data ?? '{}') as { tuner?: string }).tuner).toContain('["x",11]');
    await expect(tuner.propose({ param: 'x', to: 12 })).rejects.toThrow('closed');
  });

  it('disables AI if an explicit combined snapshot flush fails', async () => {
    const p = port();
    p.save = async () => {
      throw new Error('flush failed');
    };
    const tuner = new Tuner({ x: { value: 10 } });
    const monitor = new BodyMonitor({ tuner, persistence: p });
    await monitor.restore();
    await expect(monitor.persist()).rejects.toThrow('flush failed');
    expect(monitor.tuningDisabled).toBe('storage-failed');
    expect(tuner.tuningDisabled).toBe('storage-failed');
  });

  it('disables AI when a delayed baseline snapshot fails', async () => {
    vi.useFakeTimers();
    const p = port();
    p.save = async () => {
      throw new Error('timer save failed');
    };
    const tuner = new Tuner({ x: { value: 10 } }, { clock: () => 0 });
    const monitor = new BodyMonitor({ tuner, persistence: p, clock: () => 0 });
    await monitor.restore();
    monitor.evaluate(sample(rssBody(0), 0), sample(rssBody(1), 1), {});
    await vi.advanceTimersByTimeAsync(10_000);
    expect(monitor.tuningDisabled).toBe('storage-failed');
    expect(tuner.tuningDisabled).toBe('storage-failed');
    await expect(monitor.close()).rejects.toThrow('timer save failed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('serializes concurrent critical writes and exposes values only after durable commit', async () => {
    const p = port();
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const save = p.save.bind(p);
    p.save = async (data) => {
      if (p.saves === 0) {
        started?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      await save(data);
    };
    const tuner = new Tuner({ x: { value: 10 }, y: { value: 10 } }, { actor: () => 'user', wallClock: () => WALL });
    const monitor = new BodyMonitor({ tuner, persistence: p });
    await monitor.restore();
    const change = tuner.propose({ param: 'x', to: 11 });
    const lock = tuner.lock('y');
    await startedPromise;
    expect(tuner.get('x')).toBe(10);
    expect(tuner.logs).toHaveLength(0);
    if (!release) throw new Error('save did not start');
    release();
    expect((await change).applied).toBe(true);
    expect((await lock).applied).toBe(true);
    const recoveredTuner = new Tuner({ x: { value: 10 }, y: { value: 10 } }, { wallClock: () => WALL });
    const recovered = new BodyMonitor({ tuner: recoveredTuner, persistence: p });
    await recovered.restore();
    expect(recoveredTuner.get('x')).toBe(11);
    expect((await recoveredTuner.propose({ param: 'y', to: 11 })).reason).toBe('param locked');
    await monitor.close();
    await recovered.close();
  });

  it('fails closed on a combined-store critical write without changing the committed value', async () => {
    const p = port();
    const save = p.save.bind(p);
    let fail = false;
    p.save = async (data) => {
      if (fail) throw new Error('fixture failure');
      await save(data);
    };
    const tuner = new Tuner({ x: { value: 10 } }, { wallClock: () => WALL });
    const monitor = new BodyMonitor({ tuner, persistence: p });
    await monitor.restore();
    await tuner.propose({ param: 'x', to: 11 });
    const committed = p.data;
    fail = true;
    await expect(tuner.propose({ param: 'x', to: 10 })).rejects.toThrow('fixture failure');
    expect(tuner.get('x')).toBe(11);
    expect(tuner.tuningDisabled).toBe('storage-failed');
    expect(monitor.tuningDisabled).toBe('storage-failed');
    expect(p.data).toBe(committed);
  });

  it('accumulates monotonic installation time conservatively across restarts', async () => {
    const p = port();
    let mono = 0;
    const create = () => new BodyMonitor({ persistence: p, clock: () => mono, wallClock: () => WALL, timeZone: 'UTC' });
    const a = create();
    await a.restore();
    const first = sample(cpuBody(0.5), WALL, undefined, mono);
    let state = a.evaluate(first, first, {}).state;
    mono = 23 * 3_600_000;
    const second = sample(cpuBody(0.5), WALL + WEEK, undefined, mono);
    state = a.evaluate(first, second, state).state;
    expect(a.baseline.read('cpu', WALL)?.dates).toBe(1);
    await a.persist();
    mono = 0;
    const b = create();
    await b.restore();
    expect(b.baseline.learningProgress).toBeCloseTo((23 / 24) * 100);
    const resumed = sample(cpuBody(0.5), WALL + WEEK * 2, undefined, mono);
    state = b.evaluate(resumed, resumed, b.restoredState ?? {}).state;
    mono = 3_600_000;
    const last = sample(cpuBody(0.5), WALL + WEEK * 3, undefined, mono);
    b.evaluate(resumed, last, state);
    expect(b.baseline.learningProgress).toBe(100);
    expect(b.baseline.read('cpu', WALL)?.dates).toBe(2);
    await b.close();
  });

  it('persists installation age across idle runs before the first sample', async () => {
    const p = port();
    let mono = 0;
    const create = () => new BodyMonitor({ persistence: p, clock: () => mono, wallClock: () => WALL, timeZone: 'UTC' });
    const a = create();
    await a.restore();
    mono = 23 * 3_600_000;
    await a.persist();
    mono = 0;
    const b = create();
    await b.restore();
    expect(b.baseline.learningProgress).toBeCloseTo((23 / 24) * 100);
    mono = 3_600_000;
    await b.persist();
    mono = 0;
    const c = create();
    await c.restore();
    expect(c.baseline.learningProgress).toBe(100);
    await c.close();
  });

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

  it('uses the configured timezone when restoring', async () => {
    const p = port();
    const seed = new Baseline({ installedAt: WALL, timeZone: 'America/New_York' });
    const a = new BodyMonitor({ baseline: seed, persistence: p });
    await a.restore();
    a.evaluate(sample(cpuBody(0.2), WALL - 1), sample(cpuBody(0.2), WALL), {});
    await a.close();
    const b = new BodyMonitor({ persistence: p, timeZone: 'America/New_York' });
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
    await expect(a.tuner.propose({ param: 'x', to: 11 })).rejects.toThrow('restore pending');
    await a.monitor.restore();
    const first = await a.tuner.propose({ param: 'x', to: 11 });
    await a.tuner.propose({ param: 'x', to: 10 });
    actor = 'user';
    await a.tuner.lock('y');
    actor = 'agent';
    a.monitor.evaluate(sample(cpuBody(0.2), WALL - 1), sample(cpuBody(0.2), WALL), {});
    await a.monitor.close();
    const b = create();
    await b.monitor.restore();
    expect(b.tuner.tuningDisabled).toBeUndefined();
    expect(b.monitor.baseline.read('cpu', WALL)?.count).toBe(17);
    expect((await b.tuner.propose({ param: 'x', to: 11 })).reason).toBe('hourly change limit');
    expect((await b.tuner.unlock('y')).applied).toBe(false);
    expect((await b.tuner.propose({ param: 'y', to: 11 })).reason).toBe('param locked');
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
      await expect(a.tuner.propose({ param: 'x', to: 11 })).rejects.toThrow('restore-failed');
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

  it('persists tuner-only mutations before returning and flushes on exit', async () => {
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
    await tuner.propose({ param: 'x', to: 20 });
    await tuner.lock('x');
    expect(p.saves).toBe(2);
    mono = 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(p.saves).toBe(2);
    await tuner.unlock('x');
    mono = 15_000;
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.saves).toBe(3);
    await monitor.close();
    expect(p.saves).toBe(4);
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
