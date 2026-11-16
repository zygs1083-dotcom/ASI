import { type DisksFact, effectiveDisks, type FactStatus } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { bodyThresholdSignals } from '../src/host/attention/thresholds.ts';
import { StateStore } from '../src/host/state/store.ts';
import { SRC, sig } from './helpers.ts';

const statuses: FactStatus[] = ['ok', 'stale', 'denied', 'unsupported', 'unavailable', 'unknown'];

describe('disk snapshots across time', () => {
  it('preserves effective disks after time advances across parent and volume combinations', () => {
    for (const status of statuses) {
      for (const volumeStatus of [undefined, ...statuses]) {
        for (const observedAt of [0, 2000]) {
          for (const ttlMs of [3000, 30000]) {
            for (const fields of ['both', 'observed', 'ttl', 'none'] as const) {
              for (const unavailableMounts of [[], ['/data'], ['/net']]) {
                const value = [
                  { mount: '/', total: 100, free: 90 },
                  {
                    mount: '/data',
                    total: 100,
                    free: 2,
                    ...(volumeStatus ? { status: volumeStatus } : {}),
                    ...(fields === 'both' || fields === 'observed' ? { observedAt } : {}),
                    ...(fields === 'both' || fields === 'ttl' ? { ttlMs } : {}),
                  },
                ];
                const st = new StateStore(() => 0);
                st.apply(
                  sig({
                    id: 'disks',
                    kind: 'fact.updated',
                    data: { path: 'self.body.disks', value, status, ttlMs: 6000, unavailableMounts },
                  }),
                );
                const original: DisksFact = {
                  kind: 'disks',
                  value,
                  status,
                  source: SRC,
                  observedAt: 0,
                  ttlMs: 6000,
                  unavailableMounts,
                };
                for (const t1 of [0, 2000, 5000, 6000, 6500]) {
                  const snapshot = st.snapshot(t1).self.body.disks;
                  for (const t2 of [t1, 3000, 5999, 6000, 6500, 32000, 35000].filter((t) => t >= t1)) {
                    expect(effectiveDisks(snapshot, t2)).toEqual(effectiveDisks(original, t2));
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  it.each([2, 90])('does not alert or clear a latch for inherited stale /data (free=%i)', (free) => {
    const st = new StateStore(() => 0);
    const previous = st.snapshot(0).self.body;
    st.apply(
      sig({
        id: 'disks',
        kind: 'fact.updated',
        data: {
          path: 'self.body.disks',
          ttlMs: 6000,
          value: [
            { mount: '/', total: 100, free: 90 },
            { mount: '/data', total: 100, free, observedAt: 2000, ttlMs: 30000 },
          ],
        },
      }),
    );
    const body = st.snapshot(5000).self.body;
    const next = { body, at: 6500, source: SRC };
    const prev = { body: previous, at: 0, source: SRC };
    expect(bodyThresholdSignals(prev, next).signals).toEqual([]);
    const latched = bodyThresholdSignals({ ...prev, state: { 'disk:/data': 'critical' } }, next);
    expect(latched.signals).toEqual([]);
    expect(latched.state['disk:/data']).toBe('critical');
  });

  it.each(statuses)('empty disks preserve only denied and unsupported: %s', (status) => {
    for (const value of [null, []]) {
      const st = new StateStore(() => 0);
      st.apply(sig({ id: 'empty', kind: 'fact.updated', data: { path: 'self.body.disks', value, status } }));
      const disks = st.snapshot(1).self.body.disks;
      expect(disks.kind).toBe('disks');
      expect(disks.status).toBe(status === 'denied' || status === 'unsupported' ? status : 'unknown');
    }
  });
});
