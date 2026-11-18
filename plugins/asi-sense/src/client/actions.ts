import type { SensePanelProps } from '@asi/sense-ui/model';
import type { RemoteResult, TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol';
import type {} from 'asi-sense/remote';

type Api = Pick<
  TypertRemoteNamespaceMap['asiSense'],
  | 'selectTarget'
  | 'dismissTargetNotice'
  | 'toggleRule'
  | 'confirmRule'
  | 'deleteRule'
  | 'pause'
  | 'setSendTitles'
  | 'setGlobalFileWatch'
  | 'retryGlobalFileWatch'
  | 'addFileExclusion'
  | 'removeFileExclusion'
  | 'openPermissionSettings'
  | 'revertTuning'
  | 'lockParam'
  | 'feedback'
  | 'resumeTuning'
  | 'resetTuning'
  | 'retryTuningBackup'
  | 'dismissTuningBackup'
  | 'acceptRebaseline'
>;
type Actions = Omit<SensePanelProps, 'model'>;

export function createActions(api: Api) {
  let failed = false;
  let closed = false;
  const listeners = new Set<() => void>();
  const publish = (value: boolean) => {
    if (closed || value === failed) return;
    failed = value;
    for (const listener of [...listeners]) listener();
  };
  const fire = (promise: Promise<RemoteResult<void>>) => {
    void promise.then(
      (result) => {
        if (!result.ok) publish(true);
      },
      () => publish(true),
    );
  };
  const complete = async (action: () => Promise<RemoteResult<void>>) => {
    try {
      const result = await action();
      if (!result.ok) throw result.error;
    } catch (error) {
      if (error instanceof Error && error.message.trim()) throw error;
      if (
        error &&
        typeof error === 'object' &&
        'message' in error &&
        typeof error.message === 'string' &&
        error.message.trim()
      ) {
        throw new Error(error.message);
      }
      const message = typeof error === 'string' ? error.trim() : '';
      throw new Error(message || '操作失败，请重试。');
    }
  };
  const actions: Actions = {
    onSelectTarget: (id) => complete(() => api.selectTarget(id ?? '')),
    onDismissTargetNotice: () => complete(() => api.dismissTargetNotice()),
    onToggleRule: (id, enabled) => fire(api.toggleRule(id, enabled)),
    onConfirmRule: (id) => fire(api.confirmRule(id)),
    onDeleteRule: (id) => fire(api.deleteRule(id)),
    onPause: (paused) => fire(api.pause(paused)),
    onToggleTitles: (enabled) => fire(api.setSendTitles(enabled)),
    onToggleGlobalFileWatch: (enabled) => fire(api.setGlobalFileWatch(enabled)),
    onRetryGlobalFileWatch: () => complete(() => api.retryGlobalFileWatch()),
    onAddFileExclusion: (pattern) => complete(() => api.addFileExclusion(pattern)),
    onRemoveFileExclusion: (pattern) => complete(() => api.removeFileExclusion(pattern)),
    onOpenPermissionSettings: () => fire(api.openPermissionSettings()),
    onRevertTuning: (id) => fire(api.revertTuning(id)),
    onLockParam: (param, locked) => fire(api.lockParam(param, locked)),
    onFeedback: (id, verdict) => fire(api.feedback(id, verdict)),
    onResumeTuning: () => complete(() => api.resumeTuning()),
    onResetTuning: () => complete(() => api.resetTuning()),
    onRetryTuningBackup: () => complete(() => api.retryTuningBackup()),
    onDismissTuningBackup: () => complete(() => api.dismissTuningBackup()),
    onAcceptRebaseline: (id) => complete(() => api.acceptRebaseline(id)),
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
