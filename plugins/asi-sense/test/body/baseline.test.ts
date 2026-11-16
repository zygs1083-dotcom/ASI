import { describe, expect, it } from 'vitest';
import { BASELINE_MIN_COUNT, BASELINE_SLOTS, Baseline } from '../../src/host/body/baseline.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MON10 = Date.UTC(2026, 0, 5, 10); // Monday 2026-01-05 10:00 UTC
const MON10W2 = Date.UTC(2026, 0, 12, 10); // next Monday, same week slot
const NY = 'America/New_York';
const mk = (opts: Record<string, unknown> = {}) => new Baseline({ timeZone: 'UTC', installedAt: 0, ...opts });

const observeN = (b: Baseline, metric: string, value: number, ats: readonly number[]) => {
  for (const at of ats) b.observe(metric, value, at);
};

describe('Baseline buckets', () => {
  it('bootstraps robust scale before judging a high-variance bucket', () => {
    const b = new Baseline({ installedAt: 0, timeZone: 'UTC' });
    for (let i = 1; i <= 8; i++) b.observe('network.rx', i * 10_000, i);
    const stat = b.read('network.rx', 8);
    expect(stat?.mean).toBe(45_000);
    expect(stat?.scale).toBeCloseTo(1.4826 * 20_000);
  });

  it('learns per local weekday/hour slot and tracks distinct dates', () => {
    const b = mk();
    observeN(b, 'cpu', 0.5, [MON10, MON10W2]);
    const stat = b.read('cpu', MON10 + 1); // same Mon-10 slot
    expect(stat?.count).toBe(2);
    expect(stat?.dates).toBe(2);
    expect(b.read('cpu', MON10 + HOUR)).toBeUndefined(); // Mon-11 is another slot
    expect(b.read('cpu', MON10 + DAY)).toBeUndefined(); // Tue-10 is another slot
  });

  it('rejects nonfinite values/timestamps and ignores out-of-order observations', () => {
    expect(() => mk({ clock: () => Number.NaN }).learningProgress).toThrow(TypeError);
    const b = mk();
    b.observe('cpu', 0.5, MON10);
    b.observe('cpu', Number.NaN, MON10 + 1);
    b.observe('cpu', 0.9, Number.NaN);
    b.observe('cpu', 0.9, MON10); // same stamp
    b.observe('cpu', 0.9, MON10 - 1); // backward
    expect(b.read('cpu', MON10)?.count).toBe(1);
  });

  it('gates maturity on 24 FULL hours from installedAt', () => {
    const b = new Baseline({ timeZone: 'UTC', installedAt: MON10 });
    expect(b.mature(MON10 + DAY - 1)).toBe(false);
    expect(b.mature(MON10 + DAY)).toBe(true);
    expect(b.mature(Number.NaN)).toBe(false);
  });

  it('reaches learningProgress 100 only after 24 full hours', () => {
    let now = MON10;
    const b = new Baseline({ timeZone: 'UTC', installedAt: MON10, clock: () => now });
    now = MON10 + HOUR * 12;
    expect(b.learningProgress).toBe(50);
    now = MON10 + DAY - 1;
    expect(b.learningProgress).toBeLessThan(100);
    now = MON10 + DAY;
    expect(b.learningProgress).toBe(100);
  });

  it('clone() forks copy-on-write: later observes never leak back', () => {
    const b = mk();
    b.observe('cpu', 0.5, MON10);
    const c = b.clone();
    c.observe('cpu', 0.9, MON10 + 1);
    expect(b.read('cpu', MON10)?.count).toBe(1);
    expect(c.read('cpu', MON10)?.count).toBe(2);
  });
});

