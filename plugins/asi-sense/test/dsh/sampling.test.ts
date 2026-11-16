import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import { apply } from '../../src/host/dsh/index.ts';
import { createPresenter } from '../../src/host/presenter/index.ts';

vi.mock('../../src/host/dsh/local-ports.ts', () => ({
  localPorts: () => ({ clock: { wall: () => 0, mono: () => 0 } }),
}));
vi.mock('../../src/host/dsh/port.ts', () => ({ createDshPort: () => ({}) }));
vi.mock('../../src/host/runtime/index.ts', () => ({
  createSenseRuntime: () => ({
    start: async () => {},
    stop: async () => {},
    actions: {},
    rules: { settings: () => ({ sendTitles: false }) },
  }),
}));
vi.mock('../../src/host/presenter/index.ts', () => ({
  createPresenter: vi.fn(() => ({ close: () => {}, frames: () => ({}) })),
}));
vi.mock('../../src/host/dsh/remote.ts', () => ({ AsiSenseRemote: class {} }));
vi.mock('../../src/host/dsh/tools.ts', () => ({ registerSenseTools: () => () => {} }));

describe('DSH sampling intervals', () => {
  it('passes the helper thermal heartbeat to the presenter', async () => {
    const ctx = new Context();
    ctx.provide('profileContext', {
      name: 'fixture',
      dir: '/tmp/synthetic-profile',
      patchPath: '',
      installAnchor: '',
      cwd: '',
      home: '',
      startedBundles: [],
      overlays: [],
      telemetryDisabledEnv: undefined,
    });
    try {
      await apply(ctx, { storageRoot: '/tmp/synthetic' });
      expect(createPresenter).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sampleIntervalsMs: { thermal: 30_000 } }),
      );
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
