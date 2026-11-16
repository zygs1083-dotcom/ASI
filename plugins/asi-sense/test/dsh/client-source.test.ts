import { describe, expect, it, vi } from 'vitest';
import { createFrameState } from '../../src/client/frame-state.ts';

function controlledStream<T>() {
  let resolveNext: ((item: IteratorResult<T>) => void) | undefined;
  const stream = {
    dispose: vi.fn(() => resolveNext?.({ done: true, value: undefined })),
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<T>>((resolve) => {
            resolveNext = resolve;
          }),
      };
    },
  };
  return {
    stream,
    send(value: T) {
      if (!resolveNext) throw new Error('stream is not waiting');
      const resolve = resolveNext;
      resolveNext = undefined;
      resolve({ done: false, value });
    },
  };
}

describe('client frame state', () => {
  it('publishes frames as stable snapshots and disposes the stream', async () => {
    const { stream, send } = controlledStream<number>();
    const frames = createFrameState(stream);
    const listener = vi.fn();
    const off = frames.subscribe(listener);
    const initial = frames.getSnapshot();
    expect(initial).toEqual({ status: 'connecting' });
    expect(frames.getSnapshot()).toBe(initial);
    send(42);
    await vi.waitFor(() => expect(frames.getSnapshot()).toEqual({ status: 'live', value: 42 }));
    expect(listener).toHaveBeenCalledOnce();
    await frames.dispose();
    expect(stream.dispose).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    off();
  });

  it('reports an unexpected stream failure without leaking exception text', async () => {
    const stream = {
      dispose: vi.fn(),
      [Symbol.asyncIterator](): AsyncIterator<number> {
        return {
          next: async () => {
            throw new Error('sensitive stream details');
          },
        };
      },
    };
    const frames = createFrameState(stream);
    await vi.waitFor(() => expect(frames.getSnapshot()).toEqual({ status: 'failed' }));
    await frames.dispose();
    expect(stream.dispose).toHaveBeenCalledOnce();
  });
});
