import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { NetworkSampler, isOnline, parseNetstatIB } from '../src/network.js';
import type { RunFn } from '../src/command.js';

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const iface = (over: Partial<NetworkInterfaceInfo>): NetworkInterfaceInfo =>
  ({ address: 'a', netmask: 'n', family: 'IPv4', mac: 'm', internal: false, cidr: null, ...over }) as NetworkInterfaceInfo;

const HEADER =
  'Name  Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes    Coll';
const linkRow = (name: string, link: string, rx: number, tx: number) =>
  `${name}   1500  ${link}    aa:bb:cc:dd:ee:ff     100     0       ${rx}     200     0       ${tx}      0`;
const netstat = (...rows: string[]) => [HEADER, ...rows].join('\n');

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('parseNetstatIB', () => {
  it('counts only Network=<Link#..> rows, dedups by name, excludes lo0', () => {
    const m = parseNetstatIB(fx('netstat_1.txt'));
    expect([...m.keys()]).toEqual(['en0']);
    expect(m.get('en0')).toEqual({ rx: 1000, tx: 2000, link: '<Link#4>' });
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
    expect(m.get('utun9')).toEqual({ rx: 6000, tx: 9000, link: '<Link#20>' });
  });

  it('throws on a link row matching neither field-count variant', () => {
    expect(() => parseNetstatIB(fx('netstat_badlink.txt'))).toThrow();
  });
});

describe('isOnline', () => {
  const cases: [NodeJS.Dict<NetworkInterfaceInfo[]>, boolean][] = [
    [{ en0: [iface({})] }, true],
    [{ en0: [iface({ family: 4 as unknown as 'IPv4' })] }, true],
    [{ en0: [iface({ family: 'IPv6', address: '2001:db8::5' })] }, true],
    [{ en0: [iface({ family: 6 as unknown as 'IPv6', address: '2606:4700::1' })] }, true],
    [{ en0: [iface({ family: 'IPv6', address: 'fe80::1' })] }, false],
    [{ en0: [iface({ family: 'IPv6', address: 'fd00::9' })] }, false],
    [{ en0: [iface({ family: 'IPv6', address: 'ff02::1' })] }, false],
    [{ en0: [iface({ family: 'IPv6', address: '2::1' })] }, false],
    [{ en0: [iface({ family: 'IPv6', address: '3::1' })] }, false],
    [{ en0: [iface({ family: 'IPv6', address: '::1' })] }, false],
    [{ lo0: [iface({ internal: false })] }, false],
    [{ en0: [iface({ internal: true })] }, false],
    [{}, false],
  ];
  it.each(cases)('address predicate %#', (interfaces, expected) => {
    expect(isOnline(interfaces)).toBe(expected);
  });

  it('requires the default route', () => {
    expect(isOnline({ en0: [iface({})] }, false)).toBe(false);
    expect(isOnline({ en0: [iface({ family: 'IPv6', address: '2001:db8::5' })] }, false)).toBe(false);
  });

  it('pairs a route only with usable addresses of its own family', () => {
    const v4 = { en0: [iface({})] };
    const v6 = { en0: [iface({ family: 'IPv6', address: '2001:db8::5' })] };
    expect(isOnline(v4, { inet: true, inet6: false })).toBe(true);
    expect(isOnline(v4, { inet: false, inet6: true })).toBe(false); // a v6 route cannot carry v4
    expect(isOnline(v6, { inet: false, inet6: true })).toBe(true);
    expect(isOnline(v6, { inet: true, inet6: false })).toBe(false); // a v4 route cannot carry v6
    expect(isOnline(v4, false)).toBe(false); // legacy boolean callers unchanged
    expect(isOnline(v6, true)).toBe(true);
  });
});

