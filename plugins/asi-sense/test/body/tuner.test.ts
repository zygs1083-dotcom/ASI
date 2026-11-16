import { beforeEach, describe, expect, it } from 'vitest';
import type { BodyPersistence } from '../../src/host/body/persistence.ts';
import { Tuner, type TunerActor, type TunerOptions } from '../../src/host/body/tuner.ts';
import type { ParameterSpec } from '../../src/host/body/tuner-spec.ts';

const T = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const specs: Record<string, ParameterSpec> = {
  'cpu.sigma': { value: 3, min: 1, max: 12, noiseDirection: 'up' },
  'floor.disk': { value: 0.05, min: 0.02, max: 0.5, tighten: 'up' },
  'floor.ctx': { value: 0.5, tighten: 'down' },
  'floor.custom': { value: 0.5, tighten: 'down' },
  mode: { value: 'auto', choices: ['auto', 'manual'] },
  flag: { value: true },
  zero: { value: 0 },
  plain: { value: 10, min: 0, max: 1000 },
};

let mono = 0;
let wall = T;
let actor: TunerActor | 'admin' = 'agent';
const mk = (s = specs, extra: Partial<TunerOptions> = {}) => {
  const t = new Tuner(s, {
    clock: () => mono,
    wallClock: () => wall,
    actor: () => actor as TunerActor,
    persistence: { load: async () => undefined, save: async () => {} },
    ...extra,
  });
  if (!extra.persistence) t.restoreSnapshot(undefined);
  return t;
};
const asUser = () => {
  actor = 'user';
};
const asAgent = () => {
  actor = 'agent';
};

beforeEach(() => {
  mono = 0;
  wall = T;
  actor = 'agent';
});

class FakePersist implements BodyPersistence {
  data: string | undefined;
  saves = 0;
  load(): Promise<string | undefined> {
    return Promise.resolve(this.data);
  }
  save(d: string): Promise<void> {
    this.data = d;
    this.saves++;
    return Promise.resolve();
  }
}

describe('Tuner actor trust', () => {
  it('defaults to agent and resolves the actor only through the injected resolver', async () => {
    mono = 0;
    wall = T;
    const t = mk();
    // Extra forged argument is ignored; the resolver still governs.
    const r = await (t.propose as (req: unknown, by?: string) => Promise<{ applied: boolean; change: { by: string } }>)(
      { param: 'plain', to: 15, reason: 'x' },
      'user',
    );
    expect(r.applied).toBe(true);
    expect(r.change.by).toBe('agent'); // +50% boundary OK for agent
  });

  it('rejects an untrusted actor resolver result without applying', async () => {
    actor = 'admin';
    const t = mk();
    const r = await t.propose({ param: 'plain', to: 12 });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('untrusted actor');
    expect(t.get('plain')).toBe(10);
    asAgent();
  });

  it('only the trusted user may lock/unlock; agents are audited and rejected', async () => {
    const t = mk();
    const rl = await t.lock('plain');
    expect(rl.applied).toBe(false);
    expect(rl.reason).toBe('lock requires trusted user');
    expect(t.logs.at(-1)?.operation).toBe('lock');
    asUser();
    expect((await t.lock('plain')).applied).toBe(true);
    asAgent();
    expect((await t.unlock('plain')).applied).toBe(false); // agent cannot undo it either
  });
});

