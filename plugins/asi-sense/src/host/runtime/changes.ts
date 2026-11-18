import type { SenseState } from '@asi/sense-types';
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
    selectTarget: (id) => publish(actions.selectTarget?.(id) ?? Promise.reject(new Error('target unavailable'))),
    dismissTargetNotice: () => publish(actions.dismissTargetNotice?.() ?? Promise.resolve()),
    toggleRule: (id, enabled) => publish(actions.toggleRule(id, enabled)),
    confirmRule: (id) => publish(actions.confirmRule(id)),
    deleteRule: (id) => publish(actions.deleteRule(id)),
    pause: (value) => publish(actions.pause(value)),
    setSendTitles: (value) => publish(actions.setSendTitles(value)),
    setGlobalFileWatch: (value) =>
      publish(actions.setGlobalFileWatch?.(value) ?? Promise.reject(new Error('globalFileWatch unavailable'))),
    addFileExclusion: (pattern) =>
      publish(actions.addFileExclusion?.(pattern) ?? Promise.reject(new Error('addFileExclusion unavailable'))),
    removeFileExclusion: (pattern) =>
      publish(actions.removeFileExclusion?.(pattern) ?? Promise.reject(new Error('removeFileExclusion unavailable'))),
    openPermissionSettings: () => publish(actions.openPermissionSettings()),
    revertTuning: (id) => publish(actions.revertTuning(id)),
    lockParam: (param, locked) => publish(actions.lockParam(param, locked)),
    feedback: (id, verdict) => publish(actions.feedback(id, verdict)),
    acceptRebaseline: (id) => publish(actions.acceptRebaseline(id)),
    resumeTuning: () => publish(actions.resumeTuning()),
    resetTuning: () => publish(actions.resetTuning()),
    retryTuningBackup: () => publish(actions.retryTuningBackup()),
    dismissTuningBackup: () => publish(actions.dismissTuningBackup()),
  };
}
