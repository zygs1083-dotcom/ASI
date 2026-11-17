import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { effectiveDisks, factStatusAt } from '@asi/sense-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as command from '../src/command.js';
import { type ExecFn, type RunFn, runCommand } from '../src/command.js';
import * as fact from '../src/fact.js';
import { MemorySampler } from '../src/memory.js';
import { NetworkSampler } from '../src/network.js';
import { BodyProbe, type ProbeCollectors } from '../src/probe.js';
import type { Body, Fact, TokensValue } from '../src/types.js';

const src = (api: string) => fact.source('test', api);
const ok = <T>(v: T, api = 'fake'): Fact<T> => fact.ok(v, src(api));
const fx = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const baseCollectors = (): ProbeCollectors => ({
  cpu: async (ttl) => fact.ok({ usage: 0.5, perCore: [0.5], load1: 1, load5: 1, load15: 1 }, src('cpu'), ttl),
  memory: async (ttl) => fact.ok({ total: 1, used: 1, pressure: 'normal', swapUsed: 0 }, src('mem'), ttl),
  disks: async (_cwd, ttl) => ({ ...fact.ok([{ mount: '/', total: 10, free: 5 }], src('disks'), ttl), kind: 'disks' }),
  battery: async (ttl) => fact.ok(null, src('batt'), ttl),
  network: async (ttl) => fact.ok({ online: true, rxBps: 1, txBps: 1 }, src('net'), ttl),
  process: async (_pid, ttl) => fact.ok({ rss: 1, cpu: 0.1, uptimeSec: 5 }, src('proc'), ttl),
});

const tokenFact = (ttl = 12345): Fact<TokensValue> =>
  fact.ok({ sessionUsage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }, src('tokenSource'), ttl);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

const fakeEn0 = () =>
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    en0: [{ address: '10.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: 'aa', internal: false, cidr: null }],
  });

