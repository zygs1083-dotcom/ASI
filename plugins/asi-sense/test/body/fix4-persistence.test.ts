import { describe, expect, it } from 'vitest';
import { BodyMonitor, Tuner } from '../../src/host/body/index.ts';

const WALL = Date.UTC(2026, 0, 1);

function storage(initial?: string) {
  let data = initial;
  let failures = 0;
  let writes = 0;
  return {
    load: async () => data,
    save: async (next: string) => {
      writes++;
      if (failures-- > 0) throw new Error('before rename');
      data = next;
    },
    fail: (count: number) => {
      failures = count;
    },
    overwrite: (next: string) => {
      data = next;
    },
    writes: () => writes,
    text: () => data,
  };
}

describe('fix4 tuning guardrails', () => {
  it.each([false, true])('R1 keeps restore failure stronger than write failure (combined=%s)', async (combined) => {
    const persistence = storage('{');
    let actor: 'user' | 'agent' = 'agent';
    const make = () => {
      const tuner = new Tuner(
        { x: { value: 10 } },
        { actor: () => actor, clock: () => 0, wallClock: () => WALL, ...(combined ? {} : { persistence }) },
      );
      const monitor = combined
        ? new BodyMonitor({ tuner, persistence, clock: () => 0, wallClock: () => WALL })
        : undefined;
      return {
        tuner,
        monitor,
        restore: () => monitor?.restore() ?? tuner.restore(),
        close: () => monitor?.close() ?? tuner.close(),
      };
    };
    const a = make();
    await a.restore();
    expect(a.tuner.tuningDisabled).toBe('restore-failed');
    persistence.fail(1);
    await expect(a.monitor?.persist() ?? a.tuner.persist()).rejects.toThrow('before rename');
    expect(a.tuner.tuningDisabled).toBe('restore-failed');
    if (a.monitor) expect(a.monitor.tuningDisabled).toBe('restore-failed');
    const disabledSnapshot = JSON.parse(persistence.text() ?? '{}');
    expect(disabledSnapshot.disabled).toBe('restore-failed');
    if (combined) expect(JSON.parse(disabledSnapshot.tuner).disabled).toBe('restore-failed');
    const b = make();
    await b.restore();
    expect(b.tuner.tuningDisabled).toBe('restore-failed');
    await a.close();
    actor = 'user';
    await expect(b.tuner.resumeTuning()).rejects.toThrow('recovery unavailable');
    actor = 'agent';
    await expect(b.tuner.propose({ param: 'x', to: 11 })).rejects.toThrow('restore-failed');
    await expect(b.tuner.resetTuning()).rejects.toThrow('trusted user');
    actor = 'user';
    persistence.fail(1);
    await expect(b.tuner.resetTuning()).rejects.toThrow('before rename');
    expect(b.tuner.tuningDisabled).toBe('restore-failed');
    await b.tuner.resetTuning();
    expect(b.tuner.get('x')).toBe(10);
    expect(b.tuner.logs.at(-1)).toMatchObject({ by: 'user', status: 'applied', operation: 'reset' });
    await expect(b.tuner.resetTuning()).rejects.toThrow('reset unavailable');
    actor = 'agent';
    expect((await b.tuner.propose({ param: 'x', to: 11 })).applied).toBe(true);
    await b.close();
    const c = make();
    await c.restore();
    expect(c.tuner.tuningDisabled).toBeUndefined();
    expect(c.tuner.get('x')).toBe(11);
    expect(c.tuner.logs.some((entry) => entry.operation === 'reset' && entry.by === 'user')).toBe(true);
    await c.close();
  });

  it('R1 rejects partially restored values and locks before user reset', async () => {
    const persistence = storage();
    let actor: 'user' | 'agent' = 'agent';
    const make = () => {
      const tuner = new Tuner(
        { x: { value: 10 }, y: { value: 10 } },
        { actor: () => actor, clock: () => 0, wallClock: () => WALL },
      );
      const monitor = new BodyMonitor({ tuner, persistence, clock: () => 0, wallClock: () => WALL });
      return { tuner, monitor };
    };
    const a = make();
    await a.monitor.restore();
    await a.tuner.propose({ param: 'x', to: 11 });
    actor = 'user';
    await a.tuner.lock('y');
    await a.monitor.close();
    const broken = JSON.parse(persistence.text() ?? '{}');
    broken.baseline = '{';
    persistence.overwrite(JSON.stringify(broken));
    const b = make();
    await b.monitor.restore();
    expect(b.tuner.tuningDisabled).toBe('restore-failed');
    expect(b.tuner.get('x')).toBe(10);
    await b.tuner.resetTuning();
    expect(b.tuner.get('x')).toBe(10);
    expect(b.tuner.undoableChanges).toHaveLength(0);
    actor = 'agent';
    expect((await b.tuner.propose({ param: 'y', to: 11 })).applied).toBe(true);
    await b.monitor.close();
    const c = make();
    await c.monitor.restore();
    expect(c.tuner.tuningDisabled).toBeUndefined();
    expect(c.tuner.get('x')).toBe(10);
    expect(c.tuner.get('y')).toBe(11);
    expect(c.tuner.logs.some((entry) => entry.operation === 'reset')).toBe(true);
    await c.monitor.close();
  });

  it.each([false, true])(
    'R2 retains frozen budget clocks without writing a rejection (combined=%s)',
    async (combined) => {
      const persistence = storage();
      let actor: 'user' | 'agent' = 'agent';
      let mono = 0;
      let wall = WALL;
      const make = () => {
        const tuner = new Tuner(
          { x: { value: 10 }, y: { value: 10 } },
          { actor: () => actor, clock: () => mono, wallClock: () => wall, ...(combined ? {} : { persistence }) },
        );
        const monitor = combined
          ? new BodyMonitor({ tuner, persistence, clock: () => mono, wallClock: () => wall })
          : undefined;
        return {
          tuner,
          restore: () => monitor?.restore() ?? tuner.restore(),
          close: () => monitor?.close() ?? tuner.close(),
        };
      };
      const a = make();
      await a.restore();
      expect((await a.tuner.propose({ param: 'x', to: 11 })).applied).toBe(true);
      expect((await a.tuner.propose({ param: 'x', to: 12 })).applied).toBe(true);
      await a.close();
      const b = make();
      await b.restore();
      mono = 30 * 60_000;
      wall = WALL - 1;
      const writes = persistence.writes();
      const disk = persistence.text();
      expect((await b.tuner.propose({ param: 'x', to: 13 })).reason).toContain('frozen');
      expect(persistence.writes()).toBe(writes);
      expect(persistence.text()).toBe(disk);
      mono += 31 * 60_000;
      wall = WALL;
      expect((await b.tuner.propose({ param: 'x', to: 13 })).reason).toContain('hourly');
      expect(persistence.writes()).toBe(writes);
      actor = 'user';
      const lock = await b.tuner.lock('y');
      expect(lock.change.id.endsWith('-3')).toBe(true);
      await b.close();
      mono = 0;
      const c = make();
      await c.restore();
      actor = 'agent';
      expect((await c.tuner.propose({ param: 'x', to: 13 })).reason).toContain('hourly');
      mono = 30 * 60_000;
      expect((await c.tuner.propose({ param: 'x', to: 13 })).applied).toBe(true);
      await c.close();
    },
  );

  it.each([false, true])('R2 persists a frozen window before wall catch-up (combined=%s)', async (combined) => {
    const persistence = storage();
    let actor: 'user' | 'agent' = 'agent';
    let mono = 0;
    let wall = WALL;
    const make = () => {
      const tuner = new Tuner(
        { x: { value: 10 }, y: { value: 10 } },
        { actor: () => actor, clock: () => mono, wallClock: () => wall, ...(combined ? {} : { persistence }) },
      );
      const monitor = combined
        ? new BodyMonitor({ tuner, persistence, clock: () => mono, wallClock: () => wall })
        : undefined;
      return {
        tuner,
        restore: () => monitor?.restore() ?? tuner.restore(),
        close: () => monitor?.close() ?? tuner.close(),
      };
    };
    const a = make();
    await a.restore();
    await a.tuner.propose({ param: 'x', to: 11 });
    await a.tuner.propose({ param: 'x', to: 12 });
    await a.close();
    const b = make();
    await b.restore();
    mono = 30 * 60_000;
    wall = WALL - 1;
    expect((await b.tuner.propose({ param: 'x', to: 13 })).reason).toContain('frozen');
    actor = 'user';
    await b.tuner.lock('y');
    await b.close();
    mono = 0;
    const c = make();
    await c.restore();
    actor = 'agent';
    mono = 31 * 60_000;
    expect((await c.tuner.propose({ param: 'x', to: 13 })).reason).toContain('frozen');
    wall = WALL;
    expect((await c.tuner.propose({ param: 'x', to: 13 })).reason).toContain('hourly');
    mono += 30 * 60_000;
    expect((await c.tuner.propose({ param: 'x', to: 13 })).applied).toBe(true);
    await c.close();
  });

  it.each([false, true])(
    'R2 retains freeze even when a proposal fails validation first (combined=%s)',
    async (combined) => {
      const persistence = storage();
      let mono = 0;
      let wall = WALL;
      const make = () => {
        const tuner = new Tuner(
          { x: { value: 10, max: 20 } },
          { clock: () => mono, wallClock: () => wall, ...(combined ? {} : { persistence }) },
        );
        const monitor = combined
          ? new BodyMonitor({ tuner, persistence, clock: () => mono, wallClock: () => wall })
          : undefined;
        return {
          tuner,
          restore: () => monitor?.restore() ?? tuner.restore(),
          close: () => monitor?.close() ?? tuner.close(),
        };
      };
      const a = make();
      await a.restore();
      await a.tuner.propose({ param: 'x', to: 11 });
      await a.tuner.propose({ param: 'x', to: 12 });
      await a.close();
      const b = make();
      await b.restore();
      mono = 30 * 60_000;
      wall = WALL - 1;
      const writes = persistence.writes();
      expect((await b.tuner.propose({ param: 'x', to: 100 })).reason).toBe('out of bounds');
      expect(persistence.writes()).toBe(writes);
      mono += 31 * 60_000;
      wall = WALL;
      expect((await b.tuner.propose({ param: 'x', to: 13 })).reason).toContain('hourly');
      await b.close();
    },
  );

  it('R2 rejects a nonfinite staging clock without erasing restored budgets', async () => {
    const persistence = storage();
    let mono = 0;
    let wall = WALL;
    let calls = 0;
    let badClock = false;
    const clock = () => (badClock && ++calls === 2 ? Number.NaN : mono);
    const make = () => new Tuner({ x: { value: 10, max: 20 } }, { persistence, clock, wallClock: () => wall });
    const a = make();
    await a.restore();
    await a.propose({ param: 'x', to: 11 });
    await a.propose({ param: 'x', to: 12 });
    await a.close();
    const b = make();
    await b.restore();
    mono = 30 * 60_000;
    wall = WALL - 1;
    badClock = true;
    await expect(b.propose({ param: 'x', to: 100 })).rejects.toThrow('clocks must be finite');
    badClock = false;
    expect((await b.propose({ param: 'x', to: 100 })).reason).toBe('out of bounds');
    mono += 31 * 60_000;
    wall = WALL;
    expect((await b.propose({ param: 'x', to: 13 })).reason).toContain('hourly');
    await b.close();
  });
});
