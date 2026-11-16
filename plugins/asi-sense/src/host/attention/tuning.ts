import type { DeliveryLevel, Signal, WatchRule } from '@asi/sense-types';
import { selectRule } from './rules.ts';

export type AlertKind = 'body.rate' | 'body.anomaly' | 'file.burst';
export type AlertLevels = Record<AlertKind, DeliveryLevel>;

const rules: Record<AlertKind, { id: string; where: Record<string, unknown> }> = {
  'body.rate': { id: 'body-rate-warn', where: { severity: 'warn' } },
  'body.anomaly': { id: 'body-anomaly-warn', where: { severity: 'warn' } },
  'file.burst': { id: 'file-burst-external-deletion', where: { externalDeletionExceeded: true } },
};

export function tunedRule(
  items: readonly WatchRule[],
  signal: Signal,
  now: number,
  levels: AlertLevels,
): WatchRule | undefined {
  const kind = signal.kind as AlertKind;
  const target = rules[kind];
  const eta = signal.data.timeToFloorMs ?? signal.data.etaToFloorMs;
  const protectedAlert =
    signal.data.severity === 'critical' ||
    (kind === 'body.rate' &&
      signal.data.severity === 'warn' &&
      (signal.data.ruleId === 'context-eta' || (typeof eta === 'number' && Number.isFinite(eta) && eta <= 600_000)));
  if (!target || protectedAlert) return selectRule(items, signal, now);
  return selectRule(
    items.map((rule) =>
      rule.id === target.id &&
      rule.createdBy === 'user' &&
      rule.approved &&
      rule.note === 'system' &&
      rule.match.kind === kind &&
      rule.match.subject === undefined &&
      JSON.stringify(rule.match.where) === JSON.stringify(target.where)
        ? { ...rule, level: levels[kind] }
        : rule,
    ),
    signal,
    now,
  );
}
