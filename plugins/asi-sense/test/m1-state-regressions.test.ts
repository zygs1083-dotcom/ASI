import type { Signal } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { createWatchRule, matchesRule, validateRule } from '../src/host/attention/rules.ts';
import { classifyCause, type ToolWindow } from '../src/host/attention/selfcause.ts';
import { StateStore } from '../src/host/state/store.ts';
import { FakeClock, pipe, SRC2, sess, sig } from './helpers.ts';

describe('self-cause ancestry', () => {
  it('classifies shell children and grandchildren across concurrent tool windows', () => {
    const w1: ToolWindow = { startedAt: 100, endedAt: 200, cwd: '/a', pid: 42 };
    const w2: ToolWindow = { startedAt: 100, endedAt: 300, cwd: '/b', pid: 77 };
    const proc = (id: string, at: number, data: Signal['data']) => sig({ id, kind: 'process.exited', at, data });
    // direct child via ppid, grandchild via ancestors — each its own window
    expect(classifyCause(proc('c1', 150, { pid: 43, ppid: 42 }), [w1])).toBe('agent');
    expect(classifyCause(proc('g1', 150, { pid: 50, ppid: 43, ancestors: [43, 42, 1] }), [w1])).toBe('agent');
    // concurrent windows: descendants of w2's shell are not attributed to w1
    expect(classifyCause(proc('c2', 150, { pid: 90, ppid: 77 }), [w1, w2])).toBe('agent');
    expect(classifyCause(proc('g2', 150, { pid: 91, ancestors: [90, 77, 1] }), [w1, w2])).toBe('agent');
    // unrelated processes inside the same timespan stay non-agent
    expect(classifyCause(proc('u1', 150, { pid: 999, ppid: 1 }), [w1, w2])).toBe('unknown');
    expect(classifyCause(proc('u2', 150, { pid: 999, ancestors: [1] }), [w1])).toBe('unknown');
    // inclusive bounds: at start/end classify, outside stays non-agent
    expect(classifyCause(proc('e1', 100, { pid: 43, ppid: 42 }), [w1])).toBe('agent');
    expect(classifyCause(proc('e2', 200, { pid: 43, ppid: 42 }), [w1])).toBe('agent');
    expect(classifyCause(proc('e3', 201, { pid: 43, ppid: 42 }), [w1])).toBe('unknown');
    expect(classifyCause(proc('e4', 99, { pid: 43, ppid: 42 }), [w1])).toBe('unknown');
    // nested shells attributed through the ancestor chain alone
    expect(classifyCause(proc('n1', 150, { pid: 60, ppid: 55, ancestors: [55, 44, 42, 1] }), [w1])).toBe('agent');
  });
});

