import { Context } from '@deepseek-ai/cordis';
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol';
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
    openPermissionSettings: vi.fn(async () => {}),
    revertTuning: vi.fn(async () => ({ applied: true })),
    lockParam: vi.fn(async () => ({ applied: true })),
    feedback: vi.fn(async () => ({ applied: true })),
    acceptRebaseline: vi.fn(async () => ({ applied: true })),
    resumeTuning: vi.fn(async () => {}),
    resetTuning: vi.fn(async () => {}),
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
});
