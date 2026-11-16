import { describe, expect, it } from 'vitest';
import { Tuner, type TunerActor } from '../../src/host/body/tuner.ts';
import type { ParameterSpec } from '../../src/host/body/tuner-spec.ts';

const HOUR = 3_600_000;
const WALL = Date.UTC(2026, 0, 5);

describe('Tuner hard guard regressions', () => {
  it('cannot serialize bad clocks into an empty persisted quota window', () => {
    let mono = 0;
    const tuner = new Tuner({ x: { value: 10 } }, { clock: () => mono, wallClock: () => WALL });
    tuner.propose({ param: 'x', to: 11 });
    tuner.propose({ param: 'x', to: 10 });
    mono = Number.NaN;
    expect(() => tuner.serialize()).toThrow(TypeError);
    mono = 0;
    expect(tuner.propose({ param: 'x', to: 11 }).reason).toBe('hourly change limit');
  });

  it.each([
    { value: 0.05 },
    { value: 0.05, tighten: 'down' },
    { value: Number.NaN, tighten: 'up' },
    { value: Number.POSITIVE_INFINITY, tighten: 'up' },
    { value: 'low', tighten: 'up' },
  ])('rejects invalid floor specs at construction: %j', (spec) => {
    expect(() => new Tuner({ 'floor.disk.critical': spec as ParameterSpec })).toThrow(TypeError);
  });

  it('caps 10 to 11 to 10 loops continuously over 24 hours at six AI changes', () => {
    let mono = 0;
    const tuner = new Tuner({ x: { value: 10 } }, { clock: () => mono, wallClock: () => WALL });
    let applied = 0;
    for (let hour = 0; hour < 24; hour++) {
      mono = hour * HOUR;
      for (const to of [11, 10]) if (tuner.propose({ param: 'x', to }).applied) applied++;
    }
    expect(applied).toBe(6);
    mono = 24 * HOUR;
    expect(tuner.propose({ param: 'x', to: 11 }).applied).toBe(true);
    expect(tuner.logs.at(-1)?.at).toBe(WALL);
  });

  it('corrupt restore cannot reset two used changes into a permitted third attempt', () => {
    const tuner = new Tuner({ x: { value: 10 } }, { clock: () => 0, wallClock: () => WALL });
    const first = tuner.propose({ param: 'x', to: 11 });
    tuner.propose({ param: 'x', to: 10 });
    expect(tuner.restoreSnapshot('{')).toBe('failed');
    const third = tuner.propose({ param: 'x', to: 11 });
    expect(third.reason).toContain('restore-failed');
    expect(third.change.id.split('-').slice(0, -1)).not.toEqual(first.change.id.split('-').slice(0, -1));
  });

  it('user can revert a tightened floor despite exhausted AI budget and lock', () => {
    let actor: TunerActor = 'agent';
    const tuner = new Tuner(
      { 'floor.disk': { value: 0.05, tighten: 'up' } },
      {
        actor: () => actor,
        clock: () => 0,
        wallClock: () => WALL,
      },
    );
    tuner.propose({ param: 'floor.disk', to: 0.075 });
    const id = tuner.propose({ param: 'floor.disk', to: 0.1 }).change.id;
    expect(tuner.propose({ param: 'floor.disk', to: 0.125 }).reason).toBe('hourly change limit');
    expect(tuner.revert(id).reason).toBe('safety: cannot loosen');
    actor = 'user';
    tuner.lock('floor.disk');
    expect(tuner.revert(id).applied).toBe(true);
    expect(tuner.get('floor.disk')).toBe(0.075);
    expect(tuner.logs.at(-1)?.operation).toBe('revert');
  });
});
