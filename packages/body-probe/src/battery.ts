import { runCommand, type RunFn } from './command.js';
import * as fact from './fact.js';
import type { BatteryValue, Fact, SourceRef } from './types.js';

export function parsePmsetBatt(text: string): BatteryValue | null {
  if (!/Now drawing from/.test(text)) throw new Error('pmset: unrecognized output');
  const row = text.split('\n').find((line) => line.includes('InternalBattery'));
  if (!row) return null;
  const m = /(\d+)\s*%;\s*([A-Za-z ]+?)\s*;(.*)$/.exec(row);
  if (!m) throw new Error('pmset: malformed battery row');
  const percent = Number(m[1]);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error('pmset: percent out of range');
  }
  const charging = m[2]!.trim() === 'charging';
  const estimate = /(\d+):(\d+)\s+remaining/.exec(m[3]!);
  if (!estimate) return { percent, charging };
  return { percent, charging, minutesLeft: Number(estimate[1]) * 60 + Number(estimate[2]) };
}

export interface BatteryDeps {
  run?: RunFn;
  platform?: NodeJS.Platform;
  src?: SourceRef;
}

export class BatterySampler {
  private readonly src: SourceRef;

  constructor(private readonly deps: BatteryDeps = {}) {
    this.src = deps.src ?? fact.source('battery', '/usr/bin/pmset -g batt');
  }

  sample(ttlMs: number = fact.DEFAULT_TTL_MS): Promise<Fact<BatteryValue | null>> {
    if ((this.deps.platform ?? process.platform) !== 'darwin') {
      return Promise.resolve(fact.fail('unavailable', this.src, ttlMs));
    }
    const run = this.deps.run ?? runCommand;
    return fact.collect(this.src, async () => parsePmsetBatt(await run('/usr/bin/pmset', ['-g', 'batt'])), ttlMs);
  }
}
