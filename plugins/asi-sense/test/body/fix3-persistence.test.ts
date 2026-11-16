import { describe, expect, it } from 'vitest';
import { BodyMonitor, Tuner } from '../../src/host/body/index.ts';

function storage(initial?: string) {
  let data: string | undefined = initial;
  let failures = 0;
  let writes = 0;
  return {
    load: async () => data,
    save: async (next: string) => {
      writes++;
      if (failures > 0) {
        failures--;
        throw new Error('before rename');
      }
      data = next;
    },
    fail: (count: number) => {
      failures = count;
    },
    writes: () => writes,
    text: () => data,
  };
}

describe('fix3 durable tuning', () => {
  it('N1 keeps a rejected change out of the old snapshot if the disabled marker also fails', async () => {
    const persistence = storage();
    const tuner = new Tuner({ x: { value: 10 } }, { persistence });
    await tuner.restore();
    await tuner.persist();
    persistence.fail(2);
    await expect(tuner.propose({ param: 'x', to: 11 })).rejects.toThrow('before rename');
    expect(tuner.tuningDisabled).toBe('storage-failed');
    const restarted = new Tuner({ x: { value: 10 } }, { persistence });
    await restarted.restore();
    expect(restarted.get('x')).toBe(10);
    await restarted.close();
  });

  it.each([false, true])(
    'N2 preserves confirmed values, locks, budgets and undo after failure (combined=%s)',
    async (combined) => {
      const persistence = storage();
      let actor: 'agent' | 'user' = 'agent';
      const specs = { x: { value: 10 }, y: { value: 10 } };
      const tuner = new Tuner(specs, { actor: () => actor, ...(combined ? {} : { persistence }) });
      const monitor = combined ? new BodyMonitor({ tuner, persistence }) : undefined;
      await (monitor?.restore() ?? tuner.restore());
      const first = await tuner.propose({ param: 'x', to: 11 });
      actor = 'user';
      await tuner.lock('y');
      actor = 'agent';
      persistence.fail(1);
      await expect(tuner.propose({ param: 'x', to: 12 })).rejects.toThrow('before rename');
      await (monitor?.persist() ?? tuner.persist());
      await (monitor?.close() ?? tuner.close());
      const again = new Tuner(specs, { actor: () => actor, ...(combined ? {} : { persistence }) });
      const restored = combined ? new BodyMonitor({ tuner: again, persistence }) : undefined;
      await (restored?.restore() ?? again.restore());
      expect(again.tuningDisabled).toBe('storage-failed');
      expect(again.get('x')).toBe(11);
      expect(again.undoableChanges.map((entry) => entry.id)).toContain(first.change.id);
      await expect(again.resumeTuning()).rejects.toThrow('trusted user');
      actor = 'user';
      persistence.fail(1);
      await expect(again.resumeTuning()).rejects.toThrow('before rename');
      expect(again.tuningDisabled).toBe('storage-failed');
      await again.resumeTuning();
      actor = 'agent';
      expect((await again.propose({ param: 'y', to: 11 })).reason).toBe('param locked');
      actor = 'user';
      expect((await again.revert(first.change.id)).applied).toBe(true);
      actor = 'agent';
      expect((await again.propose({ param: 'x', to: 11 })).applied).toBe(true);
      expect((await again.propose({ param: 'x', to: 12 })).reason).toContain('hourly');
      await (restored?.close() ?? again.close());
    },
  );

  it('N8 keeps 500 rejected proposals in memory without writing or consuming durable IDs', async () => {
    const persistence = storage();
    const tuner = new Tuner({ x: { value: 10, max: 20 } }, { persistence });
    await tuner.restore();
    for (let i = 0; i < 500; i++) expect((await tuner.propose({ param: 'x', to: 100 })).applied).toBe(false);
    const applied = await tuner.propose({ param: 'x', to: 11 });
    expect(persistence.writes()).toBe(1);
    expect(applied.change.id.endsWith('-1')).toBe(true);
    const disk = JSON.parse(persistence.text() ?? '{}');
    expect(disk.log.every((entry: { status: string }) => entry.status === 'applied')).toBe(true);
    await tuner.close();
  });

  it('N8 retains the larger of 30-day or 200 applied records and every undoable change', async () => {
    const persistence = storage();
    let wall = 100 * 86_400_000;
    const specs = { x: { value: 10 }, y: { value: 10 } };
    const tuner = new Tuner(specs, { persistence, actor: () => 'user', wallClock: () => wall });
    await tuner.restore();
    const oldUndo = await tuner.propose({ param: 'y', to: 11 });
    for (let i = 0; i < 202; i++) await tuner.propose({ param: 'x', to: i % 2 ? 10 : 11 });
    expect(JSON.parse(persistence.text() ?? '{}').applied).toHaveLength(203);
    wall += 31 * 86_400_000;
    await tuner.propose({ param: 'x', to: 11 });
    expect(JSON.parse(persistence.text() ?? '{}').applied).toHaveLength(201);
    await tuner.close();
    const restored = new Tuner(specs, { persistence, actor: () => 'user', wallClock: () => wall });
    await restored.restore();
    expect((await restored.revert(oldUndo.change.id)).applied).toBe(true);
    await restored.close();
  });

  it('N8 retains recent applied lock audits beyond the 500-entry display cap and prunes old audits', async () => {
    let wall = 100 * 86_400_000;
    const specs = { x: { value: 10 } };
    const seed = storage();
    const initial = new Tuner(specs, { persistence: seed, actor: () => 'user', wallClock: () => wall });
    await initial.restore();
    await initial.lock('x');
    await initial.unlock('x');
    await initial.close();
    const snapshot = JSON.parse(seed.text() ?? '{}') as {
      idPrefix: string;
      nextId: number;
      log: { id: string }[];
    };
    const entries = snapshot.log;
    snapshot.log = Array.from({ length: 500 }, (_, i) => ({ ...entries[i % 2], id: `${snapshot.idPrefix}-${i + 1}` }));
    snapshot.nextId = 501;
    const persistence = storage(JSON.stringify(snapshot));
    const tuner = new Tuner(specs, { persistence, actor: () => 'user', wallClock: () => wall });
    await tuner.restore();
    expect(tuner.tuningDisabled).toBeUndefined();
    await tuner.lock('x');
    expect(tuner.logs).toHaveLength(500);
    expect(JSON.parse(persistence.text() ?? '{}').log).toHaveLength(501);
    wall += 31 * 86_400_000;
    await tuner.unlock('x');
    expect(JSON.parse(persistence.text() ?? '{}').log).toHaveLength(200);
    await tuner.close();
    const restored = new Tuner(specs, { persistence, actor: () => 'user', wallClock: () => wall });
    await restored.restore();
    expect(restored.tuningDisabled).toBeUndefined();
    expect(restored.logs).toHaveLength(200);
    await restored.close();
  });
});
