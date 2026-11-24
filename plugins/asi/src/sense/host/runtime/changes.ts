import type { SenseSnapshot, SenseState } from '@asi/sense-types';
import type { SenseActions } from './ports.ts';

export function createStateListeners() {
  const listeners = new Set<(state: SenseState) => void>();
  return {
    notify(state: SenseState) {
      for (const listener of listeners) {
        try {
          listener(structuredClone(state));
        } catch {}
      }
    },
    subscribe(listener: (state: SenseState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear: () => listeners.clear(),
  };
}

export function createSnapshotListeners() {
  const listeners = new Set<(snapshot: SenseSnapshot) => void>();
  return {
    get size(): number {
      return listeners.size;
    },
    notify(snapshot: SenseSnapshot) {
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue;
        try {
          listener(structuredClone(snapshot));
        } catch {}
      }
    },
    subscribe(listener: (snapshot: SenseSnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear: () => listeners.clear(),
  };
}

export async function settleShutdown(work: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(work);
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (errors.length === 1) throw errors[0]?.reason;
  if (errors.length > 1)
    throw new AggregateError(
      errors.map((result) => result.reason),
      'runtime shutdown failed',
    );
}

export function createChanges() {
  const listeners = new Set<() => void>();
  let pending = false;
  let dirty = false;
  let depth = 0;
  const schedule = () => {
    if (pending || depth || !dirty) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      if (depth || !dirty) return;
      dirty = false;
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue;
        try {
          listener();
        } catch {}
      }
    });
  };
  return {
    changed() {
      dirty = true;
      schedule();
    },
    async batch<T>(work: () => T | Promise<T>): Promise<T> {
      depth++;
      try {
        return await work();
      } finally {
        depth--;
        schedule();
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      listeners.clear();
      dirty = false;
    },
  };
}

export function observableActions(actions: SenseActions, changed: () => void): SenseActions {
  const publish = <T>(task: Promise<T>): Promise<T> => task.finally(changed);
  return {
    pause: (value) => publish(actions.pause(value)),
    setSendTitles: (value) => publish(actions.setSendTitles(value)),
    setPowerMode: (mode, reason) => publish(actions.setPowerMode(mode, reason)),
    openPermissionSettings: () => publish(actions.openPermissionSettings()),
  };
}