describe('NetworkSampler', () => {
  const sampler = (
    texts: string[],
    now: () => number,
    interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]> = () => ({ en0: [iface({})] }),
    route?: RunFn,
  ) => {
    let i = 0;
    const run: RunFn = async (file, args = []) =>
      file.endsWith('netstat') ? texts[Math.min(i++, texts.length - 1)]!
        : route ? route(file, args) : ''; // /sbin/route exit 0
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

  it('gives newly appearing interfaces their own baseline and reports unknown on resets', async () => {
    let t = 0;
    const s = sampler(
      [fx('netstat_hotplug_1.txt'), fx('netstat_hotplug_2.txt'), fx('netstat_reset_2.txt'),
        netstat(linkRow('en0', '<Link#4>', 1500, 1700), linkRow('en7', '<Link#9>', 71000, 91000))],
      () => (t += 1000) - 1000,
    );
    await s.sample(0);
    const second = await s.sample(1000);
    // en0 delta over 1s; en7 appeared -> contributes nothing this interval
    expect(second.value?.rxBps).toBe(2000);
    // en0 counters dropped below baseline -> rebase, reported unknown not 0 B/s
    expect((await s.sample(1000)).status).toBe('unknown');
    const fourth = await s.sample(1000);
    expect(fourth.status).toBe('ok');
    expect(fourth.value?.rxBps).toBe(2000); // 1000/s en0 + 1000/s en7
  });

  it.each([
    ['<Link#5>', 1_000_000_000], // same name, new link identity, counters already higher
    ['<Link#4>', 2_000_000_100], // same identity, implausible burst
  ])('reports unknown on a corrupt delta (link %s, rx %i) and recovers', async (link, rx) => {
    let t = 0;
    const s = sampler(
      [netstat(linkRow('en0', '<Link#4>', 100, 200)),
        netstat(linkRow('en0', link, rx, 200)),
        netstat(linkRow('en0', link, rx + 2000, 400))],
      () => (t += 1000) - 1000,
    );
    await s.sample(0);
    expect((await s.sample(1000)).status).toBe('unknown'); // not a fake spike
    const next = await s.sample(1000);
    expect(next.status).toBe('ok');
    expect(next.value).toEqual({ online: true, rxBps: 2000, txBps: 200 });
  });

  const routeCases: [RunFn, boolean | undefined, string][] = [
    [async () => '', true, 'ok'],
    // a recognizable "no default route" diagnostic means genuinely offline
    [async () => { throw Object.assign(new Error('route: writing to routing socket: not in table'), { code: 1 }); }, false, 'ok'],
    // a bare nonzero exit is undiagnosed: unknown, not offline
    [async () => { throw Object.assign(new Error('exit 1'), { code: 1 }); }, undefined, 'unknown'],
    [async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }, undefined, 'unknown'],
  ];
  it.each(routeCases)('maps the route probe to online/status %#', async (route, online, status) => {
    let t = 0;
    const s = sampler([fx('netstat_1.txt'), fx('netstat_2.txt')], () => (t += 1000) - 1000, undefined, route);
    await s.sample(0);
    const f = await s.sample(1000);
    expect(f.status).toBe(status);
    if (online !== undefined) expect(f.value?.online).toBe(online);
  });

  it.each([
    ['online', 'ok'],
    ['offline', 'ok'],
    ['unknown', 'unknown'],
  ] as const)('caches a %s route verdict 30s but never unknown', async (mode, status) => {
    let t = 0;
    let routeCalls = 0;
    let i = 0;
    const texts = [fx('netstat_1.txt'), fx('netstat_2.txt'), fx('netstat_2.txt'), fx('netstat_2.txt'), fx('netstat_2.txt')];
    const run: RunFn = async (file) => {
      if (file.endsWith('netstat')) return texts[Math.min(i++, texts.length - 1)]!;
      routeCalls += 1;
      if (mode === 'offline') {
        throw Object.assign(new Error('route: writing to routing socket: not in table'), { code: 1 });
      }
      if (mode === 'unknown') throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return '';
    };
    const s = new NetworkSampler({ platform: 'darwin', run, now: () => t, interfaces: () => ({ en0: [iface({})] }) });
    await s.sample(0);
    t = 1_000;
    expect((await s.sample(0)).status).toBe(status);
    t = 29_000;
    await s.sample(0);
    expect(routeCalls).toBe(mode === 'unknown' ? 3 : 1); // unknown retries every sample
    t = 30_001;
    await s.sample(0);
    expect(routeCalls).toBe(mode === 'unknown' ? 4 : 2); // success/offline expire at 30s
  });

  it('queries only the -inet6 route for IPv6-only interfaces', async () => {
    let t = 0;
    const routeArgs: string[][] = [];
    const s = sampler(
      [fx('netstat_1.txt'), fx('netstat_2.txt')],
      () => (t += 1000) - 1000,
      () => ({ en0: [iface({ family: 'IPv6', address: '2001:db8::5' })] }),
      async (_file, args = []) => { routeArgs.push([...args]); return ''; },
    );
    await s.sample(0);
    const f = await s.sample(1000);
    expect(f.value?.online).toBe(true);
    expect(routeArgs).toEqual([['-n', 'get', '-inet6', 'default']]);
  });

  it.each<{
    interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
    routes: Record<string, 'ok' | 'offline' | 'unknown'>;
    online: boolean;
    queried: string[][];
  }>([
    // IPv4 address, but only an IPv6 default route exists: offline.
    { interfaces: () => ({ en0: [iface({})] }),
      routes: { '-inet': 'offline', '-inet6': 'ok' },
      online: false, queried: [['-n', 'get', '-inet', 'default']] },
    // IPv6 address, but only an IPv4 default route exists: offline.
    { interfaces: () => ({ en0: [iface({ family: 'IPv6', address: '2001:db8::5' })] }),
      routes: { '-inet': 'ok', '-inet6': 'offline' },
      online: false, queried: [['-n', 'get', '-inet6', 'default']] },
    // Dual stack: one family's unknown does not invalidate the other's
    // online; the unknown family is not cached and retried next sample.
    { interfaces: () => ({ en0: [iface({}), iface({ family: 'IPv6', address: '2001:db8::5' })] }),
      routes: { '-inet': 'unknown', '-inet6': 'ok' },
      online: true, queried: [
        ['-n', 'get', '-inet', 'default'], ['-n', 'get', '-inet6', 'default'],
        ['-n', 'get', '-inet', 'default'],
      ] },
  ])('pairs route verdicts with their own family %#', async ({ interfaces, routes, online, queried }) => {
    let t = 0;
    const routeArgs: string[][] = [];
    const s = sampler(
      [fx('netstat_1.txt'), fx('netstat_2.txt')],
      () => (t += 1000) - 1000,
      interfaces,
      async (_file, args = []) => {
        routeArgs.push([...args]);
        const mode = routes[args[2]!];
        if (mode === 'offline') {
          throw Object.assign(new Error('route: writing to routing socket: not in table'), { code: 1 });
        }
        if (mode === 'unknown') throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        return '';
      },
    );
    await s.sample(0);
    const f = await s.sample(1000);
    expect(f.status).toBe('ok');
    expect(f.value?.online).toBe(online);
    expect(routeArgs).toEqual(queried);
  });

  it('an aborted generation never writes the route cache', async () => {
    let routes = 0;
    const d = deferred<string>();
    const controller = new AbortController();
    const run: RunFn = async (file) => {
      if (file.endsWith('netstat')) return netstat(linkRow('en0', '<Link#4>', 100, 200));
      routes += 1;
      return routes === 1 ? d.promise : '';
    };
    const s = new NetworkSampler({ platform: 'darwin', run, now: () => 0, interfaces: () => ({ en0: [iface({})] }) });
    const stale = s.sample(0, controller.signal); // netstat done, route deferred
    await vi.waitFor(() => expect(routes).toBe(1));
    controller.abort();
    d.resolve(''); // late success for the aborted probe must not be cached
    await stale;
    await s.sample(0);
    expect(routes).toBe(2); // no cache entry: the next sample re-runs the probe
    await s.sample(0);
    expect(routes).toBe(2); // the fresh verdict is now cached
  });

  it('composes observedAt/ttlMs from the oldest constituent (rate vs route)', async () => {
    let mono = 0;
    let wall = 1_000;
    let i = 0;
    let routeCalls = 0;
    const texts = [fx('netstat_1.txt'), fx('netstat_2.txt'), fx('netstat_2.txt'), fx('netstat_2.txt')];
    const s = new NetworkSampler({
      platform: 'darwin',
      run: async (file) => (file.endsWith('netstat')
        ? texts[Math.min(i++, texts.length - 1)]!
        : (routeCalls += 1, '')),
      now: () => mono,
      wall: () => wall,
      interfaces: () => ({ en0: [iface({})] }),
    });
    await s.sample(6000); // baseline sample; route observed at wall 1000
    wall = 5_000; mono = 4_000;
    const f = await s.sample(6000);
    expect(f.status).toBe('ok');
    expect(f.observedAt).toBe(1000); // the cached route observation is oldest
    expect(f.ttlMs).toBe(90_000);    // 3 * 30s route period beats the rate sample's ttl
    expect(routeCalls).toBe(1);
  });

  it('a late-resolving aborted sample cannot overwrite the newer baseline or route cache', async () => {
    let t = 0, calls = 0, routes = 0;
    const d = deferred<string>();
    const controller = new AbortController();
    const run: RunFn = async (file) => {
      if (!file.endsWith('netstat')) return ++routes === 1 ? d.promise : '';
      calls += 1;
      // sample k reads (1000k, 2000k) except the baseline (100, 200)
      return netstat(linkRow('en0', '<Link#4>', calls === 1 ? 100 : 1000 * calls, calls === 1 ? 200 : 2000 * calls));
    };
    const s = new NetworkSampler({ platform: 'darwin', run, now: () => t, interfaces: () => ({ en0: [iface({})] }) });
    const stale = s.sample(0, controller.signal); // netstat resolves, route deferred
    await s.sample(0);                            // newer sample completes fully (baseline B2, route true)
    controller.abort();
    d.resolve(''); // late route success for the aborted sample
    expect((await stale).status).not.toBe('ok');
    t = 1_000;
    const f = await s.sample(0);
    expect(f.value).toEqual({ online: true, rxBps: 1000, txBps: 2000 }); // deltas vs newer baseline (2000,4000)
    expect(routes).toBe(2); // stale sample never wrote its route outcome
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

  it('reports unavailable when the netstat command fails', async () => {
    const s = new NetworkSampler({ platform: 'darwin', run: async () => { throw new Error('offline'); }, now: () => 0 });
    expect((await s.sample(0)).status).toBe('unavailable');
  });

  it('reports unknown and rebases when interfaces() throws', async () => {
    let t = 0;
    let i = 0;
    const texts = [fx('netstat_1.txt'), fx('netstat_2.txt'), fx('netstat_2.txt')];
    const ifaces = vi.fn<() => NodeJS.Dict<NetworkInterfaceInfo[]>>(() => {
      throw new Error('os boom');
    });
    const s = new NetworkSampler({
      platform: 'darwin',
      run: async (file) => (file.endsWith('netstat') ? texts[Math.min(i++, texts.length - 1)]! : ''),
      now: () => (t += 1000) - 1000,
      interfaces: ifaces,
    });
    expect((await s.sample(0)).status).toBe('unknown'); // online undecidable
    ifaces.mockImplementation(() => ({ en0: [iface({})] }));
    expect((await s.sample(0)).status).toBe('unknown'); // baseline again
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
