import { describe, expect, it } from 'vitest';
import {
  effectiveDisks,
  factStatusAt,
  NEED_KEYS,
  type NeedEvaluation,
  type SenseSettingsSnapshot,
  sanitizeForModel,
  THERMAL_ORDINAL,
} from '../src/index.ts';

describe('shared type exports', () => {
  it('exposes survival need keys, thermal ordinals, freshness helpers and credential sanitization', () => {
    expect(NEED_KEYS).toEqual(['energy', 'space', 'memory', 'mind', 'thermals']);
    expect(THERMAL_ORDINAL.critical).toBe(3);

    const settings: SenseSettingsSnapshot = {
      paused: false,
      sendTitles: true,
      powerMode: 'normal',
    };
    expect(settings.powerMode).toBe('normal');

    const need: NeedEvaluation = {
      key: 'energy',
      label: '能量',
      satisfaction: 85,
      urgency: 15,
      zone: 'comfortable',
      driveActive: false,
      summary: 'AC connected',
      evidence: { charging: true },
      updatedAt: 100,
    };
    expect(need.zone).toBe('comfortable');

    expect(
      factStatusAt(
        {
          value: 'idle',
          status: 'ok',
          source: { id: 'dsh', api: 'events', host: 'local' },
          observedAt: 10,
          ttlMs: 20,
        },
        30,
      ),
    ).toBe('stale');

    const disks = effectiveDisks(
      {
        kind: 'disks',
        value: [{ mount: '/', total: 100, free: 50 }],
        status: 'ok',
        source: { id: 'disks', api: 'statfs', host: 'local' },
        observedAt: 10,
        ttlMs: 50,
      },
      20,
    );
    expect(disks.status).toBe('ok');

    const tokenPrefix = ['ghp', '_'].join('');
    expect(sanitizeForModel(`title ${tokenPrefix}${'a'.repeat(36)}`)).toBe('title [redacted]');
  });
});
