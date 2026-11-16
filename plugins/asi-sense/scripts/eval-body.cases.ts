import assert from 'node:assert/strict';
import type { BodyThresholdSample, BodyThresholdState, Signal } from '@asi/sense-types';
import { Baseline, BodyMonitor } from '../src/host/body/index.ts';
import { DAY, HOUR, SEEDS, trace } from './eval-body.data.ts';

const WEEK = 7 * DAY;
const MON10 = Date.UTC(2026, 0, 19, 10);
const template = trace(SEEDS[0]).next().value;
assert(template);

function sample(at: number, monotonicAt: number, value: number): BodyThresholdSample {
  const original = template.sample;
  return {
    ...original,
    at,
    monotonicAt,
    body: {
      ...original.body,
      cpu: {
        ...original.body.cpu,
        status: 'ok',
        observedAt: at,
        value: { usage: value, perCore: [value], load1: value, load5: value, load15: value },
      },
    },
  };
}

function monitor(): BodyMonitor {
  const baseline = new Baseline({ installedAt: MON10 - 2 * WEEK, elapsedMs: 2 * WEEK, timeZone: 'UTC' });
  for (const offset of [-2 * WEEK, -WEEK]) {
    for (let i = 0; i < 8; i++) baseline.observe('cpu', 0.5, MON10 + offset + i);
  }
  return new BodyMonitor({ baseline, timeZone: 'UTC', rateRules: [], anomalyRules: [{ id: 'cpu', metric: 'cpu' }] });
}

export function regressionCases(): void {
  const jumps = monitor();
  let state: BodyThresholdState = {};
  let prev = sample(MON10, 0, 0.5);
  const detected: Signal[] = [];
  for (const [wall, mono, value] of [
    [MON10, 1, 0.5],
    [MON10 + 3 * HOUR, 2, 0.5],
    [MON10 + 1, 3, 0.99],
    [MON10 + 2, 4, 0.99],
    [MON10 + 3, 5, 0.99],
  ]) {
    const next = sample(wall, mono, value);
    const result = jumps.evaluate(prev, next, state);
    detected.push(...result.signals);
    state = result.state;
    prev = next;
  }
  for (let i = 0; i < 51; i++) {
    const path = `/fixture/jump/${i}`;
    detected.push(
      ...jumps.accept(
        {
          id: `jump-delete-${i}`,
          kind: 'file.changed',
          at: MON10 + i,
          source: template.sample.source,
          subject: path,
          data: { path, change: 'delete' },
        },
        i + 6,
      ),
    );
  }
  assert(detected.some((s) => s.kind === 'body.anomaly' && s.data.severity === 'warn'));
  assert(detected.some((s) => s.kind === 'file.burst' && s.data.externalDeletionExceeded === true));

  const crossing = monitor();
  state = {};
  prev = sample(MON10 + 57 * 60_000, 0, 0.5);
  for (let i = 0; i < 4; i++) {
    const next = sample(MON10 + (57 + i) * 60_000, i + 1, 0.99);
    const result = crossing.evaluate(prev, next, state);
    state = result.state;
    prev = next;
  }
  assert.equal(state['baseline:cpu'], 'warn');
  assert.equal(crossing.baseline.read('cpu', MON10 + HOUR), undefined);
  console.log('PASS: wall-clock jump/rollback still detects CPU warning and 51 external deletes.');
  console.log('PASS: sustained CPU anomaly crossing into an immature bucket does not train it.');
}
