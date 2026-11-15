import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { MemorySampler, parsePressureLevel, parseSwapUsage, parseVmStat } from '../src/memory.js';
import type { RunFn } from '../src/command.js';

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const run =
  (vmStat: string, pressure: string, swap: string): RunFn =>
  async (file, args = []) => {
    if (file.endsWith('vm_stat')) return vmStat;
    if (args.includes('kern.memorystatus_vm_pressure_level')) return pressure;
    if (args.includes('vm.swapusage')) return swap;
    throw new Error(`unexpected command ${file} ${args.join(' ')}`);
  };

describe('parseVmStat', () => {
  it('reads the page size from the header and the product-formula fields', () => {
    expect(parseVmStat(fx('vm_stat.txt'))).toEqual({
      pageSize: 16384,
      anonymous: 2500000,
      purgeable: 10,
      fileBacked: 4000000,
      wired: 20,
      compressorOccupied: 30,
    });
  });
  it('rejects output missing a required field', () => {
    expect(() => parseVmStat(fx('vm_stat_missing.txt'))).toThrow();
  });
  it('rejects garbage', () => {
    expect(() => parseVmStat('nonsense')).toThrow();
  });
});

describe('parseSwapUsage', () => {
  it('parses used with M suffix', () => {
    expect(parseSwapUsage(fx('swapusage.txt'))).toBe(12.5 * 1024 ** 2);
  });
  it.each([
    ['used = 10B', 10],
    ['used = 512K', 512 * 1024],
    ['used = 1.50G', 1.5 * 1024 ** 3],
    ['used = 2.25T', 2.25 * 1024 ** 4],
  ])('parses unit suffixes: %s', (frag, expected) => {
    expect(parseSwapUsage(`total = 1T ${frag} free = 0B`)).toBe(expected);
  });
  it('rejects output without a used field', () => {
    expect(() => parseSwapUsage('total = 1T free = 1T')).toThrow();
  });
});

describe('parsePressureLevel', () => {
  it.each([[1, 'normal'], [2, 'warn'], [4, 'critical']] as const)('maps %s to %s', (n, expected) => {
    expect(parsePressureLevel(String(n))).toBe(expected);
  });
  it.each([3, 0, 5, NaN])('rejects unknown code %s', (n) => {
    expect(() => parsePressureLevel(String(n))).toThrow();
  });
});

