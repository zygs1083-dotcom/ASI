import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BatterySampler, parsePmsetBatt } from '../src/battery.js';
import type { RunFn } from '../src/command.js';

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const run =
  (stdout: string): RunFn =>
  async () =>
    stdout;

describe('parsePmsetBatt', () => {
  it('parses discharging on battery with hh:mm estimate', () => {
    expect(parsePmsetBatt(fx('pmset_discharging.txt'))).toEqual({
      percent: 85,
      charging: false,
      powerState: 'battery',
      minutesLeft: 3 * 60 + 25,
    });
  });
  it('parses charging only for the exact charging token', () => {
    expect(parsePmsetBatt(fx('pmset_charging.txt'))).toEqual({
      percent: 40,
      charging: true,
      powerState: 'charging',
      minutesLeft: 70,
    });
  });
  it.each(['pmset_charged.txt', 'pmset_ac_zero.txt'])(
    'recognizes AC full without a remaining estimate: %s',
    (fixture) => {
      expect(parsePmsetBatt(fx(fixture))).toEqual({ percent: 100, charging: false, powerState: 'charged' });
    },
  );
  it.each([
    ['pmset_noestimate.txt', 55, false, 'battery', true],
    ['pmset_ac_noestimate.txt', 40, true, 'charging', true],
    ['pmset_ac_paused.txt', 80, false, 'external', true],
    ['pmset_invalid_estimate.txt', 55, false, 'battery', false],
  ])('omits unavailable or invalid estimates: %s', (fixture, percent, charging, powerState, pending) => {
    expect(parsePmsetBatt(fx(fixture))).toEqual({
      percent,
      charging,
      powerState,
      ...(pending ? { estimatePending: true } : {}),
    });
  });
  it('returns null for a desktop with no battery row', () => {
    expect(parsePmsetBatt(fx('pmset_desktop.txt'))).toBeNull();
  });
  it('throws on garbage output', () => {
    expect(() => parsePmsetBatt(fx('pmset_garbage.txt'))).toThrow();
  });
});

describe('BatterySampler', () => {
  it('reports ok with null value when the machine has no battery', async () => {
    const s = new BatterySampler({ platform: 'darwin', run: run(fx('pmset_desktop.txt')) });
    const f = await s.sample();
    expect(f.status).toBe('ok');
    expect(f.value).toBeNull();
  });
  it('reports unavailable on garbage output', async () => {
    const s = new BatterySampler({ platform: 'darwin', run: run(fx('pmset_garbage.txt')) });
    expect((await s.sample()).status).toBe('unavailable');
  });
  it('reports unavailable when the command fails', async () => {
    const s = new BatterySampler({
      platform: 'darwin',
      run: async () => {
        throw new Error('no pmset');
      },
    });
    expect((await s.sample()).status).toBe('unavailable');
  });
  it('never invokes commands on non-darwin', async () => {
    const runSpy = vi.fn<RunFn>();
    const s = new BatterySampler({ platform: 'linux', run: runSpy });
    expect((await s.sample()).status).toBe('unavailable');
    expect(runSpy).not.toHaveBeenCalled();
  });
});