describe('Tuner guard matrix', () => {
  it('binds agent/auto to amplitude, direction, lock and budgets; user bypasses AI guards', async () => {
    const t = mk();
    expect((await t.propose({ param: 'plain', to: 15 })).applied).toBe(true); // +50% ok
    expect((await t.propose({ param: 'plain', to: 16 })).applied).toBe(true); // vs CURRENT 15 → +6% ok
    expect((await t.propose({ param: 'plain', to: 100 })).reason).toBe('exceeds ±50%');
    asUser();
    expect((await t.propose({ param: 'plain', to: 900 })).applied).toBe(true); // user bypasses amplitude
    asAgent();
    // Floor tighten: agent may only move a floor param in its tighten direction.
    const t2 = mk();
    expect((await t2.propose({ param: 'floor.disk', to: 0.075 })).applied).toBe(true); // tighten:up → raise ok
    expect((await t2.propose({ param: 'floor.disk', to: 0.05 })).reason).toBe('safety: cannot loosen');
    expect((await t2.propose({ param: 'floor.custom', to: 0.4 })).applied).toBe(true); // tighten:down → lower ok
    expect((await t2.propose({ param: 'floor.custom', to: 0.5 })).reason).toBe('safety: cannot loosen');
  });

  it('still enforces whitelist/type/bounds/no-op on user', async () => {
    const t = mk();
    asUser();
    expect((await t.propose({ param: 'nope', to: 1 })).reason).toBe('unknown param');
    expect((await t.propose({ param: 'mode', to: 'bogus' })).reason).toBe('not in choices');
    expect((await t.propose({ param: 'mode', to: 5 })).reason).toBe('type mismatch');
    expect((await t.propose({ param: 'plain', to: 10 })).reason).toBe('no-op');
    expect((await t.propose({ param: 'plain', to: 2000 })).reason).toBe('out of bounds');
    expect((await t.propose({ param: 'plain', to: Number.NaN })).reason).toBe('nonfinite');
    expect((await t.propose({ param: 'zero', to: 0.1 })).applied).toBe(true); // user bypasses amplitude even off zero
    asAgent();
    expect((await t.propose({ param: 'zero', to: 0 })).reason).toBe('exceeds ±50%'); // |0-0.1| > 0.05
    const t2 = mk();
    expect((await t2.propose({ param: 'zero', to: 0.1 })).reason).toBe('exceeds ±50%'); // agent cannot leave zero at all
  });

  it('rejects locked params for propose but lets the user REVERT through the lock', async () => {
    const t = mk();
    expect((await t.propose({ param: 'plain', to: 15 })).applied).toBe(true);
    const changeId = t.logs.filter((l) => l.status === 'applied').at(-1)?.id as string;
    asUser();
    expect((await t.lock('plain')).applied).toBe(true);
    expect((await t.propose({ param: 'plain', to: 20 })).reason).toBe('param locked');
    const rv = await t.revert(changeId); // user revert bypasses the lock
    expect(rv.applied).toBe(true);
    expect(t.get('plain')).toBe(10);
  });

  it('rejects nonfinite clocks for propose, lock and feedback — no mutation', async () => {
    const t = mk();
    asUser(); // even the trusted user cannot act on bad clocks
    mono = Number.NaN;
    await expect(t.propose({ param: 'plain', to: 12 })).rejects.toThrow('clocks must be finite');
    mono = 0;
    wall = Number.NaN;
    await expect(t.propose({ param: 'plain', to: 12 })).rejects.toThrow('clocks must be finite');
    await expect(t.lock('plain')).rejects.toThrow('clocks must be finite');
    await expect(t.registerAlert('a1', 'r1', 'cpu.sigma')).rejects.toThrow('clocks must be finite');
    await expect(t.feedback('a1', 'noise')).rejects.toThrow('clocks must be finite');
    wall = T;
    expect(t.get('plain')).toBe(10);
    expect((await t.lock('plain')).applied).toBe(true);
  });
});

describe('Tuner revert semantics', () => {
  it('rejects stale reverts — ABA (10→11→10) never revives the first change', async () => {
    const t = mk();
    const id1 = (await t.propose({ param: 'plain', to: 11 })).change.id;
    await t.propose({ param: 'plain', to: 10 });
    const stale = await t.revert(id1);
    expect(stale.applied).toBe(false);
    expect(stale.reason).toContain('stale');
    expect((await t.revert('nonexistent')).reason).toContain('no applied change');
  });

  it('lets the user revert a large change the agent could not', async () => {
    const t = mk();
    asUser();
    const id = (await t.propose({ param: 'plain', to: 100 })).change.id; // user 10→100
    asAgent();
    const r = await t.revert(id); // agent revert = AI attempt 100→10 → −90% > 50%
    expect(r.applied).toBe(false);
    asUser();
    expect((await t.revert(id)).applied).toBe(true);
    expect(t.get('plain')).toBe(10);
  });
});