describe('MemorySampler', () => {
  it.each([4096, 16384])('computes used/cached from vm_stat at page size %i', async (pageSize) => {
    const s = new MemorySampler({
      platform: 'darwin',
      run: run(fx('vm_stat.txt').replace('16384', String(pageSize)), '1\n', fx('swapusage.txt')),
      totalmem: () => 128 * 1024 ** 3,
    });
    const f = await s.sample();
    expect(f.status).toBe('ok');
    expect(f.value).toEqual({
      total: 128 * 1024 ** 3,
      used: (2500000 - 10 + 20 + 30) * pageSize,
      cached: (4000000 + 10) * pageSize,
      pressure: 'normal',
      swapUsed: 12.5 * 1024 ** 2,
    });
  });

  it('clamps anonymous-purgeable at zero when purgeable exceeds anonymous', async () => {
    const s = new MemorySampler({
      platform: 'darwin',
      run: run(fx('vm_stat.txt').replace('2500000.', '5.'), '1\n', fx('swapusage.txt')),
      totalmem: () => 128 * 1024 ** 3,
    });
    const f = await s.sample();
    expect(f.value?.used).toBe(50 * 16384);
    expect(f.value?.cached).toBe((4000000 + 10) * 16384);
  });

  it('waits for slow siblings before mapping a fast failure', async () => {
    let resolveSwap!: (s: string) => void;
    const runFn: RunFn = async (file, args = []) => {
      if (file.endsWith('vm_stat')) throw Object.assign(new Error('nope'), { code: 'EACCES' });
      if (args.includes('vm.swapusage')) return new Promise<string>((res) => { resolveSwap = res; });
      return '1\n';
    };
    let settled = false;
    const p = new MemorySampler({ platform: 'darwin', run: runFn }).sample()
      .then((f) => { settled = true; return f; });
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false); // still pending on the slow swap command
    resolveSwap(fx('swapusage.txt'));
    expect((await p).status).toBe('denied'); // EACCES classification preserved
  });

  it('caches a successful swap reading for 30s but never a rejected one', async () => {
    let t = 0;
    let calls = 0;
    let fail = true;
    const runFn: RunFn = async (file, args = []) => {
      if (file.endsWith('vm_stat')) return fx('vm_stat.txt');
      if (args.includes('vm.swapusage')) {
        calls += 1;
        if (fail) throw new Error('swap down');
        return fx('swapusage.txt');
      }
      return '1\n';
    };
    const s = new MemorySampler({ platform: 'darwin', run: runFn, now: () => t });
    expect((await s.sample()).status).toBe('unavailable');
    fail = false;
    expect((await s.sample()).status).toBe('ok'); // rejected runs are retried
    t = 29_999;
    await s.sample();
    expect(calls).toBe(2);                       // success is cached
    t = 30_000;
    await s.sample();
    expect(calls).toBe(3);                       // and expires at 30s
  });

  it('caches the pressure reading for 5s, never a rejected one', async () => {
    let t = 0, calls = 0, fail = true;
    const runFn: RunFn = async (file, args = []) => {
      if (file.endsWith('vm_stat')) return fx('vm_stat.txt');
      if (args.includes('kern.memorystatus_vm_pressure_level')) {
        calls += 1;
        if (fail) throw new Error('pressure down');
        return '1\n';
      }
      return fx('swapusage.txt');
    };
    const s = new MemorySampler({ platform: 'darwin', run: runFn, now: () => t });
    expect((await s.sample()).status).toBe('unavailable'); // rejected: not cached
    fail = false;
    await s.sample();
    expect(calls).toBe(2);   // success caches at t=0
    t = 4_999;
    await s.sample();
    expect(calls).toBe(2);   // inside the 5s window
    t = 5_000;
    await s.sample();
    expect(calls).toBe(3);   // boundary expiry re-runs
  });

  it('composes observedAt/ttlMs from the oldest constituent, ties take the smallest period', async () => {
    let mono = 0;
    let wall = 1_000;
    const s = new MemorySampler({
      platform: 'darwin',
      run: run(fx('vm_stat.txt'), '1\n', fx('swapusage.txt')),
      totalmem: () => 128 * 1024 ** 3,
      now: () => mono,
      wall: () => wall,
    });
    const first = await s.sample(6000); // all constituents fresh at wall 1000
    expect(first.observedAt).toBe(1000);
    expect(first.ttlMs).toBe(6000);     // three-way tie -> smallest period (vm, ttl/3 = 2000)

    wall = 9_000; mono = 4_000;         // pressure & swap caches still valid
    const second = await s.sample(6000);
    expect(second.observedAt).toBe(1000); // cached constituents are the oldest
    expect(second.ttlMs).toBe(15_000);    // pressure's 5000 wins the tie against swap's 30000

    wall = 40_000; mono = 25_000;       // pressure expired (>5s), swap still cached
    const third = await s.sample(6000);
    expect(third.observedAt).toBe(1000); // swap's original observation is oldest
    expect(third.ttlMs).toBe(90_000);    // 3 * swap period
  });

  it('honors caller-supplied pressure/swap cache periods', async () => {
    let mono = 0;
    let pressureCalls = 0;
    const runFn: RunFn = async (file, args = []) => {
      if (file.endsWith('vm_stat')) return fx('vm_stat.txt');
      if (args.includes('kern.memorystatus_vm_pressure_level')) {
        pressureCalls += 1;
        return '1\n';
      }
      return fx('swapusage.txt');
    };
    const s = new MemorySampler({ platform: 'darwin', run: runFn, now: () => mono });
    const periods = { pressureMs: 60_000, swapMs: 60_000 };
    await s.sample(6000, undefined, periods);
    mono = 10_000;
    await s.sample(6000, undefined, periods);
    expect(pressureCalls).toBe(1); // still cached at 10s under a 60s period
  });

  it('returns unavailable when any command output is malformed', async () => {
    const s = new MemorySampler({ platform: 'darwin', run: run('garbage', '1\n', fx('swapusage.txt')) });
    const f = await s.sample();
    expect(f.status).toBe('unavailable');
    expect(f.value).toBeNull();
  });

  it('returns unavailable on unknown pressure code rather than inventing normal', async () => {
    const s = new MemorySampler({ platform: 'darwin', run: run(fx('vm_stat.txt'), '3\n', fx('swapusage.txt')) });
    expect((await s.sample()).status).toBe('unavailable');
  });

  it('returns unavailable when a command fails', async () => {
    const s = new MemorySampler({ platform: 'darwin', run: async () => { throw new Error('spawn failed'); } });
    expect((await s.sample()).status).toBe('unavailable');
  });

  it('never invokes commands on non-darwin', async () => {
    const runSpy = vi.fn<RunFn>();
    const s = new MemorySampler({ platform: 'linux', run: runSpy });
    const f = await s.sample();
    expect(f.status).toBe('unavailable');
    expect(runSpy).not.toHaveBeenCalled();
  });
});