describe('BodyProbe', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

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

  it('preserves the disk discriminator for frozen collectors and collection failures', async () => {
    for (const fails of [false, true]) {
      const collectors = baseCollectors();
      collectors.disks = async () => {
        if (fails) throw new Error('fixture failure');
        return Object.freeze({
          ...fact.ok([{ mount: '/', total: 10, free: 5 }], src('disks')),
          kind: 'disks' as const,
        });
      };
      const probe = new BodyProbe(collectors);
      probe.start();
      await flush();
      expect(probe.history()[0]!.body.disks.kind).toBe('disks');
      expect(probe.latest()!.disks).toMatchObject({ kind: 'disks', status: fails ? 'unknown' : 'ok' });
      await probe.stop();
    }
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

  it('reaggregates disk freshness between publications at each exact deadline', async () => {
    const t0 = Date.now();
    const collectors = baseCollectors();
    collectors.disks = async () => ({
      kind: 'disks',
      value: [
        { mount: '/', total: 100, free: 2, status: 'ok', observedAt: t0, ttlMs: 6000 },
        { mount: '/b', total: 100, free: 90, status: 'ok', observedAt: t0 + 2000, ttlMs: 30000 },
      ],
      status: 'ok',
      source: src('disks'),
      observedAt: t0,
      ttlMs: 6000,
      unavailableMounts: ['/missing'],
    });
    const probe = new BodyProbe(collectors);
    probe.start({ intervalMs: 2000 });
    await flush();
    await probe.stop();
    const original = probe.history()[0]!.body.disks;
    expect(effectiveDisks(original, t0 + 6500)).toMatchObject({
      status: 'ok',
      observedAt: t0 + 2000,
      ttlMs: 30000,
      indeterminateMounts: ['/', '/missing'],
    });
    await vi.advanceTimersByTimeAsync(6000);
    expect(probe.latest()!.disks.value?.[0]?.status).toBe('stale');
    await vi.advanceTimersByTimeAsync(500);
    expect(probe.latest()!.disks).toMatchObject({
      status: 'ok',
      observedAt: t0 + 2000,
      ttlMs: 30000,
      value: [{ status: 'stale' }, { status: 'ok' }],
    });
    await vi.advanceTimersByTimeAsync(25500);
    expect(probe.latest()!.disks.status).toBe('stale');
    expect(effectiveDisks({ ...original, status: 'denied' }, t0 + 6500).status).toBe('denied');
    expect(effectiveDisks({ ...original, status: 'unsupported' }, t0 + 6500).status).toBe('unsupported');
    expect(effectiveDisks({ ...original, value: null }, t0 + 6500).status).toBe('unknown');
    expect(effectiveDisks({ ...original, value: null }, t0 + 6500).status).toBe('unknown');
    expect(effectiveDisks({ ...original, value: [] }, t0 + 6500).status).toBe('unknown');
    expect(
      factStatusAt({ value: [], status: 'ok', source: original.source, observedAt: t0, ttlMs: 30000 }, t0 + 6500),
    ).toBe('ok');
    expect(probe.history()[0]!.body.disks).toEqual(original);
  });

  it('aggregates mixed stale and unavailable volumes without letting unavailable metadata win', () => {
    const at = Date.now();
    const disks = {
      kind: 'disks' as const,
      status: 'ok' as const,
      source: src('disks'),
      observedAt: at,
      ttlMs: 30_000,
      value: [
        { mount: '/stale', total: 100, free: 50, status: 'stale' as const, observedAt: at - 10_000, ttlMs: 10_000 },
        {
          mount: '/missing',
          total: 100,
          free: 50,
          status: 'unavailable' as const,
          observedAt: at - 20_000,
          ttlMs: 1_000,
        },
      ],
    };
    expect(fact.disksAt(disks, 0, at)).toMatchObject({ status: 'stale', observedAt: at - 10_000, ttlMs: 10_000 });
    expect(fact.disksAt({ ...disks, value: [disks.value[1]!] }, 0, at).status).toBe('unknown');
  });

  it('uses monotonic disk deadlines after wall-clock jumps', async () => {
    const t0 = Date.now();
    const collectors = baseCollectors();
    collectors.disks = async () => ({
      kind: 'disks',
      value: [
        { mount: '/', total: 100, free: 2, status: 'ok', observedAt: t0, ttlMs: 6000 },
        { mount: '/b', total: 100, free: 90, status: 'ok', observedAt: t0, ttlMs: 30000 },
      ],
      status: 'ok',
      source: src('disks'),
      observedAt: t0,
      ttlMs: 6000,
    });
    const probe = new BodyProbe(collectors);
    probe.start({ intervalMs: 2000 });
    await flush();
    await probe.stop();
    vi.setSystemTime(t0 + 3_600_000);
    expect(probe.latest()!.disks.value?.map((v) => v.status)).toEqual(['ok', 'ok']);
    await vi.advanceTimersByTimeAsync(6000);
    expect(probe.latest()!.disks).toMatchObject({ status: 'ok', value: [{ status: 'stale' }, { status: 'ok' }] });
    vi.setSystemTime(t0 - 3_600_000);
    expect(probe.latest()!.disks.value?.map((v) => v.status)).toEqual(['stale', 'ok']);
    await vi.advanceTimersByTimeAsync(24000);
    expect(probe.latest()!.disks.status).toBe('stale');
  });

  it('unsubscribes listeners and isolates thrown errors and mutations', async () => {
    const probe = new BodyProbe(baseCollectors());
    const seen: number[] = [];
    probe.onSample((b) => {
      b.cpu.value!.usage = 999;
      throw new Error('listener bug');
    });
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
      return new Promise<Fact<never>>((res) => {
        resolveCpu = res;
      });
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
    collectors.cpu = () =>
      new Promise<Fact<never>>((res) => {
        resolveCpu = res;
      });
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
    rejecting.start({
      intervalMs: 2000,
      tokenSource: {
        read: async () => {
          throw new Error('meter down');
        },
      },
    });
    await flush();
    expect(rejecting.latest()?.tokens.status).toBe('unavailable');
    await rejecting.stop();

    const hanging = new BodyProbe(baseCollectors());
    let released!: () => void;
    hanging.start({
      intervalMs: 2000,
      tokenSource: {
        read: () =>
          new Promise<Fact<TokensValue>>((res) => {
            released = () => res(tokenFact());
          }),
      },
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

  it('restarts immediately without waiting for a still-pending previous sample', async () => {
    let calls = 0;
    let resolveFirst!: (f: Fact<never>) => void;
    const collectors = baseCollectors();
    collectors.cpu = (ttl) => {
      calls += 1;
      return calls === 1
        ? new Promise<Fact<never>>((res) => {
            resolveFirst = res;
          })
        : Promise.resolve(
            fact.ok({ usage: 0.9, perCore: [], load1: 0, load5: 0, load15: 0 }, src('cpu'), ttl) as never,
          );
    };
    const probe = new BodyProbe(collectors);
    const seen: number[] = [];
    probe.onSample((b) => seen.push(b.cpu.value!.usage));
    probe.start({ intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    const stopped = probe.stop();
    probe.start({ intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2); // fresh tick runs right away, not behind the old one
    await stopped;
    resolveFirst(fact.ok({ usage: 0.1, perCore: [], load1: 0, load5: 0, load15: 0 }, src('cpu')) as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([0.9]); // obsolete generation never publishes
    await probe.stop();
  });

  it('stop() resolves despite a hung collector and tokenSource, leaving no timers', async () => {
    const collectors = baseCollectors();
    collectors.memory = () => new Promise<Fact<never>>(() => {});
    const probe = new BodyProbe(collectors);
    probe.start({
      intervalMs: 1000,
      tokenSource: { read: () => new Promise<Fact<TokensValue>>(() => {}) },
    });
    await vi.advanceTimersByTimeAsync(0);
    await probe.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(probe.latest()).toBeNull();
  });

  it.each([
    ['stop', ['first']],
    ['restart', ['first', 'first', 'second']],
  ] as const)('cuts off stale dispatch when a listener %ss mid-tick', async (mode, expected) => {
    const probe = new BodyProbe(baseCollectors());
    const seen: string[] = [];
    let once = false;
    probe.onSample(() => {
      seen.push('first');
      if (once) return;
      once = true;
      void probe.stop();
      if (mode === 'restart') probe.start({ intervalMs: 1000 });
    });
    probe.onSample(() => seen.push('second'));
    probe.start({ intervalMs: 1000 });
    await flush();
    expect(seen).toEqual(expected);
    await probe.stop();
  });

  it('samples battery at most every 30s (ttl >=90s), republishing observedAt', async () => {
    const collectors = baseCollectors();
    let batteryCalls = 0;
    collectors.battery = async (ttl) => {
      batteryCalls += 1;
      return fact.ok({ percent: 50, charging: false }, src('batt'), ttl);
    };
    const probe = new BodyProbe(collectors);
    probe.start({ intervalMs: 2000 });
    await flush();
    const firstAt = probe.latest()!.battery.observedAt;
    expect(probe.latest()?.battery.ttlMs).toBe(90_000);
    await vi.advanceTimersByTimeAsync(28_000);
    expect(batteryCalls).toBe(1); // 14 ticks served from cache
    expect(probe.latest()?.battery.observedAt).toBe(firstAt);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(batteryCalls).toBe(2);
    await probe.stop();
  });

  it("stop() waits only for its own generation's commands, not unrelated signals", async () => {
    const foreign = new AbortController();
    const d = deferred<{ stdout: string }>();
    const pending = runCommand(
      '/bin/f',
      [],
      vi.fn<ExecFn>(() => d.promise),
      foreign.signal,
    );
    pending.catch(() => {});
    try {
      const probe = new BodyProbe(baseCollectors());
      probe.start({ intervalMs: 1000 });
      await flush();
      await probe.stop(); // resolves while the foreign command is still pending
    } finally {
      d.resolve({ stdout: 'x' }); // settle + deregister the foreign command
      foreign.abort();
      await pending.catch(() => {});
    }
  });

  it('leaves no timers when a collector synchronously stops the probe mid-tick', async () => {
    const collectors = baseCollectors();
    let probe!: BodyProbe;
    collectors.memory = () => {
      // reentrant stop: aborts the tick mid-setup
      void probe.stop();
      return new Promise<Fact<never>>(() => {});
    };
    probe = new BodyProbe(collectors);
    probe.start({
      intervalMs: 1000,
      tokenSource: { read: () => new Promise<Fact<TokensValue>>(() => {}) },
    });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    await probe.stop();
  });

  it('stop() aborts a real child command and returns only after it exits', async () => {
    vi.useRealTimers(); // the spawned child lives in real time
    const pidFile = path.join(os.tmpdir(), `body-probe-probe-${process.pid}.pid`);
    const collectors = baseCollectors();
    collectors.memory = async (ttl, signal) => {
      await runCommand(
        process.execPath,
        [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 6e4);`,
        ],
        undefined,
        signal,
      );
      return fact.ok({ total: 1, used: 1, pressure: 'normal', swapUsed: 0 }, src('mem'), ttl);
    };
    const probe = new BodyProbe(collectors);
    let pid = 0;
    try {
      probe.start({ intervalMs: 60_000 });
      await vi.waitFor(
        () => {
          pid = Number(fs.readFileSync(pidFile, 'utf8'));
        },
        { timeout: 5000, interval: 20 },
      );
      await probe.stop(); // drains the aborted command through child close
      expect(() => process.kill(pid, 0)).toThrowError(/ESRCH/);
    } finally {
      await probe.stop();
      try {
        if (pid) process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      fs.rmSync(pidFile, { force: true });
    }
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

  it('validates cadence fields like intervalMs', async () => {
    const probe = new BodyProbe(baseCollectors());
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2147483648]) {
      for (const key of ['memoryMs', 'routeMs', 'disksMs'] as const) {
        expect(() => probe.start({ cadence: { [key]: bad } })).toThrow(RangeError);
      }
    }
    expect(() => probe.start({ cadence: { memoryMs: 5000, batteryMs: 1 } })).not.toThrow();
    await probe.stop();
  });

  it.each([
    ['memory', 5000],
    ['network', 5000],
    ['disks', 10_000],
    ['battery', 30_000],
  ] as const)('samples %s on the first tick at/after its %ims period', async (key, periodMs) => {
    const collectors = baseCollectors();
    const spy = vi.spyOn(collectors, key);
    const probe = new BodyProbe(collectors);
    probe.start({ intervalMs: 2000 });
    await flush();
    expect(spy).toHaveBeenCalledTimes(1); // always sampled on the first tick
    await vi.advanceTimersByTimeAsync(periodMs - 2000);
    expect(spy).toHaveBeenCalledTimes(1); // earlier ticks republish the cache
    await vi.advanceTimersByTimeAsync(4000); // first 2s tick at/after the period
    expect(spy).toHaveBeenCalledTimes(2);
    await probe.stop();
  });

  it('honors a custom cadence and does not carry it into the next start', async () => {
    const collectors = baseCollectors();
    let calls = 0;
    collectors.memory = async (ttl) => {
      calls += 1;
      return fact.ok({ total: 1, used: 1, pressure: 'normal', swapUsed: 0 }, src('mem'), ttl);
    };
    const probe = new BodyProbe(collectors);
    probe.start({ intervalMs: 2000, cadence: { memoryMs: 3000 } });
    await flush();
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(4000); // t=4 >= 3s period
    expect(calls).toBe(2);
    await probe.stop();
    probe.start({ intervalMs: 2000 }); // defaults apply again
    await flush();
    expect(calls).toBe(3); // the outer cache resets on start
    await vi.advanceTimersByTimeAsync(4000); // t=4 < default 5s: cached
    expect(calls).toBe(3);
    await probe.stop();
  });

  it('does not invoke later collectors once an earlier one stops the tick', async () => {
    const collectors = baseCollectors();
    const spies = [
      vi.spyOn(collectors, 'disks'),
      vi.spyOn(collectors, 'battery'),
      vi.spyOn(collectors, 'network'),
      vi.spyOn(collectors, 'process'),
    ];
    let probe!: BodyProbe;
    collectors.memory = () => {
      // reentrant stop: aborts the tick mid-setup
      void probe.stop();
      return new Promise<Fact<never>>(() => {});
    };
    probe = new BodyProbe(collectors);
    probe.start({ intervalMs: 1000 });
    await flush();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await probe.stop();
  });

  it('republishes cached facts as-is and marks them stale once their ttl lapses', async () => {
    const collectors = baseCollectors();
    collectors.memory = async (ttl) =>
      fact.ok({ total: 1, used: 1, pressure: 'normal', swapUsed: 0 }, src('mem'), Math.min(ttl, 2500));
    const probe = new BodyProbe(collectors);
    const seen: Body[] = [];
    probe.onSample((b) => seen.push(b));
    probe.start({ intervalMs: 2000 });
    await flush();
    expect(seen[0]?.memory.status).toBe('ok');
    await vi.advanceTimersByTimeAsync(2000); // cached republish, age < ttl
    expect(seen[1]?.memory.status).toBe('ok');
    expect(seen[1]?.memory.observedAt).toBe(seen[0]?.memory.observedAt); // never refreshed
    await vi.advanceTimersByTimeAsync(2000); // still cached, but now older than its ttl
    expect(seen[2]?.memory.status).toBe('stale');
    expect(seen[2]?.memory.observedAt).toBe(seen[0]?.memory.observedAt);
    await probe.stop();
  });

  it.each(['stat', 'statfs'] as const)(
    'a never-settling disk %s keeps one hung op per path across 8 stop/starts',
    async (op) => {
      let statCalls = 0;
      let statfsCalls = 0;
      vi.spyOn(fs.promises, 'stat').mockImplementation(async (p) => {
        statCalls += 1;
        if (op === 'stat') await new Promise<never>(() => {});
        return { dev: String(p) === '/' ? 1 : 2 } as fs.Stats;
      });
      vi.spyOn(fs.promises, 'statfs').mockImplementation(async () => {
        statfsCalls += 1;
        if (op === 'statfs') await new Promise<never>(() => {});
        return { bsize: 4096, blocks: 10, bavail: 5 } as fs.StatsFs;
      });
      const collectors = baseCollectors();
      delete (collectors as Partial<ProbeCollectors>).disks; // default sampler path
      const probe = new BodyProbe(collectors);
      const seen: Body[] = [];
      probe.onSample((b) => seen.push(b));
      for (let i = 0; i < 8; i += 1) {
        probe.start({ intervalMs: 2000, cwd: '/fake-cwd' });
        await flush();
        await probe.stop();
      }
      expect(statCalls).toBe(2); // one wedged job per queried path, never duplicated
      expect(statfsCalls).toBe(op === 'stat' ? 0 : 2);
      expect(seen).toHaveLength(8); // wedged volumes no longer gate the tick
      expect(seen.every((b) => b.disks.status === 'unknown' && b.disks.value === null)).toBe(true);
      expect(seen.every((b) => (b.disks.unavailableMounts ?? []).length === 2)).toBe(true);
      expect(vi.getTimerCount()).toBe(0); // stop() cancels the per-volume timeouts
    },
  );

  it.each(['stat', 'statfs'] as const)(
    'publishes every tick while a resolved-cwd disk %s hangs; root keeps refreshing',
    async (op) => {
      let free = 10;
      vi.spyOn(fs.promises, 'stat').mockImplementation(async (p) => {
        if (op === 'stat' && String(p) === '/wedge') return new Promise<never>(() => {});
        return { dev: 1 } as fs.Stats;
      });
      vi.spyOn(fs.promises, 'statfs').mockImplementation(async (p) => {
        if (op === 'statfs' && String(p) === '/wedge') return new Promise<never>(() => {});
        free += 1;
        return { bsize: 1, blocks: free, bavail: free } as fs.StatsFs;
      });
      const collectors = baseCollectors();
      delete (collectors as Partial<ProbeCollectors>).disks; // default sampler path
      const probe = new BodyProbe(collectors);
      const seen: Body[] = [];
      probe.onSample((b) => seen.push(b));
      probe.start({ intervalMs: 2000, cwd: '/wedge', cadence: { disksMs: 2000 } });
      await flush();
      expect(seen).toHaveLength(1);
      expect(seen[0]?.disks.status).toBe('unknown'); // first turn may be unknown
      expect(seen[0]?.disks.unavailableMounts).toEqual(['/', '/wedge']);
      expect(seen[0]?.cpu.status).toBe('ok');
      await vi.advanceTimersByTimeAsync(2000); // root lands under the 3s timeout
      expect(seen).toHaveLength(2);
      expect(seen[1]?.disks.unavailableMounts).toEqual(['/wedge']);
      const root1 = seen[1]?.disks.value?.find((v) => v.mount === '/');
      await vi.advanceTimersByTimeAsync(4000); // two more ticks past the timeout
      const last = seen.at(-1)!;
      const root2 = last.disks.value?.find((v) => v.mount === '/');
      expect(seen).toHaveLength(4); // ticks never wait on the wedge
      expect(root2?.free).toBeGreaterThan(root1?.free ?? -1); // root refreshed
      expect(root2?.observedAt).toBeGreaterThan(root1?.observedAt ?? 0);
      expect(last.disks.unavailableMounts).toEqual(['/wedge']);
      expect(last.cpu.status).toBe('ok');
      await probe.stop();
    },
  );

  it('restarting clears inner network caches: route re-probes, new offline lands after baseline', async () => {
    let routeCalls = 0;
    let online = true;
    let i = 0;
    const texts = [fx('netstat_1.txt'), fx('netstat_2.txt'), fx('netstat_2.txt'), fx('netstat_2.txt')];
    vi.spyOn(command, 'defaultRun').mockImplementation(async (file, args = []) => {
      if (file.endsWith('netstat')) return texts[Math.min(i++, texts.length - 1)]!;
      if (file.endsWith('route')) {
        routeCalls += 1;
        if (!online) {
          throw Object.assign(new Error('route: writing to routing socket: not in table'), { code: 1 });
        }
        return '';
      }
      if (file.endsWith('vm_stat')) return fx('vm_stat.txt');
      if (file.endsWith('sysctl')) {
        return args
          .slice(1)
          .map((key) => (key === 'vm.swapusage' ? fx('swapusage.txt').trimEnd() : '1'))
          .join('\n');
      }
      return '1\n';
    });
    fakeEn0();
    const probe = new BodyProbe({}, { platform: 'darwin' });
    probe.start({ intervalMs: 1000, cadence: { networkMs: 2000, routeMs: 5000 } });
    await vi.advanceTimersByTimeAsync(3000); // baseline t0, online rate fact at t2
    expect(probe.latest()?.network.value?.online).toBe(true);
    expect(routeCalls).toBe(1);
    online = false;
    await probe.stop();
    probe.start({ intervalMs: 1000, cadence: { networkMs: 2000, routeMs: 30_000 } });
    await flush(); // reset must force a route probe despite the longer routeMs
    expect(routeCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(2000); // rate baseline completes -> offline lands
    expect(probe.latest()?.network.status).toBe('ok');
    expect(probe.latest()?.network.value?.online).toBe(false);
    await probe.stop();
  });

  it('restarting clears inner memory caches: pressure/swap re-run and report new values', async () => {
    let pressureCalls = 0;
    let swapCalls = 0;
    let pressureOut = '1\n';
    let swapOut = fx('swapusage.txt');
    vi.spyOn(command, 'defaultRun').mockImplementation(async (file, args = []) => {
      if (file.endsWith('vm_stat')) return fx('vm_stat.txt');
      if (file.endsWith('sysctl')) {
        if (args.includes('kern.memorystatus_vm_pressure_level')) pressureCalls += 1;
        if (args.includes('vm.swapusage')) swapCalls += 1;
        return args
          .slice(1)
          .map((key) => (key === 'vm.swapusage' ? swapOut.trimEnd() : pressureOut.trimEnd()))
          .join('\n');
      }
      if (file.endsWith('netstat')) return fx('netstat_1.txt');
      return '';
    });
    const probe = new BodyProbe({}, { platform: 'darwin' });
    probe.start({ intervalMs: 1000 });
    await flush();
    expect(pressureCalls).toBe(1);
    expect(swapCalls).toBe(1);
    expect(probe.latest()?.memory.value?.pressure).toBe('normal');
    await vi.advanceTimersByTimeAsync(4000); // still inside the 5s/30s cache windows
    expect(pressureCalls).toBe(1);
    expect(swapCalls).toBe(1);
    pressureOut = '2\n';
    swapOut = 'total = 1T used = 5G free = 0B';
    await probe.stop();
    probe.start({ intervalMs: 1000 });
    await flush();
    expect(pressureCalls).toBe(2); // inner caches were cleared, not only the outer ones
    expect(swapCalls).toBe(2);
    expect(probe.latest()?.memory.value?.pressure).toBe('warn');
    expect(probe.latest()?.memory.value?.swapUsed).toBe(5 * 1024 ** 3);
    await probe.stop();
  });

  it('clamps child cadences up to the parent so composites stay ok between polls', async () => {
    let pressureCalls = 0;
    let swapCalls = 0;
    let routeCalls = 0;
    vi.spyOn(command, 'defaultRun').mockImplementation(async (file, args = []) => {
      if (file.endsWith('vm_stat')) return fx('vm_stat.txt');
      if (file.endsWith('sysctl')) {
        if (args.includes('kern.memorystatus_vm_pressure_level')) pressureCalls += 1;
        if (args.includes('vm.swapusage')) swapCalls += 1;
        return args
          .slice(1)
          .map((key) => (key === 'vm.swapusage' ? fx('swapusage.txt').trimEnd() : '1'))
          .join('\n');
      }
      if (file.endsWith('netstat')) return fx('netstat_1.txt');
      if (file.endsWith('route')) {
        routeCalls += 1;
        return '';
      }
      return '1\n';
    });
    fakeEn0();
    const probe = new BodyProbe({}, { platform: 'darwin' });
    probe.start({
      intervalMs: 2000,
      cadence: { memoryMs: 30_000, networkMs: 30_000, pressureMs: 5000, swapMs: 5000, routeMs: 5000 },
    });
    await flush();
    expect([pressureCalls, swapCalls, routeCalls]).toEqual([1, 1, 1]);
    await vi.advanceTimersByTimeAsync(28_000); // children must not poll faster than the parent
    expect([pressureCalls, swapCalls, routeCalls]).toEqual([1, 1, 1]);
    const mem = probe.latest()!.memory;
    const net = probe.latest()!.network;
    expect(mem.status).toBe('ok'); // no spurious stale before the parent poll
    expect(mem.ttlMs).toBe(90_000); // 3 * effective 30s child period
    expect(net.ttlMs).toBe(90_000);
    await vi.advanceTimersByTimeAsync(2000); // t=30s: the parent polls again
    expect([pressureCalls, swapCalls, routeCalls]).toEqual([2, 2, 2]);
    expect(probe.latest()?.network.status).toBe('ok');
    await probe.stop();
  });

  it('uses the injected monotonic clock for cadence, staleness and history when wall moves back', async () => {
    const counts = { memory: 0, network: 0, battery: 0, disks: 0 };
    const collectors = baseCollectors();
    collectors.memory = async (ttl) => {
      counts.memory += 1;
      return fact.ok({ total: 1, used: 1, pressure: 'normal', swapUsed: 0 }, src('mem'), ttl);
    };
    collectors.network = async (ttl) => {
      counts.network += 1;
      return fact.ok({ online: true, rxBps: 1, txBps: 1 }, src('net'), ttl);
    };
    collectors.battery = async (ttl) => {
      counts.battery += 1;
      return fact.ok(null, src('batt'), ttl);
    };
    collectors.disks = async (_cwd, ttl) => {
      counts.disks += 1;
      return { ...fact.ok([{ mount: '/', total: 10, free: 5 }], src('disks'), ttl), kind: 'disks' };
    };
    // The injected mono clock wraps the faked global performance.now(), so
    // advancing timers progresses it while setSystemTime moves only the wall.
    const probe = new BodyProbe(collectors, {
      now: () => globalThis.performance.now(),
      wall: () => Date.now(),
    });
    probe.start({ intervalMs: 2000 });
    await flush();
    expect(counts).toEqual({ memory: 1, network: 1, battery: 1, disks: 1 });
    vi.setSystemTime(Date.now() - 3_600_000); // wall rolls back one hour
    await vi.advanceTimersByTimeAsync(2000); // inside every cadence
    expect(counts).toEqual({ memory: 1, network: 1, battery: 1, disks: 1 });
    await vi.advanceTimersByTimeAsync(4000); // 6s mono: 5s cadences refetch
    expect(counts).toEqual({ memory: 2, network: 2, battery: 1, disks: 1 });
    expect(probe.latest()?.memory.status).toBe('ok'); // fresh facts usable after rollback
    await vi.advanceTimersByTimeAsync(26_000); // 32s mono: battery 30s, disks 10s refetch
    expect(counts.battery).toBe(2);
    expect(counts.disks).toBeGreaterThanOrEqual(3);
    await probe.stop();
    await vi.advanceTimersByTimeAsync(16_000); // tracked deadline is monotonic, not wall
    expect(probe.latest()?.memory.status).toBe('stale');
    await vi.advanceTimersByTimeAsync(300_000); // the history window is monotonic too
    expect(probe.history()).toHaveLength(0);
  });

  it('marks real composite facts stale after stop; stored history stays ok', async () => {
    const run: RunFn = async (file, args = []) => {
      if (file.endsWith('vm_stat')) return fx('vm_stat.txt');
      if (file.endsWith('netstat')) return fx('netstat_1.txt');
      if (file.endsWith('sysctl')) {
        return args
          .slice(1)
          .map((key) => (key === 'vm.swapusage' ? fx('swapusage.txt').trimEnd() : '1'))
          .join('\n');
      }
      return '1\n'; // route success output is unused
    };
    // Samplers default to the same (faked) monotonic clock as the probe.
    const memory = new MemorySampler({ platform: 'darwin', run, totalmem: () => 1 });
    const network = new NetworkSampler({
      platform: 'darwin',
      run,
      interfaces: () => ({
        en0: [{ address: '10.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: 'aa', internal: false, cidr: null }],
      }),
    });
    const collectors = baseCollectors();
    collectors.memory = (ttl, signal) => memory.sample(ttl, signal);
    collectors.network = (ttl, signal) => network.sample(ttl, signal);
    const probe = new BodyProbe(collectors);
    probe.start({ intervalMs: 2000 });
    // t=0 baseline + cached republish + fresh composite at t=6: pressure
    // (5s) re-reads, swap/route (30s) stay cached and are the oldest parts.
    await vi.advanceTimersByTimeAsync(6000);
    await probe.stop();
    const mem = probe.latest()!.memory;
    const net = probe.latest()!.network;
    expect(mem.status).toBe('ok');
    expect(net.status).toBe('ok');
    expect(mem.observedAt).toBe(Date.now()); // fresh vm read, despite the t=0 swap cache
    expect(net.observedAt).toBe(Date.now());
    expect(mem.ttlMs).toBe(15_000); // earliest expiry: fresh vm/pressure reads at t6 (+15s)
    expect(net.ttlMs).toBe(15_000); // the t6 rate sample's own ttl, not the route's
    const until = (f: Fact<unknown>) => f.observedAt + f.ttlMs;
    const toBoundary = Math.min(until(mem), until(net)) - Date.now() - 1;
    const pastBoundary = Math.max(until(mem), until(net)) - Date.now() + 1;
    await vi.advanceTimersByTimeAsync(toBoundary);
    expect(probe.latest()?.memory.status).toBe('ok');
    expect(probe.latest()?.network.status).toBe('ok');
    vi.setSystemTime(Date.now() - 3_600_000); // rollback cannot revive tracked deadlines
    await vi.advanceTimersByTimeAsync(pastBoundary - toBoundary);
    expect(probe.latest()?.memory.status).toBe('stale');
    expect(probe.latest()?.network.status).toBe('stale');
    expect(probe.latest()?.memory.observedAt).toBe(mem.observedAt); // never refreshed
    expect(probe.latest()?.network.observedAt).toBe(net.observedAt);
    const last = probe.history().at(-1)!;
    expect(last.body.memory.status).toBe('ok'); // stored points are never re-marked
    expect(last.body.network.status).toBe('ok');
  });

  it('marks macOS facts unavailable off-darwin and never spawns their commands', async () => {
    const collectors: Partial<ProbeCollectors> = baseCollectors();
    delete collectors.memory;
    delete collectors.network;
    delete collectors.battery;
    const run = vi.spyOn(command, 'defaultRun').mockResolvedValue('');
    const probe = new BodyProbe(collectors, { platform: 'linux' });
    probe.start({ intervalMs: 1000 });
    await flush();
    const body = probe.latest()!;
    expect(body.memory.status).toBe('unavailable');
    expect(body.network.status).toBe('unavailable');
    expect(body.battery.status).toBe('unavailable');
    expect(run).not.toHaveBeenCalled();
    await probe.stop();
  });
});
