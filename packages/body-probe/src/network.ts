import os from 'node:os';
import { defaultRun, type RunFn } from './command.js';
import * as fact from './fact.js';
import type { Fact, NetworkValue, SourceRef } from './types.js';

export interface IfaceCounters {
  rx: number;
  tx: number;
  link?: string; // the '<Link#N>' identity of the interface row
}

const PHYSICAL_IFACE_RE = /^(?:en|pdp_ip)\d+$/;
const VIRTUAL_IFACE_RE = /^(?:lo|utun|tun|tap|ipsec|ppp|gif|stf|awdl|llw|anpi|ap|bridge|feth|vmenet|pktap|xhc)\d*$/i;

export function parseRouteInterface(text: string): string | undefined {
  return /^\s*interface:\s*(\S+)/m.exec(text)?.[1];
}

/**
 * Selects which `netstat -ibn` link counters to sum so VPN/overlay tunnels
 * (`utun*`, `ipsec*`, etc.) and peer-to-peer links (`awdl*`, `llw*`) are not
 * double-counted on top of the underlying physical NIC (`en*`, `pdp_ip*`).
 *
 * 1. Prefer all physical NICs (`en*`, `pdp_ip*`) plus any non-virtual
 *    default-route interface present in `counters`.
 * 2. If none exist in `counters`, fall back to default-route interface(s)
 *    reported by `route -n get`.
 * 3. Otherwise fall back to all non-loopback link counters.
 */
export function selectTrafficInterfaces(
  counters: ReadonlyMap<string, IfaceCounters>,
  routeIfaces: ReadonlySet<string> = new Set(),
): string[] {
  const primary: string[] = [];
  for (const name of counters.keys()) {
    if (PHYSICAL_IFACE_RE.test(name) || (routeIfaces.has(name) && !VIRTUAL_IFACE_RE.test(name))) {
      primary.push(name);
    }
  }
  if (primary.length > 0) return primary;
  const routed = [...routeIfaces].filter((name) => counters.has(name));
  if (routed.length > 0) return routed;
  return [...counters.keys()];
}

// Real `netstat -ibn` Link rows for interfaces without a MAC (utun*, awdl
// tunnels, ...) omit the Address column entirely, leaving one fewer field
// than the header. Rows are re-aligned by inserting an empty Address so the
// Ibytes/Obytes header indexes stay correct.
export function parseNetstatIB(text: string): Map<string, IfaceCounters> {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const header = (lines[0] ?? '').split(/\s+/);
  const iName = header.indexOf('Name');
  const iNet = header.indexOf('Network');
  const iAddr = header.indexOf('Address');
  const iRx = header.indexOf('Ibytes');
  const iTx = header.indexOf('Obytes');
  if (iName < 0 || iNet < 0 || iAddr < 0 || iRx < 0 || iTx < 0) {
    throw new Error('netstat -ibn: missing columns');
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
      if (!/^\d+$/.test(cols[iAddr]!)) throw new Error('netstat -ibn: malformed link row');
      fields = [...cols.slice(0, iAddr), '', ...cols.slice(iAddr)];
    } else if (cols.length !== header.length) {
      throw new Error('netstat -ibn: malformed link row');
    }
    const name = fields[iName]!.replace(/\*+$/, ''); // '*' marks a down interface
    if (/^lo\d*$/.test(name) || counters.has(name)) continue;
    const rx = Number(fields[iRx]);
    const tx = Number(fields[iTx]);
    if (!Number.isInteger(rx) || rx < 0 || !Number.isInteger(tx) || tx < 0) {
      throw new Error('netstat -ibn: bad counters');
    }
    counters.set(name, { rx, tx, link });
  }
  return counters;
}

type IfaceMap = NodeJS.Dict<os.NetworkInterfaceInfo[]>;
type RouteFamily = 'inet' | 'inet6';

// A family is usable only with a globally routable address: any non-internal
// IPv4, or a global-unicast IPv6 in 2000::/3. Loopback, ULA, link-local and
// multicast IPv6 never count — all live outside 2000::/3.
function usableFamilies(interfaces: IfaceMap): Record<RouteFamily, boolean> {
  const usable: Record<RouteFamily, boolean> = { inet: false, inet6: false };
  for (const [name, list] of Object.entries(interfaces)) {
    if (/^lo\d*$/.test(name)) continue;
    for (const i of list ?? []) {
      if (i.internal) continue;
      const family = i.family as unknown;
      if (family === 'IPv4' || family === 4) usable.inet = true;
      if ((family === 'IPv6' || family === 6) && /^[23][0-9a-f]{3}:/i.test(i.address)) usable.inet6 = true;
    }
  }
  return usable;
}

