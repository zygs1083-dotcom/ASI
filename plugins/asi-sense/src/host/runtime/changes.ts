import type { WatchRule } from '@asi/sense-types';
import type { Tuner } from '../body/tuner.ts';
import type { RuntimeAttention } from './attention.ts';
import type { SenseActions, TuneRequest } from './ports.ts';
import type { Settings } from './settings.ts';

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

export function watchTool(settings: Settings, actions: SenseActions, sync: () => Promise<void>, changed: () => void) {
  return async (request: {
    action: 'list' | 'add' | 'remove';
    rule?: Omit<WatchRule, 'approved' | 'createdBy'>;
    id?: string;
  }) => {
    if ('param' in request) throw new Error('unsupported-param');
    if (request.action === 'list') return settings.list();
    if (request.action === 'add' && request.rule) {
      await settings.add(request.rule);
      await sync();
      changed();
      return settings.list();
    }
    if (request.action === 'remove' && request.id) {
      const rule = settings.list().find((item) => item.id === request.id);
      if (rule?.createdBy !== 'agent') throw new Error('only agent rules can be removed');
      await actions.deleteRule(request.id);
      return settings.list();
    }
    throw new TypeError('invalid env_watch request');
  };
}

export function tuningTool(tuner: Tuner, attention: RuntimeAttention, changed: () => void) {
  return (request: TuneRequest) => {
    const operation =
      'action' in request
        ? tuner.feedback(request.alertId, request.verdict).then((result) => {
            if (result.applied) attention.feedback(request.alertId, request.verdict);
            return result;
          })
        : tuner.get(request.param) === undefined
          ? Promise.reject(new Error('unsupported-param'))
          : tuner.propose(request);
    return operation.finally(changed);
  };
}
