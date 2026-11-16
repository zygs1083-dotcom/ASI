import { describe, expect, it } from 'vitest';
import { syntheticFrame } from '../../scripts/e2e-synthetic.ts';
import { stalePanelModel } from '../../src/client/frame-state.ts';
import { panelModel } from '../../src/client/panel-model.ts';
import { createFramesSource } from '../../src/host/dsh/frames.ts';
import { toWirePanelModel } from '../../src/host/dsh/wire.ts';
import { StateStore } from '../../src/host/state/store.ts';

async function fixture() {
  const state = new StateStore(() => 1).snapshot();
  const source = createFramesSource({
    state: () => state,
    subscribe: () => () => false,
    rules: { list: () => [], isEnabled: () => true, settings: () => ({ paused: false, sendTitles: false }) },
  });
  const controller = new AbortController();
  const iterator = source(controller.signal)[Symbol.asyncIterator]();
  const frame = await iterator.next();
  controller.abort();
  await iterator.return?.();
  if (!frame.value) throw new Error('frame missing');
  return toWirePanelModel(frame.value);
}

describe('sidebar frame projection', () => {
  it('shows disconnected facts and independently fresh disk volumes as stale without altering the baseline', () => {
    const frame = syntheticFrame();
    const disk = frame.state.self.body.disks.value?.[0];
    if (!disk) throw new Error('synthetic disk missing');
    disk.status = 'ok';
    frame.state.env.focusedWindow.status = 'denied';
    frame.state.observation.sources.fixture = { status: 'ok', lastSignalAt: frame.now };
    const stale = stalePanelModel(frame);
    expect(stale.state.self.body.cpu.status).toBe('stale');
    expect(stale.state.self.body.disks.status).toBe('stale');
    expect(stale.state.self.body.disks.value?.[0]?.status).toBe('stale');
    expect(stale.state.env.frontApp.status).toBe('stale');
    expect(stale.state.env.where.toolExec.status).toBe('stale');
    expect(stale.state.env.focusedWindow.status).toBe('denied');
    expect(stale.state.observation.sources.fixture?.status).toBe('stale');
    expect(frame.state.self.body.cpu.status).toBe('ok');
    expect(disk.status).toBe('ok');
  });
  it('preserves supported dynamic disk metrics', async () => {
    const frame = await fixture();
    frame.tuning = {
      parameters: [],
      log: [],
      suggestions: [
        { id: 's', metric: 'disk:/fixture', unit: 'bytes', slotLabel: 'slot', from: 1, to: 2, samples: 3, dates: 2 },
      ],
    };
    expect(panelModel(frame).tuning?.suggestions?.[0]?.metric).toBe('disk:/fixture');
  });

  it('rejects an unknown wire metric rather than trusting it as a UI metric', async () => {
    const frame = await fixture();
    frame.tuning = {
      parameters: [],
      log: [],
      suggestions: [
        { id: 's', metric: 'invalid', unit: 'ratio', slotLabel: 'slot', from: 1, to: 2, samples: 3, dates: 2 },
      ],
    };
    expect(() => panelModel(frame)).toThrow('unrecognized tuning metric');
  });
});
