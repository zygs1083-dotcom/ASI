import { createRequire } from 'node:module';
import { MemorySampler, NetworkSampler } from '@asi/body-probe';
import type { Body } from '@asi/sense-types';
import type { SensePanelProps } from '@asi/sense-ui/model';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attentionLine } from '../../../../packages/sense-ui/src/attention.ts';
import { evaluateBody } from '../../../../packages/sense-ui/src/health.ts';
import { Sparkline } from '../../../../packages/sense-ui/src/sparkline.tsx';
import { createPresenter } from '../../src/host/presenter/index.ts';
import { createSenseRuntime } from '../../src/host/runtime/index.ts';
import type { AgentEvent, JobEvent, TokenSnapshot } from '../../src/host/runtime/ports.ts';
import { diskFact, f, mkBody } from '../body/helpers.ts';

afterEach(() => vi.useRealTimers());

async function harness() {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  let mono = 0;
  let sample: (body: Body) => void = () => {};
  let job: (event: JobEvent) => Promise<void> = async () => {};
  let agent: (event: AgentEvent) => Promise<void> = async () => {};
  let tokens: TokenSnapshot | undefined;
  let clockObserver: (() => void) | undefined;
  let observingClock = false;
  const clock = {
    wall: () => Date.now(),
    mono: () => {
      if (clockObserver && !observingClock) {
        observingClock = true;
        try {
          clockObserver();
        } finally {
          observingClock = false;
        }
      }
      return mono;
    },
  };
  const runtime = createSenseRuntime(
    {
      clock,
      dsh: {
        onAgentEvent: (cb) => {
          agent = cb;
          return () => {};
        },
        onTool: () => () => {},
        onJob: (cb) => {
          job = cb;
          return () => {};
        },
        deliver: async () => {},
        tokenSnapshot: async () => tokens,
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
    tokens: (value: TokenSnapshot) => {
      tokens = value;
    },
    observeClock: (observer?: () => void) => {
      clockObserver = observer;
    },
    agent: (event: AgentEvent) => agent(event),
    job: (event: JobEvent) => job(event),
    advance: async (ms: number) => {
      mono += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
    elapse: (ms: number) => {
      mono += ms;
      vi.setSystemTime(Date.now() + ms);
    },
    sample: async (body: Body) => {
      sample(body);
      await vi.advanceTimersByTimeAsync(0);
    },
    sampleRaw: (body: Body) => sample(body),
    settle: () => vi.advanceTimersByTimeAsync(0),
  };
}

describe('presenter', () => {
  it('uses the current disk critical floor in projected ETA', async () => {
    const h = await harness();
    expect((await h.runtime.body.tuner.propose({ param: 'floor.disk.critical', to: 0.075 })).applied).toBe(true);
    const gib = 1024 ** 3;
    for (const free of [80, 76, 75]) {
      const disks = diskFact([{ mount: '/', total: 100 * gib, free: free * gib, observedAt: Date.now() }]);
      disks.observedAt = Date.now();
      await h.sample(mkBody({ disks }));
      if (free !== 75) await h.advance(10_000);
    }
    const eta = h.presenter.snapshot().insights?.['disk:/']?.currentEta;
    expect(eta?.timeToThresholdMs).toBeCloseTo(((75 - 7.5) / 15) * 60_000, 3);
    h.presenter.close();
    await h.runtime.stop();
  });

  it.each([-61_000, 0, 61_000])(
    'shows freshly sampled memory and network trends without lag across a %i ms wall jump, then shows real lag',
    async (jump) => {
      const h = await harness();
      let mono = 0;
      let reads = 0;
      let routes = 0;
      let swaps = 0;
      let lastBody: Body | undefined;
      const network = new NetworkSampler({
        platform: 'darwin',
        now: () => mono,
        wall: () => Date.now(),
        interfaces: () => ({
          en0: [
            { address: '198.51.100.1', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null },
          ],
        }),
        run: async (file) => {
          if (!file.endsWith('netstat')) {
            routes++;
            return '';
          }
          reads++;
          return (
            `Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll\n` +
            `en0 1500 <Link#4> aa 1 0 ${reads * reads * 7000} 1 0 ${reads * reads * 14000} 0`
          );
        },
      });
      const memory = new MemorySampler({
        platform: 'darwin',
        now: () => mono,
        wall: () => Date.now(),
        totalmem: () => 1_000_000,
        run: async (file, args = []) => {
          if (file.endsWith('vm_stat')) {
            return (
              `page size of 4096 bytes\nAnonymous pages: ${reads * 10}.\nPages purgeable: 0.\n` +
              'File-backed pages: 5.\nPages wired down: 5.\nPages occupied by compressor: 5.'
            );
          }
          return args
            .slice(1)
            .map((key) => {
              if (key === 'vm.swapusage') swaps++;
              return key === 'vm.swapusage' ? 'used = 1M' : '1';
            })
            .join('\n');
        },
      });
      const sample = async () => {
        const networkFact = await network.sample(15_000);
        const memoryFact = await memory.sample(15_000);
        lastBody = mkBody({ network: networkFact, memory: memoryFact });
        await h.sample(lastBody);
      };
      await sample();
      mono += 17_000;
      h.elapse(17_000);
      await sample();
      vi.setSystemTime(Date.now() + jump);
      mono += 7_000;
      h.elapse(7_000);
      await sample();
      expect(routes).toBe(1);
      expect(swaps).toBe(1);
      const current = h.presenter.snapshot();
      expect(current.history.memory.at(-1)).toEqual({ at: current.now, value: 0.16384 });
      expect(current.history.networkRx.at(-1)).toEqual({ at: current.now, value: 5000 });
      expect(current.history.networkTx.at(-1)).toEqual({ at: current.now, value: 10000 });
      expect(current.state.self.body.memory.observedAt).toBe(current.now);
      expect(current.state.self.body.network.observedAt).toBe(current.now);
      const require = createRequire(import.meta.resolve('@asi/sense-ui'));
      const React = require('react');
      const { renderToString } = require('react-dom/server');
      const render = (points: typeof current.history.memory, now: number) =>
        renderToString(
          React.createElement(Sparkline, {
            points,
            now,
            sampleIntervalMs: 5_000,
            label: '合成趋势',
            format: String,
          }),
        );
      for (const points of [current.history.memory, current.history.networkRx, current.history.networkTx]) {
        const html = render(points, current.now);
        expect(html).toContain('最近 5 分钟趋势：当前');
        expect(html).not.toContain('数据滞后');
      }
      mono += 16_000;
      h.elapse(16_000);
      if (!lastBody) throw new Error('missing sample');
      await h.sample(lastBody);
      const stopped = h.presenter.snapshot();
      for (const points of [stopped.history.memory, stopped.history.networkRx, stopped.history.networkTx]) {
        expect(render(points, stopped.now)).toContain('数据滞后');
      }
      h.presenter.close();
      await h.runtime.stop();
    },
  );

  it('preserves token reasons through probe, session transitions, store and presenter', async () => {
    const h = await harness();
    const token = () => h.presenter.snapshot().state.self.body.tokens;
    expect(token()).toMatchObject({ status: 'unknown', reason: '没有活动会话' });
    await h.sample(mkBody({ tokens: { ...f(null, 'unavailable'), reason: '未接入用量来源' } }));
    expect(token()).toMatchObject({ status: 'unavailable', reason: '没有活动会话' });
    await h.agent({ type: 'created', sessionId: 'a' });
    expect(token()).toMatchObject({ status: 'unavailable', reason: '会话中尚未收到用量' });
    await h.agent({ type: 'created', sessionId: 'b' });
    await h.agent({ type: 'disposed', sessionId: 'a' });
    expect(token().reason).toBe('会话中尚未收到用量');
    await h.agent({ type: 'pre-step', sessionId: 'b' });
    expect(token()).toMatchObject({ status: 'unavailable', reason: '会话中尚未收到用量' });
    h.tokens({ sessionUsage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } });
    await h.agent({ type: 'post-step', sessionId: 'b' });
    expect(token().status).toBe('ok');
    expect(token().reason).toBeUndefined();
    await h.agent({ type: 'disposed', sessionId: 'b' });
    h.presenter.close();
    await h.runtime.stop();
  });

  it('updates an unavailable token reason when the last session closes', async () => {
    const h = await harness();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    expect(h.presenter.snapshot().state.self.body.tokens.reason).toBe('会话中尚未收到用量');
    await h.agent({ type: 'disposed', sessionId: 's' });
    expect(h.presenter.snapshot().state.self.body.tokens.reason).toBe('没有活动会话');
    h.presenter.close();
    await h.runtime.stop();
  });

  it.each(['created', 'disposed'] as const)(
    'uses current session presence when a delayed probe sample commits after %s',
    async (event) => {
      const h = await harness();
      if (event === 'disposed') await h.agent({ type: 'created', sessionId: 's' });
      const original = h.runtime.body.monitor.evaluateAuto.bind(h.runtime.body.monitor);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const spy = vi.spyOn(h.runtime.body.monitor, 'evaluateAuto').mockImplementation(async (...args) => {
        await gate;
        return original(...args);
      });
      h.sampleRaw(mkBody({ tokens: { ...f(null, 'unavailable'), reason: '未接入用量来源' } }));
      await h.settle();
      expect(spy).toHaveBeenCalled();
      await h.agent({ type: event, sessionId: 's' });
      release();
      await h.settle();
      expect(h.presenter.snapshot().state.self.body.tokens.reason).toBe(
        event === 'created' ? '会话中尚未收到用量' : '没有活动会话',
      );
      h.presenter.close();
      await h.runtime.stop();
    },
  );

  it.each([false, true])(
    'commits every fact deadline before batched notifications with session=%s',
    async (session) => {
      const h = await harness();
      if (session) {
        await h.agent({ type: 'created', sessionId: 's' });
        await h.agent({ type: 'pre-step', sessionId: 's' });
      }
      const memory = {
        ...f({ total: 100, used: 30, pressure: 'normal' as const, swapUsed: 0 }),
        observedAt: Date.now(),
        ttlMs: 5_000,
      };
      const cpu = (usage: number) => ({
        ...f({ usage, perCore: [usage], load1: 0, load5: 0, load15: 0 }),
        observedAt: Date.now(),
        ttlMs: 5_000,
      });
      await h.sample(mkBody({ cpu: cpu(0.1), memory }));
      await h.advance(4_000);
      const seen: { deadline: number | undefined; remaining: number | undefined; cpu: number | undefined }[] = [];
      const off = h.runtime.subscribe(() => {
        seen.push({
          deadline: h.runtime.factMeta('/self/body/memory')?.deadlineMono,
          remaining: h.presenter.snapshot().state.self.body.memory.staleInMs,
          cpu: h.runtime.state().self.body.cpu.value?.usage,
        });
      });
      await h.sample(mkBody({ cpu: cpu(0.9), memory }));
      expect(seen.length).toBeGreaterThan(1);
      expect(seen.every((entry) => entry.deadline === 9_000 && entry.remaining === 5_000 && entry.cpu === 0.9)).toBe(
        true,
      );
      off();
      h.presenter.close();
      await h.runtime.stop();
    },
  );

  it('keeps reentrant reads on the old or fully committed fact deadlines', async () => {
    const h = await harness();
    const memory = {
      ...f({ total: 100, used: 30, pressure: 'normal' as const, swapUsed: 0 }),
      observedAt: Date.now(),
      ttlMs: 5_000,
    };
    const cpu = (usage: number) => ({
      ...f({ usage, perCore: [usage], load1: 0, load5: 0, load15: 0 }),
      observedAt: Date.now(),
      ttlMs: 5_000,
    });
    await h.sample(mkBody({ cpu: cpu(0.1), memory }));
    await h.advance(4_000);
    const seen: [number | undefined, number | undefined, number | undefined][] = [];
    h.observeClock(() =>
      seen.push([
        h.runtime.state().self.body.cpu.value?.usage,
        h.runtime.factMeta('/self/body/cpu')?.deadlineMono,
        h.runtime.factMeta('/self/body/memory')?.deadlineMono,
      ]),
    );
    await h.sample(mkBody({ cpu: cpu(0.9), memory }));
    h.observeClock();
    expect(seen).toContainEqual([0.1, 5_000, 5_000]);
    expect(seen).toContainEqual([0.9, 9_000, 9_000]);
    expect(
      seen.filter((item) => JSON.stringify(item) !== '[0.1,5000,5000]' && JSON.stringify(item) !== '[0.9,9000,9000]'),
    ).toEqual([]);
    h.presenter.close();
    await h.runtime.stop();
  });

  it('anchors delayed disk rate event ETA to evaluation time without hiding the current ETA', async () => {
    const h = await harness();
    const start = Date.now();
    const gib = 1024 ** 3;
    for (const [delay, observed, free] of [
      [0, 0, 80],
      [10_000, 10_000, 79],
      [10_000, 15_000, 75],
    ]) {
      await h.advance(delay);
      const disks = diskFact([{ mount: '/', total: 100 * gib, free: free * gib, observedAt: start + observed }]);
      disks.observedAt = start + observed;
      await h.sample(mkBody({ disks }));
    }
    const event = h.runtime.events().find((entry) => entry.kind === 'body.rate');
    const model = h.presenter.snapshot();
    const projected = model.events.find((entry) => entry.signal.id === event?.id);
    expect(event).toMatchObject({ at: start + 20_000, detail: { evidenceAt: start + 15_000 } });
    expect(model.insights?.['disk:/']?.currentEta?.asOf).toBe(start + 15_000);
    expect(projected?.signal.at).toBe(start + 20_000);
    expect(projected?.signal.data.evidenceAt).toBe(start + 15_000);
    expect(attentionLine(model, evaluateBody(model.state.self.body, model.now, model.insights))).toBe(
      '磁盘 4 分钟后见底',
    );
    h.presenter.close();
    await h.runtime.stop();
  });

  it('uses elapsed monotonic time for delayed context ETA alerts and event details', async () => {
    const h = await harness();
    const start = Date.now();
    for (const [delay, observed, remaining] of [
      [0, 0, 615],
      [20_000, 10_000, 605],
    ]) {
      await h.advance(delay);
      const tokens = {
        ...f({
          contextWindow: 10_000,
          contextUsed: 10_000 - remaining,
          sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }),
        observedAt: start + observed,
      };
      await h.sample(mkBody({ tokens }));
    }
    expect(h.runtime.body.monitor.restoredState?.['rate:context-eta']).toBe('warn');
    const event = h.runtime.events().find((entry) => entry.kind === 'body.rate' && entry.detail?.metric === 'context');
    expect(event).toMatchObject({
      at: start + 20_000,
      detail: { evidenceAt: start + 10_000, timeToFloorMs: 595_000, severity: 'warn' },
    });
    expect(h.presenter.snapshot().events.find((entry) => entry.signal.id === event?.id)).toMatchObject({
      signal: { at: start + 20_000, data: { evidenceAt: start + 10_000 } },
      detail: { timeToFloorMs: 595_000 },
    });
    h.presenter.close();
    await h.runtime.stop();
  });

  it('raises an ETA alert on cached republication without inventing a new observation', async () => {
    const h = await harness();
    const start = Date.now();
    const tokens = (remaining: number, observedAt: number) => ({
      ...f({
        contextWindow: 10_000,
        contextUsed: 10_000 - remaining,
        sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      observedAt,
    });
    await h.sample(mkBody({ tokens: tokens(615, start) }));
    await h.advance(10_000);
    const cached = mkBody({ tokens: tokens(605, start + 10_000) });
    await h.sample(cached);
    expect(h.runtime.events().filter((entry) => entry.kind === 'body.rate')).toHaveLength(0);
    await h.advance(5_000);
    await h.sample(cached);
    const rateEvents = h.runtime.events().filter((entry) => entry.kind === 'body.rate');
    expect(rateEvents).toHaveLength(1);
    expect(rateEvents[0]).toMatchObject({
      at: start + 15_000,
      detail: { evidenceAt: start + 10_000, timeToFloorMs: 600_000 },
    });
    expect(h.presenter.snapshot().events.find((entry) => entry.signal.id === rateEvents[0].id)).toMatchObject({
      signal: { at: start + 15_000, data: { evidenceAt: start + 10_000 } },
    });
    expect(h.runtime.body.monitor.rateEvidence('context').points).toHaveLength(2);
    await h.advance(1_000);
    await h.sample(cached);
    expect(h.runtime.events().filter((entry) => entry.kind === 'body.rate')).toHaveLength(1);
    h.presenter.close();
    await h.runtime.stop();
  });

  it('evaluates ETA when a received sample waits before publication', async () => {
    const h = await harness();
    const start = Date.now();
    const tokens = (remaining: number, observedAt: number) => ({
      ...f({
        contextWindow: 10_000,
        contextUsed: 10_000 - remaining,
        sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      observedAt,
    });
    await h.sample(mkBody({ tokens: tokens(615, start) }));
    await h.advance(20_000);
    h.sampleRaw(mkBody({ tokens: tokens(605, start + 10_000) }));
    h.elapse(10_000);
    await h.settle();
    const event = h.runtime.events().find((entry) => entry.kind === 'body.rate' && entry.detail?.metric === 'context');
    expect(event).toMatchObject({
      at: start + 30_000,
      detail: { evidenceAt: start + 10_000, timeToFloorMs: 585_000 },
    });
    h.presenter.close();
    await h.runtime.stop();
  });

  it.each([-61_000, 61_000])('keeps delayed rate event evidence aligned across a %i ms wall jump', async (jump) => {
    const h = await harness();
    const start = Date.now();
    const gib = 1024 ** 3;
    for (const [delay, observed, free] of [
      [0, 0, 80],
      [10_000, 10_000, 79],
      [10_000, 15_000, 75],
    ]) {
      await h.advance(delay);
      const disks = diskFact([{ mount: '/', total: 100 * gib, free: free * gib, observedAt: start + observed }]);
      disks.observedAt = start + observed;
      h.sampleRaw(mkBody({ disks }));
      if (free === 75) vi.setSystemTime(Date.now() + jump);
      await h.settle();
    }
    const model = h.presenter.snapshot();
    expect(model.insights?.['disk:/']?.currentEta?.asOf).toBe(start + 15_000);
    expect(model.events.find((entry) => entry.detail?.kind === 'body.rate')?.signal.at).toBe(start + 20_000);
    expect(attentionLine(model, evaluateBody(model.state.self.body, model.now, model.insights))).toBe(
      '磁盘 4 分钟后见底',
    );
    h.presenter.close();
    await h.runtime.stop();
  });

  it('aggregates disk parent from final volume deadlines after cached republishes', async () => {
    const h = await harness();
    const now = Date.now();
    const disks = diskFact([
      { mount: '/a', total: 100, free: 80, observedAt: now, ttlMs: 5_000, status: 'ok' },
      { mount: '/b', total: 100, free: 80, observedAt: now, ttlMs: 7_000, status: 'ok' },
    ]);
    disks.observedAt = now;
    disks.ttlMs = 5_000;
    await h.sample(mkBody({ disks }));
    await h.advance(4_000);
    await h.sample(mkBody({ disks }));
    expect(h.presenter.snapshot().state.self.body.disks.staleInMs).toBe(3_000);
    await h.advance(1_000);
    let result = h.presenter.snapshot().state.self.body.disks;
    expect(result.status).toBe('ok');
    expect(result.value?.map((volume) => volume.status)).toEqual(['stale', 'ok']);
    expect(result.staleInMs).toBe(2_000);
    expect(h.runtime.factMeta('/self/body/disks')?.deadlineMono).toBe(7_000);
    await h.sample(mkBody({ disks }));
    result = h.presenter.snapshot().state.self.body.disks;
    expect(result.value?.map((volume) => volume.status)).toEqual(['stale', 'ok']);
    expect(result.staleInMs).toBe(2_000);
    await h.advance(2_000);
    result = h.presenter.snapshot().state.self.body.disks;
    expect(h.runtime.state().self.body.disks.status).toBe('stale');
    expect(result.status).toBe('stale');
    expect(result.value?.map((volume) => volume.status)).toEqual(['stale', 'stale']);
    expect(result.staleInMs).toBeUndefined();
    h.presenter.close();
    await h.runtime.stop();
  });

  it('never revives an expired cached disk when its TTL metadata changes', async () => {
    const h = await harness();
    const now = Date.now();
    const disks = diskFact([{ mount: '/', total: 100, free: 80, observedAt: now, ttlMs: 5_000, status: 'ok' }]);
    disks.observedAt = now;
    disks.ttlMs = 5_000;
    await h.sample(mkBody({ disks }));
    await h.advance(4_000);
    await h.sample(mkBody({ disks }));
    if (!disks.value) throw new Error('missing disk');
    disks.value[0].ttlMs = 10_000;
    disks.ttlMs = 10_000;
    await h.sample(mkBody({ disks }));
    expect(h.presenter.snapshot().state.self.body.disks.staleInMs).toBe(1_000);
    await h.advance(1_000);
    expect(h.presenter.snapshot().state.self.body.disks.status).toBe('stale');
    disks.value[0].status = 'unavailable';
    await h.sample(mkBody({ disks }));
    disks.value[0].status = 'ok';
    await h.sample(mkBody({ disks }));
    expect(h.runtime.state().self.body.disks.value?.[0].status).toBe('stale');
    expect(h.presenter.snapshot().state.self.body.disks).toMatchObject({ status: 'stale' });
    expect(h.presenter.snapshot().state.self.body.disks.staleInMs).toBeUndefined();
    await h.advance(1_000);
    disks.observedAt = Date.now();
    disks.value[0].observedAt = Date.now();
    await h.sample(mkBody({ disks }));
    expect(h.presenter.snapshot().state.self.body.disks.status).toBe('ok');
    h.presenter.close();
    await h.runtime.stop();
  });

  it.each(['denied', 'unsupported'] as const)(
    'preserves disk collection status %s with or without fresh volumes',
    async (status) => {
      const h = await harness();
      for (const value of [
        null,
        [],
        [{ mount: '/', total: 100, free: 80, status: 'ok' as const, observedAt: Date.now(), ttlMs: 5_000 }],
      ]) {
        const disks = diskFact(value, status);
        disks.observedAt = Date.now();
        await h.sample(mkBody({ disks }));
        expect(h.runtime.state().self.body.disks.status).toBe(status);
        expect(h.runtime.factMeta('/self/body/disks')?.deadlineMono).toBe(Infinity);
        const presented = h.presenter.snapshot().state.self.body.disks;
        expect(presented.status).toBe(status);
        expect(presented.staleInMs).toBeUndefined();
        if (value?.length) expect(presented.value?.[0].status).toBe('ok');
      }
      h.presenter.close();
      await h.runtime.stop();
    },
  );

  it.each([false, true])('publishes complete body commits to every subscriber with session=%s', async (session) => {
    const h = await harness();
    if (session) {
      await h.agent({ type: 'created', sessionId: 's' });
      await h.agent({ type: 'pre-step', sessionId: 's' });
    }
    const body = (cpu: number, pressure: 'normal' | 'critical') =>
      mkBody({
        cpu: { ...f({ usage: cpu, perCore: [cpu], load1: 0, load5: 0, load15: 0 }), observedAt: Date.now() },
        memory: { ...f({ total: 100, used: 90, pressure, swapUsed: 0 }), observedAt: Date.now() },
      });
    await h.sample(body(0.1, 'normal'));
    const seen: unknown[] = [];
    let queuedJob: Promise<void> | undefined;
    const off = h.runtime.subscribe((state) => {
      queuedJob ??= h.job({ type: 'started', id: 'synthetic-job' });
      seen.push({
        cpu: state.self.body.cpu.value?.usage,
        memory: state.self.body.memory.value?.pressure,
        currentCpu: h.runtime.state().self.body.cpu.value?.usage,
        currentMemory: h.runtime.state().self.body.memory.value?.pressure,
        latch: h.runtime.body.monitor.restoredState?.memory,
        event: h.runtime.events().some((event) => event.kind === 'body.threshold' && event.subject === 'memory'),
      });
    });
    await h.advance(1_000);
    await h.sample(body(0.9, 'critical'));
    await queuedJob;
    expect(seen.length).toBeGreaterThan(1);
    expect(h.runtime.events().some((event) => event.kind === 'job.started' && event.subject === 'synthetic-job')).toBe(
      true,
    );
    for (const entry of seen) {
      expect(entry).toEqual({
        cpu: 0.9,
        memory: 'critical',
        currentCpu: 0.9,
        currentMemory: 'critical',
        latch: 'critical',
        event: true,
      });
    }
    off();
    h.presenter.close();
    await h.runtime.stop();
  });

  it('anchors delayed rate points and ETA to the same observation time as the fact', async () => {
    const h = await harness();
    const start = Date.now();
    const gib = 1024 ** 3;
    for (const [delay, observed, free] of [
      [0, 0, 80],
      [10_000, 10_000, 76],
      [10_000, 15_000, 75],
    ]) {
      await h.advance(delay);
      const disks = diskFact([{ mount: '/', total: 100 * gib, free: free * gib, observedAt: start + observed }]);
      disks.observedAt = start + observed;
      await h.sample(mkBody({ disks }));
    }
    const model = h.presenter.snapshot();
    expect(model.state.self.body.disks.value?.[0].observedAt).toBe(start + 15_000);
    const eta = model.insights?.['disk:/']?.currentEta;
    expect(eta?.asOf).toBe(start + 15_000);
    expect((eta?.ratePerMinute ?? 0) / gib).toBeCloseTo(-20.5714285714, 6);
    h.presenter.close();
    await h.runtime.stop();
  });

  it('keeps fact and rate anchors aligned if wall time jumps after sample receipt', async () => {
    const h = await harness();
    const start = Date.now();
    const gib = 1024 ** 3;
    for (const [delay, observed, free] of [
      [0, 0, 80],
      [10_000, 10_000, 76],
      [10_000, 15_000, 75],
    ]) {
      await h.advance(delay);
      const disks = diskFact([{ mount: '/', total: 100 * gib, free: free * gib, observedAt: start + observed }]);
      disks.observedAt = start + observed;
      h.sampleRaw(mkBody({ disks }));
      if (free === 75) vi.setSystemTime(Date.now() + 61_000);
      await h.settle();
    }
    const model = h.presenter.snapshot();
    expect(model.state.self.body.disks.value?.[0].observedAt).toBe(start + 15_000);
    expect(model.insights?.['disk:/']?.currentEta?.asOf).toBe(start + 15_000);
    h.presenter.close();
    await h.runtime.stop();
  });

  it('uses the existing token fact anchor when the wall clock jumps before its first rate sample', async () => {
    const h = await harness();
    const start = Date.now();
    h.tokens({
      contextWindow: 1_000,
      contextUsed: 100,
      contextWindowSource: 'configured',
      sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    vi.setSystemTime(Date.now() + 61_000);
    await h.sample(mkBody());
    expect(h.presenter.snapshot().state.self.body.tokens.observedAt).toBe(start);
    expect(h.runtime.body.monitor.rateEvidence('context').points).toEqual([{ mono: 0, value: 900 }]);
    h.presenter.close();
    await h.runtime.stop();
  });

  it('attributes tokens floor severity to the current session latch only', async () => {
    const h = await harness();
    const snapshot = (used: number) => ({
      contextWindow: 1_000,
      contextUsed: used,
      contextWindowSource: 'configured' as const,
      sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    // Session A at 96%: its own context latch goes critical.
    await h.agent({ type: 'created', sessionId: 'a' });
    h.tokens(snapshot(960));
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    await h.agent({ type: 'post-step', sessionId: 'a' });
    await h.sample(mkBody());
    expect(h.presenter.snapshot().insights?.tokens?.severity).toBe('critical');
    // Session B at 5%: the token fact refreshes before B's first body
    // sample — A's critical latch must not bleed into B's insight.
    await h.agent({ type: 'created', sessionId: 'b' });
    h.tokens(snapshot(50));
    await h.agent({ type: 'pre-step', sessionId: 'b' });
    await h.agent({ type: 'post-step', sessionId: 'b' });
    expect(h.presenter.snapshot().state.self.body.tokens.value?.contextUsed).toBe(50);
    expect(h.presenter.snapshot().insights?.tokens?.severity).toBeUndefined();
    await h.sample(mkBody());
    expect(h.presenter.snapshot().insights?.tokens?.severity).toBeUndefined();
    // Back on A: its own latch (not a stale global) still projects critical.
    h.tokens(snapshot(960));
    await h.agent({ type: 'pre-step', sessionId: 'a' });
    await h.agent({ type: 'post-step', sessionId: 'a' });
    expect(h.presenter.snapshot().insights?.tokens?.severity).toBe('critical');
    h.presenter.close();
    await h.runtime.stop();
  });

  it('exposes only old or complete body snapshots to synchronous reentrant readers during commit', async () => {
    const h = await harness();
    const body = (cpu: number, pressure: 'normal' | 'critical') =>
      mkBody({
        cpu: { ...f({ usage: cpu, perCore: [cpu], load1: 0, load5: 0, load15: 0 }), observedAt: Date.now() },
        memory: { ...f({ total: 100, used: 90, pressure, swapUsed: 0 }), observedAt: Date.now() },
      });
    await h.sample(body(0.1, 'normal'));
    await h.advance(1_000);
    const read = () => ({
      cpu: h.runtime.state().self.body.cpu.value?.usage,
      memory: h.runtime.state().self.body.memory.value?.pressure,
      latch: h.runtime.body.monitor.restoredState?.memory,
      event: h.runtime.events().some((event) => event.kind === 'body.threshold' && event.subject === 'memory'),
    });
    const old = read();
    const seen: ReturnType<typeof read>[] = [];
    h.observeClock(() => seen.push(read()));
    await h.sample(body(0.9, 'critical'));
    h.observeClock();
    const fresh = read();
    expect(fresh).toEqual({ cpu: 0.9, memory: 'critical', latch: 'critical', event: true });
    expect(seen).toContainEqual(old);
    expect(seen).toContainEqual(fresh);
    expect(
      seen.filter(
        (entry) => JSON.stringify(entry) !== JSON.stringify(old) && JSON.stringify(entry) !== JSON.stringify(fresh),
      ),
    ).toEqual([]);
    h.presenter.close();
    await h.runtime.stop();
  });

  it('counts down a disk parent until its last fresh volume expires', async () => {
    const h = await harness();
    const now = Date.now();
    const disks = diskFact([
      { mount: '/a', total: 100, free: 80, observedAt: now, ttlMs: 4_000, status: 'ok' },
      { mount: '/b', total: 100, free: 80, observedAt: now, ttlMs: 10_000, status: 'ok' },
    ]);
    disks.observedAt = now;
    disks.ttlMs = 4_000;
    await h.sample(mkBody({ disks }));
    let result = h.presenter.snapshot().state.self.body.disks;
    expect(result.staleInMs).toBe(10_000);
    expect(result.value?.map((volume) => volume.staleInMs)).toEqual([4_000, 10_000]);
    await h.advance(4_000);
    result = h.presenter.snapshot().state.self.body.disks;
    expect(h.runtime.state().self.body.disks.status).toBe('ok');
    expect(result.status).toBe('ok');
    expect(result.staleInMs).toBe(6_000);
    await h.advance(6_000);
    expect(h.runtime.state().self.body.disks.status).toBe('stale');
    expect(h.presenter.snapshot().state.self.body.disks.status).toBe('stale');
    h.presenter.close();
    await h.runtime.stop();
  });

  it('requires three new rate points after an unavailable reading', async () => {
    const h = await harness();
    const gib = 1024 ** 3;
    const disk = async (free: number) => {
      const disks = diskFact([{ mount: '/', total: 100 * gib, free: free * gib, observedAt: Date.now() }]);
      disks.observedAt = Date.now();
      await h.sample(mkBody({ disks }));
    };
    await disk(80);
    await h.advance(10_000);
    await disk(76);
    await h.advance(10_000);
    await disk(75);
    expect(h.presenter.snapshot().insights?.['disk:/']?.currentEta).toBeDefined();
    await h.advance(10_000);
    await h.sample(mkBody({ disks: diskFact(null, 'unavailable') }));
    await h.advance(10_000);
    await disk(74);
    expect(h.presenter.snapshot().insights?.['disk:/']?.currentEta).toBeUndefined();
    expect(h.runtime.body.monitor.rateEvidence('disk:/')).toMatchObject({
      latched: true,
      points: [{ value: 74 * gib }],
    });
    await h.advance(10_000);
    await disk(72);
    expect(h.presenter.snapshot().insights?.['disk:/']?.currentEta).toBeUndefined();
    await h.advance(10_000);
    await disk(70);
    expect(h.presenter.snapshot().insights?.['disk:/']?.currentEta).toBeDefined();
    h.presenter.close();
    await h.runtime.stop();
  });

  it('does not add rate evidence or refresh asOf when cached disk readings are republished', async () => {
    const h = await harness();
    const gib = 1024 ** 3;
    const disk = (free: number) => {
      const disks = diskFact([{ mount: '/', total: 100 * gib, free: free * gib, observedAt: Date.now() }]);
      disks.observedAt = Date.now();
      return mkBody({ disks });
    };
    const first = disk(80);
    await h.sample(first);
    for (let i = 0; i < 4; i++) {
      await h.advance(2_000);
      await h.sample(structuredClone(first));
    }
    expect(h.runtime.body.monitor.rateEvidence('disk:/').points).toHaveLength(1);
    await h.advance(2_000);
    const second = disk(76);
    await h.sample(second);
    await h.advance(2_000);
    await h.sample(structuredClone(second));
    expect(h.runtime.body.monitor.rateEvidence('disk:/').points).toHaveLength(2);
    expect(h.presenter.snapshot().insights?.['disk:/']?.currentEta).toBeUndefined();
    await h.advance(8_000);
    await h.sample(disk(75));
    const asOf = h.presenter.snapshot().insights?.['disk:/']?.currentEta?.asOf;
    expect(asOf).toBe(Date.now());
    await h.advance(2_000);
    const third = disk(75);
    if (!third.disks.value) throw new Error('missing disk');
    third.disks.value[0].observedAt = Date.now() - 2_000;
    third.disks.observedAt = Date.now() - 2_000;
    await h.sample(third);
    expect(h.presenter.snapshot().insights?.['disk:/']?.currentEta?.asOf).toBe(asOf);
    expect(h.runtime.body.monitor.rateEvidence('disk:/').points).toHaveLength(3);
    h.presenter.close();
    await h.runtime.stop();
  });

  it('retains cached rate evidence across a forward wall jump', async () => {
    const h = await harness();
    const gib = 1024 ** 3;
    let last = mkBody();
    for (const free of [80, 76, 75]) {
      if (free !== 80) await h.advance(10_000);
      const disks = diskFact([{ mount: '/', total: 100 * gib, free: free * gib, observedAt: Date.now() }]);
      disks.observedAt = Date.now();
      last = mkBody({ disks });
      await h.sample(last);
    }
    const asOf = h.presenter.snapshot().insights?.['disk:/']?.currentEta?.asOf;
    vi.setSystemTime(Date.now() + 61_000);
    await h.advance(2_000);
    await h.sample(structuredClone(last));
    expect(h.runtime.body.monitor.rateEvidence('disk:/').points).toHaveLength(3);
    expect(h.presenter.snapshot().insights?.['disk:/']?.currentEta?.asOf).toBe(asOf);
    h.presenter.close();
    await h.runtime.stop();
  });

  it('projects runtime status and a monotonic stale countdown across wall jumps', async () => {
    const h = await harness();
    const cpu = {
      ...f({ usage: 0.5, perCore: [0.5], load1: 0, load5: 0, load15: 0 }),
      observedAt: Date.now(),
      ttlMs: 5_000,
    };
    await h.sample(mkBody({ cpu }));
    expect(h.presenter.snapshot().state.self.body.cpu).toMatchObject({ status: 'ok', staleInMs: 5_000 });
    vi.setSystemTime(Date.now() + 61_000);
    await h.advance(2_000);
    expect(h.presenter.snapshot().state.self.body.cpu).toMatchObject({ status: 'ok', staleInMs: 3_000 });
    vi.setSystemTime(Date.now() - 122_000);
    await h.advance(3_000);
    const expired = h.presenter.snapshot().state.self.body.cpu;
    expect(expired.status).toBe('stale');
    expect(expired.staleInMs).toBeUndefined();
    h.presenter.close();
    await h.runtime.stop();
  });

  it('keeps an active rate ETA after the triggering event is evicted', async () => {
    const h = await harness();
    const gib = 1024 ** 3;
    for (const free of [80, 76, 75]) {
      if (free !== 80) await h.advance(10_000);
      const disks = diskFact([{ mount: '/', total: 100 * gib, free: free * gib, observedAt: Date.now() }]);
      disks.observedAt = Date.now();
      await h.sample(mkBody({ disks }));
    }
    for (let i = 0; i < 201; i++) await h.job({ type: 'exited', id: `job-${i}`, exitCode: 0 });
    expect(h.runtime.events().some((event) => event.kind === 'body.rate')).toBe(false);
    expect(h.presenter.snapshot().insights?.['disk:/']?.currentEta?.ratePerMinute).toBeCloseTo(-15 * gib, 3);
    h.presenter.close();
    await h.runtime.stop();
  });

  it.each([30_000, -30_000])('uses monotonic rate evidence across a %i ms wall clock jump', async (jump) => {
    const h = await harness();
    const gib = 1024 ** 3;
    for (const [i, free] of [80, 76, 75].entries()) {
      if (i) await h.advance(10_000);
      if (i === 2) vi.setSystemTime(Date.now() + jump);
      const disks = diskFact([{ mount: '/', total: 100 * gib, free: free * gib, observedAt: Date.now() }]);
      disks.observedAt = Date.now();
      await h.sample(mkBody({ disks }));
    }
    const eta = h.presenter.snapshot().insights?.['disk:/']?.currentEta;
    expect(eta?.asOf).toBe(Date.now() - jump);
    expect(eta?.ratePerMinute).toBeCloseTo(-15 * gib, 3);
    expect(eta?.timeToThresholdMs).toBeCloseTo((70 / 15) * 60_000, 3);
    const evidence = h.runtime.body.monitor.rateEvidence('disk:/');
    expect(evidence).toMatchObject({ latched: true, asOf: Date.now(), ratePerMinute: -15 * gib });
    expect(evidence.points.map((point) => point.mono)).toEqual([0, 10_000, 20_000]);
    evidence.points[0].value = 0;
    expect(h.runtime.body.monitor.rateEvidence('disk:/').points[0].value).toBe(80 * gib);
    h.presenter.close();
    await h.runtime.stop();
  });

  it.each([61_000, -61_000])('keeps all frame time differences stable across a %i ms wall jump', async (jump) => {
    const h = await harness();
    const gib = 1024 ** 3;
    for (const free of [80, 76, 75]) {
      if (free !== 80) await h.advance(10_000);
      const disks = diskFact([{ mount: '/', total: 100 * gib, free: free * gib, observedAt: Date.now() }]);
      disks.observedAt = Date.now();
      await h.sample(
        mkBody({
          disks,
          cpu: { ...f({ usage: 0.5, perCore: [0.5], load1: 0, load5: 0, load15: 0 }), observedAt: Date.now() },
        }),
      );
    }
    await h.job({ type: 'started', id: 'synthetic' });
    await h.advance(2_000);
    const before = h.presenter.snapshot();
    expect(before.state.self.body.cpu.staleInMs).toBe(58_000);
    expect(before.state.self.body.disks.value?.[0].staleInMs).toBe(58_000);
    const differences = (frame: typeof before) => {
      const point = frame.history.cpu.at(-1);
      const eta = frame.insights?.['disk:/']?.currentEta;
      const event = frame.events.find((e) => e.signal.kind === 'job.started');
      if (!point || !eta || !event) throw new Error('missing timeline evidence');
      return {
        now: frame.now,
        cpuAge: frame.now - frame.state.self.body.cpu.observedAt,
        cpuStaleIn: frame.state.self.body.cpu.staleInMs,
        diskStaleIn: frame.state.self.body.disks.value?.[0].staleInMs,
        historyAge: frame.now - point.at,
        etaAge: frame.now - eta.asOf,
        eventAge: frame.now - event.signal.at,
      };
    };
    vi.setSystemTime(Date.now() + jump);
    const after = h.presenter.snapshot();
    expect(differences(after)).toEqual(differences(before));
    expect(after.state.self.body.disks.status).toBe('ok');
    await h.advance(1_000);
    const disks = diskFact([{ mount: '/', total: 100 * gib, free: 74 * gib, observedAt: Date.now() }]);
    disks.observedAt = Date.now();
    await h.sample(mkBody({ disks }));
    await h.job({ type: 'exited', id: 'synthetic' });
    await h.runtime.tools.bodyTune({ param: 'rate.rss.maxRatio', to: 0.6 });
    const next = h.presenter.snapshot();
    expect(next.now - before.now).toBe(1_000);
    expect(next.state.self.body.disks.value?.[0].observedAt).toBe(next.now);
    expect(next.insights?.['disk:/']?.currentEta?.asOf).toBe(next.now);
    expect(next.history.disks['/'].at(-1)?.at).toBe(next.now);
    expect(next.events.find((e) => e.signal.kind === 'job.exited')?.signal.at).toBe(next.now);
    expect(next.state.observation.sources.dsh.lastSignalAt).toBe(next.now);
    expect(next.tuning.log.at(-1)?.at).toBe(next.now);
    h.presenter.close();
    await h.runtime.stop();
  });

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
    expect(frame.history.cpu.map((point) => point.value)).toEqual([0.2]);
    expect(frame.history.memory).toHaveLength(1);
    expect(frame.sampleIntervalsMs?.cpu).toBe(1_000);
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

  it('projects self-caused events as suppressed without changing their reason or cause', async () => {
    const h = await harness();
    vi.spyOn(h.runtime, 'events').mockReturnValue([
      {
        id: 'self-caused',
        kind: 'process.exited',
        subject: 'false',
        at: Date.now(),
        level: 'record',
        reason: 'self-caused',
        cause: 'agent',
        source: { id: 'synthetic', api: 'dsh', host: 'local' },
      },
    ]);
    expect(h.presenter.snapshot().events[0]).toMatchObject({
      level: 'suppressed',
      reason: 'self-caused',
      cause: 'agent',
      signal: { subject: 'false' },
    });
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

  it('distinguishes reverted, superseded, rejected and undoable tuning entries', async () => {
    const h = await harness();
    const first = await h.runtime.tools.bodyTune({ param: 'rate.rss.maxRatio', to: 0.6 });
    const second = await h.runtime.tools.bodyTune({ param: 'rate.rss.maxRatio', to: 0.7 });
    const rejected = await h.runtime.tools.bodyTune({ param: 'rate.rss.maxRatio', to: 100 });
    const before = h.presenter.snapshot().tuning.log;
    expect(before.find((entry) => entry.id === first.change.id)).toMatchObject({
      status: 'superseded',
      undoable: false,
      reverted: false,
    });
    expect(before.find((entry) => entry.id === second.change.id)).toMatchObject({
      status: 'undoable',
      undoable: true,
      reverted: false,
    });
    expect(before.find((entry) => entry.id === rejected.change.id)).toMatchObject({
      status: 'rejected',
      undoable: false,
      reverted: false,
    });
    await h.runtime.actions.revertTuning(first.change.id);
    await h.runtime.actions.lockParam('rate.rss.maxRatio', true);
    const attempts = h.presenter.snapshot().tuning.log;
    expect(attempts.find((entry) => entry.id === first.change.id)).toMatchObject({
      status: 'superseded',
      reverted: false,
    });
    expect(attempts.at(-1)).toMatchObject({ status: 'other', undoable: false, reverted: false });
    await h.runtime.actions.revertTuning(second.change.id);
    const after = h.presenter.snapshot().tuning.log;
    expect(after.find((entry) => entry.id === second.change.id)).toMatchObject({
      status: 'reverted',
      undoable: false,
      reverted: true,
    });
    expect(after.find((entry) => entry.id === first.change.id)).toMatchObject({
      status: 'superseded',
      reverted: false,
    });
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
    await h.agent({ type: 'created', sessionId: 's' });
    for (const [window, used] of [
      [1000, 0],
      [1000, 200],
      [1200, 500],
    ] as const) {
      if (used) await h.advance(70_000);
      h.tokens({
        contextWindow: window,
        contextUsed: used,
        sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
      await h.agent({ type: used ? 'post-step' : 'pre-step', sessionId: 's' });
      await h.sample(mkBody());
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
    await h.agent({ type: 'created', sessionId: 's' });
    for (const [used, source] of [
      [0, 'fallback'],
      [100, 'fallback'],
      [200, 'configured'],
      [300, 'configured'],
      [400, 'configured'],
    ] as const) {
      if (used) await h.advance(10_000);
      h.tokens({
        contextWindow: 1000,
        contextUsed: used,
        contextWindowSource: source,
        sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
      await h.agent({ type: used ? 'post-step' : 'pre-step', sessionId: 's' });
      await h.sample(mkBody());
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
      onResumeTuning: async () => {},
      onResetTuning: async () => {},
      onAcceptRebaseline: async () => {},
    };
    props.model.state.env.activeJobs = {
      ...props.model.state.env.activeJobs,
      status: 'ok',
      value: [
        { id: 'owned', name: 'owned fixture', owner: 'session-a', status: 'running' },
        { id: 'orphan', name: 'orphan fixture', status: 'running' },
      ],
    };
    const html = renderToString(React.createElement(ui.SensePanel, props));
    expect(html).toContain('环境感知');
    expect(html).toContain('owned fixture（running）');
    expect(html).toContain('orphan fixture（running · 无主）');
    h.presenter.close();
    await h.runtime.stop();
  });
});
