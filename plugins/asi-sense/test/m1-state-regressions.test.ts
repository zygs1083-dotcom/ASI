import type { Signal } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { StateStore } from '../src/host/state/store.ts';
import { FakeClock, SRC, SRC2, sig } from './helpers.ts';

describe('job tracking', () => {
  let seq = 0;
  const started = (job: string, at: number, extra: Partial<Signal> = {}) =>
    sig({
      id: `st-${job}-${at}-${seq++}`,
      kind: 'job.started',
      at,
      subject: job,
      data: { command: job, sequence: at },
      ...extra,
    });
  const exited = (job: string, at: number, extra: Partial<Signal> = {}) =>
    sig({
      id: `ex-${job}-${at}-${seq++}`,
      kind: 'job.exited',
      at,
      subject: job,
      data: { exitCode: 0, sequence: at },
      ...extra,
    });
  const ids = (st: StateStore) => (st.snapshot().env.activeJobs.value ?? []).map((j) => j.id);
  const factUpdate = (id: string, at: number, value: unknown) =>
    sig({ id, kind: 'fact.updated', at, data: { path: 'env.activeJobs', value, sequence: at } });

  it('tracks interleaved jobs independently and retains exit tombstones', () => {
    const c = new FakeClock();
    const st = new StateStore(c.time, 1000, c.time);
    st.apply(started('A', 1));
    st.apply(started('B', 10, { source: SRC2 }));
    st.apply(exited('A', 5));
    expect(ids(st)).toEqual(['B']);
    st.apply(started('C', 3));
    expect(ids(st)).toEqual(['B', 'C']);
    expect(st.snapshot().env.activeJobs.observedAt).toBe(3);
    expect(st.snapshot().env.activeJobs.source).toEqual(SRC);
    st.apply(started('A', 2));
    expect(ids(st)).toEqual(['B', 'C']);
    st.apply(exited('B', 9, { source: SRC2 }));
    expect(ids(st)).toEqual(['B', 'C']);
    st.apply(started('D', 7));
    st.apply(exited('D', 7));
    st.apply(started('D', 7));
    expect(ids(st)).toEqual(['B', 'C', 'D']);
    st.apply(started('D', 8));
    expect(ids(st)).toEqual(['B', 'C', 'D']);
    st.apply(exited('C', 20));
    c.advance(600_000);
    st.apply(started('C', 15));
    expect(ids(st)).toEqual(['B', 'D', 'C']);
  });

  it('seeds tracking from fact.updated replacements and clears on null', () => {
    const c = new FakeClock();
    const st = new StateStore(c.time, 1000);
    st.apply(started('X', 1));
    st.apply(factUpdate('seed', 10, [{ id: 'S', owner: 'sess-1', startedAt: 9, status: 'running' }]));
    st.apply(started('N', 11, { data: { command: 'N', sessionId: 'sess-2', sequence: 11 } }));
    expect(ids(st).sort()).toEqual(['N', 'S']);
    expect(st.snapshot().env.activeJobs.value?.find((j) => j.id === 'N')?.owner).toBe('sess-2');
    expect(st.snapshot().env.activeJobs.value?.find((j) => j.id === 'S')?.owner).toBe('sess-1');
    st.apply(factUpdate('clr', 20, null));
    st.apply(started('R', 21));
    expect(ids(st)).toEqual(['R']);
  });
});

describe('source recovery', () => {
  it('ordinary successful signals recover source status in observation.sources', () => {
    const c = new FakeClock();
    const store = new StateStore(c.time, 1000, c.time);
    store.apply(sig({ id: 'd1', kind: 'source.status', at: 1, data: { status: 'denied' } }));
    expect(store.snapshot().observation.sources.fs?.status).toBe('denied');
    store.apply(sig({ id: 'ok', kind: 'app.activated', at: 5, data: { name: 'A' } }));
    expect(store.snapshot().observation.sources.fs?.status).toBe('ok');
    store.apply(sig({ id: 'd2', kind: 'source.status', at: 6, data: { status: 'denied', sequence: 6 } }));
    expect(store.snapshot().observation.sources.fs?.status).toBe('denied');
    store.apply(sig({ id: 'stale', kind: 'source.status', at: 2, data: { status: 'ok', sequence: 2 } }));
    expect(store.snapshot().observation.sources.fs?.status).toBe('denied');
  });
});

describe('store subscriber reentrancy', () => {
  it('serializes reentrant subscriber snapshots and isolates listener errors', () => {
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

    const boom = new Error('cb');
    const st4 = new StateStore(new FakeClock().time);
    expect(() =>
      st4.apply(sig({ id: '1', kind: 'app.activated', at: 1, data: { name: 'C' } }), () => {
        throw boom;
      }),
    ).toThrow(boom);
    expect(() =>
      st4.apply(sig({ id: '2', kind: 'app.activated', at: 2, data: { name: 'D' } }), () => {
        throw undefined;
      }),
    ).toThrow();
    expect(st4.snapshot().env.frontApp.value?.name).toBe('D');
  });
});
