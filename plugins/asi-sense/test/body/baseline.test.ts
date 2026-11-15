import { describe, expect, it } from 'vitest';
import { Baseline } from '../../src/host/body/baseline.ts';

const T = Date.UTC(2026, 0, 5); // Monday 00:00 UTC → bucket 1*24+0 = 24
const HOUR = 3_600_000;
let now = T;
const mk = (minScale?: Record<string, number>) => new Baseline({ clock: () => now, installedAt: T, minScale });
const slotsOf = (b: Baseline, metric: string) =>
  (JSON.parse(b.serialize()).metrics as Record<string, unknown[]>)[metric];
const rebuild = (json: string) => Baseline.deserialize(json, { clock: () => now });

describe('Baseline', () => {
  it('keeps 168 UTC buckets keyed by weekday+hour', () => {
    const b = mk();
    const mon9 = T + 9 * HOUR;
    b.observe('cpu', 0.5, mon9);
    expect(b.read('cpu', mon9)?.mean).toBe(0.5);
    expect(b.read('cpu', mon9 + 24 * HOUR)).toBeUndefined();
    expect(b.read('cpu', mon9 + HOUR)).toBeUndefined();
    const slots = slotsOf(b, 'cpu');
    expect(slots).toHaveLength(168);
    expect(slots.filter(Boolean)).toHaveLength(1);
  });

  it('updates mean/median/MAD deterministically and clips spikes at 3x scale', () => {
    const b = mk({ cpu: 0.03 });
    b.observe('cpu', 0.2, T);
    b.observe('cpu', 0.3, T + 1);
    const r = b.read('cpu', T);
    expect(r?.mean).toBeCloseTo(0.2045, 6);
    expect(r?.count).toBe(2);
    expect(r?.confidence).toBeCloseTo(2 / 60, 6);
    const slot = slotsOf(b, 'cpu')[24] as Record<string, number>;
    expect(slot.median).toBeCloseTo(0.2015, 6);
    expect(slot.mad).toBeCloseTo(0.0015, 6);
    b.observe('cpu', 0.2, T + 2);
    b.observe('cpu', 5, T + 3); // residual ~4.8 clipped to 3*.03 → mean += .0045
    expect((slotsOf(b, 'cpu')[24] as Record<string, number>).mean).toBeCloseTo(0.208775, 6);
  });

  it('rejects nonfinite/oversized timestamps, non-increasing obs; tracks progress', () => {
    const b = mk();
    b.observe('cpu', Number.NaN, T);
    b.observe('cpu', 0.5, 8.65e15); // beyond valid Date range
    b.observe('cpu', 0.5, T);
    b.observe('cpu', 0.9, T);
    b.observe('cpu', 0.9, T - 1);
    expect(b.read('cpu', T)?.count).toBe(1);
    expect(b.read('cpu', 8.65e15)).toBeUndefined();
    // inherited/object-key metric names get the default scale, never NaN
    for (const odd of ['constructor', '__proto__', 'toString']) {
      b.observe(odd, 5, T);
      expect(b.read(odd, T)?.scale).toBe(1);
    }
    expect(b.learningProgress).toBe(0);
    now = T + 7.2 * HOUR;
    expect(b.learningProgress).toBeCloseTo(30);
    now = T + 24 * HOUR;
    expect(b.learningProgress).toBe(100);
    now = T;
    expect(() => new Baseline({ clock: 'x' as never })).toThrow(TypeError);
    expect(() => mk({ cpu: -1 })).toThrow(TypeError);
  });

  it('round-trips via serialize and rebuilds on malformed input', () => {
    const b = mk();
    b.observe('cpu', 0.5, T);
    b.observe('rss', 1000, T + HOUR);
    expect(rebuild(b.serialize()).serialize()).toBe(b.serialize());
    const fresh = () => new Baseline({ clock: () => now }).serialize();
    const badSlot = Array<unknown>(168).fill(null);
    badSlot[24] = { mean: 0, median: 0, mad: -1, count: 1, lastAt: T }; // mad<0
    const badIndex = Array<unknown>(168).fill(null);
    badIndex[24] = { mean: 0, median: 0, mad: 0, count: 1, lastAt: T + HOUR }; // lastAt lands in slot 25
    const bads = [
      'not json',
      '{"version":2,"installedAt":0,"metrics":{}}',
      '{"version":1,"installedAt":0,"metrics":[1]}', // metrics must be an object
      `{"version":1,"installedAt":0,"metrics":{"cpu":[1]}}`,
      `{"version":1,"installedAt":0,"metrics":{"cpu":${JSON.stringify(badSlot)}}}`,
      `{"version":1,"installedAt":0,"metrics":{"cpu":${JSON.stringify(badIndex)}}}`,
    ];
    for (const json of bads) expect(rebuild(json).serialize()).toBe(fresh());
  });

  it('installs nothing when ANY metric entry is invalid (atomic restore)', () => {
    const good = Array<unknown>(168).fill(null);
    good[24] = { mean: 0.5, median: 0.5, mad: 0, count: 3, lastAt: T };
    const bad = Array<unknown>(168).fill(null);
    bad[25] = { mean: 'x', median: 0, mad: 0, count: 1, lastAt: T + HOUR };
    const json = `{"version":1,"installedAt":0,"metrics":{"cpu":${JSON.stringify(good)},"rss":${JSON.stringify(bad)}}}`;
    const b = rebuild(json);
    expect(b.read('cpu', T)).toBeUndefined(); // cpu was valid — still discarded
    expect(b.serialize()).toBe(new Baseline({ clock: () => now }).serialize());
  });
});
