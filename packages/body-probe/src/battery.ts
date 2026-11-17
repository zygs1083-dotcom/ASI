import { defaultRun, type RunFn } from './command.js';
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
  const estimate = /(?:^|\s)(\d+):([0-5]\d)\s+remaining\b/.exec(m[3]!);
  const minutes = estimate ? Number(estimate[1]) * 60 + Number(estimate[2]) : undefined;
  const ac = /Now drawing from 'AC Power'/.test(text);
  const onBattery = /Now drawing from 'Battery Power'/.test(text);
  const powerState = ac
    ? m[2]!.trim() === 'charged' || minutes === 0
      ? 'charged'
      : charging
        ? 'charging'
        : 'external'
    : onBattery
      ? 'battery'
      : undefined;
  return {
    percent,
    charging,
    ...(powerState ? { powerState } : {}),
    ...(powerState !== 'charged' && /\(no estimate\)/i.test(m[3]!) ? { estimatePending: true } : {}),
    ...((powerState === 'battery' || powerState === 'charging') &&
    minutes !== undefined &&
    Number.isSafeInteger(minutes) &&
    minutes > 0
      ? { minutesLeft: minutes }
      : {}),
  };
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

  sample(ttlMs: number = fact.DEFAULT_TTL_MS, signal?: AbortSignal): Promise<Fact<BatteryValue | null>> {
    if ((this.deps.platform ?? process.platform) !== 'darwin') {
      return Promise.resolve(fact.fail('unavailable', this.src, ttlMs));
    }
    const run = this.deps.run ?? defaultRun;
    return fact.collect(
      this.src,
      async () => parsePmsetBatt(await run('/usr/bin/pmset', ['-g', 'batt'], signal)),
      ttlMs,
    );
  }
}
