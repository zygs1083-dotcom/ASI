import { describe, expect, it } from 'vitest';
import { TimeWindow } from '../../src/host/body/window.ts';

const pts = (...ats: number[]) => ats.map((at) => ({ at }));
const ats = (w: TimeWindow<{ at: number }>, cutoff?: number) => w.values(cutoff).map((p) => p.at);

describe('TimeWindow', () => {
  it('retains more points than its initial capacity, in push order', () => {
    const w = new TimeWindow<{ at: number }>(4);
    for (const p of pts(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10)) w.push(p);
    expect(w.size).toBe(11);
    expect(ats(w)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('prunes by time only: evicts at < cutoff, keeps the boundary', () => {
    const w = new TimeWindow<{ at: number }>();
    for (const p of pts(0, 10, 20, 30)) w.push(p);
    w.prune(20);
    expect(ats(w)).toEqual([20, 30]); // at == cutoff is retained
    w.prune(31);
    expect(ats(w)).toEqual([]);
    w.prune(0); // empty stays empty
  });

  it('keeps wrap-around order after prune + push growth', () => {
    const w = new TimeWindow<{ at: number }>(4);
    for (const p of pts(0, 1, 2, 3, 4, 5)) w.push(p); // grew once
    w.prune(4);
    for (const p of pts(6, 7, 8, 9, 10, 11, 12)) w.push(p); // wraps + regrows
    expect(ats(w)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('values(cutoff) filters without mutating the ring', () => {
    const w = new TimeWindow<{ at: number }>();
    for (const p of pts(0, 5, 10, 15)) w.push(p);
    expect(ats(w, 10)).toEqual([10, 15]);
    expect(w.size).toBe(4);
    expect(ats(w)).toEqual([0, 5, 10, 15]);
  });
});
