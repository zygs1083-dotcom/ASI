import { describe, expect, it, vi } from 'vitest';
import { presenterFrames } from '../../src/host/dsh/presenter-frames.ts';
import type { PresenterModel } from '../../src/host/presenter/project.ts';

describe('presenter frame adapter', () => {
  it('cancels a waiting presenter iterator exactly once', async () => {
    let finish: ((value: IteratorResult<PresenterModel>) => void) | undefined;
    const close = vi.fn(async () => {
      finish?.({ done: true, value: undefined });
      return { done: true as const, value: undefined };
    });
    const iterator: AsyncIterator<PresenterModel> = {
      next: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      return: close,
    };
    const source = presenterFrames({ frames: () => ({ [Symbol.asyncIterator]: () => iterator }) });
    const controller = new AbortController();
    const stream = source(controller.signal)[Symbol.asyncIterator]();
    const next = stream.next();
    controller.abort();
    expect((await next).done).toBe(true);
    await stream.return?.();
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not subscribe when the caller is already aborted', async () => {
    const frames = vi.fn(() => ({
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: undefined }) }),
    }));
    const controller = new AbortController();
    controller.abort();
    const next = await presenterFrames({ frames })(controller.signal)[Symbol.asyncIterator]().next();
    expect(next.done).toBe(true);
    expect(frames).not.toHaveBeenCalled();
  });
});
