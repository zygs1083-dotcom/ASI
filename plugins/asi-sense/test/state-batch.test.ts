import type { Signal } from '@asi/sense-types';
import { expect, it } from 'vitest';
import { StateStore } from '../src/host/state/store.ts';

it('keeps batched reads old and delivers complete snapshots before reentrant writes', () => {
  const store = new StateStore(
    () => 1_000,
    60_000,
    () => 0,
  );
  const signal = (id: string, path: string, value: unknown): Signal => ({
    id,
    kind: 'fact.updated',
    at: 1_000,
    source: { id: 'synthetic', api: 'test', host: 'local' },
    subject: path,
    data: { path, value },
  });
  const read = () => ({
    app: store.snapshot().env.frontApp.value?.name ?? null,
    window: store.snapshot().env.focusedWindow.value?.title ?? null,
    activity: store.snapshot().self.activity.value,
  });
  const old = read();
  const observed: ReturnType<typeof read>[] = [];
  let queued = false;
  store.subscribe(() => {
    observed.push(read());
    if (!queued) {
      queued = true;
      store.apply(signal('activity', 'self.activity', 'tool'));
    }
  });
  store.batch(() => {
    store.apply(signal('app', 'env.frontApp', { name: 'Example', bundleId: 'example' }), () => {
      expect(read()).toEqual(old);
    });
    expect(read()).toEqual(old);
    store.apply(signal('window', 'env.focusedWindow', { title: 'Synthetic' }));
    expect(read()).toEqual(old);
  });
  expect(observed).toEqual([
    { app: 'Example', window: 'Synthetic', activity: old.activity },
    { app: 'Example', window: 'Synthetic', activity: old.activity },
    { app: 'Example', window: 'Synthetic', activity: 'tool' },
  ]);
});
