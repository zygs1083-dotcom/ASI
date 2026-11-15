import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { defaultRun, type RunFn } from './command.js';
import * as fact from './fact.js';
import type { Fact, NetworkValue, SourceRef } from './types.js';

export interface IfaceCounters {
  rx: number;
  tx: number;
  link?: string; // the '<Link#N>' identity of the interface row
}

// Real `netstat -ib` Link rows for interfaces without a MAC (utun*, awdl
// tunnels, ...) omit the Address column entirely, leaving one fewer field
// than the header. Rows are re-aligned by inserting an empty Address so the
// Ibytes/Obytes header indexes stay correct.
export function parseNetstatIB(text: string): Map<string, IfaceCounters> {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const header = (lines[0] ?? '').split(/\s+/);
  const iName = header.indexOf('Name');
  const iNet = header.indexOf('Network');
  const iAddr = header.indexOf('Address');
  const iRx = header.indexOf('Ibytes');
  const iTx = header.indexOf('Obytes');
  if (iName < 0 || iNet < 0 || iAddr < 0 || iRx < 0 || iTx < 0) {
    throw new Error('netstat -ib: missing columns');
  }
  const counters = new Map<string, IfaceCounters>();
  for (const line of lines.slice(1)) {
    const cols = line.split(/\s+/);
    const link = cols[iNet];
    if (!link || !/^<Link#\d+>$/.test(link)) continue;
    let fields = cols;
    if (cols.length === header.length - 1) {
      // The one-field-short row is only a legit omitted Address when the slot
      // after Network is a packet count; a MAC there means a numeric column is
      // missing instead and realigning would misread the counters.
      if (!/^\d+$/.test(cols[iAddr]!)) throw new Error('netstat -ib: malformed link row');
      fields = [...cols.slice(0, iAddr), '', ...cols.slice(iAddr)];
    } else if (cols.length !== header.length) {
      throw new Error('netstat -ib: malformed link row');
    }
    const name = fields[iName]!.replace(/\*+$/, ''); // '*' marks a down interface
    if (/^lo\d*$/.test(name) || counters.has(name)) continue;
    const rx = Number(fields[iRx]);
    const tx = Number(fields[iTx]);
    if (!Number.isInteger(rx) || rx < 0 || !Number.isInteger(tx) || tx < 0) {
      throw new Error('netstat -ib: bad counters');
    }
    counters.set(name, { rx, tx, link });
  }
  return counters;
}

type IfaceMap = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

// "online" = at least one globally usable address (any non-internal IPv4, or
// a global-unicast IPv6 in 2000::/3) AND a default route. Loopback, ULA,
// link-local and multicast IPv6 never count — all live outside 2000::/3.
export function isOnline(interfaces: IfaceMap, hasDefaultRoute = true): boolean {
  if (!hasDefaultRoute) return false;
  for (const [name, list] of Object.entries(interfaces)) {
    if (/^lo\d*$/.test(name)) continue;
    for (const i of list ?? []) {
      if (i.internal) continue;
      const family = i.family as unknown;
      if (family === 'IPv4' || family === 4) return true;
      if ((family === 'IPv6' || family === 6) && /^[23][0-9a-f]{3}:/i.test(i.address)) return true;
    }
  }
  return false;
}

export interface NetworkDeps {
  run?: RunFn;
  platform?: NodeJS.Platform;
  interfaces?: () => IfaceMap;
  now?: () => number;
  src?: SourceRef;
}

interface Snapshot {
  at: number;
  counters: Map<string, IfaceCounters>;
}

const ROUTE_CACHE_MS = 30_000;
// Rates above 10 Gbit/s in a single sample interval are counter artefacts
// (rebase aftermath), not real traffic.
const MAX_BPS = 10_000_000_000 / 8;

export class NetworkSampler {
  private prev: Snapshot | undefined;
  private route: { at: number; value: boolean | 'unknown' } | undefined;
  private readonly src: SourceRef;

  constructor(private readonly deps: NetworkDeps = {}) {
    this.src = deps.src ?? fact.source('network', '/usr/sbin/netstat -ib');
  }

  async sample(ttlMs: number = fact.DEFAULT_TTL_MS, signal?: AbortSignal): Promise<Fact<NetworkValue>> {
    if ((this.deps.platform ?? process.platform) !== 'darwin') {
      return fact.fail('unavailable', this.src, ttlMs);
    }
    const run = this.deps.run ?? defaultRun;
    try {
      const counters = parseNetstatIB(await run('/usr/sbin/netstat', ['-ib'], signal));
      signal?.throwIfAborted();
      const now = (this.deps.now ?? (() => performance.now()))();
      const online = await this.onlineStatus(now, run, signal);
      signal?.throwIfAborted();
      if (online === 'unknown') {
        this.prev = undefined; // reset baseline safely; next sample re-baselines
        return fact.fail('unknown', this.src, ttlMs);
      }
      const prev = this.prev;
      this.prev = { at: now, counters };
      if (!prev) return fact.fail('unknown', this.src, ttlMs);
      const elapsedSec = (now - prev.at) / 1000;
      if (!(elapsedSec > 0)) return fact.fail('unknown', this.src, ttlMs);
      let rx = 0;
      let tx = 0;
      for (const [name, cur] of counters) {
        const before = prev.counters.get(name);
        if (!before) continue; // newly appeared interface: baseline only
        const dRx = cur.rx - before.rx;
        const dTx = cur.tx - before.tx;
        // Same-name replacement (different link) or a counter reset can fake
        // huge spikes; the baseline is already current, so report unknown.
        if (before.link !== cur.link || dRx < 0 || dTx < 0) {
          return fact.fail('unknown', this.src, ttlMs);
        }
        rx += dRx;
        tx += dTx;
      }
      const rxBps = rx / elapsedSec;
      const txBps = tx / elapsedSec;
      if (rxBps > MAX_BPS || txBps > MAX_BPS || rxBps + txBps > MAX_BPS) {
        return fact.fail('unknown', this.src, ttlMs);
      }
      return fact.ok({ online, rxBps, txBps }, this.src, ttlMs);
    } catch (err) {
      // Abort leaves the baseline untouched so a later generation can still
      // compute deltas; real failures reset it.
      if (!signal?.aborted) this.prev = undefined;
      return fact.fail(fact.errorStatus(err), this.src, ttlMs);
    }
  }

  // 'unknown' when the interfaces list is unreadable or the default-route
  // probe fails non-numerically: online cannot be determined.
  private async onlineStatus(now: number, run: RunFn, signal?: AbortSignal): Promise<boolean | 'unknown'> {
    let interfaces: IfaceMap;
    try {
      interfaces = (this.deps.interfaces ?? os.networkInterfaces)();
    } catch {
      return 'unknown';
    }
    if (this.route && now - this.route.at < ROUTE_CACHE_MS) {
      return this.route.value === 'unknown' ? 'unknown' : isOnline(interfaces, this.route.value);
    }
    let value: boolean | 'unknown';
    try {
      await run('/sbin/route', ['-n', 'get', 'default'], signal);
      value = true;
    } catch (err) {
      if (signal?.aborted) return 'unknown'; // abort outcomes are never cached
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      value = typeof code === 'number' && code > 0 ? false : 'unknown';
    }
    signal?.throwIfAborted();
    this.route = { at: now, value };
    return value === 'unknown' ? 'unknown' : isOnline(interfaces, value);
  }
}
