import type { NeedsPanelModel } from '@asi/sense-ui';
import type { AsiPanelModel } from '../host/dsh/wire-types.js';

export function stalePanelModel(model: NeedsPanelModel): NeedsPanelModel {
  const stale = <T>(value: T): T =>
    value && typeof value === 'object' && 'status' in value && value.status === 'ok'
      ? { ...value, status: 'stale' }
      : value;
  const group = <T extends object>(value: T): T =>
    Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stale(item)])) as T;
  const { self, env, observation } = model.state;
  const body = group(self.body);
  const disks = body.disks;
  return {
    ...model,
    state: {
      self: {
        ...group(self),
        body: { ...body, disks: { ...disks, value: disks.value?.map(stale) ?? null } },
      },
      env: { ...group(env), where: group(env.where) },
      observation: { ...observation, sources: group(observation.sources) },
    },
  };
}

export function staleAsiPanelModel(model: AsiPanelModel): AsiPanelModel {
  return {
    needs: stalePanelModel(model.needs),
    sleep: { ...model.sleep, stale: true },
    growth: { ...model.growth, stale: true },
    intuition: { ...model.intuition, stale: true },
    tom: { ...model.tom, stale: true },
    dream: { ...model.dream, stale: true },
  };
}

export type FrameSnapshot<T> =
  | { status: 'connecting' }
  | { status: 'live'; value: T }
  | { status: 'reconnecting' | 'ended' | 'failed'; value?: T };

export interface FrameStream<T> extends AsyncIterable<{ value: T; accept(): void }> {
  dispose(): void | Promise<void>;
}

export interface FrameStateOptions {
  /** Exponential backoff schedule (ms) before showing `'failed'`. Defaults to `[500, 1000, 2000, 4000, 5000]`. */
  retryDelaysMs?: readonly number[];
  /** Gentle background self-heal interval (ms) even after entering `'failed'`. Defaults to `8000`. */
  backgroundRetryMs?: number;
}

const DEFAULT_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 5000] as const;
const DEFAULT_BACKGROUND_RETRY_MS = 8_000;

export function createFrameState<T>(open: (disconnected: () => void) => FrameStream<T>, options?: FrameStateOptions) {
  const retryDelays = options?.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const backgroundRetryMs = options?.backgroundRetryMs ?? DEFAULT_BACKGROUND_RETRY_MS;

  let snapshot: FrameSnapshot<T> = { status: 'connecting' };
  let closed = false;
  let closing: Promise<void> | undefined;
  let activeStream: FrameStream<T> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeRetry: (() => void) | undefined;
  const listeners = new Set<() => void>();

  const publish = (next: FrameSnapshot<T>) => {
    if (closed) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  const withCached = (status: 'reconnecting' | 'ended' | 'failed'): FrameSnapshot<T> =>
    'value' in snapshot && snapshot.value !== undefined ? { status, value: snapshot.value } : { status };

  const clearRetryTimer = () => {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    const wake = wakeRetry;
    wakeRetry = undefined;
    wake?.();
  };

  const waitBackoff = (delayMs: number) =>
    new Promise<void>((resolve) => {
      if (closed) {
        resolve();
        return;
      }
      wakeRetry = resolve;
      retryTimer = setTimeout(
        () => {
          retryTimer = undefined;
          const wake = wakeRetry;
          wakeRetry = undefined;
          wake?.();
        },
        Math.max(0, delayMs),
      );
    });

  const pump = (async () => {
    let consecutiveFailures = 0;

    while (!closed) {
      let stream: FrameStream<T>;
      try {
        stream = open(() => publish(withCached('reconnecting')));
      } catch {
        consecutiveFailures += 1;
        if (consecutiveFailures > retryDelays.length) {
          publish(withCached('failed'));
        } else if ('value' in snapshot && snapshot.value !== undefined) {
          publish(withCached('reconnecting'));
        }
        const delay = retryDelays[consecutiveFailures - 1] ?? backgroundRetryMs;
        await waitBackoff(delay);
        continue;
      }

      activeStream = stream;
      let receivedFrame = false;

      try {
        for await (const item of stream) {
          if (closed) break;
          receivedFrame = true;
          consecutiveFailures = 0;
          publish({ status: 'live', value: item.value });
          if (!closed) item.accept();
        }
        if (closed) break;
        // Stream ended cleanly on host restart/reload -> self-heal automatically instead of getting stuck
        consecutiveFailures += 1;
        publish(
          consecutiveFailures > retryDelays.length
            ? withCached('ended')
            : receivedFrame || ('value' in snapshot && snapshot.value !== undefined)
              ? withCached('reconnecting')
              : { status: 'connecting' },
        );
      } catch {
        if (closed) break;
        consecutiveFailures += 1;
        publish(
          consecutiveFailures > retryDelays.length
            ? withCached('failed')
            : receivedFrame || ('value' in snapshot && snapshot.value !== undefined)
              ? withCached('reconnecting')
              : { status: 'connecting' },
        );
      } finally {
        if (activeStream === stream) activeStream = undefined;
        await Promise.resolve(stream.dispose()).catch(() => undefined);
      }

      if (closed) break;
      const delay = retryDelays[consecutiveFailures - 1] ?? backgroundRetryMs;
      await waitBackoff(delay);
    }
  })();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (!closed) listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reconnect() {
      if (closed) return;
      publish(
        'value' in snapshot && snapshot.value !== undefined ? withCached('reconnecting') : { status: 'connecting' },
      );
      const current = activeStream;
      if (current) {
        void Promise.resolve(current.dispose()).catch(() => undefined);
      }
      clearRetryTimer();
    },
    dispose() {
      if (!closing) {
        closed = true;
        listeners.clear();
        clearRetryTimer();
        closing = Promise.resolve(activeStream?.dispose())
          .catch(() => undefined)
          .then(() => pump);
      }
      return closing;
    },
  };
}
