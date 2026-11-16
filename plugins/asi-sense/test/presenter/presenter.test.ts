import { createRequire } from 'node:module';
import type { Body } from '@asi/sense-types';
import type { SensePanelProps } from '@asi/sense-ui/model';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPresenter } from '../../src/host/presenter/index.ts';
import { createSenseRuntime } from '../../src/host/runtime/index.ts';
import { diskFact, f, mkBody } from '../body/helpers.ts';

afterEach(() => vi.useRealTimers());

async function harness() {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  let mono = 0;
  let sample: (body: Body) => void = () => {};
  const clock = { wall: () => Date.now(), mono: () => mono };
  const runtime = createSenseRuntime(
    {
      clock,
      dsh: {
        onAgentEvent: () => () => {},
        onTool: () => () => {},
        onJob: () => () => {},
        deliver: async () => {},
        tokenSnapshot: async () => undefined,
      },
      storage: { load: async () => undefined, save: async () => {} },
      helper: { spawn: () => undefined },
      probe: {
        create: () => ({
          onSample: (cb) => {
            sample = cb;
            return () => {};
          },
          start: () => {},
          stop: async () => {},
        }),
      },
      files: { watch: () => ({ close: () => {} }) },
    },
    { platform: 'linux' },
  );
  await runtime.start();
  const presenter = createPresenter(runtime, { clock, sampleIntervalsMs: { cpu: 100 } });
  return {
    runtime,
    presenter,
    advance: async (ms: number) => {
      mono += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
    sample: async (body: Body) => {
      sample(body);
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

describe('presenter', () => {
  it('shares throttled frames while retaining every new sample and reusing unchanged series', async () => {
    const h = await harness();
    const a = h.presenter.frames()[Symbol.asyncIterator]();
    const b = h.presenter.frames()[Symbol.asyncIterator]();
    const first = (await a.next()).value;
    expect((await b.next()).value).toBe(first);
    const aNext = a.next();
    const bNext = b.next();
    let delivered = false;
    void aNext.then(() => {
      delivered = true;
    });
    const body = mkBody({
      cpu: { ...f({ usage: 0.1, perCore: [0.1], load1: 0, load5: 0, load15: 0 }), observedAt: Date.now() },
      memory: { ...f({ used: 50, total: 100, pressure: 'normal', swapUsed: 0 }), observedAt: Date.now() },
    });
    await h.advance(100);
    body.cpu.observedAt = Date.now();
    body.memory.observedAt = Date.now();
    await h.sample(body);
    await h.advance(100);
    if (!body.cpu.value) throw new Error('missing cpu');
    body.cpu = { ...body.cpu, observedAt: Date.now(), value: { ...body.cpu.value, usage: 0.2 } };
    await h.sample(body);
    expect(delivered).toBe(false);
    await h.advance(300);
    const result = await aNext;
    if (result.done) throw new Error('missing frame');
    const frame = result.value;
    expect((await bNext).value).toBe(frame);
    expect(frame.history.cpu.map((point) => point.value)).toEqual([0.1, 0.2]);
    expect(frame.history.memory).toHaveLength(1);
    expect(frame.sampleIntervalsMs?.cpu).toBe(100);
    const memory = frame.history.memory;
    expect(h.presenter.snapshot().history.memory).toBe(memory);
    await h.runtime.actions.pause(true);
    await h.advance(0);
    const pending = a.next();
    h.presenter.close();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(await b.next()).toEqual({ done: true, value: undefined });
    await h.runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not bypass the shared throttle by disconnecting and reconnecting', async () => {
    const h = await harness();
    const first = h.presenter.frames()[Symbol.asyncIterator]();
    const initial = (await first.next()).value;
    await first.return?.();
    await h.advance(100);
    await h.runtime.actions.pause(true);
    await h.advance(0);
    const second = h.presenter.frames()[Symbol.asyncIterator]();
    expect((await second.next()).value).toBe(initial);
    const next = second.next();
    await h.advance(400);
    const result = await next;
    expect(result.done).toBe(false);
    expect(result.value.paused).toBe(true);
    h.presenter.close();
    await h.runtime.stop();
  });

  it('reports elapsed monotonic learning time even without another body sample', async () => {
    const h = await harness();
    await h.runtime.actions.pause(true);
    await h.advance(86_400_000);
    expect(h.presenter.snapshot().learning).toMatchObject({ status: 'ready', collectedMs: 86_400_000 });
    h.presenter.close();
    await h.runtime.stop();
  });

  it('projects rules, tuning, event privacy and independent disk freshness', async () => {
    const h = await harness();
    const now = Date.now();
    const disks = diskFact([
      { mount: '/', total: 100, free: 20, observedAt: now, status: 'ok' },
      { mount: '/old', total: 100, free: 20, observedAt: now, status: 'stale' },
      { mount: '/unreadable', total: 100, free: 20, observedAt: now, status: 'ok' },
    ]);
    disks.observedAt = now;
    disks.unavailableMounts = ['/unreadable'];
    await h.sample(mkBody({ disks }));
    await h.runtime.actions.setSendTitles(false);
    vi.spyOn(h.runtime, 'events').mockReturnValue([
      {
        id: 'synthetic',
        kind: 'window.focused',
        subject: 'synthetic-title',
        at: now,
        level: 'record',
        reason: 'synthetic-title',
        ruleId: 'synthetic-title',
        source: { id: 'synthetic', api: 'ax', host: 'local' },
      },
    ]);
    const model = h.presenter.snapshot();
    expect(model.history.disks['/']).toEqual([{ at: now, value: 0.8 }]);
    expect(model.history.disks['/old']).toBeUndefined();
    expect(model.history.disks['/unreadable']).toBeUndefined();
    expect(JSON.stringify(model.events)).not.toContain('synthetic-title');
    expect(model.rules.length).toBeGreaterThan(0);
    expect(model.tuning?.parameters.find((param) => param.key === 'rate.rss.maxRatio')?.value).toBe(0.5);
    h.presenter.close();
    await h.runtime.stop();
  });

  it('projects natural suggestion values and the disabled reason without converting units', async () => {
    const h = await harness();
    const metrics = ['cpu', 'memory', 'disk:/data', 'rss', 'context', 'network.rx', 'network.tx', 'battery', 'thermal'];
    vi.spyOn(h.runtime.body.monitor, 'rebaselineSuggestions', 'get').mockReturnValue(
      metrics.map((metric, i) => ({
        id: String(i),
        stream: 'synthetic',
        metric,
        slot: 38,
        from: 3,
        to: 7,
        samples: 8,
        dates: 3,
      })),
    );
    vi.spyOn(h.runtime.body.tuner, 'tuningDisabled', 'get').mockReturnValue('storage-failed');
    const tuning = h.presenter.snapshot().tuning;
    expect(tuning.disabled).toEqual({ reason: 'storage-failed' });
    expect(tuning.suggestions.map(({ metric, unit, from, to }) => [metric, unit, from, to])).toEqual([
      ['cpu', 'ratio', 3, 7],
      ['memory', 'ratio', 3, 7],
      ['disk:/data', 'bytes', 3, 7],
      ['processRss', 'bytes', 3, 7],
      ['tokens', 'tokens', 3, 7],
      ['networkRx', 'bytes-per-second', 3, 7],
      ['networkTx', 'bytes-per-second', 3, 7],
      ['battery', 'percent', 3, 7],
      ['thermal', 'ordinal', 3, 7],
    ]);
    expect(tuning.suggestions[0]?.slotLabel).toBe('周一 14 时');
    h.presenter.close();
    await h.runtime.stop();
  });

  it('projects floor severity and rate thresholds but waits for three samples before estimating', async () => {
    const h = await harness();
    const gib = 1024 ** 3;
    const disks = (free: number) => {
      const result = diskFact([{ mount: '/', total: 10 * gib, free, status: 'ok', observedAt: Date.now() }]);
      result.observedAt = Date.now();
      return result;
    };
    await h.sample(mkBody({ disks: disks(8 * gib) }));
    await h.advance(5_000);
    await h.sample(mkBody({ disks: disks(gib / 10) }));
    const current = h.presenter.snapshot().insights?.['disk:/'];
    expect(current).toMatchObject({
      sources: expect.arrayContaining(['floor', 'rate']),
      triggered: expect.arrayContaining(['floor', 'rate']),
      severity: 'critical',
      thresholds: {
        floor: { value: 0.95, source: 'floor' },
        rate: { value: 2 * gib, unit: 'bytes' },
      },
    });
    expect(current?.currentEta).toBeUndefined();
    await h.advance(2_000);
    await h.sample(mkBody({ disks: disks(gib / 20) }));
    expect(h.presenter.snapshot().insights?.['disk:/']?.currentEta).toMatchObject({
      asOf: Date.now(),
      sampleIntervalMs: 10_000,
      ratePerMinute: expect.any(Number),
    });
    expect(h.presenter.snapshot().insights?.['disk:/']?.currentEta?.ratePerMinute).toBeLessThan(0);
    h.presenter.close();
    await h.runtime.stop();
  });

  it('recalculates disk ETA for three consecutive samples and clears it on recovery', async () => {
    const h = await harness();
    const gib = 1024 ** 3;
    const sampleDisk = async (free: number) => {
      const disks = diskFact([{ mount: '/', total: 100 * gib, free: free * gib, observedAt: Date.now() }]);
      disks.observedAt = Date.now();
      await h.sample(mkBody({ disks }));
    };
    await sampleDisk(80);
    await h.advance(10_000);
    await sampleDisk(76);
    expect(h.presenter.snapshot().insights?.['disk:/']?.currentEta).toBeUndefined();
    for (const [free, rate] of [
      [75, -15],
      [73, -13.2],
      [70, -13.8],
    ] as const) {
      await h.advance(10_000);
      await sampleDisk(free);
      const eta = h.presenter.snapshot().insights?.['disk:/']?.currentEta;
      expect(eta?.asOf).toBe(Date.now());
      expect(eta?.ratePerMinute).toBeCloseTo(rate * gib, 3);
      expect(eta?.timeToThresholdMs).toBeCloseTo(((free - 5) / -rate) * 60_000, 3);
    }
    await h.advance(10_000);
    await sampleDisk(79);
    expect(
      h.runtime
        .events()
        .filter((event) => event.kind === 'body.rate')
        .at(-1)?.detail?.severity,
    ).toBe('normal');
    expect(h.presenter.snapshot().insights?.['disk:/']?.currentEta).toBeUndefined();
    h.presenter.close();
    await h.runtime.stop();
  });

  it('hides disk ETA when the fitted trend reverses while the rate alarm remains active', async () => {
    const h = await harness();
    const gib = 1024 ** 3;
    for (const free of [100, 30, 85, 95]) {
      if (free !== 100) await h.advance(10_000);
      const disks = diskFact([{ mount: '/', total: 100 * gib, free: free * gib, observedAt: Date.now() }]);
      disks.observedAt = Date.now();
      await h.sample(mkBody({ disks }));
      if (free === 85) expect(h.presenter.snapshot().insights?.['disk:/']?.currentEta).toBeDefined();
    }
    expect(
      h.runtime
        .events()
        .filter((event) => event.kind === 'body.rate')
        .at(-1)?.detail?.severity,
    ).toBe('warn');
    expect(h.presenter.snapshot().insights?.['disk:/']?.currentEta).toBeUndefined();
    h.presenter.close();
    await h.runtime.stop();
  });

  it('hides disk ETA for a flat fitted trend while the rate alarm remains active', async () => {
    const h = await harness();
    const gib = 1024 ** 3;
    for (const free of [100, 20, 80, 80]) {
      if (free !== 100) await h.advance(10_000);
      const disks = diskFact([{ mount: '/', total: 100 * gib, free: free * gib, observedAt: Date.now() }]);
      disks.observedAt = Date.now();
      await h.sample(mkBody({ disks }));
    }
    expect(
      h.runtime
        .events()
        .filter((event) => event.kind === 'body.rate')
        .at(-1)?.detail?.severity,
    ).toBe('warn');
    expect(h.presenter.snapshot().insights?.['disk:/']?.currentEta).toBeUndefined();
    h.presenter.close();
    await h.runtime.stop();
  });

  it('fits the exact event window, including its boundary, using raw free bytes', async () => {
    const h = await harness();
    const gib = 1024 ** 3;
    for (const [delay, free] of [
      [0, 80],
      [10_000, 76],
      [10_000, 75],
      [50_000, 70],
      [1_000, 69.9],
    ] as const) {
      await h.advance(delay);
      const disks = diskFact([{ mount: '/', total: 100 * gib, free: free * gib, observedAt: Date.now() }]);
      disks.observedAt = Date.now();
      await h.sample(mkBody({ disks }));
      if (free <= 70) {
        const eta = h.presenter.snapshot().insights?.['disk:/']?.currentEta;
        expect(eta?.ratePerMinute).toBeCloseTo(-6 * gib, 3);
        expect(eta?.timeToThresholdMs).toBeCloseTo(((free - 5) / 6) * 60_000, 3);
      }
    }
    h.presenter.close();
    await h.runtime.stop();
  });

  it('estimates disk depletion from historical free bytes when capacity changes', async () => {
    const h = await harness();
    const gib = 1024 ** 3;
    for (const [total, free] of [
      [100, 80],
      [200, 70],
      [300, 60],
    ] as const) {
      if (total !== 100) await h.advance(10_000);
      const disks = diskFact([{ mount: '/', total: total * gib, free: free * gib, observedAt: Date.now() }]);
      disks.observedAt = Date.now();
      await h.sample(mkBody({ disks }));
    }
    const eta = h.presenter.snapshot().insights?.['disk:/']?.currentEta;
    expect(eta?.ratePerMinute).toBeCloseTo(-60 * gib, 3);
    expect(eta?.timeToThresholdMs).toBeCloseTo(45_000, 3);
    h.presenter.close();
    await h.runtime.stop();
  });

  it('hides ETA when too few samples remain in the active event window', async () => {
    const h = await harness();
    const gib = 1024 ** 3;
    for (const [delay, free] of [
      [0, 80],
      [10_000, 76],
      [70_000, 74],
    ] as const) {
      await h.advance(delay);
      const disks = diskFact([{ mount: '/', total: 100 * gib, free: free * gib, observedAt: Date.now() }]);
      disks.observedAt = Date.now();
      await h.sample(mkBody({ disks }));
    }
    expect(
      h.runtime
        .events()
        .filter((event) => event.kind === 'body.rate')
        .at(-1)?.detail?.severity,
    ).toBe('warn');
    expect(h.presenter.snapshot().insights?.['disk:/']?.currentEta).toBeUndefined();
    h.presenter.close();
    await h.runtime.stop();
  });

  it('uses remaining tokens and the event window for context ETA even when capacity changes', async () => {
    const h = await harness();
    for (const [window, used] of [
      [1000, 0],
      [1000, 200],
      [1200, 500],
    ] as const) {
      if (used) await h.advance(70_000);
      const tokens = f({
        contextWindow: window,
        contextUsed: used,
        sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
      tokens.observedAt = Date.now();
      await h.sample(mkBody({ tokens }));
    }
    const event = h.runtime
      .events()
      .filter((entry) => entry.kind === 'body.rate')
      .at(-1);
    expect(event?.detail).toMatchObject({ metric: 'context', severity: 'warn', windowMs: 300_000 });
    const eta = h.presenter.snapshot().insights?.tokens?.currentEta;
    expect(eta?.asOf).toBe(Date.now());
    expect(eta?.ratePerMinute).toBeCloseTo((300 / 140) * 60);
    expect(eta?.timeToThresholdMs).toBeCloseTo((700 / 300) * 140_000);
    h.presenter.close();
    await h.runtime.stop();
  });

  it('does not use unconfirmed context capacity as historical evidence', async () => {
    const h = await harness();
    for (const [used, source] of [
      [0, 'fallback'],
      [100, 'fallback'],
      [200, 'configured'],
      [300, 'configured'],
      [400, 'configured'],
    ] as const) {
      if (used) await h.advance(10_000);
      const tokens = f({
        contextWindow: 1000,
        contextUsed: used,
        contextWindowSource: source,
        sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
      tokens.observedAt = Date.now();
      await h.sample(mkBody({ tokens }));
      if (used === 300) expect(h.presenter.snapshot().insights?.tokens?.currentEta).toBeUndefined();
    }
    expect(h.presenter.snapshot().insights?.tokens?.currentEta?.ratePerMinute).toBeCloseTo(600);
    h.presenter.close();
    await h.runtime.stop();
  });

  it('renders the projected model with SensePanel on the server', async () => {
    const h = await harness();
    const uiName = '@asi/sense-ui';
    const ui = await import(uiName);
    const require = createRequire(import.meta.resolve('@asi/sense-ui'));
    const React = require('react');
    const { renderToString } = require('react-dom/server');
    const noop = () => {};
    const props: SensePanelProps = {
      model: h.presenter.snapshot(),
      onToggleRule: noop,
      onConfirmRule: noop,
      onDeleteRule: noop,
      onPause: noop,
      onToggleTitles: noop,
      onOpenPermissionSettings: noop,
      onRevertTuning: noop,
      onLockParam: noop,
      onFeedback: noop,
    };
    expect(renderToString(React.createElement(ui.SensePanel, props))).toContain('环境感知');
    h.presenter.close();
    await h.runtime.stop();
  });
});