describe('Baseline serialization (v2)', () => {
  it('round-trips buckets, dates, installedAt and timezone', () => {
    const b = new Baseline({ timeZone: NY, installedAt: MON10 });
    observeN(b, 'cpu', 0.5, [MON10, MON10W2]);
    const r = Baseline.deserialize(b.serialize(), { timeZone: NY });
    expect(r.restoreFailed).toBe(false);
    expect(r.timeZone).toBe(NY);
    expect(r.installedAt).toBe(MON10);
    expect(r.read('cpu', MON10)).toMatchObject({ count: 2, dates: 2 });
  });

  it('adopts the persisted zone when the host gives no override', () => {
    const b = new Baseline({ timeZone: 'UTC', installedAt: MON10 });
    b.observe('cpu', 0.5, MON10);
    const r = Baseline.deserialize(b.serialize());
    expect(r.timeZone).toBe('UTC');
  });

  it.each([
    ['truncated json', '{'],
    ['bad version', '{"version":1}'],
    [
      'nonfinite stat',
      JSON.stringify({
        version: 2,
        installedAt: 0,
        timeZone: 'UTC',
        metrics: {
          cpu: Array(BASELINE_SLOTS)
            .fill(null)
            .map((_, i) =>
              i === 34 ? { mean: Number.NaN, median: 1, mad: 0, count: 1, lastAt: MON10, dates: ['2026-1-5'] } : null,
            ),
        },
      }),
    ],
    ['wrong slot count', JSON.stringify({ version: 2, installedAt: 0, timeZone: 'UTC', metrics: { cpu: [null] } })],
    ['missing timezone', JSON.stringify({ version: 2, installedAt: 0, metrics: {} })],
  ])('fails closed on malformed snapshot: %s', (_name, json) => {
    const r = Baseline.deserialize(json, { timeZone: 'UTC' });
    expect(r.restoreFailed).toBe(true);
    expect(r.read('cpu', MON10)).toBeUndefined();
  });

  it('rejects a bucket whose lastAt does not land in its own slot', () => {
    const b = mk();
    b.observe('cpu', 0.5, MON10);
    const d = JSON.parse(b.serialize()) as { metrics: { cpu: unknown[] } };
    const arr = d.metrics.cpu;
    const idx = arr.findIndex((x) => x !== null);
    arr[idx + 1] = arr[idx]; // move the bucket one slot later — slot mismatch
    arr[idx] = null;
    expect(Baseline.deserialize(JSON.stringify(d), { timeZone: 'UTC' }).restoreFailed).toBe(true);
  });
});

describe('Baseline local timezone + DST', () => {
  const FALL = {
    edt0130: Date.UTC(2026, 10, 1, 5, 30), // 2026-11-01 01:30 EDT
    est0130: Date.UTC(2026, 10, 1, 6, 30), // 2026-11-01 01:30 EST (repeated hour)
    est0230: Date.UTC(2026, 10, 1, 7, 30), // 2026-11-01 02:30 EST
  };
  const SPRING = {
    est0130: Date.UTC(2026, 2, 8, 6, 30), // 2026-03-08 01:30 EST
    edt0330: Date.UTC(2026, 2, 8, 7, 30), // 2026-03-08 03:30 EDT (02:xx skipped)
    nextSun0230: Date.UTC(2026, 2, 15, 6, 30), // 2026-03-15 02:30 EDT
  };

  it('coalesces the repeated fall-back hour into one Sun-01 bucket', () => {
    const b = new Baseline({ timeZone: NY, installedAt: 0 });
    b.observe('cpu', 0.5, FALL.edt0130);
    b.observe('cpu', 0.6, FALL.est0130);
    const stat = b.read('cpu', FALL.est0130 + 1);
    expect(stat?.count).toBe(2); // same local hour → same bucket
    expect(b.read('cpu', FALL.est0230)).toBeUndefined();
  });

  it('never fabricates a bucket for the skipped spring-forward hour', () => {
    const b = new Baseline({ timeZone: NY, installedAt: 0 });
    b.observe('cpu', 0.5, SPRING.est0130); // local 01:30
    b.observe('cpu', 0.7, SPRING.edt0330); // local 03:30
    expect(b.read('cpu', SPRING.est0130)?.count).toBe(1);
    expect(b.read('cpu', SPRING.edt0330)?.count).toBe(1);
    expect(b.read('cpu', SPRING.nextSun0230)).toBeUndefined(); // Sun-02 stayed empty
  });

  it('keeps 09:00 in its own slot across the DST switch', () => {
    const b = new Baseline({ timeZone: NY, installedAt: 0 });
    const before = Date.UTC(2026, 2, 7, 14, 0); // Sat 09:00 EST
    const after = Date.UTC(2026, 2, 14, 13, 0); // Sat 09:00 EDT (next week)
    b.observe('cpu', 0.5, before);
    b.observe('cpu', 0.5, after);
    const stat = b.read('cpu', before);
    expect(stat?.count).toBe(2);
    expect(stat?.dates).toBe(2); // same Sat-09 slot, two local dates
  });
});

describe('Baseline eligibility constants', () => {
  it('requires 8 samples and 2 dates per bucket', () => {
    expect(BASELINE_MIN_COUNT).toBe(8);
    expect(BASELINE_SLOTS).toBe(168);
  });
});
