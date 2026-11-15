import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { NetworkSampler, isOnline, parseNetstatIB } from '../src/network.js';
import type { RunFn } from '../src/command.js';

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const iface = (over: Partial<NetworkInterfaceInfo>): NetworkInterfaceInfo =>
  ({ address: 'a', netmask: 'n', family: 'IPv4', mac: 'm', internal: false, cidr: null, ...over }) as NetworkInterfaceInfo;

describe('parseNetstatIB', () => {
  it('counts only Network=<Link#..> rows, dedups by name, excludes lo0', () => {
    const m = parseNetstatIB(fx('netstat_1.txt'));
    expect([...m.keys()]).toEqual(['en0']);
    expect(m.get('en0')).toEqual({ rx: 1000, tx: 2000 });
  });
  it('accepts a valid but empty table', () => {
    expect(parseNetstatIB(fx('netstat_empty.txt')).size).toBe(0);
  });
  it('throws when byte columns are missing from the header', () => {
    expect(() => parseNetstatIB(fx('netstat_malformed.txt'))).toThrow();
  });

  it('re-aligns link rows that omit the Address column and excludes lo0*', () => {
    const m = parseNetstatIB(fx('netstat_utun_2.txt'));
    expect([...m.keys()]).toEqual(['utun9']);
    expect(m.get('utun9')).toEqual({ rx: 6000, tx: 9000 });
  });

  it('throws on a link row matching neither field-count variant', () => {
    expect(() => parseNetstatIB(fx('netstat_badlink.txt'))).toThrow();
  });
});

describe('isOnline', () => {
  it('is true when a non-internal IPv4 address exists', () => {
    expect(isOnline({ en0: [iface({})] })).toBe(true);
    expect(isOnline({ en0: [iface({ family: 4 as unknown as 'IPv4' })] })).toBe(true);
  });
  it('is false for internal-only or IPv6-only', () => {
    expect(isOnline({ lo0: [iface({ internal: true })] })).toBe(false);
    expect(isOnline({ en0: [iface({ family: 'IPv6' })] })).toBe(false);
    expect(isOnline({})).toBe(false);
  });

  it('skips loopback interfaces by name even when marked non-internal', () => {
    expect(isOnline({ lo0: [iface({ internal: false })] })).toBe(false);
  });
});

describe('NetworkSampler', () => {
  const sampler = (texts: string[], now: () => number, interfaces = () => ({ en0: [iface({})] })) => {
    let i = 0;
    const run: RunFn = async () => texts[Math.min(i++, texts.length - 1)]!;
    return new NetworkSampler({ platform: 'darwin', run, now, interfaces });
  };

  it('first sample records baseline and reports unknown; next computes B/s over elapsed', async () => {
    let t = 0;
    const s = sampler([fx('netstat_1.txt'), fx('netstat_2.txt')], () => (t += 2000) - 2000);
    const first = await s.sample(0);
    expect(first.status).toBe('unknown');
    const second = await s.sample(2000);
    expect(second.status).toBe('ok');
    expect(second.value).toEqual({ online: true, rxBps: 1000, txBps: 1500 });
  });

  it('gives newly appearing interfaces their own baseline and zeroes resets', async () => {
    let t = 0;
    const s = sampler([fx('netstat_hotplug_1.txt'), fx('netstat_hotplug_2.txt'), fx('netstat_reset_2.txt')],
      () => (t += 1000) - 1000);
    await s.sample(0);
    const second = await s.sample(1000);
    // en0 delta over 1s; en7 appeared -> contributes nothing this interval
    expect(second.value?.rxBps).toBe(2000);
    const third = await s.sample(1000);
    // en0 counters reset -> contributes 0; en7 now has a baseline but prev had it at 70000/90000
    expect(third.value?.rxBps).toBe(0);
    expect(third.value?.txBps).toBe(0);
  });

  it('reports unavailable on malformed output then rebases safely', async () => {
    let t = 0;
    const s = sampler([fx('netstat_1.txt'), fx('netstat_malformed.txt'), fx('netstat_2.txt'), fx('netstat_2.txt')],
      () => (t += 1000) - 1000);
    await s.sample(0);
    expect((await s.sample(1000)).status).toBe('unavailable');
    // rebased: this sample only records the baseline again
    expect((await s.sample(1000)).status).toBe('unknown');
    const ok = await s.sample(1000);
    expect(ok.status).toBe('ok');
    expect(ok.value?.rxBps).toBe(0);
  });

  it('reports unavailable when the command fails', async () => {
    const s = new NetworkSampler({ platform: 'darwin', run: async () => { throw new Error('offline'); }, now: () => 0 });
    expect((await s.sample(0)).status).toBe('unavailable');
  });

  it('reports unavailable and rebases when interfaces() throws', async () => {
    let t = 0;
    let i = 0;
    const texts = [fx('netstat_1.txt'), fx('netstat_2.txt'), fx('netstat_2.txt')];
    const ifaces = vi.fn<() => NodeJS.Dict<NetworkInterfaceInfo[]>>(() => {
      throw new Error('os boom');
    });
    const s = new NetworkSampler({
      platform: 'darwin',
      run: async () => texts[Math.min(i++, texts.length - 1)]!,
      now: () => (t += 1000) - 1000,
      interfaces: ifaces,
    });
    expect((await s.sample(0)).status).toBe('unavailable');
    ifaces.mockImplementation(() => ({ en0: [iface({})] }));
    expect((await s.sample(0)).status).toBe('unknown'); // prev cleared -> baseline again
    expect((await s.sample(0)).status).toBe('ok');
  });

  it('reports unavailable when now() throws', async () => {
    const s = new NetworkSampler({
      platform: 'darwin',
      run: async () => fx('netstat_1.txt'),
      now: () => { throw new Error('clock'); },
    });
    expect((await s.sample(0)).status).toBe('unavailable');
  });

  it('computes rates for no-MAC link rows after realignment', async () => {
    let t = 0;
    const s = sampler([fx('netstat_utun_1.txt'), fx('netstat_utun_2.txt')], () => (t += 2000) - 2000);
    await s.sample(0);
    const f = await s.sample(2000);
    expect(f.status).toBe('ok');
    expect(f.value?.rxBps).toBe(2000);
    expect(f.value?.txBps).toBe(3000);
  });

  it('never invokes commands on non-darwin', async () => {
    const runSpy = vi.fn<RunFn>();
    const s = new NetworkSampler({ platform: 'linux', run: runSpy });
    expect((await s.sample(0)).status).toBe('unavailable');
    expect(runSpy).not.toHaveBeenCalled();
  });
});
