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
  it('marks the old frame stale on carrier loss, accepts a new baseline and cancels on dispose', async () => {
    const physical = [controlledStream<number>(), controlledStream<number>()];
    const accepted = [vi.fn(), vi.fn()];
    const opened = vi.fn();
    let disconnected: (() => void) | undefined;
    const dispose = vi.fn(() => physical[1]?.stream.dispose());
    const frames = createFrameState<number>((onDisconnect) => {
      disconnected = onDisconnect;
      return {
        dispose,
        async *[Symbol.asyncIterator]() {
          for (const [i, source] of physical.entries()) {
            opened(i + 1);
            for await (const value of source.stream) {
              yield { value, generation: i + 1, accept: accepted[i] };
            }
            if (i === 0) disconnected?.();
          }
        },
      };
    });
    physical[0]?.send(42);
    await vi.waitFor(() => expect(frames.getSnapshot()).toEqual({ status: 'live', value: 42 }));
    expect(accepted[0]).toHaveBeenCalledOnce();
    physical[0]?.stream.dispose();
    await vi.waitFor(() => expect(frames.getSnapshot()).toEqual({ status: 'reconnecting', value: 42 }));
    expect(opened.mock.calls).toEqual([[1], [2]]);
    physical[1]?.send(99);
    await vi.waitFor(() => expect(frames.getSnapshot()).toEqual({ status: 'live', value: 99 }));
    expect(accepted[1]).toHaveBeenCalledOnce();
    await frames.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('cancels while waiting for a replacement baseline', async () => {
    let onDisconnect: (() => void) | undefined;
    let finish: (() => void) | undefined;
    const dispose = vi.fn(() => finish?.());
    const frames = createFrameState<number>((disconnected) => {
      onDisconnect = disconnected;
      return {
        dispose,
        async *[Symbol.asyncIterator]() {
          yield { value: 42, accept: () => {} };
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
      };
    });
    await vi.waitFor(() => expect(frames.getSnapshot()).toEqual({ status: 'live', value: 42 }));
    onDisconnect?.();
    expect(frames.getSnapshot()).toEqual({ status: 'reconnecting', value: 42 });
    await frames.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('publishes frames as stable snapshots and disposes the stream', async () => {
    const { stream, send } = controlledStream<number>();
    const frames = createFrameState(() => ({
      dispose: stream.dispose,
      async *[Symbol.asyncIterator]() {
        for await (const value of stream) yield { value, accept: () => {} };
      },
    }));
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
    const frames = createFrameState(() => ({
      dispose: stream.dispose,
      async *[Symbol.asyncIterator]() {
        for await (const value of stream) yield { value, accept: () => {} };
      },
    }));
    await vi.waitFor(() => expect(frames.getSnapshot()).toEqual({ status: 'failed' }));
    await frames.dispose();
    expect(stream.dispose).toHaveBeenCalledOnce();
  });
});