describe('rule boundary validation', () => {
  const base = { id: 'r', match: { kind: 'k' }, level: 'wake' as const, createdBy: 'user' as const, approved: true };
  const withWhere = (where: unknown) => ({ ...base, match: { kind: 'k', where } });

  it('invalid where values fail closed and are rejected at rule boundaries', async () => {
    // absent, empty object and null-prototype objects are valid/unconditional
    expect(validateRule(base)).toEqual([]);
    expect(validateRule(withWhere({}))).toEqual([]);
    expect(validateRule(withWhere({ exitCode: { '!=': 0 } }))).toEqual([]);
    const nullProto = Object.assign(Object.create(null) as object, { kind: 'k' });
    expect(validateRule({ ...base, match: nullProto })).toEqual([]);
    // null/false/array/string/number/undefined wheres are invalid
    for (const where of [null, false, [], 'x', 1, undefined]) {
      expect(validateRule(withWhere(where)).length).toBeGreaterThan(0);
      const r = createWatchRule(withWhere(where) as never);
      expect(matchesRule(r, sig({ id: '1', kind: 'k' }), 0)).toBe(false);
    }
    // unknown operators and empty/invalid comparators are invalid too
    expect(validateRule(withWhere({ x: { '~': 1 } })).length).toBeGreaterThan(0);
    expect(validateRule(withWhere({ x: {} })).length).toBeGreaterThan(0);
    expect(validateRule(withWhere({ x: { '>': 'nan' } })).length).toBeGreaterThan(0);
    // boundaries: constructor rules and addRule throw TypeError on invalid input
    const c = new FakeClock();
    expect(() => pipe(c, [createWatchRule(withWhere(null) as never)])).toThrow(TypeError);
    const { pipeline } = pipe(c);
    expect(() => pipeline.addRule(createWatchRule(withWhere([]) as never))).toThrow(TypeError);
    const k = (id: string, x: number) => sig({ id, kind: 'k', at: 0, data: { x } });
    // constructor rules are cloned: mutating the caller's copy cannot widen them
    const ctor = createWatchRule({
      id: 'ctor',
      match: { kind: 'k', where: { x: 1 } },
      level: 'wake',
      createdBy: 'user',
    });
    const p2 = pipe(c, [ctor]);
    ctor.match.where = {};
    expect((await p2.pipeline.accept(k('c1', 2), sess())).level).toBe('record');
    expect((await p2.pipeline.accept(k('c2', 1), sess())).level).toBe('wake');
    // same for addRule
    const added = createWatchRule({
      id: 'added',
      match: { kind: 'k', where: { x: 1 } },
      level: 'wake',
      createdBy: 'user',
    });
    pipeline.addRule(added);
    added.match.where = {};
    expect((await pipeline.accept(k('a1', 2), sess())).level).toBe('record');
    expect((await pipeline.accept(k('a2', 1), sess())).level).toBe('wake');
    // upsert by id replaces without duplicating: record beats nothing now
    pipeline.addRule(
      createWatchRule({ id: 'added', match: { kind: 'k', where: { x: 1 } }, level: 'record', createdBy: 'user' }),
    );
    expect((await pipeline.accept(k('a3', 1), sess())).level).toBe('record');
    expect(pipeline.removeRule('added')).toBe(true);
    expect(pipeline.removeRule('added')).toBe(false);
    expect(() => pipeline.removeRule(1 as never)).toThrow(TypeError);
    expect((await pipeline.accept(k('a4', 1), sess())).level).toBe('record');
  });

  it('expires rules on the wall clock, not the monotonic clock', async () => {
    const c = new FakeClock();
    const { pipeline } = pipe(c, [
      createWatchRule({
        id: 'exp',
        match: { kind: 'k' },
        level: 'wake',
        createdBy: 'user',
        expiresAt: 50,
      }),
    ]);
    const k = (id: string) => sig({ id, kind: 'k', at: 0 });
    expect((await pipeline.accept(k('a'), sess())).level).toBe('wake');
    c.advance(10_000); // monotonic 10000, wall 10000 → expired on both
    c.jumpWall(-10_000); // wall back to 0 → rule valid again despite monotonic
    expect((await pipeline.accept(k('b'), sess())).level).toBe('wake');
    c.jumpWall(100); // wall 100 ≥ expiresAt 50 → expired
    expect((await pipeline.accept(k('d'), sess())).level).toBe('record');
  });
});

describe('job tracking', () => {
  let seq = 0;
  const started = (job: string, at: number, extra: Partial<Signal> = {}) =>
    sig({ id: `st-${job}-${at}-${seq++}`, kind: 'job.started', at, subject: job, data: { command: job }, ...extra });
  const exited = (job: string, at: number, extra: Partial<Signal> = {}) =>
    sig({ id: `ex-${job}-${at}-${seq++}`, kind: 'job.exited', at, subject: job, data: { exitCode: 0 }, ...extra });
  const ids = (st: StateStore) => (st.snapshot().env.activeJobs.value ?? []).map((j) => j.id);
  const factUpdate = (id: string, at: number, value: unknown) =>
    sig({ id, kind: 'fact.updated', at, data: { path: 'env.activeJobs', value } });

  it('tracks interleaved jobs independently and retains exit tombstones', () => {
    const c = new FakeClock();
    const st = new StateStore(c.time, 1000);
    st.apply(started('A', 1));
    st.apply(started('B', 10, { source: SRC2 }));
    st.apply(exited('A', 5)); // late exit removes only A
    expect(ids(st)).toEqual(['B']);
    // a late independent start still joins; the aggregate keeps the newest
    // event's observedAt AND source metadata while rebuilding the value
    st.apply(started('C', 3));
    expect(ids(st)).toEqual(['B', 'C']);
    expect(st.snapshot().env.activeJobs.observedAt).toBe(10);
    expect(st.snapshot().env.activeJobs.source).toEqual(SRC2);
    // a delayed start older than the exit cannot resurrect within retention
    st.apply(started('A', 2));
    expect(ids(st)).toEqual(['B', 'C']);
    // a stale exit after a newer start is ignored — the job stays running
    st.apply(exited('B', 9));
    expect(ids(st)).toEqual(['B', 'C']);
    // exit wins an equal timestamp over start; a distinct-id start at the
    // same time hits the event-time guard, not dedup
    st.apply(started('D', 7));
    st.apply(exited('D', 7));
    st.apply(started('D', 7));
    expect(ids(st)).toEqual(['B', 'C']);
    // a genuinely newer start may reuse the id
    st.apply(started('D', 8));
    expect(ids(st)).toEqual(['B', 'C', 'D']);
    // the tombstone prunes at the 600s retention boundary: old start resurrects
    st.apply(exited('C', 20));
    c.advance(600_000);
    st.apply(started('C', 15));
    expect(ids(st)).toEqual(['B', 'D', 'C']);
  });

  it('seeds tracking from fact.updated replacements and clears on null', () => {
    const c = new FakeClock();
    const st = new StateStore(c.time, 1000);
    st.apply(started('X', 1));
    // a trusted array replacement seeds tracking so later job events keep it
    st.apply(factUpdate('seed', 10, [{ id: 'S', startedAt: 9, status: 'running' }]));
    st.apply(started('N', 11));
    expect(ids(st).sort()).toEqual(['N', 'S']); // X dropped, S preserved by tracking
    // a null replacement clears tracking: the next event cannot resurrect
    st.apply(factUpdate('clr', 20, null));
    st.apply(started('R', 21));
    expect(ids(st)).toEqual(['R']);
  });
});

