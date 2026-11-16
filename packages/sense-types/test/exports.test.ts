import { describe, expect, it } from 'vitest';
import type { BodyThresholdSample, TuningChange, TuningValue } from '../src/index.ts';

describe('shared type exports', () => {
  it('exposes tuning change types and required monotonic receipt time', () => {
    const value: TuningValue = 2;
    const change: TuningChange = {
      id: 'example-1',
      param: 'cpu.sigma',
      from: 1,
      to: value,
      by: 'auto',
      reason: 'fixture',
      at: 0,
    };
    const receipt: Pick<BodyThresholdSample, 'monotonicAt'> = { monotonicAt: 10 };
    expect(change.to).toBe(2);
    expect(receipt.monotonicAt).toBe(10);
  });
});
