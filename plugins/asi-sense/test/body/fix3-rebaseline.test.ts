import type { BodyThresholdState } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { matchesRule } from '../../src/host/attention/rules.ts';
import { Baseline, BODY_HISTORY, BodyMonitor, defaultBodyRules, Tuner } from '../../src/host/body/index.ts';
import { type Candidate, record } from '../../src/host/body/rebaseline-candidate.ts';
import { cpuBody, freshSample, memBody, mkBody } from './helpers.ts';

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const START = Date.UTC(2026, 0, 19, 10);

async function fixture(metric: 'cpu' | 'memory' = 'cpu') {
  let wall = START;
  let mono = 0;
  let saved: string | undefined;
  let actor: 'user' | 'agent' | 'auto' = 'agent';
  const persistence = {
    load: async () => saved,
    save: async (value: string) => {
      saved = value;
    },
  };
  const baseline = new Baseline({ installedAt: START - 2 * WEEK, timeZone: 'UTC', elapsedMs: 2 * WEEK });
  for (const week of [-2, -1]) {
    for (const hour of [0, 3_600_000]) {
      for (let i = 0; i < 8; i++) baseline.observe(metric, 0.5, START + week * WEEK + hour + i);
    }
  }
  const make = () => {
    const tuner = new Tuner({}, { actor: () => actor, clock: () => mono, wallClock: () => wall });
    const monitor = new BodyMonitor({
      baseline,
      tuner,
      persistence,
      timeZone: 'UTC',
      clock: () => mono,
      wallClock: () => wall,
      rateRules: [],
      anomalyRules: [{ id: metric, metric }],
    });
    return { tuner, monitor };
  };
  const first = make();
  await first.monitor.restore();
  let state: BodyThresholdState = {};
  let prev = freshSample(metric === 'cpu' ? cpuBody(0.5) : memBody(50), START - 1, undefined, -1);
  const feed = async (at: number, value: number | undefined) => {
    wall = at;
    mono = at - START;
    const body = value === undefined ? mkBody() : metric === 'cpu' ? cpuBody(value) : memBody(value * 100);
    const next = freshSample(body, at, undefined, mono);
    const result = await first.monitor.evaluateAuto(prev, next, state);
    state = result.state;
    prev = next;
    return result;
  };
  return {
    ...first,
    feed,
    make,
    snapshot: () => saved,
    overwrite: (value: string) => {
      saved = value;
    },
    setActor: (value: typeof actor) => {
      actor = value;
    },
    state: () => state,
  };
}

