import { describe, expect, it } from 'vitest';
import { StateStore } from '../src/host/state/store.ts';
import { FakeClock, SRC, sig } from './helpers.ts';

function storeAt(clock: FakeClock) {
  return new StateStore(clock.time, 1000);
}

describe('StateStore normalization', () => {
  it("maps source.status 'error' to unavailable like source.error", () => {
    const st = storeAt(new FakeClock());
    st.apply(sig({ id: '1', kind: 'source.status', at: 1, data: { status: 'error' } }));
    expect(st.snapshot().observation.sources.fs?.status).toBe('unavailable');
  });

  it('falls back to subject when app.activated has no bundleId', () => {
    const st = storeAt(new FakeClock());
    st.apply(
      sig({
        id: '1',
        kind: 'app.activated',
        at: 1,
        subject: 'com.acme.App',
        data: { name: 'Acme' },
      }),
    );
    expect(st.snapshot().env.frontApp.value).toEqual({
      name: 'Acme',
      bundleId: 'com.acme.App',
    });
  });
});

describe('StateStore isolation', () => {
  it('deep-clones input so later caller mutation cannot corrupt facts', () => {
    const st = storeAt(new FakeClock());
    const s = sig({
      id: '1',
      kind: 'fact.updated',
      at: 1,
      data: { path: 'self.activity', value: { deep: 1 } },
    });
    st.apply(s);
    (s.data.value as { deep: number }).deep = 99;
    s.subject = 'mutated';
    expect(st.snapshot().self.activity.value).toEqual({ deep: 1 });
  });

  it('gives every subscriber an isolated snapshot', () => {
    const st = storeAt(new FakeClock());
    const names: string[] = [];
    st.subscribe((s) => {
      // mutate the first listener's copy
      if (s.env.frontApp.value) s.env.frontApp.value.name = 'HACKED';
      names.push(s.env.frontApp.value?.name ?? '?');
    });
    st.subscribe((s) => names.push(s.env.frontApp.value?.name ?? '?'));
    st.apply(sig({ id: '1', kind: 'app.activated', at: 1, data: { name: 'A' } }));
    expect(names).toEqual(['HACKED', 'A']);
    expect(st.snapshot().env.frontApp.value?.name).toBe('A');
  });

  it('accepts a first observation older than the constructor clock', () => {
    const st = new StateStore(() => 100);
    st.apply(sig({ id: '1', kind: 'app.activated', at: 90, data: { name: 'Late' } }));
    expect(st.snapshot().env.frontApp.value?.name).toBe('Late');
    st.apply(sig({ id: '2', kind: 'app.activated', at: 80, data: { name: 'Older' } }));
    expect(st.snapshot().env.frontApp.value?.name).toBe('Older');
    st.apply(sig({ id: 'file', kind: 'file.changed', at: 90, subject: '/r/late' }));
    expect(st.snapshot().env.watchedPaths.observedAt).toBe(90);
  });
});

describe('StateStore guards', () => {
  it('rejects fact.updated without an own value property', () => {
    const st = storeAt(new FakeClock());
    st.apply(
      sig({
        id: '1',
        kind: 'fact.updated',
        at: 1,
        data: { path: 'self.activity', status: 'ok' },
      }),
    );
    const f = st.snapshot().self.activity;
    expect(f.status).toBe('unknown');
    expect(f.value).toBeNull();
  });

  it('dedups repeated signal.id before counting', () => {
    const st = storeAt(new FakeClock());
    const seen: number[] = [];
    st.subscribe((s) => seen.push(s.env.watchedPaths.value?.['/r/a']?.changes ?? 0));
    st.apply(sig({ id: 'f', kind: 'file.changed', at: 1, subject: '/r/a' }));
    st.apply(sig({ id: 'f', kind: 'file.changed', at: 2, subject: '/r/a' }));
    st.apply(sig({ id: 'g', kind: 'file.changed', at: 3, subject: '/r/a' }));
    expect(st.snapshot().env.watchedPaths.value?.['/r/a']).toEqual({
      lastChange: 3,
      changes: 2,
    });
    // subscribers saw only the two unique inputs
    expect(seen).toEqual([1, 2]);
  });

  it('writes __proto__/constructor keys safely in dictionaries', () => {
    const st = storeAt(new FakeClock());
    const src = (id: string) => ({ id, api: 'x', host: 'h' });
    st.apply(
      sig({
        id: '1',
        kind: 'app.activated',
        at: 1,
        source: src('__proto__'),
        data: { name: 'A' },
      }),
    );
    st.apply(
      sig({
        id: '2',
        kind: 'app.activated',
        at: 2,
        source: src('constructor'),
        data: { name: 'B' },
      }),
    );
    const sources = st.snapshot().observation.sources;
    expect(Object.getOwnPropertyDescriptor(sources, '__proto__')?.value).toMatchObject({
      status: 'ok',
      lastSignalAt: 1,
    });
    expect(sources.constructor).toMatchObject({
      status: 'ok',
      lastSignalAt: 2,
    });
    st.apply(sig({ id: '3', kind: 'file.changed', at: 3, subject: '__proto__' }));
    st.apply(sig({ id: '4', kind: 'file.changed', at: 4, subject: 'constructor' }));
    const w = st.snapshot().env.watchedPaths.value ?? {};
    const protoEntry = Object.getOwnPropertyDescriptor(w, '__proto__')?.value;
    expect(protoEntry).toEqual({ lastChange: 3, changes: 1 });
    expect(w.constructor).toEqual({ lastChange: 4, changes: 1 });
    // no prototype pollution leaked out of the dictionaries
    expect(Object.getPrototypeOf({})).not.toBe(protoEntry);
    expect(SRC.id).toBe('fs');
  });
});
