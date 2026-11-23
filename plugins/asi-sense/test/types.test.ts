import {
  type AsiSenseServiceApi,
  type DisksFact,
  disksStatusAt,
  effectiveDisks,
  factStatusAt,
  type NeedsSnapshot,
  type Signal,
} from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { diskFact, SRC, sig } from './helpers.ts';

function rejectDiskFact(disks: DisksFact): void {
  // @ts-expect-error disk facts must use disksStatusAt
  factStatusAt(disks, 0);
}

describe('sense-types contracts', () => {
  it('enforces disk fact helper safety and exposes service & needs types', () => {
    const sampleSignal: Signal = sig({ id: 's1', kind: 'app.activated' });
    expect(sampleSignal.source).toEqual(SRC);
    const disks = diskFact(
      [
        { mount: '/', total: 100, free: 50, observedAt: 0, ttlMs: 1000 },
        { mount: '/Volumes/Ext', total: 100, free: 10, observedAt: 0, ttlMs: 500 },
      ],
      'ok',
      0,
      1000,
      ['/Volumes/Off'],
    );
    expect(disksStatusAt(disks, 600)).toBe('ok');
    expect(disksStatusAt(disks, 1200)).toBe('stale');
    const eff = effectiveDisks(disks, 600);
    expect(eff.value?.find((v) => v.mount === '/Volumes/Ext')?.status).toBe('stale');
    expect(eff.indeterminateMounts.sort()).toEqual(['/Volumes/Ext', '/Volumes/Off']);
    expect(rejectDiskFact).toBeTypeOf('function');

    const checkTypes = (_svc?: AsiSenseServiceApi, _snap?: NeedsSnapshot) => true;
    expect(checkTypes()).toBe(true);
  });
});
