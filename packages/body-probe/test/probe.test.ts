import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BodyProbe, type ProbeCollectors } from '../src/probe.js';
import * as fact from '../src/fact.js';
import type { Body, Fact, TokensValue } from '../src/types.js';

const src = (api: string) => fact.source('test', api);
const ok = <T>(v: T, api = 'fake'): Fact<T> => fact.ok(v, src(api));

const baseCollectors = (): ProbeCollectors => ({
  cpu: async (ttl) => fact.ok({ usage: 0.5, perCore: [0.5], load1: 1, load5: 1, load15: 1 }, src('cpu'), ttl),
  memory: async (ttl) => fact.ok({ total: 1, used: 1, pressure: 'normal', swapUsed: 0 }, src('mem'), ttl),
  disks: async (_cwd, ttl) => fact.ok([{ mount: '/', total: 10, free: 5 }], src('disks'), ttl),
  battery: async (ttl) => fact.ok(null, src('batt'), ttl),
  network: async (ttl) => fact.ok({ online: true, rxBps: 1, txBps: 1 }, src('net'), ttl),
  process: async (_pid, ttl) => fact.ok({ rss: 1, cpu: 0.1, uptimeSec: 5 }, src('proc'), ttl),
});

const tokenFact = (ttl = 12345): Fact<TokensValue> =>
  fact.ok({ sessionUsage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }, src('tokenSource'), ttl);

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('BodyProbe', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits an immediate sample then follows the cadence', async () => {
    const probe = new BodyProbe(baseCollectors());
    const seen: Body[] = [];
    probe.onSample((b) => seen.push(b));
    probe.start({ intervalMs: 2000, tokenSource: { read: async () => tokenFact() } });
    await flush();
    expect(seen).toHaveLength(1);
    expect(probe.latest()?.cpu.value?.usage).toBe(0.5);
    await vi.advanceTimersByTimeAsync(4000);
    expect(seen).toHaveLength(3);
    await probe.stop();
  });

  it('rejects invalid interval and history arguments', async () => {
    const probe = new BodyProbe(baseCollectors());
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => probe.start({ intervalMs: bad })).toThrow(RangeError);
      expect(() => probe.history(bad)).toThrow(RangeError);
    }
    // Node timers cannot delay beyond 2^31-1ms; reject instead of firing ~1ms.
    for (const bad of [2147483648, 3e9]) {
      expect(() => probe.start({ intervalMs: bad })).toThrow(RangeError);
    }
    expect(probe.history(4000)).toEqual([]); // large windows clamp to 300s
    expect(() => probe.start()).not.toThrow();
    await probe.stop();
  });

  it('marks ok facts stale in latest() once older than ttl without mutating history', async () => {
    const probe = new BodyProbe(baseCollectors());
    probe.start({ intervalMs: 2000 });
    await flush();
    expect(probe.latest()?.cpu.status).toBe('ok');
    expect(probe.latest()?.cpu.ttlMs).toBe(6000);
    await probe.stop();
    await vi.advanceTimersByTimeAsync(7000);
    expect(probe.latest()?.cpu.status).toBe('stale');
    const point = probe.history()[0]!;
    expect(point.body.cpu.status).toBe('ok');
  });

  it('unsubscribes listeners and isolates thrown errors and mutations', async () => {
    const probe = new BodyProbe(baseCollectors());
    const seen: number[] = [];
    probe.onSample((b) => { b.cpu.value!.usage = 999; throw new Error('listener bug'); });
    probe.onSample((b) => seen.push(b.cpu.value!.usage));
    const off = probe.onSample(() => seen.push(-1));
    off();
    off(); // idempotent
    probe.start({ intervalMs: 2000 });
    await flush();
    expect(seen).toEqual([0.5]);
    expect(probe.latest()?.cpu.value?.usage).toBe(0.5);
    await probe.stop();
  });

  it('does not overlap ticks while a collector is still pending', async () => {
    let resolveCpu!: (f: Fact<never>) => void;
    let calls = 0;
    const collectors = baseCollectors();
    collectors.cpu = (ttl) => {
      calls += 1;
      return new Promise<Fact<never>>((res) => { resolveCpu = res; });
    };
    const probe = new BodyProbe(collectors);
    const seen: Body[] = [];
    probe.onSample((b) => seen.push(b));
    probe.start({ intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1); // no second tick while the first is pending
    resolveCpu!(fact.ok({ usage: 0.1, perCore: [], load1: 0, load5: 0, load15: 0 }, src('cpu')) as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(1);
    await probe.stop();
  });

  it('suppresses samples that finish after stop()', async () => {
    let resolveCpu!: (f: Fact<never>) => void;
    const collectors = baseCollectors();
    collectors.cpu = () => new Promise<Fact<never>>((res) => { resolveCpu = res; });
    const probe = new BodyProbe(collectors);
    const seen: Body[] = [];
    probe.onSample((b) => seen.push(b));
    probe.start({ intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    const stopping = probe.stop();
    resolveCpu!(fact.ok({ usage: 1, perCore: [], load1: 0, load5: 0, load15: 0 }, src('cpu')) as never);
    await stopping;
    await vi.advanceTimersByTimeAsync(5000);
    expect(seen).toHaveLength(0);
    expect(probe.latest()).toBeNull();
  });

  it('keeps history chronological, clamped to 300s, filtered at call time after stop', async () => {
    const probe = new BodyProbe(baseCollectors());
    probe.start({ intervalMs: 100_000 });
    for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(100_000);
    const all = probe.history();
    expect(all.length).toBeLessThanOrEqual(4); // capacity ceil(300000/100000)+1 = 4
    const ats = all.map((p) => p.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
    expect(probe.history(400).length).toBe(all.length); // clamps to 300s
    await probe.stop();
    await vi.advanceTimersByTimeAsync(301_000);
    expect(probe.history()).toHaveLength(0); // age expiry applies after stop too
  });

  it('returns cloned points so history consumers cannot mutate the ring', async () => {
    const probe = new BodyProbe(baseCollectors());
    probe.start({ intervalMs: 2000 });
    await flush();
    const p = probe.history()[0]!;
    p.body.cpu.value!.usage = -42;
    p.at = 0;
    expect(probe.latest()?.cpu.value?.usage).toBe(0.5);
    expect(probe.history()[0]!.at).not.toBe(0);
    await probe.stop();
  });

  it('maps missing/throwing/slow tokenSource to an unavailable tokens fact', async () => {
    const probe = new BodyProbe(baseCollectors());
    probe.start({ intervalMs: 2000 });
    await flush();
    expect(probe.latest()?.tokens.status).toBe('unavailable');
    await probe.stop();

    const rejecting = new BodyProbe(baseCollectors());
    rejecting.start({ intervalMs: 2000, tokenSource: { read: async () => { throw new Error('meter down'); } } });
    await flush();
    expect(rejecting.latest()?.tokens.status).toBe('unavailable');
    await rejecting.stop();

    const hanging = new BodyProbe(baseCollectors());
    let released!: () => void;
    hanging.start({
      intervalMs: 2000,
      tokenSource: { read: () => new Promise<Fact<TokensValue>>((res) => { released = () => res(tokenFact()); }) },
    });
    await vi.advanceTimersByTimeAsync(1001);
    expect(hanging.latest()?.tokens.status).toBe('unavailable');
    await hanging.stop();
    released();
  });

  it('preserves the external token fact ttl and source', async () => {
    const probe = new BodyProbe(baseCollectors());
    probe.start({ intervalMs: 2000, tokenSource: { read: async () => tokenFact(12345) } });
    await flush();
    const tokens = probe.latest()?.tokens;
    expect(tokens?.status).toBe('ok');
    expect(tokens?.ttlMs).toBe(12345);
    expect(tokens?.source.api).toBe('tokenSource');
    await probe.stop();
  });

  it('keeps the thermal placeholder unavailable via ProcessInfo.thermalState', async () => {
    const probe = new BodyProbe(baseCollectors());
    probe.start({ intervalMs: 2000 });
    await flush();
    const thermal = probe.latest()?.thermal;
    expect(thermal?.status).toBe('unavailable');
    expect(thermal?.value).toBeNull();
    expect(thermal?.source.api).toBe('ProcessInfo.thermalState');
    await probe.stop();
  });

  it('serializes a restart behind a still-pending previous sample', async () => {
    let calls = 0;
    let resolveFirst!: (f: Fact<never>) => void;
    const collectors = baseCollectors();
    collectors.cpu = (ttl) => {
      calls += 1;
      if (calls === 1) return new Promise<Fact<never>>((res) => { resolveFirst = res; });
      return Promise.resolve(fact.ok(
        { usage: 0.9, perCore: [], load1: 0, load5: 0, load15: 0 }, src('cpu'), ttl) as never);
    };
    const probe = new BodyProbe(collectors);
    const seen: Body[] = [];
    probe.onSample((b) => seen.push(b));
    probe.start({ intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    const stopped = probe.stop();
    probe.start({ intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1); // new generation must wait for the pending tick
    resolveFirst(fact.ok({ usage: 0.1, perCore: [], load1: 0, load5: 0, load15: 0 }, src('cpu')) as never);
    await stopped;
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    expect(seen).toHaveLength(1); // the obsolete generation never published
    expect(seen[0]!.cpu.value?.usage).toBe(0.9);
    await probe.stop();
  });

  it('start/stop are safe to repeat and stop leaves no timers behind', async () => {
    const probe = new BodyProbe(baseCollectors());
    probe.start({ intervalMs: 2000 });
    probe.start({ intervalMs: 2000 });
    await flush();
    await probe.stop();
    await probe.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(probe.latest()).not.toBeNull(); // latest remains readable
  });
});