describe('user-confirmed rebaseline', () => {
  it('N3: three weeks of 90% memory creates one context suggestion without normalizing a leak', async () => {
    const f = await fixture('memory');
    const signals = [];
    for (let week = 0; week < 3; week++) {
      for (let i = 0; i < 8; i++) {
        const usage = 0.75 + week * 0.075 + i * 0.0001;
        signals.push(...(await f.feed(START + week * WEEK + i * 60_000, usage)).signals);
      }
    }
    expect(f.monitor.baseline.read('memory', START)?.mean).toBeCloseTo(0.5);
    expect(f.state()['baseline:memory']).toBe('warn');
    expect(f.monitor.rebaselineSuggestions).toHaveLength(1);
    expect(signals.filter((signal) => signal.data.type === 'rebaseline-suggestion')).toHaveLength(1);
    const suggestion = signals.find((signal) => signal.data.type === 'rebaseline-suggestion');
    expect(
      defaultBodyRules().some(
        (rule) => suggestion && rule.level === 'context' && matchesRule(rule, suggestion, suggestion.at),
      ),
    ).toBe(true);
    expect(f.tuner.undoableChanges).toHaveLength(0);
    expect((await f.feed(START + 2 * WEEK + 9 * 60_000, 0.9)).state['baseline:memory']).toBe('warn');
    await f.monitor.close();
  });

  it('N4: only a trusted user can accept an 80% replacement, with an undoable audit', async () => {
    const f = await fixture('memory');
    for (let week = 0; week < 3; week++) {
      for (let i = 0; i < 8; i++) await f.feed(START + week * WEEK + i * 60_000, 0.9);
    }
    const id = f.monitor.rebaselineSuggestions[0].id;
    for (const actor of ['agent', 'auto'] as const) {
      f.setActor(actor);
      expect((await f.monitor.acceptRebaseline(id)).applied).toBe(false);
      expect(f.monitor.baseline.read('memory', START)?.mean).toBeCloseTo(0.5);
    }
    f.setActor('user');
    const accepted = await f.monitor.acceptRebaseline(id);
    expect(accepted.applied).toBe(true);
    expect(accepted.change.by).toBe('user');
    expect(f.monitor.baseline.read('memory', START)?.mean).toBeCloseTo(0.9);
    expect(f.monitor.restoredState?.['baseline:memory']).toBe('normal');
    expect(f.tuner.undoableChanges.map((entry) => entry.id)).toContain(accepted.change.id);
    await f.monitor.close();
  });

  it('N5: sparse three-date alerts cannot replace a mature bucket or produce a suggestion', async () => {
    const f = await fixture();
    for (let i = 0; i < 3; i++) await f.feed(START + i * 60_000, 0.99);
    await f.feed(START + WEEK, 0.99);
    await f.feed(START + 2 * WEEK, 0.99);
    expect(f.monitor.rebaselineSuggestions).toHaveLength(0);
    expect(f.monitor.baseline.read('cpu', START)?.count).toBeGreaterThanOrEqual(8);
    expect(f.monitor.baseline.read('cpu', START)?.mean).toBeCloseTo(0.5);
    await f.monitor.close();
  });

  it('N6: missing readings do not bridge an expired 21-day candidate', async () => {
    const f = await fixture();
    for (let i = 0; i < 8; i++) await f.feed(START + i * 60_000, 0.99);
    await f.feed(START + WEEK, undefined);
    await f.feed(START + 4 * WEEK, 0.99);
    for (let i = 0; i < 8; i++) await f.feed(START + 12 * WEEK + i * 60_000, 0.99);
    expect(f.monitor.rebaselineSuggestions).toHaveLength(0);
    expect(f.monitor.baseline.read('cpu', START)?.mean).toBeCloseTo(0.5);
    await f.monitor.close();
  });

  it('N6: a non-alert reading in the same bucket interrupts candidate evidence', async () => {
    const f = await fixture();
    for (let week = 0; week < 2; week++) {
      for (let i = 0; i < 8; i++) await f.feed(START + week * WEEK + i * 60_000, 0.99);
    }
    await f.feed(START + WEEK + 9 * 60_000, 0.5);
    for (let i = 0; i < 8; i++) await f.feed(START + 2 * WEEK + i * 60_000, 0.99);
    expect(f.monitor.rebaselineSuggestions).toHaveLength(0);
    await f.monitor.close();
  });

  it('N6: expires and persists an unfinished candidate even when the metric goes missing', async () => {
    const f = await fixture();
    for (let i = 0; i < 8; i++) await f.feed(START + i * 60_000, 0.99);
    await f.feed(START + 4 * WEEK, undefined);
    await f.monitor.persist();
    expect(JSON.parse(f.snapshot() ?? '{}').rebaseline.candidates).toHaveLength(0);
    await f.monitor.close();
  });

  it('does not count a replayed reading again after a restart', () => {
    const candidate: Candidate = { stream: 'fake', metric: 'cpu', slot: 34, days: [] };
    const reading = { at: START, value: 0.99, zone: 'UTC' };
    expect(record(candidate, '2026-1-19', 10, 1, reading)).toBe(true);
    const { lastMono: _lastMono, ...restored } = candidate;
    expect(record(restored, '2026-1-19', 10, 2, reading)).toBe(false);
    expect(restored.days[0].samples).toHaveLength(1);
  });

  it('N7: undo restores the persisted warning and streak without repeating a warning signal', async () => {
    const f = await fixture();
    for (let week = 0; week < 3; week++) {
      for (let i = 0; i < 8; i++) await f.feed(START + week * WEEK + i * 60_000, 0.99);
    }
    f.setActor('user');
    const accepted = await f.monitor.acceptRebaseline(f.monitor.rebaselineSuggestions[0].id);
    expect((await f.tuner.revert(accepted.change.id)).applied).toBe(true);
    expect(f.monitor.restoredState?.['baseline:cpu']).toBe('warn');
    const restored = f.make();
    await restored.monitor.restore();
    const state = restored.monitor.restoredState;
    expect(state?.['baseline:cpu']).toBe('warn');
    expect(state?.[BODY_HISTORY]?.fs?.anomaly?.streaks.cpu).toBeGreaterThanOrEqual(3);
    const at = START + 2 * WEEK + 9 * 60_000;
    const prev = freshSample(cpuBody(0.99), at - 1, undefined, 2 * WEEK + 9 * 60_000 - 1);
    const next = freshSample(cpuBody(0.99), at, undefined, 2 * WEEK + 9 * 60_000);
    const result = await restored.monitor.evaluateAuto(prev, next, state ?? {});
    expect(result.state['baseline:cpu']).toBe('warn');
    expect(result.signals.filter((s) => s.kind === 'body.anomaly' && s.data.severity === 'warn')).toHaveLength(0);
    await restored.monitor.close();
    await f.monitor.close();
  });

  it('rejudges the latest reading instead of the original suggestion sample', async () => {
    const f = await fixture();
    for (let week = 0; week < 3; week++) {
      for (let i = 0; i < 8; i++) await f.feed(START + week * WEEK + i * 60_000, 0.99);
    }
    await f.feed(START + 2 * WEEK + 9 * 60_000, 0.7);
    f.setActor('user');
    expect((await f.monitor.acceptRebaseline(f.monitor.rebaselineSuggestions[0].id)).applied).toBe(true);
    expect(f.monitor.restoredState?.['baseline:cpu']).toBe('warn');
    await f.monitor.close();
  });

  it('does not rejudge a current reading from a different bucket using the replaced bucket', async () => {
    const f = await fixture();
    for (let week = 0; week < 3; week++) {
      for (let i = 0; i < 8; i++) await f.feed(START + week * WEEK + i * 60_000, 0.99);
    }
    expect((await f.feed(START + 2 * WEEK + 3_600_000, 0.5)).state['baseline:cpu']).toBe('normal');
    f.setActor('user');
    expect((await f.monitor.acceptRebaseline(f.monitor.rebaselineSuggestions[0].id)).applied).toBe(true);
    expect(f.monitor.restoredState?.['baseline:cpu']).toBe('normal');
    await f.monitor.close();
  });

  it('restores a suggestion without notifying twice and lets the user accept it', async () => {
    const f = await fixture();
    for (let week = 0; week < 3; week++) {
      for (let i = 0; i < 8; i++) await f.feed(START + week * WEEK + i * 60_000, 0.99);
    }
    const id = f.monitor.rebaselineSuggestions[0].id;
    await f.monitor.close();
    const restored = f.make();
    await restored.monitor.restore();
    expect(restored.monitor.rebaselineSuggestions[0].id).toBe(id);
    const at = START + 2 * WEEK + 9 * 60_000;
    const prev = freshSample(cpuBody(0.99), at - 1, undefined, 2 * WEEK + 9 * 60_000 - 1);
    const next = freshSample(cpuBody(0.99), at, undefined, 2 * WEEK + 9 * 60_000);
    const result = await restored.monitor.evaluateAuto(prev, next, restored.monitor.restoredState ?? {});
    expect(result.signals.some((s) => s.data.type === 'rebaseline-suggestion')).toBe(false);
    f.setActor('user');
    expect((await restored.monitor.acceptRebaseline(id)).applied).toBe(true);
    await restored.monitor.close();
  });

  it('fails closed on legacy undo data that cannot restore the former warning state', async () => {
    const f = await fixture();
    for (let week = 0; week < 3; week++) {
      for (let i = 0; i < 8; i++) await f.feed(START + week * WEEK + i * 60_000, 0.99);
    }
    f.setActor('user');
    await f.monitor.acceptRebaseline(f.monitor.rebaselineSuggestions[0].id);
    await f.monitor.close();
    const snapshot = JSON.parse(f.snapshot() ?? '{}');
    delete snapshot.rebaseline.undos[0].previous;
    f.overwrite(JSON.stringify(snapshot));
    const restored = f.make();
    await restored.monitor.restore();
    expect(restored.tuner.tuningDisabled).toBe('restore-failed');
    await restored.monitor.close();
  });
});
