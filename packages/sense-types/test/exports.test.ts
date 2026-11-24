import { describe, expect, it } from 'vitest';
import {
  type ActionOutcomeLedgerEntry,
  type AsiDrivesSnapshot,
  type AsiSleepServiceApi,
  effectiveDisks,
  factStatusAt,
  NEED_KEYS,
  type NeedEvaluation,
  PARTNER_STATE_KINDS,
  type PartnerStateSnapshot,
  type SenseSettingsSnapshot,
  type SleepMemorySummary,
  sanitizeForModel,
  THERMAL_ORDINAL,
} from '../src/index.ts';

describe('shared type exports', () => {
  it('exposes survival need keys, thermal ordinals, freshness helpers and credential sanitization', () => {
    expect(NEED_KEYS).toEqual(['energy', 'space', 'memory', 'mind', 'thermals']);
    expect(PARTNER_STATE_KINDS).toContain('deep_focus');
    expect(PARTNER_STATE_KINDS).toContain('stuck_debugging');
    const tomCheck: Pick<PartnerStateSnapshot, 'state' | 'source'> = {
      state: 'steady_flow',
      source: 'inferred',
    };
    expect(tomCheck.state).toBe('steady_flow');
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

    const ledgerEntry: ActionOutcomeLedgerEntry = {
      need: 'space',
      action: 'clean-external-cache:xcode-derived-data',
      attempts: 2,
      effectiveCount: 2,
      successRate: 1,
      totalFreedBytes: 4_000_000_000,
      totalStoppedJobs: 0,
      totalTokensSaved: 0,
      totalSatisfactionDelta: 24,
      lastAttemptAt: 200,
      lastEffective: true,
    };
    const drivesSnap: AsiDrivesSnapshot = {
      now: 200,
      powerMode: 'normal',
      higherOrderSuppressed: false,
      activeTier: null,
      drives: [],
    };
    expect(ledgerEntry.successRate).toBe(1);
    expect(drivesSnap.higherOrderSuppressed).toBe(false);

    const sleepMem: SleepMemorySummary = {
      id: 'mem_1',
      kind: 'pitfall',
      title: 'Avoid symlink traversal',
      content: 'Always verify lstat before removing directories.',
      tags: ['security'],
      pinned: false,
      confidence: 0.9,
      retention: 0.92,
      evidenceCount: 2,
      recallCount: 1,
      sourceSessionIds: ['s1'],
      createdAt: 100,
      updatedAt: 150,
    };
    const sleepSvc: AsiSleepServiceApi = {
      listMemories: () => [sleepMem],
      subscribe: () => () => {},
    };
    expect(sleepSvc.listMemories()[0]?.retention).toBeCloseTo(0.92);
  });
});
