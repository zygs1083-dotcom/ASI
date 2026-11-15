import { describe, expect, it } from 'vitest';
import { FileBurstDetector, type FileBurstOptions } from '../../src/host/body/burst.ts';
import { fileChanged } from './helpers.ts';

const det = (over: FileBurstOptions = {}) =>
  new FileBurstDetector({ windowMs: 1000, maxChanges: 3, maxDeleted: 2, ...over });

const seq = (
  d: FileBurstDetector,
  events: [id: string, at: number, path: string, change: string, cause?: 'agent' | 'user'][],
) => events.map(([id, at, path, change, cause]) => d.accept(fileChanged(id, at, path, change, cause)));

describe('FileBurstDetector', () => {
  it('counts add/modify/delete per directory and emits one wake on an external burst', () => {
    const d = det();
    const out = seq(d, [
      ['a1', 0, '/w/a.ts', 'add'],
      ['a2', 100, '/w/b.ts', 'modify'],
      ['a3', 200, '/w/c.ts', 'add'],
    ]);
    expect(out.flat()).toEqual([]);
    const sigs = d.accept(fileChanged('a4', 400, '/w/d.ts', 'add'));
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatchObject({ kind: 'file.burst', subject: '/w', layer: 'rate', at: 400 });
    expect(sigs[0]?.cause).toBeUndefined(); // external trigger is never marked agent
    expect(sigs[0]?.data).toMatchObject({
      layer: 'rate',
      level: 'wake',
      wake: true,
      ruleId: 'file.burst',
      directory: '/w',
      windowMs: 1000,
      created: 3,
      modified: 1,
      deleted: 0,
      agentDeleted: 0,
    });
    // latched: further changes over the limit do not re-emit
    expect(d.accept(fileChanged('a5', 500, '/w/e.ts', 'add'))).toEqual([]);
  });

  it('isolates directories and derives the directory from subject when data.path is absent', () => {
    const d = det();
    seq(d, [
      ['b1', 0, '/a/x', 'add'],
      ['b2', 0, '/b/x', 'add'],
      ['b3', 0, '/b/y', 'add'],
      ['b4', 0, '/b/z', 'add'],
    ]);
    const wa = d.accept(fileChanged('b5', 100, '/a/y', 'add')); // /a now has 2
    expect(wa).toEqual([]);
    const wb = d.accept(fileChanged('b6', 100, '/b/w', 'add')); // /b reaches 4
    expect(wb[0]?.subject).toBe('/b');
    expect(wb[0]?.data.directory).toBe('/b');

    const d2 = det();
    seq(d2, [
      ['s1', 0, '/s/dir/f1', 'add'],
      ['s2', 0, '/s/dir/f2', 'add'],
      ['s3', 0, '/s/dir/f3', 'add'],
    ]);
    const s4 = d2.accept({ ...fileChanged('s4', 0, '/s/dir/f4', 'add'), data: { change: 'add' } });
    expect(s4[0]?.data.directory).toBe('/s/dir'); // dirname of subject fallback
  });

  it('audits agent-only delete bursts at record level without arming the wake latch', () => {
    const d = det(); // maxDeleted 2
    seq(d, [
      ['d1', 0, '/w/a', 'delete', 'agent'],
      ['d2', 50, '/w/b', 'delete', 'agent'],
    ]);
    const audit = d.accept(fileChanged('d3', 100, '/w/c', 'delete', 'agent'));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.cause).toBe('agent');
    expect(audit[0]?.data).toMatchObject({ level: 'record', wake: false, deleted: 3, agentDeleted: 3 });
    expect(d.accept(fileChanged('d4', 150, '/w/d', 'delete', 'agent'))).toEqual([]); // audit latched
    // agent deletes never count toward the eligible totals: still no wake
    const u1 = seq(d, [
      ['u1', 200, '/w/e', 'delete', 'user'],
      ['u2', 250, '/w/f', 'delete', 'user'],
    ]);
    expect(u1.flat()).toEqual([]); // eligibleDeleted 2 is not > 2
    const wake = d.accept(fileChanged('u3', 300, '/w/g', 'delete', 'user'));
    expect(wake[0]?.cause).toBeUndefined();
    expect(wake[0]?.data).toMatchObject({ level: 'wake', wake: true, deleted: 7, agentDeleted: 4 });
  });

  it('rearms after counts fall below 80% and expires events outside the window', () => {
    const d = det();
    seq(d, [
      ['e1', 0, '/w/a', 'add'],
      ['e2', 100, '/w/b', 'add'],
      ['e3', 200, '/w/c', 'add'],
    ]);
    expect(d.accept(fileChanged('e4', 300, '/w/d', 'add'))[0]?.data.level).toBe('wake');
    // at t=2000 the whole first burst is outside windowMs=1000 → counts reset
    expect(d.accept(fileChanged('e5', 2000, '/w/e', 'add'))).toEqual([]); // silent rearm
    seq(d, [
      ['e6', 2100, '/w/f', 'add'],
      ['e7', 2200, '/w/g', 'add'],
    ]);
    const second = d.accept(fileChanged('e8', 2300, '/w/h', 'add'));
    expect(second[0]?.data).toMatchObject({ level: 'wake', created: 4 });
  });

  it('ignores non-burst signals, invalid changes, non-finite and backward timestamps', () => {
    const d = det();
    expect(d.accept({ ...fileChanged('x1', 0, '/w/a', 'add'), kind: 'job.exited' })).toEqual([]);
    expect(d.accept(fileChanged('x2', 0, '/w/a', 'rename'))).toEqual([]);
    expect(d.accept(fileChanged('x3', Number.NaN, '/w/a', 'add'))).toEqual([]);
    seq(d, [
      ['x4', 300, '/w/a', 'add'],
      ['x5', 100, '/w/b', 'add'], // backward for /w: dropped
      ['x6', 400, '/w/c', 'add'],
      ['x7', 500, '/w/d', 'add'],
    ]);
    const s = d.accept(fileChanged('x8', 600, '/w/e', 'add'));
    expect(s[0]?.data.created).toBe(4); // x5 never counted
  });

  it('counts agent deletes toward the trigger when includeAgentDeletes is set', () => {
    const d = det({ includeAgentDeletes: true });
    seq(d, [
      ['g1', 0, '/w/a', 'delete', 'agent'],
      ['g2', 50, '/w/b', 'delete', 'agent'],
    ]);
    const s = d.accept(fileChanged('g3', 100, '/w/c', 'delete', 'agent'));
    expect(s[0]?.data).toMatchObject({ level: 'wake', wake: true, deleted: 3, agentDeleted: 3 });
  });

  it('resolves limits dynamically and validates options', () => {
    let limit = 10;
    const d = det({ threshold: (p, f) => (p === 'file.burst.maxChanges' ? limit : f) });
    seq(d, [
      ['d1', 0, '/w/a', 'add'],
      ['d2', 50, '/w/b', 'add'],
      ['d3', 100, '/w/c', 'add'],
      ['d4', 150, '/w/d', 'add'],
    ]);
    expect(d.accept(fileChanged('d5', 200, '/w/e', 'add'))).toEqual([]); // limit 10 not hit
    limit = 3;
    const s = d.accept(fileChanged('d6', 300, '/w/f', 'add'));
    expect(s[0]?.data.level).toBe('wake'); // live limit 3: 6 > 3
    limit = Number.NaN;
    expect(d.accept(fileChanged('d7', 400, '/w/g', 'add'))).toEqual([]); // invalid lookup → configured 3 stays, latch active
    for (const bad of [{ windowMs: 0 }, { maxChanges: -1 }, { maxDeleted: Number.NaN }, { threshold: 7 as never }]) {
      expect(() => new FileBurstDetector(bad)).toThrow(TypeError);
    }
  });

  it('rejects invalid events before sweeping so they cannot erase history', () => {
    const d = det();
    seq(d, [
      ['p1', 0, '/w/a', 'add'],
      ['p2', 50, '/w/b', 'add'],
    ]);
    // invalid unrelated future event must not trigger the prune sweep
    expect(d.accept(fileChanged('p3', 5000, '/w/c', 'rename'))).toEqual([]);
    seq(d, [['p4', 100, '/w/c', 'add']]);
    const s = d.accept(fileChanged('p5', 150, '/w/d', 'add'));
    expect(s[0]?.data.created).toBe(4); // p1+p2 survived the invalid future event
  });

  it('removes expired directory state even while the wake latch is armed', () => {
    const d = det();
    seq(d, [
      ['s1', 0, '/a/x', 'add'],
      ['s2', 10, '/a/y', 'add'],
      ['s3', 20, '/a/z', 'add'],
      ['s4', 30, '/a/w', 'add'], // latch armed for /a
    ]);
    seq(d, [
      ['s5', 5000, '/b/x', 'add'],
      ['s6', 5010, '/b/y', 'add'],
      ['s7', 5020, '/b/z', 'add'],
      ['s8', 5030, '/b/w', 'add'], // /a expired and swept despite its latch
    ]);
    // externally indistinguishable from rearm — assert the state is really gone
    const dirs = (d as unknown as { dirs: Map<string, unknown> }).dirs;
    expect(dirs.has('/a')).toBe(false);
    expect(dirs.has('/b')).toBe(true);
  });
});
