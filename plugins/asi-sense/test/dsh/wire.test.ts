import type { SenseEvent, SensePanelModel, SenseRule } from '@asi/sense-ui';
import { describe, expect, it } from 'vitest';
import { createFramesSource } from '../../src/host/dsh/frames.ts';
import { toWirePanelModel } from '../../src/host/dsh/wire.ts';
import { StateStore } from '../../src/host/state/store.ts';

async function model(): Promise<SensePanelModel> {
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
  return frame.value;
}

function rule(where: Record<string, unknown>): SenseRule {
  return {
    id: 'r',
    name: 'r',
    enabled: true,
    confirmed: true,
    createdBy: 'user',
    level: 'wake',
    match: { kind: 'x', where },
  };
}

function event(data: Record<string, unknown>): SenseEvent {
  return {
    signal: { id: 's', kind: 'x', at: 1, source: { id: 'test', api: 'test', host: 'test' }, subject: 'x', data },
    level: 'record',
    reason: 'test',
    cause: 'unknown',
  };
}

describe('Remote frame boundary', () => {
  it('preserves nested JSON fields without changing the input model', async () => {
    const frame = await model();
    frame.events.push(event({ nested: [1, { accepted: true }] }));
    frame.rules.push(rule({ exitCode: { '!=': 0 } }));
    expect(toWirePanelModel(frame)).toEqual(frame);
  });

  it('rejects non-JSON event and rule values instead of silently altering them', async () => {
    const frame = await model();
    frame.events.push(event({ unsafe: undefined }));
    expect(() => toWirePanelModel(frame)).toThrow('Frame data is not lossless JSON');
    frame.events = [];
    frame.rules.push(rule({ unsafe: () => true }));
    expect(() => toWirePanelModel(frame)).toThrow('Frame data is not lossless JSON');
  });

  it('omits absent optional metric values at the JSON boundary', async () => {
    const frame = await model();
    frame.sampleIntervalsMs = { cpu: undefined, networkRx: 1000 };
    frame.insights = { 'disk:/': undefined, cpu: { sources: [], triggered: [] } };
    const wire = toWirePanelModel(frame);
    expect(wire.sampleIntervalsMs).toEqual({ networkRx: 1000 });
    expect(wire.insights).toEqual({ cpu: { sources: [], triggered: [] } });
  });
});
