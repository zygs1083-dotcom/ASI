import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { runCommand, type RunFn } from './command.js';
import * as fact from './fact.js';
import type { Fact, NetworkValue, SourceRef } from './types.js';

export interface IfaceCounters {
  rx: number;
  tx: number;
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
    if (!/^<Link#\d+>$/.test(cols[iNet] ?? '')) continue;
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
    counters.set(name, { rx, tx });
  }
  return counters;
}

type IfaceMap = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

export function isOnline(interfaces: IfaceMap): boolean {
  for (const [name, list] of Object.entries(interfaces)) {
    if (/^lo\d*$/.test(name)) continue;
    for (const i of list ?? []) {
      if (!i.internal && (i.family === 'IPv4' || (i.family as unknown) === 4)) return true;
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

export class NetworkSampler {
  private prev: Snapshot | undefined;
  private readonly src: SourceRef;

  constructor(private readonly deps: NetworkDeps = {}) {
    this.src = deps.src ?? fact.source('network', '/usr/sbin/netstat -ib');
  }

  async sample(ttlMs: number = fact.DEFAULT_TTL_MS): Promise<Fact<NetworkValue>> {
    if ((this.deps.platform ?? process.platform) !== 'darwin') {
      return fact.fail('unavailable', this.src, ttlMs);
    }
    const run = this.deps.run ?? runCommand;
    try {
      const counters = parseNetstatIB(await run('/usr/sbin/netstat', ['-ib']));
      const now = (this.deps.now ?? (() => performance.now()))();
      const online = isOnline((this.deps.interfaces ?? os.networkInterfaces)());
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
        if (dRx < 0 || dTx < 0) continue; // reset counter contributes 0
        rx += dRx;
        tx += dTx;
      }
      return fact.ok({ online, rxBps: rx / elapsedSec, txBps: tx / elapsedSec }, this.src, ttlMs);
    } catch (err) {
      this.prev = undefined;
      return fact.fail(fact.errorStatus(err), this.src, ttlMs);
    }
  }
}
