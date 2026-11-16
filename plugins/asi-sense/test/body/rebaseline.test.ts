import type { BodyThresholdState } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { Baseline, BodyMonitor, defaultRateRules, Tuner } from '../../src/host/body/index.ts';
import { cpuBody, diskBody, freshSample, rssBody } from './helpers.ts';

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const MON10 = Date.UTC(2026, 0, 19, 10);

async function fixture(
  specs: Record<string, { value: number }> = {},
  rules = [{ id: 'cpu', metric: 'cpu', sigma: 3 }],
  rates = [] as ReturnType<typeof defaultRateRules>,
  sourceId = 'fs',
) {
  let mono = 0;
  let wall = MON10;
  let saved: string | undefined;
  let failed = false;
  let hold: ((data: string) => Promise<void>) | undefined;
  const persistence = {
    load: async () => saved,
    save: async (data: string) => {
      if (failed) throw new Error('storage failure');
      await hold?.(data);
      saved = data;
    },
  };
  const baseline = new Baseline({ installedAt: MON10 - 2 * WEEK, timeZone: 'UTC', elapsedMs: 2 * WEEK });
  for (const offset of [-2 * WEEK, -WEEK]) {
    for (const hour of [0, 3_600_000]) {
      for (let i = 0; i < 8; i++) baseline.observe('cpu', 0.5, MON10 + offset + hour + i);
    }
  }
  let actor: 'agent' | 'user' = 'agent';
  const tuner = new Tuner(specs, { actor: () => actor, clock: () => mono, wallClock: () => wall });
  const monitor = new BodyMonitor({
    baseline,
    tuner,
    persistence,
    timeZone: 'UTC',
    clock: () => mono,
    wallClock: () => wall,
    rateRules: rates,
    anomalyRules: rules,
  });
  await monitor.restore();
  let state: BodyThresholdState = {};
  let prev = freshSample(cpuBody(0.5), wall, undefined, mono);
  prev.source = { ...prev.source, id: sourceId };
  const feed = async (at: number, receipt: number, value: number) => {
    mono = receipt;
    wall = at;
    const next = freshSample(cpuBody(value), at, undefined, receipt);
    next.source = { ...next.source, id: sourceId };
    const result = await monitor.evaluateAuto(prev, next, state);
    state = result.state;
    prev = next;
    return result;
  };
  return {
    monitor,
    tuner,
    feed,
    persistence,
    snapshot: () => saved,
    fail: () => {
      failed = true;
    },
    setHold: (callback: (data: string) => Promise<void>) => {
      hold = callback;
    },
    setTime: (at: number, receipt: number) => {
      wall = at;
      mono = receipt;
    },
    asUser: () => {
      actor = 'user';
    },
    asAgent: () => {
      actor = 'agent';
    },
  };
}

async function reload(
  persistence: { load: () => Promise<string | undefined>; save: (data: string) => Promise<void> },
  rules = [{ id: 'cpu', metric: 'cpu', sigma: 3 }],
  specs: Record<string, { value: number }> = {},
) {
  let mono = 0;
  let wall = MON10 + 2 * WEEK;
  let actor: 'agent' | 'user' = 'agent';
  const tuner = new Tuner(specs, { actor: () => actor, clock: () => mono, wallClock: () => wall });
  const monitor = new BodyMonitor({
    tuner,
    persistence,
    timeZone: 'UTC',
    clock: () => mono,
    wallClock: () => wall,
    rateRules: [],
    anomalyRules: rules,
  });
  await monitor.restore();
  let state = monitor.restoredState ?? {};
  let prev = freshSample(cpuBody(0.99), wall, undefined, mono);
  const feed = async (at: number, receipt: number, value: number) => {
    wall = at;
    mono = receipt;
    const next = freshSample(cpuBody(value), at, undefined, mono);
    const result = await monitor.evaluateAuto(prev, next, state);
    state = result.state;
    prev = next;
    return result;
  };
  return {
    monitor,
    tuner,
    feed,
    asUser: () => {
      actor = 'user';
    },
  };
}

