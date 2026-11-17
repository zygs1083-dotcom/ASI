import type { BodyThresholdSample, Fact, Signal } from '@asi/sense-types';
import { effectiveDisks, factStatusAt } from '@asi/sense-types';

/** A signal emitted by a body evaluator; `layer` names the §2.2c tier. */
export type BodySignal = Signal & { layer: 'floor' | 'rate' | 'baseline' };

/** A validated numeric body reading plus its natural low-water mark, if any. */
export interface Metric {
  value: number;
  /** Default exhaustion level: 5% of capacity for disk/context, 5% for battery. */
  floor?: number;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function okFact<T>(fact: Fact<T>, at: number): T | undefined {
  return factStatusAt(fact, at) === 'ok' && fact.value !== null ? fact.value : undefined;
}

const inRange = (v: unknown, lo: number, hi: number): v is number => finite(v) && v >= lo && v <= hi;

/**
 * Reads fresh, range-valid numeric metrics out of a body sample (DESIGN
 * §2.2c). Facts that are absent, stale, non-finite or out of range are
 * omitted — never fabricated. `context` is the actual remaining window
 * (`contextProjected` is a forecast and never read); `battery` exists only
 * while discharging.
 */
export function readMetrics(sample: BodyThresholdSample, diskFloor = 0.05): Map<string, Metric> {
  const { body, at } = sample;
  const out = new Map<string, Metric>();
  const cpu = okFact(body.cpu, at);
  if (cpu && inRange(cpu.usage, 0, 1)) out.set('cpu', { value: cpu.usage });
  const hp = okFact(body.harnessProcess, at);
  if (hp && inRange(hp.rss, 0, Number.POSITIVE_INFINITY)) out.set('rss', { value: hp.rss });
  const mem = okFact(body.memory, at);
  if (mem && finite(mem.total) && mem.total > 0 && inRange(mem.used, 0, mem.total)) {
    out.set('memory', { value: mem.used / mem.total });
  }
  for (const d of effectiveDisks(body.disks, at).value ?? []) {
    if (d.status === 'ok' && finite(d.total) && d.total > 0 && inRange(d.free, 0, d.total)) {
      out.set(`disk:${d.mount}`, { value: d.free, floor: d.total * diskFloor });
    }
  }
  const tok = okFact(body.tokens, at);
  if (tok && finite(tok.contextWindow) && tok.contextWindow > 0 && finite(tok.contextUsed) && tok.contextUsed >= 0) {
    out.set('context', { value: tok.contextWindow - tok.contextUsed, floor: tok.contextWindow * 0.05 });
  }
  const bat = okFact(body.battery, at);
  if (bat && !bat.charging && inRange(bat.percent, 0, 100)) {
    out.set('battery', { value: bat.percent, floor: 5 });
  }
  const net = okFact(body.network, at);
  if (net) {
    if (finite(net.rxBps) && net.rxBps >= 0) out.set('network.rx', { value: net.rxBps });
    if (finite(net.txBps) && net.txBps >= 0) out.set('network.tx', { value: net.txBps });
  }
  return out;
}
