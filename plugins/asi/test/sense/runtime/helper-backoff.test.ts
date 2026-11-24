import { describe, expect, it } from 'vitest';
import { SnapshotBackoff } from '../../../src/sense/host/sources/helper-backoff.ts';

describe('snapshot recovery backoff', () => {
  it.each([
    { type: 'app.activated', name: 'Example', bundleId: 'example' },
    { type: 'window.focused', title: 'Synthetic' },
    { type: 'window.title', title: 'Synthetic' },
    { type: 'thermal', state: 'nominal' },
  ])('rearms an exhausted cycle for a trusted $type delta', (delta) => {
    const backoff = new SnapshotBackoff();
    let now = 0;
    for (let i = 0; i < 10; i++) {
      backoff.failed(now);
      const delay = Math.min(60_000, 2_000 * 2 ** i);
      expect(backoff.deadline).toBe(now + delay);
      now += delay;
      expect(backoff.due(now)).toBe(true);
    }
    backoff.failed(now);
    expect(backoff.deadline).toBe(now + 300_000);
    expect(backoff.delta({ type: 'thermal', state: 'unknown' })).toBe(false);
    expect(backoff.delta({ type: 'app.activated', bundleId: 'malformed' })).toBe(false);
    expect(backoff.delta(delta)).toBe(true);
    expect(backoff.deadline).toBeUndefined();
    expect(backoff.delta(delta)).toBe(false);
    backoff.failed(now);
    expect(backoff.deadline).toBe(now + 2_000);
  });

  it('rearms the bounded cycle after five monotonic minutes without an incremental event', () => {
    const backoff = new SnapshotBackoff();
    for (let i = 0; i < 11; i++) backoff.failed(0);
    expect(backoff.due(299_999)).toBe(false);
    expect(backoff.due(300_000)).toBe(true);
    backoff.failed(300_000);
    expect(backoff.deadline).toBe(302_000);
  });
});