describe('user-confirmed rebaselining', () => {
  it('never automatically relearns during an eight-week hourly sustained CPU workload', async () => {
    const hour = 3_600_000;
    let mono = 0;
    let wall = MON10;
    let saved: string | undefined;
    const persistence = {
      load: async () => saved,
      save: async (data: string) => {
        saved = data;
      },
    };
    const seed = new Baseline({ installedAt: MON10 - 2 * WEEK, timeZone: 'UTC', elapsedMs: 2 * WEEK });
    for (const week of [-2, -1]) {
      for (let i = 0; i < 4; i++) seed.observe('cpu', 0.5, MON10 + week * WEEK + i);
    }
    const snapshot = JSON.parse(seed.serialize()) as {
      metrics: { cpu: ({ lastAt: number; dates: string[] } | null)[] };
    };
    const bucket = snapshot.metrics.cpu.find((entry) => entry !== null);
    if (!bucket) throw new Error('missing seed bucket');
    const localDate = (at: number) => {
      const date = new Date(at);
      return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
    };
    for (let slot = 0; slot < 168; slot++) {
      const at = MON10 + slot * hour;
      const date = new Date(at);
      snapshot.metrics.cpu[date.getUTCDay() * 24 + date.getUTCHours()] = {
        ...bucket,
        lastAt: at - WEEK + 3,
        dates: [localDate(at - 2 * WEEK), localDate(at - WEEK)],
      };
    }
    const baseline = Baseline.deserialize(JSON.stringify(snapshot), { timeZone: 'UTC' });
    expect(baseline.restoreFailed).toBe(false);
    const tuner = new Tuner({}, { clock: () => mono, wallClock: () => wall });
    const monitor = new BodyMonitor({
      baseline,
      tuner,
      persistence,
      timeZone: 'UTC',
      clock: () => mono,
      wallClock: () => wall,
      rateRules: [],
      anomalyRules: [{ id: 'cpu', metric: 'cpu' }],
    });
    await monitor.restore();
    let state: BodyThresholdState = {};
    let prev = freshSample(cpuBody(0.5), wall - 1, undefined, -1);
    for (let sample = 0; sample < 8 * 168; sample++) {
      mono = sample * hour;
      wall = MON10 + mono;
      const next = freshSample(cpuBody(0.99), wall, undefined, mono);
      const result = await monitor.evaluateAuto(prev, next, state);
      expect(result.tuningError).toBeUndefined();
      state = result.state;
      prev = next;
      if (sample === 168 + 2) expect(monitor.baseline.read('cpu', MON10 + 2 * hour)?.mean).toBeCloseTo(0.5);
      if (sample === 2 * 168 + 2) expect(monitor.baseline.read('cpu', MON10 + 2 * hour)?.mean).toBeCloseTo(0.5);
    }
    expect(tuner.undoableChanges.filter((entry) => entry.kind === 'rebaseline')).toHaveLength(0);
    await monitor.close();
  }, 30_000);

  it('suggests a sustained new workload on the third date and supports user undo', async () => {
    const { monitor, tuner, feed, asUser, asAgent } = await fixture();
    for (let week = 0; week < 3; week++) {
      for (let i = 0; i < 8; i++) await feed(MON10 + week * WEEK + i * 60_000, week * WEEK + i * 60_000, 0.99);
      expect(monitor.baseline.read('cpu', MON10)?.mean).toBe(0.5);
    }
    asUser();
    const change = (await monitor.acceptRebaseline(monitor.rebaselineSuggestions[0].id)).change;
    asAgent();
    expect((await tuner.revert(change.id)).reason).toContain('trusted user');
    expect(monitor.baseline.read('cpu', MON10)?.mean).toBeCloseTo(0.99);
    asUser();
    const undone = await tuner.revert(change.id);
    expect(undone.applied).toBe(true);
    expect(monitor.baseline.read('cpu', MON10)?.mean).toBeCloseTo(0.5);
    expect((await tuner.revert(undone.change.id)).applied).toBe(true);
    expect(monitor.baseline.read('cpu', MON10)?.mean).toBeCloseTo(0.99);
    await monitor.close();
  });

  it('does not relearn an actual one-day fault', async () => {
    const { monitor, tuner, feed } = await fixture();
    for (let i = 0; i < 10; i++) await feed(MON10 + i * 60_000, i * 60_000, 0.99);
    await feed(MON10 + 10 * 60_000, 10 * 60_000, 0.5);
    expect(tuner.undoableChanges.some((entry) => entry.by === 'auto')).toBe(false);
    expect(monitor.baseline.read('cpu', MON10)?.mean).toBeCloseTo(0.5);
    await monitor.close();
  });

  it('clears prior alert dates when the metric recovers in another eligible bucket', async () => {
    const current = await fixture();
    for (let i = 0; i < 8; i++) await current.feed(MON10 + i * 60_000, i * 60_000, 0.99);
    await current.feed(MON10 + 3_600_000, 3_600_000, 0.5);
    for (let week = 1; week < 3; week++) {
      for (let i = 0; i < 8; i++) {
        await current.feed(MON10 + week * WEEK + i * 60_000, week * WEEK + i * 60_000, 0.99);
      }
    }
    expect(current.tuner.undoableChanges.some((entry) => entry.by === 'auto')).toBe(false);
    expect(current.monitor.baseline.read('cpu', MON10)?.mean).toBeCloseTo(0.5);
    await current.monitor.close();
  });

  it('does not count wall-clock jumps as three elapsed alerting dates', async () => {
    const current = await fixture();
    let mono = 0;
    for (let week = 0; week < 3; week++) {
      for (let i = 0; i < 8; i++) {
        await current.feed(MON10 + week * WEEK + i * 1000, mono++, 0.99);
      }
    }
    expect(current.tuner.undoableChanges.some((entry) => entry.by === 'auto')).toBe(false);
    expect(current.monitor.baseline.read('cpu', MON10)?.mean).toBeCloseTo(0.5);
    await current.monitor.close();
  });

  it('suggests when any configured rule for a metric is alerting', async () => {
    const current = await fixture({}, [
      { id: 'permissive', metric: 'cpu', sigma: 100 },
      { id: 'sensitive', metric: 'cpu', sigma: 3 },
    ]);
    for (let week = 0; week < 3; week++) {
      for (let i = 0; i < 8; i++) {
        await current.feed(MON10 + week * WEEK + i * 60_000, week * WEEK + i * 60_000, 0.99);
      }
    }
    expect(current.monitor.baseline.read('cpu', MON10)?.mean).toBeCloseTo(0.5);
    expect(current.monitor.rebaselineSuggestions).toHaveLength(1);
    await current.monitor.close();
  });

  it('preserves default rate and floor protection after rebaselining', async () => {
    const current = await fixture({}, [{ id: 'cpu', metric: 'cpu', sigma: 3 }], defaultRateRules());
    let state: BodyThresholdState = {};
    for (let week = 0; week < 3; week++) {
      for (let i = 0; i < 8; i++) {
        state = (await current.feed(MON10 + week * WEEK + i * 60_000, week * WEEK + i * 60_000, 0.99)).state;
      }
    }
    current.asUser();
    await current.monitor.acceptRebaseline(current.monitor.rebaselineSuggestions[0].id);
    state = current.monitor.restoredState ?? {};
    expect(current.monitor.baseline.read('cpu', MON10)?.mean).toBeCloseTo(0.99);
    const wall = MON10 + 2 * WEEK + 8 * 60_000;
    const mono = 2 * WEEK + 8 * 60_000;
    const body = (rss: number, free: number) => ({
      ...cpuBody(0.99),
      harnessProcess: rssBody(rss).harnessProcess,
      disks: diskBody(free).disks,
    });
    const prev = freshSample(body(0, 1000), wall - 1, undefined, mono - 1);
    const first = freshSample(body(0, 1000), wall, undefined, mono);
    const one = await current.monitor.evaluateAuto(prev, first, state);
    const next = freshSample(body(1024 ** 3, 20), wall + 1000, undefined, mono + 1000);
    const two = await current.monitor.evaluateAuto(first, next, one.state);
    expect(two.signals.some((signal) => signal.kind === 'body.rate' && signal.data.severity === 'warn')).toBe(true);
    expect(two.signals.some((signal) => signal.subject === 'disk:/' && signal.data.severity === 'critical')).toBe(true);
    await current.monitor.close();
  });

  it('persists candidate evidence and a one-click undo across two restarts', async () => {
    const first = await fixture();
    for (let week = 0; week < 2; week++) {
      for (let i = 0; i < 8; i++) await first.feed(MON10 + week * WEEK + i * 60_000, week * WEEK + i * 60_000, 0.99);
    }
    await first.monitor.persist();
    const second = await reload(first.persistence);
    expect(second.monitor.tuningDisabled).toBeUndefined();
    for (let i = 0; i < 8; i++) await second.feed(MON10 + 2 * WEEK + i * 60_000, WEEK + i * 60_000, 0.99);
    second.asUser();
    await second.monitor.acceptRebaseline(second.monitor.rebaselineSuggestions[0].id);
    expect(second.monitor.baseline.read('cpu', MON10)?.mean).toBeCloseTo(0.99);
    const change = second.tuner.undoableChanges.find((entry) => entry.kind === 'rebaseline');
    if (!change) throw new Error('missing rebaseline');
    await second.monitor.persist();
    const third = await reload(first.persistence);
    expect(third.tuner.undoableChanges.map((entry) => entry.id)).toContain(change.id);
    third.asUser();
    expect((await third.tuner.revert(change.id)).applied).toBe(true);
    expect(third.monitor.baseline.read('cpu', MON10)?.mean).toBeCloseTo(0.5);
    await third.monitor.close();
  });

  it('restores candidate history for valid long source IDs', async () => {
    const current = await fixture({}, [{ id: 'cpu', metric: 'cpu', sigma: 3 }], [], 'source-'.repeat(40));
    for (let i = 0; i < 8; i++) await current.feed(MON10 + i * 60_000, i * 60_000, 0.99);
    await current.monitor.persist();
    const restored = await reload(current.persistence);
    expect(restored.monitor.tuningDisabled).toBeUndefined();
    await restored.monitor.close();
  });

  it('keeps the rebaseline undo visible after rejected-log flooding and reload', async () => {
    const current = await fixture();
    for (let week = 0; week < 3; week++) {
      for (let i = 0; i < 8; i++) {
        await current.feed(MON10 + week * WEEK + i * 60_000, week * WEEK + i * 60_000, 0.99);
      }
    }
    current.asUser();
    await current.monitor.acceptRebaseline(current.monitor.rebaselineSuggestions[0].id);
    const change = current.tuner.undoableChanges.find((entry) => entry.kind === 'rebaseline');
    if (!change) throw new Error('missing rebaseline');
    for (let i = 0; i < 501; i++) {
      expect((await current.tuner.propose({ param: 'unknown', to: i })).applied).toBe(false);
    }
    expect(current.tuner.logs.some((entry) => entry.id === change.id)).toBe(false);
    await current.monitor.persist();
    const restored = await reload(current.persistence);
    expect(restored.tuner.undoableChanges.map((entry) => entry.id)).toContain(change.id);
    restored.asUser();
    expect((await restored.tuner.revert(change.id)).applied).toBe(true);
    expect(restored.monitor.baseline.read('cpu', MON10)?.mean).toBeCloseTo(0.5);
    await restored.monitor.close();
  });

  it('does not misclassify an ordinary parameter with the baseline prefix', async () => {
    const specs = { 'baseline:custom': { value: 10 } };
    const current = await fixture(specs);
    const change = await current.tuner.propose({ param: 'baseline:custom', to: 11 });
    expect(change.applied).toBe(true);
    await current.monitor.persist();
    const restored = await reload(current.persistence, [{ id: 'cpu', metric: 'cpu', sigma: 3 }], specs);
    expect(restored.monitor.tuningDisabled).toBeUndefined();
    restored.asUser();
    expect((await restored.tuner.revert(change.change.id)).applied).toBe(true);
    expect(restored.tuner.get('baseline:custom')).toBe(10);
    await restored.monitor.close();
  });

  it('does not let a synthetic bucket key overwrite a whitelisted tuning parameter', async () => {
    const param = `baseline:${Buffer.from('fs').toString('base64url')}:${Buffer.from('cpu').toString('base64url')}:34`;
    const current = await fixture({ [param]: { value: 10 } });
    const change = await current.tuner.propose({ param, to: 11 });
    expect(change.applied).toBe(true);
    for (let week = 0; week < 3; week++) {
      for (let i = 0; i < 8; i++) {
        await current.feed(MON10 + week * WEEK + i * 60_000, week * WEEK + i * 60_000, 0.99);
      }
    }
    expect(current.monitor.baseline.read('cpu', MON10)?.mean).toBeCloseTo(0.5);
    expect(current.tuner.undoableChanges.map((entry) => entry.id)).toContain(change.change.id);
    current.asUser();
    expect((await current.tuner.revert(change.change.id)).applied).toBe(true);
    expect(current.tuner.get(param)).toBe(10);
    await current.monitor.close();
  });

  it('retains reversible rebaselines when a later host disables the anomaly rule', async () => {
    const current = await fixture();
    for (let week = 0; week < 3; week++) {
      for (let i = 0; i < 8; i++) {
        await current.feed(MON10 + week * WEEK + i * 60_000, week * WEEK + i * 60_000, 0.99);
      }
    }
    current.asUser();
    await current.monitor.acceptRebaseline(current.monitor.rebaselineSuggestions[0].id);
    const change = current.tuner.undoableChanges.find((entry) => entry.kind === 'rebaseline');
    if (!change) throw new Error('missing rebaseline');
    await current.monitor.persist();
    const restored = await reload(current.persistence, []);
    expect(restored.monitor.tuningDisabled).toBeUndefined();
    expect(restored.tuner.undoableChanges.map((entry) => entry.id)).toContain(change.id);
    restored.asUser();
    expect((await restored.tuner.revert(change.id)).applied).toBe(true);
    expect(restored.monitor.baseline.read('cpu', MON10)?.mean).toBeCloseTo(0.5);
    await restored.monitor.close();
  });

  it.each(['missing', 'empty'])('fails closed if a rebaseline undo snapshot is %s', async (mode) => {
    const current = await fixture();
    for (let week = 0; week < 3; week++) {
      for (let i = 0; i < 8; i++) {
        await current.feed(MON10 + week * WEEK + i * 60_000, week * WEEK + i * 60_000, 0.99);
      }
    }
    current.asUser();
    await current.monitor.acceptRebaseline(current.monitor.rebaselineSuggestions[0].id);
    await current.monitor.persist();
    const snapshot = JSON.parse(current.snapshot() ?? '{}') as { rebaseline?: { undos: unknown[] } };
    if (mode === 'missing') delete snapshot.rebaseline;
    else if (snapshot.rebaseline) snapshot.rebaseline.undos = [];
    let saved = JSON.stringify(snapshot);
    const restored = await reload({
      load: async () => saved,
      save: async (data) => {
        saved = data;
      },
    });
    expect(restored.monitor.tuningDisabled).toBe('restore-failed');
    expect(restored.tuner.tuningDisabled).toBe('restore-failed');
    await restored.monitor.close();
  });

  it('never publishes rebaseline or its log if the atomic save fails', async () => {
    const first = await fixture();
    for (let week = 0; week < 2; week++) {
      for (let i = 0; i < 8; i++) await first.feed(MON10 + week * WEEK + i * 60_000, week * WEEK + i * 60_000, 0.99);
    }
    await first.feed(MON10 + 2 * WEEK, 2 * WEEK, 0.99);
    await first.monitor.persist();
    const committed = first.snapshot();
    first.asUser();
    first.fail();
    await expect(first.monitor.acceptRebaseline(first.monitor.rebaselineSuggestions[0].id)).rejects.toThrow(
      'storage failure',
    );
    expect(first.monitor.baseline.read('cpu', MON10)?.mean).toBeCloseTo(0.5);
    expect(first.tuner.undoableChanges.some((entry) => entry.by === 'auto')).toBe(false);
    expect(first.tuner.tuningDisabled).toBe('storage-failed');
    await expect(first.monitor.close()).rejects.toThrow('storage failure');
    let saved = committed;
    const recovered = await reload({
      load: async () => saved,
      save: async (data) => {
        saved = data;
      },
    });
    expect(recovered.monitor.baseline.read('cpu', MON10)?.mean).toBeCloseTo(0.5);
    expect(recovered.tuner.undoableChanges.some((entry) => entry.by === 'auto')).toBe(false);
    await recovered.monitor.close();
  });

  it('preserves rate and floor alerts when the rebaseline save fails', async () => {
    const current = await fixture({}, [{ id: 'cpu', metric: 'cpu', sigma: 3 }], defaultRateRules());
    let state: BodyThresholdState = {};
    for (let week = 0; week < 2; week++) {
      for (let i = 0; i < 8; i++) {
        state = (await current.feed(MON10 + week * WEEK + i * 60_000, week * WEEK + i * 60_000, 0.99)).state;
      }
    }
    await current.monitor.persist();
    const wall = MON10 + 2 * WEEK;
    const mono = 2 * WEEK;
    current.setTime(wall, mono);
    const body = (rss: number, free: number) => ({
      ...cpuBody(0.99),
      harnessProcess: rssBody(rss).harnessProcess,
      disks: diskBody(free).disks,
    });
    const prev = freshSample(body(0, 1000), wall - 1000, undefined, mono - 1000);
    const next = freshSample(body(1024 ** 3, 20), wall, undefined, mono);
    const result = await current.monitor.evaluateAuto(prev, next, state);
    expect(result.tuningError).toBeUndefined();
    expect(result.signals.some((signal) => signal.kind === 'body.rate' && signal.data.severity === 'warn')).toBe(true);
    expect(result.signals.some((signal) => signal.subject === 'disk:/' && signal.data.severity === 'critical')).toBe(
      true,
    );
    expect(current.monitor.baseline.read('cpu', MON10)?.mean).toBeCloseTo(0.5);
    current.asUser();
    current.fail();
    await expect(current.monitor.acceptRebaseline(current.monitor.rebaselineSuggestions[0].id)).rejects.toThrow(
      'storage failure',
    );
    await expect(current.monitor.close()).rejects.toThrow('storage failure');
  });

  it('rejects a queued stale state rather than overwriting a committed rebaseline', async () => {
    const current = await fixture();
    let state: BodyThresholdState = {};
    for (let week = 0; week < 2; week++) {
      for (let i = 0; i < 8; i++) {
        state = (await current.feed(MON10 + week * WEEK + i * 60_000, week * WEEK + i * 60_000, 0.99)).state;
      }
    }
    const prev = freshSample(cpuBody(0.99), MON10 + WEEK, undefined, WEEK);
    const next = freshSample(cpuBody(0.99), MON10 + 2 * WEEK, undefined, 2 * WEEK);
    const later = freshSample(cpuBody(0.99), MON10 + 2 * WEEK + 1000, undefined, 2 * WEEK + 1000);
    current.setTime(MON10 + 2 * WEEK, 2 * WEEK);
    const first = current.monitor.evaluateAuto(prev, next, state);
    const stale = current.monitor.evaluateAuto(next, later, state);
    await first;
    await expect(stale).rejects.toThrow('stale adaptive state');
    expect(current.monitor.baseline.read('cpu', MON10)?.mean).toBeCloseTo(0.5);
    await current.monitor.close();
  });

  it('discards automatic candidate history before synchronous-only sampling', async () => {
    const current = await fixture();
    let state: BodyThresholdState = {};
    for (let week = 0; week < 2; week++) {
      for (let i = 0; i < 8; i++) {
        state = (await current.feed(MON10 + week * WEEK + i * 60_000, week * WEEK + i * 60_000, 0.99)).state;
      }
    }
    const prev = freshSample(cpuBody(0.99), MON10 + WEEK, undefined, WEEK);
    const normal = freshSample(cpuBody(0.5), MON10 + WEEK + 3_600_000, undefined, WEEK + 3_600_000);
    state = current.monitor.evaluate(prev, normal, state).state;
    let last = normal;
    for (let i = 0; i < 8; i++) {
      const next = freshSample(cpuBody(0.99), MON10 + 2 * WEEK + i * 60_000, undefined, 2 * WEEK + i * 60_000);
      current.setTime(next.at, next.monotonicAt);
      state = (await current.monitor.evaluateAuto(last, next, state)).state;
      last = next;
    }
    expect(current.tuner.undoableChanges.some((entry) => entry.by === 'auto')).toBe(false);
    expect(current.monitor.baseline.read('cpu', MON10)?.mean).toBeCloseTo(0.5);
    await current.monitor.close();
  });

  it('blocks synchronous sampling while a rebaseline snapshot is being committed', async () => {
    const current = await fixture();
    for (let week = 0; week < 3; week++) {
      for (let i = 0; i < 8; i++) {
        await current.feed(MON10 + week * WEEK + i * 60_000, week * WEEK + i * 60_000, 0.99);
      }
    }
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    current.setHold(async (data) => {
      const tuner = JSON.parse((JSON.parse(data) as { tuner: string }).tuner) as {
        log: { by: string; status: string; param: string }[];
      };
      if (
        !release &&
        tuner.log.some(
          (entry) => entry.by === 'user' && entry.status === 'applied' && entry.param.startsWith('baseline:'),
        )
      ) {
        started?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    });
    current.asUser();
    const committing = current.monitor.acceptRebaseline(current.monitor.rebaselineSuggestions[0].id);
    await began;
    if (!release) throw new Error('commit did not start');
    try {
      const prev = freshSample(cpuBody(0.99), MON10 + 2 * WEEK, undefined, 2 * WEEK);
      const next = freshSample(cpuBody(0.5), MON10 + 2 * WEEK + 1000, undefined, 2 * WEEK + 1000);
      expect(() => current.monitor.evaluate(prev, next, current.monitor.restoredState ?? {})).toThrow('in progress');
      expect(current.monitor.baseline.read('cpu', MON10)?.mean).toBeCloseTo(0.5);
    } finally {
      release();
    }
    await committing;
    expect(current.monitor.baseline.read('cpu', MON10)?.mean).toBeCloseTo(0.99);
    await current.monitor.close();
  });

  it('allows user acceptance even when the global AI budget is exhausted', async () => {
    const specs = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`p${i}`, { value: 10 }]));
    const current = await fixture(specs);
    for (let week = 0; week < 2; week++) {
      for (let i = 0; i < 8; i++) {
        await current.feed(MON10 + week * WEEK + i * 60_000, week * WEEK + i * 60_000, 0.99);
      }
    }
    current.setTime(MON10 + 2 * WEEK - 1000, 2 * WEEK - 1000);
    for (let i = 0; i < 24; i++) expect((await current.tuner.propose({ param: `p${i}`, to: 11 })).applied).toBe(true);
    await current.feed(MON10 + 2 * WEEK, 2 * WEEK, 0.99);
    expect(current.monitor.baseline.read('cpu', MON10)?.mean).toBeCloseTo(0.5);
    current.asUser();
    expect((await current.monitor.acceptRebaseline(current.monitor.rebaselineSuggestions[0].id)).applied).toBe(true);
    expect(current.monitor.baseline.read('cpu', MON10)?.mean).toBeCloseTo(0.99);
    await current.monitor.close();
  });
});
