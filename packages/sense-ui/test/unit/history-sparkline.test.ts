import { describe, expect, it } from 'vitest';
import { buildSpark } from '../../src/geometry';
import { sampleHistory } from '../../src/history';
import { makeScenario, SCENARIOS } from '../../src/mock/scenarios';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('24h sparkline & min/max range band geometry', () => {
  it('samples over custom 24h window without clipping points outside 5 minutes', () => {
    const anchor = 1_763_300_000_000;
    const pts = [
      { at: anchor - 18 * 3_600_000, value: 0.2 },
      { at: anchor - 6 * 3_600_000, value: 0.5 },
      { at: anchor, value: 0.8 },
    ];
    expect(sampleHistory(pts, anchor, [])).toHaveLength(1);
    expect(sampleHistory(pts, anchor, [], DAY_MS)).toHaveLength(3);
  });

  it('builds closed rangeBandPath incorporating min/max domain bounds and splitting across offline gaps', () => {
    const anchor = 1_763_300_000_000;
    const band = [
      { at: anchor - 4 * 3_600_000, min: 0.1, max: 0.9 },
      { at: anchor - 4 * 3_600_000 + 300_000, min: 0.2, max: 0.7 },
      // 3h offline gap -> should split into a second closed polygon
      { at: anchor - 300_000, min: 0.3, max: 0.6 },
      { at: anchor, min: 0.25, max: 0.65 },
    ];
    const points = band.map((b) => ({ at: b.at, value: (b.min + b.max) / 2 }));
    const built = buildSpark(points, anchor, { windowMs: DAY_MS, minMaxBand: band });
    expect(built).not.toBeNull();
    expect(built!.g.dataMin).toBe(0.1);
    expect(built!.g.dataMax).toBe(0.9);
    const zCount = built!.g.rangeBandPath?.match(/\bZ\b/g)?.length ?? 0;
    expect(zCount).toBe(2);
  });

  it('includes all four timeline preview scenarios without throwing', () => {
    expect(SCENARIOS).toEqual(
      expect.arrayContaining(['history-ready', 'history-empty', 'history-away-anomaly', 'history-monthly-error']),
    );
    const ready = makeScenario('history-ready');
    expect(ready.timeline?.today?.topApps).toHaveLength(5);
    expect(ready.timeline?.metrics?.cpu?.points.length).toBeLessThanOrEqual(288);
    expect(makeScenario('history-empty').timeline).toBeUndefined();
    expect(makeScenario('history-away-anomaly').timeline?.lastAway?.hasAnomaly).toBe(true);
    expect(makeScenario('history-monthly-error').timeline?.today).toBeDefined();
  });
});
