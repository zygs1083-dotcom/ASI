import { describe, expect, it } from 'vitest';
import { type ParameterSpec, Tuner } from '../../src/host/body/tuner.ts';

const T = Date.UTC(2026, 0, 5);
const HOUR = 3_600_000;
let now = T;
const specs: Record<string, ParameterSpec> = {
  'cpu.sigma': { value: 3, min: 1, max: 12, noiseDirection: 'up' },
  'floor.disk': { value: 0.05, min: 0.02, max: 0.5, tighten: 'up' },
  'floor.down': { value: 0.5, tighten: 'down' },
  mode: { value: 'auto', choices: ['auto', 'manual'] },
  flag: { value: true },
  zero: { value: 0 },
  plain: { value: 10 },
};
const mk = (s = specs) => new Tuner(s, () => now);
const propose = (t: Tuner, param: string, to: number | string | boolean, by: 'user' | 'agent' | 'auto' = 'user') =>
  t.propose({ param, to, reason: 'test' }, by);

describe('Tuner guards', () => {
  it('applies bounded changes and rejects everything outside them', () => {
    const t = mk();
    expect(propose(t, 'cpu.sigma', 4.5).applied).toBe(true); // exactly +50% allowed
    expect(t.get('cpu.sigma')).toBe(4.5);
    expect(t.number('cpu.sigma', 9)).toBe(4.5);
    expect(t.number('missing', 9)).toBe(9);
    const rejected: [string, number | string | boolean][] = [
      ['cpu.sigma', 7], // >+50%
      ['cpu.sigma', 4.5], // no-op
      ['cpu.sigma', 20], // max bound
      ['cpu.sigma', Number.NaN],
      ['mode', 'bogus'], // not in choices
      ['mode', 5], // type
      ['flag', 'yes'], // type
      ['nope', 1], // unknown
      ['zero', 0.1], // zero can only stay zero
      ['zero', 0], // …and that is a no-op anyway
      ['floor.disk', 0.03], // tighten:up forbids loosening
      ['floor.down', 0.6], // tighten:down forbids loosening
    ];
    for (const [param, to] of rejected) {
      const r = propose(t, param, to);
      expect(r.applied, `${param}→${String(to)}`).toBe(false);
      expect(r.change.status).toBe('rejected');
    }
    expect(propose(t, 'floor.disk', 0.06).applied).toBe(true); // tightening is allowed
    expect(propose(t, 'floor.down', 0.4).applied).toBe(true);
    expect(propose(t, 'mode', 'manual').applied).toBe(true);
  });

  it('enforces the rolling-hour cap of 2 applied changes per param', () => {
    const t = mk();
    expect(propose(t, 'plain', 12).applied).toBe(true);
    expect(propose(t, 'plain', 10).applied).toBe(true);
    expect(propose(t, 'plain', 9).applied).toBe(false);
    now += HOUR; // exact expiry boundary
    expect(propose(t, 'plain', 9).applied).toBe(true);
    now = T;
  });

  it('locks reject proposes from every actor; unlock restores', () => {
    const t = mk();
    expect(t.lock('cpu.sigma').change.status).toBe('applied');
    for (const by of ['user', 'agent', 'auto'] as const) expect(propose(t, 'cpu.sigma', 4, by).applied).toBe(false);
    expect(t.lock('nope').change.status).toBe('rejected');
    expect(t.unlock('cpu.sigma').applied).toBe(true);
    expect(propose(t, 'cpu.sigma', 4).applied).toBe(true);
  });

  it('reverts an applied change through the same guards', () => {
    const t = mk();
    const p = propose(t, 'plain', 12);
    const r = t.revert(p.change.id);
    expect(r.applied).toBe(true);
    expect(r.change.operation).toBe('revert');
    expect(t.get('plain')).toBe(10);
    expect(t.revert(p.change.id).applied).toBe(false); // stale
    expect(t.revert('chg-999').applied).toBe(false); // unknown id
    const l = propose(t, 'floor.disk', 0.06);
    t.lock('floor.disk');
    expect(t.revert(l.change.id).applied).toBe(false); // locked blocks revert too
  });
});

