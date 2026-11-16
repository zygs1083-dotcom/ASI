import type { SenseActions } from './ports.ts';

export function createChanges() {
  const listeners = new Set<() => void>();
  let pending = false;
  return {
    changed() {
      if (pending) return;
      pending = true;
      queueMicrotask(() => {
        pending = false;
        for (const listener of [...listeners]) {
          if (!listeners.has(listener)) continue;
          try {
            listener();
          } catch {}
        }
      });
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      listeners.clear();
    },
  };
}

export function observableActions(actions: SenseActions, changed: () => void): SenseActions {
  const publish = <T>(task: Promise<T>): Promise<T> => task.finally(changed);
  return {
    toggleRule: (id, enabled) => publish(actions.toggleRule(id, enabled)),
    confirmRule: (id) => publish(actions.confirmRule(id)),
    deleteRule: (id) => publish(actions.deleteRule(id)),
    pause: (value) => publish(actions.pause(value)),
    setSendTitles: (value) => publish(actions.setSendTitles(value)),
    openPermissionSettings: () => publish(actions.openPermissionSettings()),
    revertTuning: (id) => publish(actions.revertTuning(id)),
    lockParam: (param, locked) => publish(actions.lockParam(param, locked)),
    feedback: (id, verdict) => publish(actions.feedback(id, verdict)),
    acceptRebaseline: (id) => publish(actions.acceptRebaseline(id)),
    resumeTuning: () => publish(actions.resumeTuning()),
    resetTuning: () => publish(actions.resetTuning()),
  };
}
