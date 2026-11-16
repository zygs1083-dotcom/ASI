import { describe, expect, it } from 'vitest';
import { suggestionMetric, suggestionUnit } from '../../src/host/presenter/units.ts';

describe('rebaseline suggestion units', () => {
  it.each([
    ['cpu', 'cpu', 'ratio'],
    ['memory', 'memory', 'ratio'],
    ['disk:/data', 'disk:/data', 'bytes'],
    ['rss', 'processRss', 'bytes'],
    ['context', 'tokens', 'tokens'],
    ['network.rx', 'networkRx', 'bytes-per-second'],
    ['network.tx', 'networkTx', 'bytes-per-second'],
    ['battery', 'battery', 'percent'],
    ['thermal', 'thermal', 'ordinal'],
  ])('maps %s to %s with %s', (metric, expected, unit) => {
    const key = suggestionMetric(metric);
    expect(key).toBe(expected);
    expect(key && suggestionUnit(key)).toBe(unit);
  });

  it('does not guess unknown metric units', () => {
    expect(suggestionMetric('not-a-metric')).toBeUndefined();
  });
});