export type RouteVerdicts = Partial<Record<RouteFamily, boolean>>;

// "online" = some address family is usable AND a default route exists for
// that same family; routes never pair across families. `routes` may be a
// legacy boolean (same verdict for both families) or per-family verdicts.
export function isOnline(interfaces: IfaceMap, routes: boolean | RouteVerdicts = true): boolean {
  const usable = usableFamilies(interfaces);
  const routed = (f: RouteFamily) => (typeof routes === 'boolean' ? routes : routes[f] === true);
  return (usable.inet && routed('inet')) || (usable.inet6 && routed('inet6'));
}

export interface NetworkDeps {
  run?: RunFn;
  platform?: NodeJS.Platform;
  interfaces?: () => IfaceMap;
  now?: () => number; // monotonic clock for cache eligibility
  wall?: () => number; // wall clock stamped on cache entries and facts
  src?: SourceRef;
  /** Per-direction sanity ceiling in bytes/sec; defaults to 100 Gbit/s. */
  maxBps?: number;
}

export interface NetworkPeriods {
  routeMs?: number;
}

interface Snapshot {
  at: number;
  counters: Map<string, IfaceCounters>;
}

const ROUTE_CACHE_MS = 30_000;
// Rates above 100 Gbit/s per direction in a single sample interval are counter
// artefacts (rebase aftermath), not real traffic; relaxed from 10 Gbit/s
// combined so 10GbE full-duplex and 40GbE Thunderbolt bursts are not dropped.
const DEFAULT_MAX_BPS = 100_000_000_000 / 8;

interface RouteEntry {
  at: number; // monotonic stamp used for expiry
  observedAt: number; // wall stamp of the cached route observation
  value: boolean; // success (true) or known-offline (false); unknown is never cached
  iface?: string | undefined; // default-route interface reported by `route -n get`
}

// The only recognized no-route diagnostic: `route -n get` prints
// "route: writing to routing socket: not in table" and exits 1. Any other
// nonzero exit or execution failure is undiagnosed -> unknown.
const NO_ROUTE_RE = /not in table/i;

function routeDiagnostics(err: unknown): string {
  const e = err as { message?: unknown; stdout?: unknown; stderr?: unknown } | undefined;
  return [e?.stdout, e?.stderr, e?.message ?? err].map((s) => String(s ?? '')).join('\n');
}

export class NetworkSampler {
  private prev: Snapshot | undefined;
  private routes: Partial<Record<RouteFamily, RouteEntry>> = {};
  private readonly src: SourceRef;

  constructor(private readonly deps: NetworkDeps = {}) {
    this.src = deps.src ?? fact.source('network', '/usr/sbin/netstat -ibn');
  }

