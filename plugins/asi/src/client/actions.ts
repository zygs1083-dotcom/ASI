import type { RemoteResult, TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol';
import type {} from 'asi/remote';
import type { AsiPanelActions } from './AsiPanel.tsx';

type Api = Omit<TypertRemoteNamespaceMap['asi'], 'frames'>;

export function createAsiActions(api: Api, onNavigateSession?: (sessionId: string) => void) {
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
      const message = typeof err === 'string' ? err.trim() : '';
      throw new Error(message || '操作失败，请重试。');
    }
  };

  const actions: AsiPanelActions = {
    onPause: (paused) => complete(() => api.pause(paused)),
    onToggleTitles: (enabled) => complete(() => api.setSendTitles(enabled)),
    onOpenPermissionSettings: () => complete(() => api.openPermissionSettings()),
    onApproveHelp: (cardId) => complete(() => api.approveHelp(cardId)),
    onDismissHelp: (cardId) => complete(() => api.dismissHelp(cardId)),
    onOpenMaintenanceSession: async () => {
      const sessionId = await complete(() => api.openMaintenanceSession());
      onNavigateSession?.(sessionId);
    },
    onTriggerCheck: () => complete(() => api.triggerCheck()),

    onConsolidateNow: () => complete(() => api.consolidateNow()),
    onToggleAutoSleepPaused: (paused) => complete(() => api.setAutoSleepPaused(paused)),
    onCreateMemory: (input) => complete(() => api.createMemory(input)),
    onUpdateMemory: (id, patch) => complete(() => api.updateMemory(id, patch)),
    onTogglePin: (id, pinned) => complete(() => api.togglePin(id, pinned)),
    onDeleteMemory: (id) => complete(() => api.deleteMemory(id)),
    onSearchMemories: (query, kind) => complete(() => api.searchMemories(query, kind)),

    onSynthesizeNow: () => complete(() => api.synthesizeNow()),
    onToggleAutoGrowthPaused: (paused) => complete(() => api.setAutoGrowthPaused(paused)),
    onCreateManualDraft: (input) => complete(() => api.createManualDraft(input)),
    onUpdateDraft: (draftId, patch) => complete(() => api.updateDraft(draftId, patch)),
    onApproveDraft: (draftId) => complete(() => api.approveDraft(draftId)),
    onRejectDraft: (draftId) => complete(() => api.rejectDraft(draftId)),
    onUpdateSkill: (name, patch) => complete(() => api.updateSkill(name, patch)),
    onSetSkillScope: (name, input) => complete(() => api.setSkillScope(name, input)),
    onSetSkillEnabled: (name, enabled) => complete(() => api.setSkillEnabled(name, enabled)),
    onArchiveSkill: (name) => complete(() => api.archiveSkill(name)),
    onRestoreSkill: (name) => complete(() => api.restoreSkill(name)),
    onDeleteArchivedSkill: (name) => complete(() => api.deleteArchivedSkill(name)),
    onExportSkillToWorkspace: (name, ws) => complete(() => api.exportSkillToWorkspace(name, ws)),
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
