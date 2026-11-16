import { disksStatusAt } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { bodyThresholdSignals } from '../src/host/attention/thresholds.ts';
import { StateStore } from '../src/host/state/store.ts';
import { SRC, sig } from './helpers.ts';

function write(st: StateStore, data: Record<string, unknown>, at = 0): void {
  st.apply(sig({ id: `write-${at}`, kind: 'fact.updated', at, data: { path: 'self.body.disks', ...data } }));
}

describe('disk snapshot contract', () => {
  it('does not infer disks from a job containing a mount', () => {
    const st = new StateStore(() => 0);
    st.apply(
      sig({
        id: 'job',
        kind: 'fact.updated',
        at: 1,
        data: { path: 'env.activeJobs', value: [{ id: 'job-1', status: 'running', startedAt: 1, mount: '/fixture' }] },
      }),
    );
    expect(st.snapshot(2).env.activeJobs.status).toBe('ok');
  });

  it('materializes inherited stale volumes before aggregating and retains floor latches', () => {
    for (const free of [2, 90]) {
      const st = new StateStore(() => 0);
      const prev = st.snapshot(0).self.body;
      write(st, {
        status: 'stale',
        ttlMs: 6000,
        value: [
          { mount: '/', total: 100, free },
          { mount: '/data', total: 100, free: 90, status: 'ok', observedAt: 200, ttlMs: 30000 },
        ],
      });
      const body = st.snapshot(500).self.body;
      expect(body.disks.value?.[0]).toMatchObject({ status: 'stale', observedAt: 0, ttlMs: 6000 });
      expect(body.disks.value?.[1]).toMatchObject({ status: 'ok', observedAt: 200, ttlMs: 30000 });
      expect(body.disks).toMatchObject({ status: 'ok', observedAt: 200, ttlMs: 30000 });
      const withoutLatch = bodyThresholdSignals(
        { body: prev, at: 0, monotonicAt: 0, source: SRC },
        { body, at: 500, monotonicAt: 500, source: SRC },
      );
      expect(withoutLatch.signals).toEqual([]);
      const result = bodyThresholdSignals(
        { body: prev, at: 0, monotonicAt: 0, source: SRC, state: { 'disk:/': 'critical' } },
        { body, at: 500, monotonicAt: 500, source: SRC },
      );
      expect(result.signals).toEqual([]);
      expect(result.state['disk:/']).toBe('critical');
    }
  });

  it('recomputes the parent deadline from still-fresh volumes', () => {
    const st = new StateStore(() => 0);
    write(st, {
      ttlMs: 6000,
      value: [
        { mount: '/', total: 100, free: 90 },
        { mount: '/data', total: 100, free: 90, status: 'ok', observedAt: 2000, ttlMs: 30000 },
      ],
    });
    const disks = st.snapshot(6500).self.body.disks;
    expect(disks).toMatchObject({ status: 'ok', observedAt: 2000, ttlMs: 30000 });
    expect(disks.value).toMatchObject([{ status: 'stale' }, { status: 'ok' }]);
    expect(disksStatusAt(disks, 6500)).toBe('ok');
  });

  it('persists unreadable mounts, overrides readings, retains latches and clears on replacement', () => {
    const st = new StateStore(() => 0);
    const prev = st.snapshot(0).self.body;
    const value = [{ mount: '/', total: 100, free: 2 }];
    write(st, { value, unavailableMounts: ['/', '/net'] });
    const body = st.snapshot(1).self.body;
    expect(body.disks.unavailableMounts).toEqual(['/', '/net']);
    expect(body.disks.value?.[0]?.status).toBe('unavailable');
    expect(
      bodyThresholdSignals(
        { body: prev, at: 0, monotonicAt: 0, source: SRC },
        { body, at: 1, monotonicAt: 1, source: SRC },
      ).signals,
    ).toEqual([]);
    const result = bodyThresholdSignals(
      { body: prev, at: 0, monotonicAt: 0, source: SRC, state: { 'disk:/': 'critical' } },
      { body, at: 1, monotonicAt: 1, source: SRC },
    );
    expect(result.signals).toEqual([]);
    expect(result.state['disk:/']).toBe('critical');
    write(st, { value: [{ mount: '/', total: 100, free: 90 }] }, 2);
    const recovered = st.snapshot(2).self.body;
    expect(recovered.disks.unavailableMounts ?? []).toEqual([]);
    expect(
      bodyThresholdSignals(
        { body, at: 1, monotonicAt: 1, source: SRC, state: result.state },
        { body: recovered, at: 2, monotonicAt: 2, source: SRC },
      ).signals,
    ).toMatchObject([{ subject: 'disk:/', data: { severity: 'normal' } }]);
  });

  it('uses the disk contract for null and empty values in snapshots', () => {
    for (const [value, status] of [
      [null, 'unavailable'],
      [[], 'ok'],
    ] as const) {
      const st = new StateStore(() => 0);
      write(st, { value, status });
      expect(st.snapshot(1).self.body.disks.status).toBe('unknown');
    }
  });
});