describe('Tuner budgets (monotonic sliding windows)', () => {
  it('allows 2 changes/param/hour, 6/param/day, 24/day global', async () => {
    const t = mk();
    const bump = (p: string, i: number) => t.propose({ param: p, to: 10 + i });
    expect((await bump('plain', 1)).applied).toBe(true);
    expect((await bump('plain', 2)).applied).toBe(true);
    expect((await t.propose({ param: 'plain', to: 13 })).reason).toBe('hourly change limit');
    for (let i = 3; i <= 6; i++) {
      if (i % 2 === 1) mono += HOUR + 1;
      expect((await bump('plain', i)).applied).toBe(true);
    }
    mono += HOUR + 1;
    expect((await t.propose({ param: 'plain', to: 17 })).reason).toBe('daily change limit');

    // Per-param daily cap alone: one param, proposals spaced past the hour window.
    const t2 = mk();
    let applied = 0;
    for (let i = 0; i < 8; i++) {
      if ((await t2.propose({ param: 'cpu.sigma', to: i % 2 ? 3 : 4 })).applied) applied++;
      mono += HOUR + 1;
    }
    expect(applied).toBe(6);

    // Global daily cap: five params × five rounds = 25 attempts; per-param
    // caps never bind (≤5 each), so the 25th hits the global 24/day limit.
    const t3 = mk();
    const grid: [string, number][] = [
      ['cpu.sigma', 4],
      ['plain', 11],
      ['floor.disk', 0.06],
      ['floor.custom', 0.4],
      ['floor.ctx', 0.4],
      ['cpu.sigma', 3.5],
      ['plain', 12],
      ['floor.disk', 0.07],
      ['floor.custom', 0.35],
      ['floor.ctx', 0.35],
      ['cpu.sigma', 4],
      ['plain', 11],
      ['floor.disk', 0.08],
      ['floor.custom', 0.3],
      ['floor.ctx', 0.3],
      ['cpu.sigma', 3.5],
      ['plain', 12],
      ['floor.disk', 0.09],
      ['floor.custom', 0.25],
      ['floor.ctx', 0.25],
      ['cpu.sigma', 4],
      ['plain', 11],
      ['floor.disk', 0.1],
      ['floor.custom', 0.2],
      ['floor.ctx', 0.2],
    ];
    let total = 0;
    let lastReason = '';
    for (const [p, to] of grid) {
      const r = await t3.propose({ param: p, to });
      if (r.applied) total++;
      else {
        lastReason = r.reason ?? '';
        break;
      }
      mono += HOUR - 10; // ~1h spacing keeps per-param hourly windows clear
    }
    expect(total).toBe(24);
    expect(lastReason).toBe('global daily change limit');
  });

  it('counts auto feedback changes as AI budget', async () => {
    const t = mk();
    expect(await t.registerAlert('a1', 'rule1', 'cpu.sigma')).toBe(true);
    expect((await t.feedback('a1', 'noise')).applied).toBe(true);
    await t.registerAlert('a2', 'rule1', 'cpu.sigma');
    await t.feedback('a2', 'noise');
    await t.registerAlert('a3', 'rule1', 'cpu.sigma');
    await t.feedback('a3', 'noise'); // streak 3 → auto propose 3→3.75
    expect(t.get('cpu.sigma')).toBeCloseTo(3.75);
    const autoLog = t.logs.find((l) => l.by === 'auto' && l.status === 'applied');
    expect(autoLog?.operation).toBe('propose');
    expect((await t.propose({ param: 'cpu.sigma', to: 6 })).reason).toBe('exceeds ±50%'); // still AI-bound
  });
});

