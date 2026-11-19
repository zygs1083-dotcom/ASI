import { describe, expect, it, vi } from 'vitest';
import { RuntimeAttention } from '../../src/host/runtime/attention.ts';
import { FactExpiry } from '../../src/host/runtime/expiry.ts';
import { summarizeDay } from '../../src/host/runtime/history/summarize.ts';
import { LocalCalendar } from '../../src/host/runtime/history/time.ts';
import type { DshPort } from '../../src/host/runtime/ports.ts';
import type { BodySource } from '../../src/host/sources/body.ts';
import { axStatus, helperEvent } from '../../src/host/sources/helper-events.ts';

function setup(initialNow = 1_000) {
  let now = initialNow;
  const clock = { wall: () => now, mono: () => now };
  const attention = new RuntimeAttention(
    clock,
    {} as DshPort,
    () => [],
    () => {},
    () => true,
    () => {},
    new FactExpiry(clock),
  );
  const body = { setThermal: vi.fn(), finishThermalRecovery: vi.fn() } as unknown as BodySource;
  const activations = () => attention.events().filter((event) => event.kind === 'app.activated');
  return {
    attention,
    activations,
    send: async (event: Record<string, unknown>, recovering = false) => {
      now += 100;
      await helperEvent({ at: now, ...event }, attention, body, recovering);
    },
  };
}

describe('helper events dedupe and AX recovery', () => {
  it('dedupes repeated same-pid app.activated while emitting across pid changes and keeping frontApp fresh', async () => {
    const day = '2026-11-19';
    const h = setup(Date.UTC(2026, 10, 19, 10, 0, 0));
    const bounds = new LocalCalendar('UTC').dayBounds(day);
    await h.send({ type: 'app.activated', name: 'ExampleApp', bundleId: 'example.app', pid: 101 });
    expect(summarizeDay(day, { events: h.activations(), lifecycle: [] }, bounds).apps.ExampleApp?.switches).toBe(1);
    await h.send({ type: 'app.activated', name: 'ExampleApp', bundleId: 'example.app', pid: 102 });
    await h.send({ type: 'app.activated', name: 'ExampleApp', bundleId: 'example.app', pid: 101 });
    const thirdObservedAt = h.attention.state().env.frontApp.observedAt;
    await h.send({ type: 'app.activated', name: 'ExampleApp', bundleId: 'example.app', pid: 101 });
    expect(h.activations()).toHaveLength(3);
    expect(h.attention.state().env.frontApp.value).toEqual({ name: 'ExampleApp', bundleId: 'example.app', pid: 101 });
    expect(h.attention.state().env.frontApp.observedAt).toBeGreaterThan(thirdObservedAt);
    const summary = summarizeDay(day, { events: h.activations(), lifecycle: [] }, bounds);
    expect(summary.apps.ExampleApp?.switches).toBe(3);
    expect(summary.appSwitches).toBe(3);
  });

  it('deduplicates replayed snapshots by (bundleId, pid) while emitting on pid change', async () => {
    const h = setup();
    const snap = (pid: number, windowCount: number) => ({
      type: 'snapshot',
      frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid, windowCount },
      focusedWindow: { status: 'ok', pid },
      thermal: 'nominal',
    });
    await h.send(snap(101, 1));
    await h.send(snap(101, 3));
    expect(h.activations()).toHaveLength(1);
    expect(h.attention.state().env.frontApp.value?.windowCount).toBe(3);
    await h.send(snap(202, 2));
    expect(h.activations()).toHaveLength(2);
    expect(h.attention.state().env.frontApp.value).toEqual({
      name: 'ExampleApp',
      bundleId: 'example.app',
      pid: 202,
      windowCount: 2,
    });
  });

  it('restores helper.ax to ok on complete snapshots without titles or with empty title', async () => {
    const h = setup();
    const snap = (bundleId: string, pid: number, window: Record<string, unknown>, recovering = false) =>
      h.send(
        {
          type: 'snapshot',
          frontApp: { name: bundleId, bundleId, pid },
          focusedWindow: window,
          thermal: 'nominal',
        },
        recovering,
      );

    await snap('example.app', 101, { status: 'ok', pid: 101 });
    expect(h.attention.state().observation.sources['helper.ax']?.status).toBe('ok');
    expect(h.attention.state().env.focusedWindow).toMatchObject({ status: 'unknown', value: null });

    await h.send({ type: 'ax.unsupported', bundleId: 'example.app', pid: 101 });
    expect(h.attention.state().observation.sources['helper.ax']?.status).toBe('unsupported');
    await snap('example.app', 101, { status: 'ok', pid: 101 }, true);
    expect(h.attention.state().observation.sources['helper.ax']?.status).toBe('ok');

    await axStatus(h.attention, 'denied', 5_000);
    await snap('example.app', 202, { status: 'ok', pid: 202, title: '' });
    expect(h.attention.state().observation.sources['helper.ax']?.status).toBe('ok');

    await h.send({ type: 'app.activated', name: 'OtherApp', bundleId: 'other.app', pid: 303 });
    await snap('other.app', 303, { status: 'unknown', pid: 303 });
    expect(h.attention.state().observation.sources['helper.ax']?.status).toBe('unknown');
    await h.send({ type: 'ax.unsupported', bundleId: 'other.app', pid: 303 });
    expect(h.activations()).toHaveLength(3);
  });

  it('prefers denied accessibility permission over window.status=ok in snapshots', async () => {
    const h = setup();
    await h.send({
      type: 'snapshot',
      frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 101 },
      focusedWindow: { status: 'ok', pid: 101 },
      permissions: { accessibility: 'granted' },
      thermal: 'nominal',
    });
    expect(h.attention.state().observation.sources['helper.ax']?.status).toBe('ok');

    await h.send({
      type: 'snapshot',
      frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 101 },
      focusedWindow: { status: 'ok', pid: 101 },
      permissions: { accessibility: 'denied' },
      thermal: 'nominal',
    });
    expect(h.attention.state().observation.sources['helper.ax']?.status).toBe('denied');
    expect(h.attention.state().env.focusedWindow).toMatchObject({ status: 'denied', value: null });

    await axStatus(h.attention, 'ok', 9_000);
    await h.send({
      type: 'snapshot',
      frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 101 },
      focusedWindow: { status: 'ok', pid: 101, title: 'Race title' },
      permissions: { accessibility: 'denied' },
      thermal: 'nominal',
    });
    expect(h.attention.state().observation.sources['helper.ax']?.status).toBe('denied');
    expect(h.attention.state().env.focusedWindow).toMatchObject({ status: 'denied', value: null });
    expect(h.attention.events().filter((event) => event.kind === 'window.focused')).toHaveLength(0);
  });
});
