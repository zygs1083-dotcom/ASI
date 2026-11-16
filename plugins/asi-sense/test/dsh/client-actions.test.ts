import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
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

  it.each([
    ['resumeTuning', 'onResumeTuning'],
    ['resetTuning', 'onResetTuning'],
    ['acceptRebaseline', 'onAcceptRebaseline'],
  ] as const)('awaits %s and reports failures without setting the global error', async (method, callback) => {
    const { api, controller } = fixture();
    const invoke = () =>
      callback === 'onAcceptRebaseline' ? controller.actions[callback]('baseline') : controller.actions[callback]();
    await expect(invoke()).resolves.toBeUndefined();
    expect(api[method]).toHaveBeenCalledWith(...(method === 'acceptRebaseline' ? ['baseline'] : []));
    api[method].mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('gateway/bad-request', 'fixture failure', {}),
    });
    await expect(invoke()).rejects.toThrow('fixture failure');
    api[method].mockRejectedValueOnce(new Error('transport failure'));
    await expect(invoke()).rejects.toThrow('transport failure');
    api[method].mockRejectedValueOnce(undefined);
    await expect(invoke()).rejects.toThrow();
    expect(controller.getSnapshot()).toBe(false);
    controller.dispose();
  });

  it('keeps a dangerous callback pending until the remote settles', async () => {
    const { api, controller } = fixture();
    let complete!: (result: { ok: true; value: undefined }) => void;
    api.resumeTuning.mockReturnValueOnce(new Promise((resolve) => (complete = resolve)));
    const done = vi.fn();
    const pending = controller.actions.onResumeTuning().then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    complete({ ok: true, value: undefined });
    await pending;
    expect(done).toHaveBeenCalledOnce();
    controller.dispose();
  });
});
