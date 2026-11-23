import type { SleepPanelModel } from '../shared/types.js';

export function staleSleepPanelModel(model: SleepPanelModel): SleepPanelModel {
  return {
    ...model,
    stale: true,
  };
}

export type FrameSnapshot<T> =
  | { status: 'connecting' }
  | { status: 'live'; value: T }
  | { status: 'reconnecting' | 'ended' | 'failed'; value?: T };

export interface FrameStream<T> extends AsyncIterable<{ value: T; accept(): void }> {
  dispose(): void | Promise<void>;
}

export function createFrameState<T>(open: (disconnected: () => void) => FrameStream<T>) {
  let snapshot: FrameSnapshot<T> = { status: 'connecting' };
  let closed = false;
  let closing: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: FrameSnapshot<T>) => {
    if (closed) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  const terminal = (status: 'reconnecting' | 'ended' | 'failed'): FrameSnapshot<T> =>
    'value' in snapshot && snapshot.value !== undefined ? { status, value: snapshot.value } : { status };
  const stream = open(() => publish(terminal('reconnecting')));
  const pump = (async () => {
    try {
      for await (const item of stream) {
        publish({ status: 'live', value: item.value });
        if (!closed) item.accept();
      }
      publish(terminal('ended'));
    } catch {
      publish(terminal('failed'));
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
    dispose() {
      if (!closing) {
        closed = true;
        listeners.clear();
        closing = Promise.resolve(stream.dispose()).then(() => pump);
      }
      return closing;
    },
  };
}
