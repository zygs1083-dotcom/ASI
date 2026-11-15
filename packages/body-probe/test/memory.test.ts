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
  it('reads the page size from the header and the three used fields', () => {
    expect(parseVmStat(fx('vm_stat.txt'))).toEqual({
      pageSize: 16384, active: 100, wired: 20, compressorOccupied: 30,
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
  it('computes used from active+wired+compressor-occupied pages (ignores stored/inactive)', async () => {
    const s = new MemorySampler({
      platform: 'darwin',
      run: run(fx('vm_stat.txt'), '1\n', fx('swapusage.txt')),
      totalmem: () => 16 * 1024 ** 3,
    });
    const f = await s.sample();
    expect(f.status).toBe('ok');
    expect(f.value).toEqual({
      total: 16 * 1024 ** 3,
      used: 150 * 16384,
      pressure: 'normal',
      swapUsed: 12.5 * 1024 ** 2,
    });
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