describe('Tuner persistence', () => {
  it('blocks AI until restore() completes when persistence is configured', async () => {
    const p = new FakePersist();
    const t = mk(specs, { persistence: p });
    await expect(t.propose({ param: 'plain', to: 15 })).rejects.toThrow('restore pending');
    p.data = undefined; // first install → fresh state
    await t.restore();
    expect((await t.propose({ param: 'plain', to: 15 })).applied).toBe(true);
  });

  it('round-trips values, locks, windows and ID lineage across restart', async () => {
    const p = new FakePersist();
    const t = mk(specs, { persistence: p });
    await t.restore(); // first install
    await t.propose({ param: 'plain', to: 15 });
    asUser();
    await t.lock('floor.disk');
    asAgent();
    await t.persist();
    const t2 = mk(specs, { persistence: p });
    await t2.restore();
    expect(t2.get('plain')).toBe(15);
    expect((await t2.propose({ param: 'plain', to: 16 })).applied).toBe(true); // window restored → 3rd within hour ok? count: 2 in hour (15,16)... 15 applied pre-restart +16 now =2 → hourly allows
    expect((await t2.propose({ param: 'plain', to: 17 })).reason).toBe('hourly change limit'); // 3rd hits restored window
    expect((await t2.lock('floor.disk')).reason).toBe('lock requires trusted user');
    // IDs continue the same lineage
    const next = t2.logs.at(-1)?.id ?? '';
    expect(next).toContain('-');
  });

  it('fails closed on corrupt snapshots and persists a disabled marker', async () => {
    const p = new FakePersist();
    p.data = '{';
    const t = mk(specs, { persistence: p });
    await t.restore();
    expect(t.tuningDisabled).toBe('restore-failed');
    await expect(t.propose({ param: 'plain', to: 15 })).rejects.toThrow('disabled');
    expect(p.data).toContain('restore-failed'); // marker persisted
    // A later restart sees the marker and STAYS disabled — cannot unlock.
    const t2 = mk(specs, { persistence: p });
    await t2.restore();
    expect(t2.tuningDisabled).toBe('restore-failed');
    await expect(t2.propose({ param: 'plain', to: 15 })).rejects.toThrow('disabled');
  });

  it('rejects malformed versions and nonfinite values', async () => {
    const p = new FakePersist();
    const t = mk(specs, { persistence: p });
    await t.restore();
    await t.propose({ param: 'plain', to: 15 });
    await t.persist();
    const d = JSON.parse(p.data as string) as Record<string, unknown>;
    d.version = 1;
    p.data = JSON.stringify(d);
    const t2 = mk(specs, { persistence: p });
    await t2.restore();
    expect(t2.tuningDisabled).toBe('restore-failed');
  });

  it('keeps a revertable applied entry after a 500-reject flood, across reload', async () => {
    const p = new FakePersist();
    const t = mk(specs, { persistence: p });
    await t.restore();
    const id = (await t.propose({ param: 'plain', to: 15 })).change.id;
    for (let i = 0; i < 500; i++) await t.propose({ param: 'plain', to: 2000 }); // all rejected (out of bounds)
    expect(t.logs.length).toBeLessThanOrEqual(500);
    await t.persist();
    const t2 = mk(specs, { persistence: p });
    await t2.restore();
    expect(t2.undoableChanges.map((change) => change.id)).toContain(id);
    expect((await t2.revert(id)).applied).toBe(true);
    expect(t2.get('plain')).toBe(10);
  });

  it('freezes AI when the wall clock is behind the saved high-water mark', async () => {
    const p = new FakePersist();
    const t = mk(specs, { persistence: p });
    await t.restore();
    wall = T + 10_000;
    await t.propose({ param: 'plain', to: 15 });
    await t.persist(); // highwater ~T+10s
    wall = T; // wall regressed 10s below highwater
    const t2 = mk(specs, { persistence: p });
    await t2.restore();
    expect((await t2.propose({ param: 'plain', to: 16 })).reason).toContain('frozen');
    wall = T + 10_000; // caught up → aging resumes, windows thaw
    mono += 1;
    expect((await t2.propose({ param: 'plain', to: 16 })).applied).toBe(true);
  });

  it('never credits restart downtime: restored windows keep their remaining time', async () => {
    const p = new FakePersist();
    const t = mk(specs, { persistence: p });
    await t.restore();
    await t.propose({ param: 'plain', to: 15 });
    await t.propose({ param: 'plain', to: 16 });
    await t.persist();
    // Downtime of a full day must NOT expire the hourly window.
    mono += DAY + 1;
    wall += DAY + 1;
    const t2 = mk(specs, { persistence: p });
    await t2.restore();
    expect((await t2.propose({ param: 'plain', to: 17 })).reason).toBe('hourly change limit');
    // Age past the restored remaining window → frees up.
    mono += HOUR + 1;
    expect((await t2.propose({ param: 'plain', to: 17 })).applied).toBe(true);
  });
});
