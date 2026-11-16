import { describe, expect, it } from 'vitest';
import { Tuner, type TunerActor } from '../../src/host/body/tuner.ts';
import type { ParameterSpec } from '../../src/host/body/tuner-spec.ts';

const HOUR = 3_600_000;
const WALL = Date.UTC(2026, 0, 5);
const memory = () => ({ load: async () => undefined, save: async (_value: string) => {} });

describe('Tuner hard guard regressions', () => {
  it('persists locks, quota and IDs before acknowledgement even after a crash', async () => {
    let data: string | undefined;
    let actor: TunerActor = 'agent';
    const persistence = {
      load: async () => data,
      save: async (value: string) => {
        data = value;
      },
    };
    const make = () =>
      new Tuner(
        { x: { value: 10 }, y: { value: 10 } },
        { clock: () => 0, wallClock: () => WALL, actor: () => actor, persistence },
      );
    const a = make();
    await a.restore();
    const first = await a.propose({ param: 'x', to: 11 });
    await a.propose({ param: 'x', to: 10 });
    actor = 'user';
    await a.lock('y');
    actor = 'agent';
    const b = make();
    await b.restore();
    const third = await b.propose({ param: 'x', to: 11 });
    const locked = await b.propose({ param: 'y', to: 11 });
    expect(third.reason).toBe('hourly change limit');
    expect(locked.reason).toBe('param locked');
    expect(third.change.id).not.toBe(first.change.id);
    await a.close();
    await b.close();
  });

  it('leaves values unchanged and disables AI when a critical save fails', async () => {
    const persistence = {
      load: async () => undefined,
      save: async () => {
        throw new Error('save failed');
      },
    };
    const t = new Tuner({ x: { value: 10 } }, { clock: () => 0, wallClock: () => WALL, persistence });
    await t.restore();
    await expect(Promise.resolve().then(() => t.propose({ param: 'x', to: 11 }))).rejects.toThrow('save failed');
    expect(t.get('x')).toBe(10);
    expect(t.tuningDisabled).toBe('storage-failed');
  });

  it.each(['lock', 'unlock', 'revert'] as const)(
    'does not publish %s when its critical write fails',
    async (operation) => {
      let data: string | undefined;
      let fail = false;
      let actor: TunerActor = 'user';
      const persistence = {
        load: async () => data,
        save: async (value: string) => {
          if (fail) throw new Error('save failed');
          data = value;
        },
      };
      const make = () =>
        new Tuner(
          { x: { value: 10 }, y: { value: 10 } },
          {
            clock: () => 0,
            wallClock: () => WALL,
            actor: () => actor,
            persistence,
          },
        );
      const t = make();
      await t.restore();
      const applied = await t.propose({ param: 'x', to: 11 });
      if (operation === 'unlock') await t.lock('y');
      const before = data;
      const log = t.logs;
      fail = true;
      const attempt =
        operation === 'lock' ? t.lock('y') : operation === 'unlock' ? t.unlock('y') : t.revert(applied.change.id);
      await expect(attempt).rejects.toThrow('save failed');
      expect(t.tuningDisabled).toBe('storage-failed');
      expect(t.get('x')).toBe(11);
      expect(t.logs).toEqual(log);
      expect(data).toBe(before);
      fail = false;
      actor = 'agent';
      const recovered = make();
      await recovered.restore();
      expect(recovered.get('x')).toBe(11);
      expect(recovered.undoableChanges.map((entry) => entry.id)).toContain(applied.change.id);
      const y = await recovered.propose({ param: 'y', to: 11 });
      expect(y.applied).toBe(operation !== 'unlock');
      if (operation === 'unlock') expect(y.reason).toBe('param locked');
      await recovered.close();
    },
  );

  it('never acknowledges a change without a persistence port', async () => {
    const t = new Tuner({ x: { value: 10 } });
    await expect(t.propose({ param: 'x', to: 11 })).rejects.toThrow('persistence required');
    expect(t.get('x')).toBe(10);
  });

  it('disables AI when an explicit standalone snapshot flush fails', async () => {
    const persistence = {
      load: async () => undefined,
      save: async () => {
        throw new Error('flush failed');
      },
    };
    const tuner = new Tuner({ x: { value: 10 } }, { persistence });
    await tuner.restore();
    await expect(tuner.persist()).rejects.toThrow('flush failed');
    expect(tuner.tuningDisabled).toBe('storage-failed');
  });

  it('cannot serialize bad clocks into an empty persisted quota window', async () => {
    let mono = 0;
    const tuner = new Tuner({ x: { value: 10 } }, { clock: () => mono, wallClock: () => WALL, persistence: memory() });
    await tuner.restore();
    await tuner.propose({ param: 'x', to: 11 });
    await tuner.propose({ param: 'x', to: 10 });
    mono = Number.NaN;
    expect(() => tuner.serialize()).toThrow(TypeError);
    mono = 0;
    expect((await tuner.propose({ param: 'x', to: 11 })).reason).toBe('hourly change limit');
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

  it('caps 10 to 11 to 10 loops continuously over 24 hours at six AI changes', async () => {
    let mono = 0;
    const tuner = new Tuner({ x: { value: 10 } }, { clock: () => mono, wallClock: () => WALL, persistence: memory() });
    await tuner.restore();
    let applied = 0;
    for (let hour = 0; hour < 24; hour++) {
      mono = hour * HOUR;
      for (const to of [11, 10]) if ((await tuner.propose({ param: 'x', to })).applied) applied++;
    }
    expect(applied).toBe(6);
    mono = 24 * HOUR;
    expect((await tuner.propose({ param: 'x', to: 11 })).applied).toBe(true);
    expect(tuner.logs.at(-1)?.at).toBe(WALL);
  });

  it('preserves the daily budget across restart despite a forward wall-clock jump', async () => {
    let mono = 0;
    let wall = WALL;
    let data: string | undefined;
    const persistence = {
      load: async () => data,
      save: async (value: string) => {
        data = value;
      },
    };
    const create = () =>
      new Tuner(
        { x: { value: 10 } },
        {
          clock: () => mono,
          wallClock: () => wall,
          persistence,
        },
      );
    const a = create();
    await a.restore();
    for (let hour = 0; hour < 3; hour++) {
      mono = hour * HOUR;
      expect((await a.propose({ param: 'x', to: 11 })).applied).toBe(true);
      expect((await a.propose({ param: 'x', to: 10 })).applied).toBe(true);
    }
    await a.close();
    wall += 2 * 24 * HOUR;
    mono = 0;
    const b = create();
    await b.restore();
    mono = HOUR + 1;
    expect((await b.propose({ param: 'x', to: 11 })).reason).toBe('daily change limit');
    await b.close();
  });

  it('corrupt restore cannot reset two used changes into a permitted third attempt', async () => {
    const tuner = new Tuner({ x: { value: 10 } }, { clock: () => 0, wallClock: () => WALL, persistence: memory() });
    await tuner.restore();
    const first = await tuner.propose({ param: 'x', to: 11 });
    await tuner.propose({ param: 'x', to: 10 });
    expect(tuner.restoreSnapshot('{')).toBe('failed');
    await expect(tuner.propose({ param: 'x', to: 11 })).rejects.toThrow('restore-failed');
    expect(JSON.parse(tuner.serialize()).idPrefix).not.toBe(first.change.id.split('-').slice(0, -1).join('-'));
  });

  it('user can revert a tightened floor despite exhausted AI budget and lock', async () => {
    let actor: TunerActor = 'agent';
    const tuner = new Tuner(
      { 'floor.disk': { value: 0.05, tighten: 'up' } },
      {
        actor: () => actor,
        clock: () => 0,
        wallClock: () => WALL,
        persistence: memory(),
      },
    );
    await tuner.restore();
    await tuner.propose({ param: 'floor.disk', to: 0.075 });
    const id = (await tuner.propose({ param: 'floor.disk', to: 0.1 })).change.id;
    expect((await tuner.propose({ param: 'floor.disk', to: 0.125 })).reason).toBe('hourly change limit');
    expect((await tuner.revert(id)).reason).toBe('safety: cannot loosen');
    actor = 'user';
    await tuner.lock('floor.disk');
    expect((await tuner.revert(id)).applied).toBe(true);
    expect(tuner.get('floor.disk')).toBe(0.075);
    expect(tuner.logs.at(-1)?.operation).toBe('revert');
  });
});
