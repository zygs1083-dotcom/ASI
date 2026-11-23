import type { NeedsPanelProps } from '@asi/sense-ui/model';
import type { RemoteResult, TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol';
import type {} from 'asi-needs/remote';

type Api = Pick<
  TypertRemoteNamespaceMap['asiNeeds'],
  | 'pause'
  | 'setSendTitles'
  | 'openPermissionSettings'
  | 'approveHelp'
  | 'dismissHelp'
  | 'openMaintenanceSession'
  | 'triggerCheck'
>;
type Actions = Omit<NeedsPanelProps, 'model'>;

export function createActions(api: Api, onNavigateSession?: (sessionId: string) => void) {
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
  const complete = async <T>(action: () => Promise<RemoteResult<T>>): Promise<T> => {
    try {
      const result = await action();
      if (!result.ok) throw result.error;
      return result.value;
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
    onPause: (paused) => fire(api.pause(paused)),
    onToggleTitles: (enabled) => fire(api.setSendTitles(enabled)),
    onOpenPermissionSettings: () => fire(api.openPermissionSettings()),
    onApproveHelp: (id) => complete(() => api.approveHelp(id)),
    onDismissHelp: (id) => complete(() => api.dismissHelp(id)),
    onOpenMaintenanceSession: async () => {
      const sessionId = await complete(() => api.openMaintenanceSession());
      onNavigateSession?.(sessionId);
    },
    onTriggerCheck: () => complete(() => api.triggerCheck()),
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
