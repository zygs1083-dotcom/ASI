import type { SenseState } from '@asi/sense-types';
import { describe, expect, it, vi } from 'vitest';
import { createFramesSource } from '../../src/host/dsh/frames.ts';
import { StateStore } from '../../src/host/state/store.ts';

function fixture() {
  const state = new StateStore(() => 123).snapshot();
  const listeners = new Set<(state: SenseState) => void>();
  const off = vi.fn((listener: (state: SenseState) => void) => listeners.delete(listener));
  const runtime = {
    state: () => state,
    subscribe: (listener: (state: SenseState) => void) => {
      listeners.add(listener);
      return () => off(listener);
    },
    rules: {
      list: () => [
        {
          id: 'rule',
          match: { kind: 'job.exited' },
          level: 'wake' as const,
          createdBy: 'agent' as const,
          approved: false,
        },
      ],
      isEnabled: () => true,
      settings: () => ({ paused: false, sendTitles: false }),
    },
  };
  return { state, runtime, listeners, off };
}

describe('minimal frame source', () => {
  it('yields current state, maps rules, and updates when the runtime changes', async () => {
    const { state, runtime, listeners, off } = fixture();
    const controller = new AbortController();
    const iterator = createFramesSource(runtime)(controller.signal)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.state.self.body.cpu).toEqual(state.self.body.cpu);
    expect(first.value?.sendTitles).toBe(false);
    expect(first.value?.rules[0]).toMatchObject({ id: 'rule', enabled: true, confirmed: false, level: 'wake' });
    const next = iterator.next();
    state.self.body.cpu.value = { usage: 0.5, perCore: [], load1: 1, load5: 1, load15: 1 };
    for (const listener of listeners) listener(state);
    expect((await next).value?.state.self.body.cpu.value?.usage).toBe(0.5);
    controller.abort();
    await iterator.return?.();
    expect(off).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });

  it('stops a waiting stream promptly on abort', async () => {
    const { runtime, listeners, off } = fixture();
    const controller = new AbortController();
    const iterator = createFramesSource(runtime)(controller.signal)[Symbol.asyncIterator]();
    await iterator.next();
    const next = iterator.next();
    controller.abort();
    expect((await next).done).toBe(true);
    expect(off).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });

  it('refreshes subscribers after a setting change without a new state sample', async () => {
    const { runtime } = fixture();
    const source = createFramesSource(runtime);
    const controller = new AbortController();
    const iterator = source(controller.signal)[Symbol.asyncIterator]();
    await iterator.next();
    const next = iterator.next();
    source.invalidate?.();
    expect((await next).done).toBe(false);
    controller.abort();
    await iterator.return?.();
  });
});
