import { describe, expect, it, vi } from 'vitest';
import { RuntimeAttention } from '../../src/host/runtime/attention.ts';
import { FactExpiry } from '../../src/host/runtime/expiry.ts';
import type { DshPort } from '../../src/host/runtime/ports.ts';
import type { BodySource } from '../../src/host/sources/body.ts';
import { markHelperFacts } from '../../src/host/sources/helper-recovery.ts';

describe('helper recovery source isolation', () => {
  it('stales helper facts without invalidating facts supplied by other sources', () => {
    const clock = { wall: () => 1_000, mono: () => 0 };
    const attention = new RuntimeAttention(
      clock,
      {} as DshPort,
      () => [],
      () => {},
      () => true,
      () => {},
      new FactExpiry(clock),
    );
    const setThermal = vi.fn();
    const body = { setThermal } as unknown as BodySource;
    const update = (id: string, path: string, value: unknown, source: string) =>
      attention.store.apply({
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
    markHelperFacts(attention, body, 1_000, ['frontApp', 'focusedWindow', 'thermal'], 'stale');
    expect(attention.state().env.frontApp.status).toBe('ok');
    expect(attention.state().env.focusedWindow.status).toBe('stale');
    expect(attention.state().self.body.thermal.status).toBe('ok');
    expect(setThermal).not.toHaveBeenCalled();
  });
});
