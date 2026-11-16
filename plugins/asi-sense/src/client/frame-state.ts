export type FrameSnapshot<T> =
  | { status: 'connecting' }
  | { status: 'live'; value: T }
  | { status: 'ended' | 'failed'; value?: T };

export interface FrameStream<T> extends AsyncIterable<T> {
  dispose(): void;
}

export function createFrameState<T>(stream: FrameStream<T>) {
  let snapshot: FrameSnapshot<T> = { status: 'connecting' };
  let closed = false;
  let closing: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: FrameSnapshot<T>) => {
    if (closed) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  const terminal = (status: 'ended' | 'failed'): FrameSnapshot<T> =>
    snapshot.status === 'live' ? { status, value: snapshot.value } : { status };
  const pump = (async () => {
    try {
      for await (const value of stream) publish({ status: 'live', value });
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
        stream.dispose();
        closing = pump;
      }
      return closing;
    },
  };
}
