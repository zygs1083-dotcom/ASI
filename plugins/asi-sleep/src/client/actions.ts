import type { RemoteResult, TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol';
import type {} from 'asi-sleep/remote';
import type { SleepPanelActions } from './SleepPanel.js';

type Api = Pick<
  TypertRemoteNamespaceMap['asiSleep'],
  'consolidateNow' | 'setAutoSleepPaused' | 'createMemory' | 'updateMemory' | 'togglePin' | 'deleteMemory'
>;

export function createSleepActions(api: Api) {
  let failed = false;
  let closed = false;
  const listeners = new Set<() => void>();
  const publish = (value: boolean) => {
    if (closed || value === failed) return;
    failed = value;
    for (const listener of [...listeners]) listener();
  };

  const complete = async <T>(call: () => Promise<RemoteResult<T>>): Promise<T> => {
    try {
      const res = await call();
      if (!res.ok) throw res.error;
      publish(false);
      return res.value;
    } catch (err) {
      publish(true);
      if (err instanceof Error && err.message.trim()) throw err;
      if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string' && err.message.trim()) {
        throw new Error(err.message);
      }
      throw new Error('操作失败，请重试。');
    }
  };

  const actions: SleepPanelActions = {
    onConsolidateNow: () => complete(() => api.consolidateNow()),
    onToggleAutoSleepPaused: (paused) => complete(() => api.setAutoSleepPaused(paused)),
    onCreateMemory: (input) => complete(() => api.createMemory(input)),
    onUpdateMemory: (id, patch) => complete(() => api.updateMemory(id, patch)),
    onTogglePin: (id, pinned) => complete(() => api.togglePin(id, pinned)),
    onDeleteMemory: (id) => complete(() => api.deleteMemory(id)),
  };

  return {
    actions,
    clear: () => publish(false),
    getSnapshot: () => failed,
    subscribe(listener: () => void) {
      if (!closed) listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      closed = true;
      listeners.clear();
    },
  };
}
