import type { BodyThresholds, WatchRule } from '@asi/sense-types';
import { createWatchRule } from '../attention/rules.ts';
import { BODY_THRESHOLDS } from '../attention/thresholds.ts';
import type { AnomalyRule } from './anomaly.ts';
import type { RateRule } from './rate.ts';
import type { Tuner } from './tuner.ts';

const GIB = 1024 ** 3;

/**
 * Built-in rate-of-change rules (DESIGN §2.2c), returned as fresh clones:
 * disk losing >2GiB/min (every mount via `disk:*`), RSS growing >50% over
 * 5min, context projected to exhaust within 10min, plus the built-in
 * `file.burst` detector (60s window, >50 external deletes) wired through
 * `BodyMonitor`. The `param` names resolve live through the tuner.
 */
export function defaultRateRules(): RateRule[] {
  return [
    {
      id: 'disk-drop',
      metric: 'disk:*',
      windowMs: 60_000,
      direction: 'down',
      maxDelta: 2 * GIB,
      hardEtaMs: 600_000,
      param: 'rate.disk.maxDelta',
    },
    { id: 'rss-surge', metric: 'rss', windowMs: 300_000, direction: 'up', maxRatio: 0.5, param: 'rate.rss.maxRatio' },
    {
      id: 'context-eta',
      metric: 'context',
      windowMs: 300_000,
      direction: 'down',
      maxEtaMs: 600_000,
      hardEtaMs: 600_000,
      floor: 0,
      param: 'rate.context.maxEtaMs',
    },
  ];
}

/** Built-in baseline-anomaly rules (DESIGN §2.2c): 3σ, 3 consecutive. */
export function defaultAnomalyRules(): AnomalyRule[] {
  return [
    { id: 'cpu', metric: 'cpu', param: 'anomaly.cpu.sigma' },
    { id: 'memory', metric: 'memory', param: 'anomaly.memory.sigma' },
    { id: 'network-rx', metric: 'network.rx', param: 'anomaly.network.sigma' },
    { id: 'network-tx', metric: 'network.tx', param: 'anomaly.network.sigma' },
  ];
}

/**
 * Built-in body watch rules (DESIGN §2.2c), fresh clones per call — the
 * host installs these in M3 alongside DEFAULT_RULES; body never delivers
 * anything itself. `body.rate`/`body.anomaly` warnings are `context`
 * (recoveries `record`), `file.burst` with `externalDeletionExceeded` is
 * `wake` and pre-approved (system rule); agent-only burst audits record.
 */
export function defaultBodyRules(): WatchRule[] {
  return [
    createWatchRule({
      id: 'body-rate-warn',
      match: { kind: 'body.rate', where: { severity: 'warn' } },
      level: 'context',
      createdBy: 'user',
      note: 'system',
    }),
    createWatchRule({
      id: 'body-rate',
      match: { kind: 'body.rate' },
      level: 'record',
      createdBy: 'user',
      note: 'system',
    }),
    createWatchRule({
      id: 'body-anomaly-warn',
      match: { kind: 'body.anomaly', where: { severity: 'warn' } },
      level: 'context',
      createdBy: 'user',
      note: 'system',
    }),
    createWatchRule({
      id: 'body-anomaly',
      match: { kind: 'body.anomaly' },
      level: 'record',
      createdBy: 'user',
      note: 'system',
    }),
    createWatchRule({
      id: 'file-burst-external-deletion',
      match: { kind: 'file.burst', where: { externalDeletionExceeded: true } },
      level: 'wake',
      createdBy: 'user',
      approved: true,
      note: 'system',
    }),
    createWatchRule({
      id: 'file-burst',
      match: { kind: 'file.burst' },
      level: 'record',
      createdBy: 'user',
      note: 'system',
    }),
  ];
}

/** Effective floors, including explicit trusted-user loosenings. */
export function floorTable(tuner?: Tuner): BodyThresholds {
  if (!tuner) return BODY_THRESHOLDS;
  const effective = (name: string, fallback: number) => {
    const value = tuner.get(name);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };
  const table = (ns: 'disk' | 'context' | 'battery') => ({
    warn: effective(`floor.${ns}.warn`, BODY_THRESHOLDS[ns].warn),
    critical: effective(`floor.${ns}.critical`, BODY_THRESHOLDS[ns].critical),
  });
  return {
    disk: table('disk'),
    context: table('context'),
    battery: table('battery'),
    hysteresis: BODY_THRESHOLDS.hysteresis,
  };
}
