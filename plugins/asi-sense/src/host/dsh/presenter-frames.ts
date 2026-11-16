import type { createPresenter } from '../presenter/index.ts';
import type { FramesSource } from './frames.ts';

export function presenterFrames(presenter: Pick<ReturnType<typeof createPresenter>, 'frames'>): FramesSource {
  return async function* (signal) {
    if (signal.aborted) return;
    const iterator = presenter.frames()[Symbol.asyncIterator]();
    let closing: Promise<void> | undefined;
    const close = () => {
      closing ??= Promise.resolve(iterator.return?.()).then(() => undefined);
      return closing;
    };
    const abort = () => {
      void close().catch(() => undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (!signal.aborted) {
        const frame = await iterator.next();
        if (frame.done || signal.aborted) return;
        yield frame.value;
      }
    } finally {
      signal.removeEventListener('abort', abort);
      await close();
    }
  };
}