describe('source recovery', () => {
  it('ordinary successful signals recover source status before a second denied', async () => {
    const c = new FakeClock();
    const { intents, pipeline, store } = pipe(c);
    const denied = (id: string, at: number) =>
      pipeline.accept(sig({ id, kind: 'source.status', at, data: { status: 'denied' } }), sess());
    const deniedInjects = () =>
      intents
        .filter((i) => i.kind === 'inject')
        .flatMap((i) => i.update.changes)
        .filter((ch) => ch.signal.data.status === 'denied').length;
    await denied('d1', 1);
    c.advance(2001);
    await pipeline.preStep('s1');
    expect(deniedInjects()).toBe(1);
    // an ordinary successful signal marks recovery — the next denied notifies again
    await pipeline.accept(sig({ id: 'ok', kind: 'app.activated', at: 5, data: { name: 'A' } }), sess());
    await denied('d2', 6);
    c.advance(2001);
    await pipeline.preStep('s1');
    expect(deniedInjects()).toBe(2);
    // a stale status event cannot regress the mark or retrigger
    await denied('stale', 2);
    c.advance(2001);
    await pipeline.preStep('s1');
    expect(deniedInjects()).toBe(2);
    expect(store.snapshot().observation.sources.fs?.status).toBe('denied');
  });
});

describe('store subscriber reentrancy', () => {
  it('serializes reentrant subscriber snapshots and isolates listener errors', () => {
    // nested apply queues behind the outer snapshot — no listener sees shared state
    const st = new StateStore(new FakeClock().time);
    const seen: string[] = [];
    let nested = true;
    st.subscribe((s) => {
      seen.push(`l1:${s.env.frontApp.value?.name ?? '?'}`);
      if (nested) {
        nested = false;
        st.apply(sig({ id: '2', kind: 'app.activated', at: 2, data: { name: 'B' } }));
      }
    });
    st.subscribe((s) => seen.push(`l2:${s.env.frontApp.value?.name ?? '?'}`));
    st.apply(sig({ id: '1', kind: 'app.activated', at: 1, data: { name: 'A' } }));
    expect(seen).toEqual(['l1:A', 'l2:A', 'l1:B', 'l2:B']);

    // isolation: a throwing listener cannot starve the rest; unsubscribing
    // itself mid-emit is honored; listeners added during emit fire next apply
    const st2 = new StateStore(new FakeClock().time);
    const seen2: string[] = [];
    let late = 0;
    const offBad = st2.subscribe(() => {
      throw new Error('boom');
    });
    st2.subscribe((s) => {
      seen2.push(s.env.frontApp.value?.name ?? '?');
      offBad();
      st2.subscribe(() => {
        late++;
      });
    });
    st2.apply(sig({ id: '1', kind: 'app.activated', at: 1, data: { name: 'A' } }));
    st2.apply(sig({ id: '2', kind: 'app.activated', at: 2, data: { name: 'B' } }));
    expect(seen2).toEqual(['A', 'B']);
    expect(late).toBe(1);

    // unsubscribing ANOTHER listener mid-emit is honored before its turn;
    // mutations of an earlier listener's snapshot never reach later ones
    const st3 = new StateStore(new FakeClock().time);
    const seen3: string[] = [];
    let off2 = (): void => {};
    st3.subscribe((s) => {
      seen3.push('l1');
      if (s.env.frontApp.value) s.env.frontApp.value.name = 'MUT';
      off2();
    });
    off2 = st3.subscribe(() => seen3.push('l2'));
    st3.subscribe((s) => seen3.push(`l3:${s.env.frontApp.value?.name}`));
    st3.apply(sig({ id: '1', kind: 'app.activated', at: 1, data: { name: 'A' } }));
    st3.apply(sig({ id: '2', kind: 'app.activated', at: 2, data: { name: 'B' } }));
    expect(seen3).toEqual(['l1', 'l3:A', 'l1', 'l3:B']);
  });
});
