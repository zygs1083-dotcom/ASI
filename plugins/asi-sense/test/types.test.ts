import { type DisksFact, factStatusAt, type Signal, type TuningChange, type TypedSignal } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { SRC, sig } from './helpers.ts';

// Compile-time fixtures for the DESIGN §2.2c extension contracts: types only,
// no runtime rate/anomaly/burst logic exists in M1.
const rate: TypedSignal<'body.rate'> = {
  id: 'r1',
  kind: 'body.rate',
  at: 0,
  source: SRC,
  subject: 'context',
  data: {
    metric: 'context',
    windowMs: 60_000,
    delta: 1000,
    slope: 16.7,
    direction: 'down',
  },
};
const anomaly: TypedSignal<'body.anomaly'> = {
  id: 'a1',
  kind: 'body.anomaly',
  at: 0,
  source: SRC,
  subject: 'memory',
  data: { metric: 'memory', value: 0.9, baseline: 0.5, deviation: 3.2 },
};
const burst: TypedSignal<'file.burst'> = {
  id: 'b1',
  kind: 'file.burst',
  at: 0,
  source: SRC,
  subject: '/w',
  data: {
    directory: '/w',
    windowMs: 1000,
    created: 1,
    modified: 4,
    deleted: 2,
    agentDeleted: 2,
  },
};
const tuning: TuningChange = {
  id: 't1',
  param: 'wakeMax',
  from: 3,
  to: 5,
  by: 'user',
  reason: 'raised',
  at: 0,
};

// @ts-expect-error kind/data mismatch: 'body.rate' cannot take anomaly data
const bad: TypedSignal<'body.rate'> = { ...rate, data: anomaly.data };
// @ts-expect-error a union of kinds must still correlate the payload with its kind
const badUnion: TypedSignal<'body.rate' | 'file.burst'> = { ...rate, data: burst.data };

function rejectDiskFact(disks: DisksFact): void {
  // @ts-expect-error disk facts must use disksStatusAt
  factStatusAt(disks, 0);
}

describe('extension signal data types', () => {
  it('typed signals remain plain Signals', () => {
    const asSignals: Signal[] = [rate, anomaly, burst];
    expect(asSignals.map((s) => s.kind)).toEqual(['body.rate', 'body.anomaly', 'file.burst']);
    expect(tuning.by).toBe('user');
    expect(bad.kind).toBe('body.rate');
    expect(badUnion.kind).toBe('body.rate');
    expect(sig({ id: 'x', kind: 'body.rate' }).kind).toBe('body.rate');
    expect(rejectDiskFact).toBeTypeOf('function');
  });
});