  async sample(
    ttlMs: number = fact.DEFAULT_TTL_MS,
    signal?: AbortSignal,
    periods: NetworkPeriods = {},
  ): Promise<Fact<NetworkValue>> {
    if ((this.deps.platform ?? process.platform) !== 'darwin') {
      return fact.fail('unavailable', this.src, ttlMs);
    }
    const run = this.deps.run ?? defaultRun;
    // A child can never poll faster than the parent that publishes it.
    const routeMs = Math.max(periods.routeMs ?? ROUTE_CACHE_MS, ttlMs / 3);
    try {
      const counters = parseNetstatIB(await run('/usr/sbin/netstat', ['-ibn'], signal));
      signal?.throwIfAborted();
      const now = (this.deps.now ?? (() => globalThis.performance.now()))();
      const wallNow = (this.deps.wall ?? (() => Date.now()))();
      const online = await this.onlineStatus(now, wallNow, routeMs, run, signal);
      signal?.throwIfAborted();
      if (online.verdict === 'unknown') {
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
      for (const name of selectTrafficInterfaces(counters, online.routeIfaces)) {
        const cur = counters.get(name);
        const before = prev.counters.get(name);
        if (!cur || !before) continue; // newly appeared interface: baseline only
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
      const maxBps = this.deps.maxBps ?? DEFAULT_MAX_BPS;
      if (rxBps > maxBps || txBps > maxBps) {
        return fact.fail('unknown', this.src, ttlMs);
      }
      const meta = fact.oldestMeta([{ observedAt: wallNow, periodMs: ttlMs / 3, at: now }, ...online.parts]);
      const f = fact.ok({ online: online.verdict, rxBps, txBps }, this.src, meta.expiresAt! - now, wallNow);
      if (meta.expiresAt !== undefined) fact.trackDeadline(f, meta.expiresAt);
      return f;
    } catch (err) {
      // Abort leaves the baseline untouched so a later generation can still
      // compute deltas; real failures reset it.
      if (!signal?.aborted) this.prev = undefined;
      return fact.fail(fact.errorStatus(err), this.src, ttlMs);
    }
  }

  // 'unknown' when the interfaces list is unreadable or a needed route probe
  // fails without a recognized diagnostic. Only families with usable
  // addresses are probed, and a verdict only ever pairs with its own family.
  private async onlineStatus(
    now: number,
    wallNow: number,
    routeMs: number,
    run: RunFn,
    signal?: AbortSignal,
  ): Promise<{ verdict: boolean | 'unknown'; parts: fact.FactMeta[]; routeIfaces: Set<string> }> {
    let interfaces: IfaceMap;
    try {
      interfaces = (this.deps.interfaces ?? os.networkInterfaces)();
    } catch {
      return { verdict: 'unknown', parts: [], routeIfaces: new Set() };
    }
    const usable = usableFamilies(interfaces);
    const parts: fact.FactMeta[] = [];
    const verdicts: (boolean | 'unknown')[] = [];
    const routeIfaces = new Set<string>();
    for (const family of ['inet', 'inet6'] as const) {
      if (!usable[family]) continue;
      const r = await this.routeVerdict(family, now, wallNow, routeMs, run, signal);
      if (signal?.aborted) return { verdict: 'unknown', parts: [], routeIfaces: new Set() };
      verdicts.push(r.verdict);
      if (r.meta) parts.push(r.meta);
      if (r.verdict === true && r.iface) routeIfaces.add(r.iface);
    }
    if (verdicts.includes(true)) return { verdict: true, parts, routeIfaces };
    if (verdicts.includes('unknown')) return { verdict: 'unknown', parts: [], routeIfaces: new Set() };
    // No usable addresses, or every needed family is known offline.
    return { verdict: false, parts, routeIfaces };
  }

  private async routeVerdict(
    family: RouteFamily,
    now: number,
    wallNow: number,
    routeMs: number,
    run: RunFn,
    signal?: AbortSignal,
  ): Promise<{ verdict: boolean | 'unknown'; iface?: string | undefined; meta?: fact.FactMeta }> {
    const cached = this.routes[family];
    if (cached && now - cached.at < routeMs) {
      return {
        verdict: cached.value,
        iface: cached.iface,
        meta: { observedAt: cached.observedAt, periodMs: routeMs, at: cached.at },
      };
    }
    let verdict: boolean | 'unknown';
    let iface: string | undefined;
    try {
      const out = await run('/sbin/route', ['-n', 'get', `-${family}`, 'default'], signal);
      verdict = true;
      iface = parseRouteInterface(out);
    } catch (err) {
      if (signal?.aborted) return { verdict: 'unknown' };
      verdict = NO_ROUTE_RE.test(routeDiagnostics(err)) ? false : 'unknown';
    }
    // An aborted generation never writes the cache, and unknown is never
    // cached at all so the next sample retries the probe.
    if (signal?.aborted || verdict === 'unknown') return { verdict: 'unknown' };
    this.routes[family] = { at: now, observedAt: wallNow, value: verdict, iface };
    return { verdict, iface, meta: { observedAt: wallNow, periodMs: routeMs, at: now } };
  }

  // Drops the route verdicts and the rate baseline so a restart re-probes and
  // re-baselines; called by BodyProbe on stop and start. Aborted in-flight
  // reads already check their signal before writing.
  reset(): void {
    this.routes = {};
    this.prev = undefined;
  }
}
