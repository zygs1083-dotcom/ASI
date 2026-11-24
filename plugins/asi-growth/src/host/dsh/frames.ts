import type { GrowthPanelModel } from '../../shared/types.js';
import type { GrowthRuntime } from '../runtime.js';

export type GrowthFramesSource = ((signal: AbortSignal) => AsyncIterable<GrowthPanelModel>) & {
  invalidate?: (sinceRevision?: number) => void;
  revision?: () => number;
};

export const DEFAULT_GROWTH_FRAME_THROTTLE_MS = 180;

export function createGrowthFramesSource(
  runtime: GrowthRuntime,
  options?: { throttleMs?: number; now?: () => number },
): GrowthFramesSource {
  const throttleMs = Math.max(0, options?.throttleMs ?? DEFAULT_GROWTH_FRAME_THROTTLE_MS);
  const now = options?.now ?? (() => performance.now());
  const subscribers = new Set<(sinceRevision?: number) => void>();
  let currentRevision = 0;

  const source = async function* (signal: AbortSignal): AsyncIterable<GrowthPanelModel> {
    if (signal.aborted) return;

    let changed = true;
    let immediate = true;
    let timerFired = false;
    let lastEmitAt = Number.NEGATIVE_INFINITY;
    let emittedRevision = -1;
    let wake: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cleanedUp = false;

    const clearTimer = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const triggerWake = () => {
      const fn = wake;
      wake = undefined;
      fn?.();
    };

    const scheduleWake = () => {
      if (immediate || throttleMs <= 0) {
        clearTimer();
        triggerWake();
        return;
      }
      const remainingMs = lastEmitAt + throttleMs - now();
      if (remainingMs <= 0) {
        clearTimer();
        triggerWake();
        return;
      }
      if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          timerFired = true;
          triggerWake();
        }, Math.ceil(remainingMs));
      }
    };

    const onRuntimeChange = () => {
      currentRevision += 1;
      changed = true;
      if (wake !== undefined) scheduleWake();
    };

    const onInvalidate = (sinceRevision?: number) => {
      if (sinceRevision !== undefined && !changed && emittedRevision > sinceRevision) return;
      currentRevision += 1;
      changed = true;
      immediate = true;
      clearTimer();
      triggerWake();
    };

    let off: (() => void) | undefined = runtime.subscribe(onRuntimeChange);

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimer();
      signal.removeEventListener('abort', onAbort);
      subscribers.delete(onInvalidate);
      const unsub = off;
      off = undefined;
      unsub?.();
    };

    function onAbort(): void {
      cleanup();
      triggerWake();
    }

    subscribers.add(onInvalidate);
    signal.addEventListener('abort', onAbort);
    if (signal.aborted) {
      cleanup();
      return;
    }

    try {
      while (!signal.aborted) {
        if (!changed) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
          continue;
        }

        if (!immediate && !timerFired && throttleMs > 0) {
          const remainingMs = lastEmitAt + throttleMs - now();
          if (remainingMs > 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
              clearTimer();
              timer = setTimeout(() => {
                timer = undefined;
                timerFired = true;
                triggerWake();
              }, Math.ceil(remainingMs));
            });
            clearTimer();
            wake = undefined;
            continue;
          }
        }

        changed = false;
        immediate = false;
        timerFired = false;
        emittedRevision = currentRevision;
        lastEmitAt = now();
        yield runtime.panelModel();
      }
    } finally {
      cleanup();
    }
  };

  return Object.assign(source, {
    revision: () => currentRevision,
    invalidate: (sinceRevision?: number) => {
      for (const sub of [...subscribers]) {
        sub(sinceRevision);
      }
    },
  });
}