describe('Tuner feedback', () => {
  const fb = (t: Tuner, i: number, v: 'useful' | 'noise', param = 'cpu.sigma', ruleId = 'cpu-anomaly') => {
    t.registerAlert(`al-${i}`, ruleId, param);
    return t.feedback(`al-${i}`, v);
  };

  it('auto-tunes after 3 noise, resets on useful, consumes alerts once', () => {
    const t = mk();
    expect(fb(t, 1, 'noise').applied).toBe(true);
    expect(fb(t, 2, 'useful').applied).toBe(true); // streak reset
    expect(t.feedback('al-2', 'noise').applied).toBe(false); // consumed already
    expect(t.feedback('ghost', 'noise').applied).toBe(false); // unknown
    fb(t, 3, 'noise');
    fb(t, 4, 'noise');
    fb(t, 5, 'noise'); // streak 3 → auto 3*1.25
    expect(t.get('cpu.sigma')).toBe(3.75);
    expect(t.logs.find((l) => l.operation === 'propose' && l.by === 'auto')?.status).toBe('applied');
    for (let i = 6; i <= 11; i++) fb(t, i, 'noise'); // two more autos
    expect(t.get('cpu.sigma')).toBe(4.6875); // third hourly auto rejected by cap
    expect(t.logs.filter((l) => l.by === 'auto' && l.status === 'rejected').length).toBeGreaterThan(0);
  });

  it('logs a rejected auto proposal when the param has no noise policy', () => {
    const t = mk();
    for (let i = 0; i < 3; i++) fb(t, i, 'noise', 'plain', 'rule-x');
    expect(t.logs.find((l) => l.operation === 'propose' && l.by === 'auto')?.status).toBe('rejected');
    expect(t.get('plain')).toBe(10); // no policy → never guessed
    expect(t.registerAlert('dup', 'r', 'plain')).toBe(true);
    expect(t.registerAlert('dup', 'r2', 'mode')).toBe(false); // live binding can't be overwritten
  });
});

