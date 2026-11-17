import { describe, expect, it, vi } from 'vitest';
import { ExternalProcessSampler, SelfProcessSampler, parseElapsed, parsePsRow } from '../src/process.js';
import type { RunFn } from '../src/command.js';

const mem = (rss: number): NodeJS.MemoryUsage =>
  ({ rss, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 });
const res = (user: number, system: number, maxRSS = 999): NodeJS.ResourceUsage =>
  ({ userCPUTime: user, systemCPUTime: system, maxRSS }) as NodeJS.ResourceUsage;

describe('parseElapsed', () => {
  it.each([
    ['00:42', 42],
    ['03:12', 192],
    ['1:02:03', 3723],
    ['2-03:04:05', 2 * 86400 + 3 * 3600 + 4 * 60 + 5],
  ])('parses etime %s', (s, expected) => {
    expect(parseElapsed(s)).toBe(expected);
  });
  it.each(['abc', '1:99', '61:00', '2-25:00:00', '99999999999999999999:59', 'x:y'])(
    'rejects invalid etime %s', (bad) => {
      expect(() => parseElapsed(bad)).toThrow();
    });

  it('allows ordinary h:mm:ss hours above 23 when no day prefix exists', () => {
    expect(parseElapsed('30:00:00')).toBe(108000);
  });
});

describe('parsePsRow', () => {
  it('converts KiB rss, %cpu and etime', () => {
    expect(parsePsRow('  12345    2.5  01:02:03')).toEqual({
      rss: 12345 * 1024, cpu: 0.025, uptimeSec: 3723,
    });
  });
  it('rejects malformed rows', () => {
    expect(() => parsePsRow('oops')).toThrow();
  });
});

describe('SelfProcessSampler', () => {
  it('reports current rss (not peak maxRSS) and cpu from resourceUsage deltas', () => {
    let t = 0;
    const usages = [res(1_000_000, 500_000), res(2_000_000, 1_000_000)];
    let i = 0;
    const s = new SelfProcessSampler({
      now: () => (t += 1000) - 1000,
      memoryUsage: () => mem(48 * 1024 * 1024),
      resourceUsage: () => usages[Math.min(i++, usages.length - 1)]!,
      uptime: () => 120,
    });
    expect(s.sample().status).toBe('unknown');
    const f = s.sample();
    expect(f.status).toBe('ok');
    // delta cpu = 1_500_000us over 1000ms -> 1.5 (multi-core, unclamped)
    expect(f.value?.cpu).toBeCloseTo(1.5);
    expect(f.value?.rss).toBe(48 * 1024 * 1024);
    expect(f.value?.rss).not.toBe(999 * 1024);
    expect(f.value?.uptimeSec).toBe(120);
  });

  it('reset() clears the previous resourceUsage baseline so post-reset sampling re-baselines', () => {
    let t = 0;
    const usages = [
      res(0, 0),
      res(1_000_000, 0), // 1.0 CPU over 1s
      res(50_000_000, 0), // stopped gap — must NOT leak into first sample after reset
      res(50_250_000, 0), // 0.25 CPU over 1s
    ];
    let i = 0;
    const s = new SelfProcessSampler({
      now: () => (t += 1000) - 1000,
      memoryUsage: () => mem(1024),
      resourceUsage: () => usages[Math.min(i++, usages.length - 1)]!,
      uptime: () => 10,
    });
    expect(s.sample().status).toBe('unknown');
    expect(s.sample().value?.cpu).toBeCloseTo(1.0);
    s.reset();
    t += 60_000;
    const afterReset = s.sample();
    expect(afterReset.status).toBe('unknown');
    expect(afterReset.value).toBeNull();
    const fresh = s.sample();
    expect(fresh.status).toBe('ok');
    expect(fresh.value?.cpu).toBeCloseTo(0.25);
  });
});

describe('SelfProcessSampler errors', () => {
  it('returns unavailable when an OS call throws', () => {
    const s = new SelfProcessSampler({
      resourceUsage: () => { throw new Error('ru dead'); },
      memoryUsage: () => mem(1),
      uptime: () => 1,
    });
    const f = s.sample();
    expect(f.status).toBe('unavailable');
    expect(f.value).toBeNull();
  });

  it('returns unavailable on non-finite rss rather than publishing it', () => {
    let i = 0;
    const usages = [res(0, 0), res(1000, 0)];
    let t = 0;
    const s = new SelfProcessSampler({
      now: () => (t += 1000) - 1000,
      resourceUsage: () => usages[Math.min(i++, usages.length - 1)]!,
      memoryUsage: () => mem(Number.NaN),
      uptime: () => 10,
    });
    s.sample();
    const f = s.sample();
    expect(f.status).toBe('unavailable');
  });
});

describe('ExternalProcessSampler', () => {
  const run = (stdout: string): RunFn => async () => stdout;

  it('samples another pid via ps including day-format etime', async () => {
    const s = new ExternalProcessSampler(4242, { run: run('  20480   12.5  2-03:04:05\n') });
    const f = await s.sample();
    expect(f.status).toBe('ok');
    expect(f.value).toEqual({ rss: 20480 * 1024, cpu: 0.125, uptimeSec: 2 * 86400 + 3 * 3600 + 4 * 60 + 5 });
  });

  it('passes the expected ps argv', async () => {
    const runSpy = vi.fn<RunFn>(async () => '  1  0.0  00:01');
    const s = new ExternalProcessSampler(4242, { run: runSpy });
    await s.sample();
    expect(runSpy).toHaveBeenCalledWith('/bin/ps', ['-o', 'rss=,%cpu=,etime=', '-p', '4242'], undefined);
  });

  it.each([0, -3, 1.5, NaN])('rejects invalid pid %s without running commands', async (pid) => {
    const runSpy = vi.fn<RunFn>();
    const s = new ExternalProcessSampler(pid, { run: runSpy });
    expect((await s.sample()).status).toBe('unavailable');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('returns unavailable when the pid is gone or ps fails', async () => {
    const s = new ExternalProcessSampler(4242, { run: async () => { throw new Error('exit 1'); } });
    expect((await s.sample()).status).toBe('unavailable');
  });
});
