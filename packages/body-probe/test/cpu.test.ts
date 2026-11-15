import { describe, expect, it } from 'vitest';
import { CpuSampler, deltaUsage, type CoreTimes } from '../src/cpu.js';
import type { CpuInfo } from 'node:os';

const t = (user: number, nice: number, sys: number, idle: number, irq: number): CoreTimes =>
  ({ user, nice, sys, idle, irq });

const cpus = (...cores: CoreTimes[]): CpuInfo[] =>
  cores.map((times) => ({ model: 'fake', speed: 2400, times })) as CpuInfo[];

describe('deltaUsage', () => {
  it('computes per-core ratios and a weighted overall', () => {
    const prev = [t(0, 0, 0, 0, 0), t(0, 0, 0, 0, 0)];
    // core0: total 100, busy 25 -> 0.25 ; core1: total 200, busy 100 -> 0.5
    const next = [t(10, 5, 10, 75, 0), t(50, 0, 50, 100, 0)];
    const d = deltaUsage(prev, next);
    expect(d?.perCore).toEqual([0.25, 0.5]);
    expect(d?.overall).toBeCloseTo(125 / 300);
  });

  it('returns null on reset counters', () => {
    expect(deltaUsage([t(100, 0, 0, 100, 0)], [t(1, 0, 0, 1, 0)])).toBeNull();
  });

  it('returns null when any single counter decreases even if the total rises', () => {
    // user drops 100->90 while the aggregate total grows 200->320
    expect(deltaUsage([t(100, 0, 0, 100, 0)], [t(90, 0, 30, 200, 0)])).toBeNull();
  });

  it('returns null on non-finite counters', () => {
    expect(deltaUsage([t(1, 0, 0, 1, 0)], [t(Number.NaN, 0, 0, 5, 0)])).toBeNull();
  });

  it('returns null on changed core count', () => {
    expect(deltaUsage([t(1, 0, 0, 1, 0)], [t(2, 0, 0, 2, 0), t(1, 0, 0, 1, 0)])).toBeNull();
  });

  it('returns null when no time elapsed', () => {
    expect(deltaUsage([t(5, 0, 0, 5, 0)], [t(5, 0, 0, 5, 0)])).toBeNull();
  });
});

describe('CpuSampler', () => {
  it('returns unknown baseline on first sample then ratios', () => {
    const seq = [
      cpus(t(0, 0, 0, 0, 0), t(0, 0, 0, 0, 0)),
      cpus(t(10, 5, 10, 75, 0), t(50, 0, 50, 100, 0)),
    ];
    let i = 0;
    const s = new CpuSampler({ cpus: () => seq[Math.min(i++, seq.length - 1)]!, loadavg: () => [1.5, 2.5, 3.5] });
    const first = s.sample();
    expect(first.status).toBe('unknown');
    expect(first.value).toBeNull();
    const second = s.sample();
    expect(second.status).toBe('ok');
    expect(second.value?.usage).toBeCloseTo(125 / 300);
    expect(second.value?.perCore).toEqual([0.25, 0.5]);
    expect(second.value?.load1).toBe(1.5);
  });

  it('rebases with unknown after counter reset instead of fabricating', () => {
    const seq = [
      cpus(t(100, 0, 0, 100, 0)),
      cpus(t(200, 0, 0, 200, 0)),
      cpus(t(1, 0, 0, 1, 0)),   // reset
      cpus(t(21, 0, 0, 41, 0)), // delta total 60 busy 20
    ];
    let i = 0;
    const s = new CpuSampler({ cpus: () => seq[Math.min(i++, seq.length - 1)]!, loadavg: () => [0, 0, 0] });
    expect(s.sample().status).toBe('unknown');
    expect(s.sample().status).toBe('ok');
    const reset = s.sample();
    expect(reset.status).toBe('unknown');
    expect(reset.value).toBeNull();
    const after = s.sample();
    expect(after.status).toBe('ok');
    expect(after.value?.usage).toBeCloseTo(20 / 60);
  });

  it('returns unavailable when the OS call throws', () => {
    const s = new CpuSampler({ cpus: () => { throw new Error('os dead'); }, loadavg: () => [0, 0, 0] });
    const f = s.sample();
    expect(f.status).toBe('unavailable');
    expect(f.value).toBeNull();
  });

  it('returns unavailable on invalid loadavg instead of inventing zeros', () => {
    const seq = [cpus(t(0, 0, 0, 0, 0)), cpus(t(10, 0, 0, 10, 0))];
    let i = 0;
    const s = new CpuSampler({
      cpus: () => seq[Math.min(i++, seq.length - 1)]!,
      loadavg: () => [1, Number.NaN, 3],
    });
    s.sample();
    const f = s.sample();
    expect(f.status).toBe('unavailable');
    expect(f.value).toBeNull();
  });

  it('rebases with unknown after topology change', () => {
    const seq = [
      cpus(t(0, 0, 0, 0, 0)),
      cpus(t(10, 0, 0, 10, 0), t(5, 0, 0, 5, 0)),
      cpus(t(20, 0, 0, 20, 0), t(15, 0, 0, 15, 0)),
    ];
    let i = 0;
    const s = new CpuSampler({ cpus: () => seq[Math.min(i++, seq.length - 1)]!, loadavg: () => [0, 0, 0] });
    s.sample();
    expect(s.sample().status).toBe('unknown');
    const ok = s.sample();
    expect(ok.status).toBe('ok');
    expect(ok.value?.perCore).toHaveLength(2);
  });
});