describe('Tuner durability', () => {
  it('caps the log at 500 without laundering the hourly limit', () => {
    const t = mk();
    expect(propose(t, 'plain', 12).applied).toBe(true);
    expect(propose(t, 'plain', 10).applied).toBe(true); // 2 applied stamps FIRST
    for (let i = 0; i < 600; i++) propose(t, 'cpu.sigma', 20); // flood >500 rejected
    expect(t.logs.length).toBe(500);
    expect(t.logs.some((l) => l.param === 'plain')).toBe(false); // applied entries evicted…
    expect(propose(t, 'plain', 9).applied).toBe(false); // …but the cap still bites
    const rt = Tuner.deserialize(t.serialize(), specs, () => now);
    expect(propose(rt, 'plain', 9).applied).toBe(false); // throttle survives reload
  });

  it('round-trips state and rebuilds on malformed or loosened snapshots', () => {
    const t = mk();
    propose(t, 'cpu.sigma', 4);
    t.lock('floor.disk');
    t.registerAlert('keep', 'r1', 'cpu.sigma');
    const rt = Tuner.deserialize(t.serialize(), specs, () => now);
    expect(rt.get('cpu.sigma')).toBe(4);
    expect(propose(rt, 'floor.disk', 0.06).applied).toBe(false); // lock survived
    expect(rt.feedback('keep', 'noise').applied).toBe(true); // alert binding survived
    expect(propose(rt, 'cpu.sigma', 5).applied).toBe(true);
    expect(propose(rt, 'cpu.sigma', 6).applied).toBe(false); // throttle survived
  });

  it('rejects malformed snapshots wholesale — never partially restores', () => {
    const base = JSON.parse(mk().serialize()) as Record<string, unknown>;
    const snap = (mut: (d: Record<string, unknown>) => void) => {
      const d = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      mut(d);
      return JSON.stringify(d);
    };
    const fresh = mk().serialize();
    const logOk = {
      id: 'chg-1',
      param: 'plain',
      from: 10,
      to: 12,
      by: 'user',
      reason: 'r',
      at: 0,
      operation: 'propose',
      status: 'applied',
    };
    const bads = [
      'x',
      '{"version":2}',
      snap((d) => void (d.values as unknown[]).push(['cpu.sigma', 20])), // dup key / extra
      snap((d) => void (d.values as unknown[]).pop()), // missing param
      snap((d) => {
        (d.values as unknown[][])[0][1] = 0.03; // cpu.sigma below min bound
      }),
      snap((d) => void (d.locked as unknown[]).push('nope')), // unknown lock
      snap((d) => void (d.noise as unknown[]).push(['r', 9])), // streak >2
      snap((d) => void (d.alerts as unknown[]).push(['a', { ruleId: '', param: 'plain' }])), // empty ruleId
      snap((d) => void (d.alerts as unknown[]).push(['a', { ruleId: 'r', param: 'ghost' }])), // unknown param
      snap((d) => void (d.throttle as unknown[]).push(['plain', [1, 2, 3]])), // >2 stamps
      snap((d) => void (d.throttle as unknown[]).push(['ghost', [1]])), // unknown param
      snap((d) => void (d.log as unknown[]).push({ ...logOk })), // chg-1 ≥ nextId=1
      snap((d) => void (d.log as unknown[]).push({ ...logOk, id: 'bogus' })), // bad id shape
      snap((d) => void (d.log as unknown[]).push({ ...logOk, reason: 5 })), // bad reason
    ];
    for (const json of bads) {
      expect(Tuner.deserialize(json, specs, () => now).serialize()).toBe(fresh);
    }
    // >500 log entries and duplicate IDs rejected
    const big = snap((d) => {
      d.log = Array.from({ length: 501 }, (_, i) => ({ ...logOk, id: `chg-${i + 1}` }));
      d.nextId = 999;
    });
    expect(Tuner.deserialize(big, specs, () => now).serialize()).toBe(fresh);
    const dup = snap((d) => {
      d.log = [logOk, { ...logOk, at: 1 }];
      d.nextId = 9;
    });
    expect(Tuner.deserialize(dup, specs, () => now).serialize()).toBe(fresh);
    // the old public restore bypass is gone (apply is now TS-private)
    expect((mk() as unknown as Record<string, unknown>).restoreValidated).toBeUndefined();
  });

  it('logs nonfinite attempts as JSON-safe strings without poisoning durable state', () => {
    const t = mk();
    propose(t, 'plain', 12);
    propose(t, 'plain', 10);
    t.lock('floor.disk');
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const r = propose(t, 'cpu.sigma', bad);
      expect(r.applied).toBe(false);
      expect(r.change.to).toBe(String(bad)); // 'NaN' | 'Infinity' | '-Infinity'
      expect(r.change.from).toBe(3); // finite current stays numeric
    }
    const u = propose(t, 'nope', Number.NaN);
    expect(u.applied).toBe(false);
    expect(u.change.to).toBe('NaN');
    expect(u.change.from).toBe('NaN'); // unknown param's `from` fell back to `to`
    expect(t.get('cpu.sigma')).toBe(3); // rejected input can't move values
    // unknown/empty alert bindings rejected before they can poison a snapshot
    expect(t.registerAlert('bad1', '', 'plain')).toBe(false);
    expect(t.registerAlert('bad2', 'r', 'ghost')).toBe(false);
    const json = t.serialize();
    const rt = Tuner.deserialize(json, specs, () => now);
    expect(JSON.parse(rt.serialize()).log).toEqual(JSON.parse(json).log); // deep-equal roundtrip
    expect(rt.get('cpu.sigma')).toBe(3);
    expect(propose(rt, 'floor.disk', 0.06).applied).toBe(false); // lock survived
    expect(propose(rt, 'plain', 9).applied).toBe(false); // hourly cap survived
    expect(Tuner.deserialize(t.serialize(), specs, () => now).serialize()).toBe(t.serialize());
  });
});
