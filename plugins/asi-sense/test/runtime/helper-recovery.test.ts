import { describe, expect, it, vi } from 'vitest';
import { SenseBus } from '../../src/host/runtime/bus.ts';
import { FactExpiry } from '../../src/host/runtime/expiry.ts';
import type { BodySource } from '../../src/host/sources/body.ts';
import { HelperSource } from '../../src/host/sources/helper.ts';
import { HelperRecovery, markHelperFacts } from '../../src/host/sources/helper-recovery.ts';

describe('helper recovery source isolation', () => {
  it('does not apply later snapshot fields after stop interrupts an awaited field', async () => {
    const clock = { wall: () => 1_000, mono: () => 0 };
    const bus = new SenseBus(
      clock,
      () => true,
      () => {},
      new FactExpiry(clock),
    );
    const setThermal = vi.fn();
    const body = { setThermal, finishThermalRecovery: vi.fn() } as unknown as BodySource;
    const helper = new HelperSource(
      { spawn: () => undefined },
      '/fixture',
      'darwin',
      clock,
      bus,
      body,
      () => {},
      () => false,
    );
    const inner = helper as unknown as {
      child: unknown;
      session: string;
      recovery: HelperRecovery;
      event: (value: Record<string, unknown>) => Promise<void>;
    };
    inner.child = {};
    inner.session = 'fixture';
    inner.recovery = new HelperRecovery(true);
    const pending = inner.event({
      type: 'snapshot',
      at: 1_000,
      frontApp: { name: 'Example', bundleId: 'example' },
      focusedWindow: { status: 'unknown' },
      thermal: 'critical',
    });
    await helper.stop();
    await pending;
    expect(setThermal).not.toHaveBeenCalled();
    expect(body.finishThermalRecovery).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'discards an in-flight snapshot continuation after stop or replacement (%s)',
    async (replace) => {
      const clock = { wall: () => 1_000, mono: () => 0 };
      const bus = new SenseBus(
        clock,
        () => true,
        () => {},
        new FactExpiry(clock),
      );
      const body = { setThermal: vi.fn(), finishThermalRecovery: vi.fn() } as unknown as BodySource;
      const helper = new HelperSource(
        { spawn: () => undefined },
        '/fixture',
        'darwin',
        clock,
        bus,
        body,
        () => {},
        () => false,
      );
      const inner = helper as unknown as {
        child: unknown;
        stopped: boolean;
        session: string;
        recovery: HelperRecovery;
        event: (value: Record<string, unknown>) => Promise<void>;
      };
      inner.child = {};
      inner.session = 'fixture';
      inner.recovery = new HelperRecovery(true);
      const pending = inner.event({ type: 'snapshot', at: 1_000, frontApp: { name: 'Example', bundleId: 'example' } });
      await helper.stop();
      if (replace) {
        inner.stopped = false;
        inner.child = {};
        inner.recovery = new HelperRecovery(true);
      }
      await pending;
      expect(helper.nextDeadline()).toBeUndefined();
    },
  );

  it('stales helper facts without invalidating facts supplied by other sources', () => {
    const clock = { wall: () => 1_000, mono: () => 0 };
    const bus = new SenseBus(
      clock,
      () => true,
      () => {},
      new FactExpiry(clock),
    );
    const setThermal = vi.fn();
    const body = { setThermal } as unknown as BodySource;
    const update = (id: string, path: string, value: unknown, source: string) =>
      bus.store.apply({
        id,
        kind: 'fact.updated',
        subject: path,
        at: 1_000,
        source: { id: source, api: 'test', host: 'local' },
        data: { path, value, status: 'ok', ttlMs: 60_000 },
      });
    update('app', 'env.frontApp', { name: 'Other', bundleId: 'other.app' }, 'other');
    update('window', 'env.focusedWindow', { title: 'Synthetic' }, 'helper.ax');
    update('thermal', 'self.body.thermal', 'nominal', 'probe');
    markHelperFacts(bus, body, 1_000, ['frontApp', 'focusedWindow', 'thermal'], 'stale');
    expect(bus.state().env.frontApp.status).toBe('ok');
    expect(bus.state().env.focusedWindow.status).toBe('stale');
    expect(bus.state().self.body.thermal.status).toBe('ok');
    expect(setThermal).not.toHaveBeenCalled();
  });
});
