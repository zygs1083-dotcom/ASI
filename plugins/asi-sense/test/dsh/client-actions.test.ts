import { describe, expect, it, vi } from 'vitest';
import { createActions } from '../../src/client/actions.ts';

function fixture() {
  const method = () => vi.fn().mockResolvedValue({ ok: true, value: undefined });
  const api = {
    toggleRule: method(),
    confirmRule: method(),
    deleteRule: method(),
    pause: method(),
    setSendTitles: method(),
    openPermissionSettings: method(),
    revertTuning: method(),
    lockParam: method(),
    feedback: method(),
    resumeTuning: method(),
    resetTuning: method(),
    acceptRebaseline: method(),
  };
  return { api, controller: createActions(api) };
}

describe('sidebar action boundary', () => {
  it('routes existing callbacks through the matching Remote methods', async () => {
    const { api, controller } = fixture();
    const a = controller.actions;
    a.onToggleRule('rule', false);
    a.onConfirmRule('rule');
    a.onDeleteRule('rule');
    a.onPause(true);
    a.onToggleTitles(false);
    a.onOpenPermissionSettings();
    a.onRevertTuning('change');
    a.onLockParam('rate.cpu', true);
    a.onFeedback('signal', 'noise');
    await Promise.resolve();
    expect(api.toggleRule).toHaveBeenCalledWith('rule', false);
    expect(api.confirmRule).toHaveBeenCalledWith('rule');
    expect(api.deleteRule).toHaveBeenCalledWith('rule');
    expect(api.pause).toHaveBeenCalledWith(true);
    expect(api.setSendTitles).toHaveBeenCalledWith(false);
    expect(api.openPermissionSettings).toHaveBeenCalledOnce();
    expect(api.revertTuning).toHaveBeenCalledWith('change');
    expect(api.lockParam).toHaveBeenCalledWith('rate.cpu', true);
    expect(api.feedback).toHaveBeenCalledWith('signal', 'noise');
    expect(controller.getSnapshot()).toBe(false);
    controller.dispose();
  });

  it('keeps failed actions visible until dismissed and stops updates on disposal', async () => {
    const { api, controller } = fixture();
    const listener = vi.fn();
    controller.subscribe(listener);
    api.pause.mockResolvedValueOnce({ ok: false, error: { code: 'gateway/bad-request', message: 'fixture' } });
    controller.actions.onPause(true);
    await vi.waitFor(() => expect(controller.getSnapshot()).toBe(true));
    controller.actions.onToggleTitles(false);
    await Promise.resolve();
    expect(controller.getSnapshot()).toBe(true);
    controller.clear();
    expect(controller.getSnapshot()).toBe(false);
    controller.dispose();
    api.pause.mockRejectedValueOnce(new Error('fixture'));
    controller.actions.onPause(true);
    await Promise.resolve();
    expect(controller.getSnapshot()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('rejects the three explicitly deferred dangerous actions without claiming success', async () => {
    const { api, controller } = fixture();
    await expect(controller.actions.onResumeTuning()).rejects.toThrow('not available');
    await expect(controller.actions.onResetTuning()).rejects.toThrow('not available');
    await expect(controller.actions.onAcceptRebaseline('baseline')).rejects.toThrow('not available');
    expect(api.resumeTuning).not.toHaveBeenCalled();
    expect(api.resetTuning).not.toHaveBeenCalled();
    expect(api.acceptRebaseline).not.toHaveBeenCalled();
    controller.dispose();
  });
});
