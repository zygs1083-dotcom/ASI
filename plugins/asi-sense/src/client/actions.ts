import type { SensePanelProps } from '@asi/sense-ui/model';
import type { RemoteResult, TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol';
import type {} from 'asi-sense/remote';

type Api = Pick<
  TypertRemoteNamespaceMap['asiSense'],
  | 'toggleRule'
  | 'confirmRule'
  | 'deleteRule'
  | 'pause'
  | 'setSendTitles'
  | 'openPermissionSettings'
  | 'revertTuning'
  | 'lockParam'
  | 'feedback'
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
  // TODO: connect the three deferred dangerous operations after client approval.
  const unavailable = async () => {
    throw new Error('This operation is not available in the sidebar yet');
  };
  const actions: Actions = {
    onToggleRule: (id, enabled) => fire(api.toggleRule(id, enabled)),
    onConfirmRule: (id) => fire(api.confirmRule(id)),
    onDeleteRule: (id) => fire(api.deleteRule(id)),
    onPause: (paused) => fire(api.pause(paused)),
    onToggleTitles: (enabled) => fire(api.setSendTitles(enabled)),
    onOpenPermissionSettings: () => fire(api.openPermissionSettings()),
    onRevertTuning: (id) => fire(api.revertTuning(id)),
    onLockParam: (param, locked) => fire(api.lockParam(param, locked)),
    onFeedback: (id, verdict) => fire(api.feedback(id, verdict)),
    onResumeTuning: unavailable,
    onResetTuning: unavailable,
    onAcceptRebaseline: unavailable,
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
