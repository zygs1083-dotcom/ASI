import { Context } from '@deepseek-ai/cordis';
import { RemoteError, remoteMethods } from '@deepseek-ai/dsh-typert-protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { FramesSource } from '../../src/host/dsh/frames.ts';
import { AsiSenseRemote } from '../../src/host/dsh/remote.ts';
import type { SenseActions } from '../../src/host/runtime/ports.ts';

function fixture() {
  const ctx = new Context();
  onTestFinished(() => ctx.fiber.dispose());
  const actions: SenseActions = {
    toggleRule: vi.fn(async () => {}),
    confirmRule: vi.fn(async () => {}),
    deleteRule: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    setSendTitles: vi.fn(async () => {}),
    setGlobalFileWatch: vi.fn(async () => {}),
    retryGlobalFileWatch: vi.fn(async () => {}),
    addFileExclusion: vi.fn(async () => {}),
    removeFileExclusion: vi.fn(async () => {}),
    openPermissionSettings: vi.fn(async () => {}),
    revertTuning: vi.fn(async () => ({ applied: true })),
    lockParam: vi.fn(async () => ({ applied: true })),
    feedback: vi.fn(async () => ({ applied: true })),
    acceptRebaseline: vi.fn(async () => ({ applied: true })),
    resumeTuning: vi.fn(async () => {}),
    resetTuning: vi.fn(async () => {}),
    retryTuningBackup: vi.fn(async () => {}),
    dismissTuningBackup: vi.fn(async () => {}),
  };
  const invalidate = vi.fn();
  const frames: FramesSource = Object.assign(async function* () {}, { invalidate });
  return { actions, invalidate, remote: new AsiSenseRemote(ctx, actions, frames) };
}

describe('DSH remote service', () => {
  it('exposes a frame stream and user action endpoints', async () => {
    const { remote, actions, invalidate } = fixture();
    expect(remoteMethods(remote)).toContainEqual(expect.objectContaining({ method: 'frames', mode: 'stream' }));
    await remote.toggleRule('rule', false);
    await remote.confirmRule('rule');
    await remote.pause(true);
    await remote.setSendTitles(false);
    expect(actions.toggleRule).toHaveBeenCalledWith('rule', false);
    expect(actions.confirmRule).toHaveBeenCalledWith('rule');
    expect(actions.pause).toHaveBeenCalledWith(true);
    expect(actions.setSendTitles).toHaveBeenCalledWith(false);
    expect(invalidate).toHaveBeenCalledTimes(4);
  });

  it('propagates refused or failed dangerous actions rather than claiming success', async () => {
    const { remote, actions, invalidate } = fixture();
    vi.mocked(actions.revertTuning).mockResolvedValueOnce({ applied: false, reason: 'stale change' });
    await expect(remote.revertTuning('change')).rejects.toThrow('stale change');
    vi.mocked(actions.resetTuning).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(remote.resetTuning()).rejects.toThrow('storage unavailable');
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, null, '', '   ', 1, {}])(
    'rejects invalid rebaseline id %s at the remote boundary',
    async (id) => {
      const { remote, actions } = fixture();
      await expect(Reflect.apply(remote.acceptRebaseline, remote, [id])).rejects.toThrow();
      expect(actions.acceptRebaseline).not.toHaveBeenCalled();
    },
  );

  it('waits for rebaseline persistence before returning and surfaces failures', async () => {
    const { remote, actions, invalidate } = fixture();
    let complete!: (result: { applied: true }) => void;
    vi.mocked(actions.acceptRebaseline).mockReturnValueOnce(new Promise((resolve) => (complete = resolve)));
    const done = vi.fn();
    const pending = remote.acceptRebaseline('baseline').then(done);
    await Promise.resolve();
    expect(actions.acceptRebaseline).toHaveBeenCalledWith('baseline');
    expect(done).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    complete({ applied: true });
    await pending;
    expect(done).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledOnce();
    vi.mocked(actions.acceptRebaseline).mockResolvedValueOnce({ applied: false, reason: 'stale suggestion' });
    await expect(remote.acceptRebaseline('baseline')).rejects.toThrow('stale suggestion');
    vi.mocked(actions.acceptRebaseline).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(remote.acceptRebaseline('baseline')).rejects.toThrow('storage unavailable');
    expect(invalidate).toHaveBeenCalledTimes(3);
  });

  it('validates and forwards global file watch toggle and exclusion endpoints', async () => {
    const { remote, actions, invalidate } = fixture();
    await expect(Reflect.apply(remote.setGlobalFileWatch, remote, ['yes'])).rejects.toThrow();
    expect(actions.setGlobalFileWatch).not.toHaveBeenCalled();
    for (const bad of [undefined, null, '', '   ', 42]) {
      await expect(Reflect.apply(remote.addFileExclusion, remote, [bad])).rejects.toThrow();
      await expect(Reflect.apply(remote.removeFileExclusion, remote, [bad])).rejects.toThrow();
    }
    expect(actions.addFileExclusion).not.toHaveBeenCalled();
    expect(actions.removeFileExclusion).not.toHaveBeenCalled();

    invalidate.mockClear();
    await remote.setGlobalFileWatch(false);
    await remote.retryGlobalFileWatch();
    await remote.addFileExclusion('~/custom-cache');
    await remote.removeFileExclusion('~/custom-cache');
    expect(actions.setGlobalFileWatch).toHaveBeenCalledWith(false);
    expect(actions.retryGlobalFileWatch).toHaveBeenCalledOnce();
    expect(actions.addFileExclusion).toHaveBeenCalledWith('~/custom-cache');
    expect(actions.removeFileExclusion).toHaveBeenCalledWith('~/custom-cache');
    expect(invalidate).toHaveBeenCalledTimes(4);
  });

  it('rejects relative, root, home-root, and oversized exclusions with RemoteError', async () => {
    const { remote, actions } = fixture();
    for (const bad of ['./secret', '../secret', 'foo/bar', '/', '///', '~', '~/', '.'.repeat(1025)]) {
      await expect(remote.addFileExclusion(bad)).rejects.toBeInstanceOf(RemoteError);
      await expect(remote.removeFileExclusion(bad)).rejects.toBeInstanceOf(RemoteError);
    }
    expect(actions.addFileExclusion).not.toHaveBeenCalled();
    expect(actions.removeFileExclusion).not.toHaveBeenCalled();
  });
});
