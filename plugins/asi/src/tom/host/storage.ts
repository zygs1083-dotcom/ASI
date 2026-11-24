/**
 * Atomic local persistence for ASI Theory of Mind (`<storageRoot>/tom/state.json`).
 *
 * Strictly stores ONLY statistical EWMA rapport baselines, calibration bias
 * weights, and manual override preferences — NEVER raw prompt texts, window
 * titles, or file paths.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PARTNER_STATE_KINDS, type PartnerManualOverride, type PartnerStateKind } from '../shared/types.js';
import {
  type CalibrationBiases,
  createZeroCalibrationBiases,
  DEFAULT_RAPPORT_BASELINE,
  type RapportBaseline,
} from './evaluator.js';

export interface PersistedTomState {
  version: 1;
  enabled: boolean;
  manualOverride: PartnerManualOverride | null;
  baseline: RapportBaseline;
  calibrationBiases: CalibrationBiases;
  calibrationCount: number;
  lastUpdatedAt: number;
}

function isPartnerStateKind(value: unknown): value is PartnerStateKind {
  return typeof value === 'string' && (PARTNER_STATE_KINDS as readonly string[]).includes(value);
}

function clampFinite(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function createDefaultPersistedTomState(now = Date.now()): PersistedTomState {
  return {
    version: 1,
    enabled: true,
    manualOverride: null,
    baseline: { ...DEFAULT_RAPPORT_BASELINE },
    calibrationBiases: createZeroCalibrationBiases(),
    calibrationCount: 0,
    lastUpdatedAt: now,
  };
}

export function normalizePersistedTomState(raw: unknown, now = Date.now()): PersistedTomState {
  const defaults = createDefaultPersistedTomState(now);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
  const obj = raw as Record<string, unknown>;

  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : true;

  let manualOverride: PartnerManualOverride | null = null;
  if (obj.manualOverride && typeof obj.manualOverride === 'object' && !Array.isArray(obj.manualOverride)) {
    const mo = obj.manualOverride as Record<string, unknown>;
    if (
      isPartnerStateKind(mo.state) &&
      typeof mo.setAt === 'number' &&
      Number.isFinite(mo.setAt) &&
      typeof mo.expiresAt === 'number' &&
      Number.isFinite(mo.expiresAt) &&
      mo.expiresAt > now
    ) {
      manualOverride = {
        state: mo.state,
        setAt: mo.setAt,
        expiresAt: mo.expiresAt,
      };
    }
  }

  const rawBase =
    obj.baseline && typeof obj.baseline === 'object' && !Array.isArray(obj.baseline)
      ? (obj.baseline as Record<string, unknown>)
      : {};
  const baseline: RapportBaseline = {
    sampleCount: Math.floor(clampFinite(rawBase.sampleCount, 0, 0, 1_000_000)),
    ewmaInterMessageMs: Math.round(
      clampFinite(rawBase.ewmaInterMessageMs, DEFAULT_RAPPORT_BASELINE.ewmaInterMessageMs, 3_000, 900_000),
    ),
    ewmaPromptChars:
      Math.round(clampFinite(rawBase.ewmaPromptChars, DEFAULT_RAPPORT_BASELINE.ewmaPromptChars, 6, 3_000) * 10) / 10,
    ewmaAppSwitchesPer5m:
      Math.round(clampFinite(rawBase.ewmaAppSwitchesPer5m, DEFAULT_RAPPORT_BASELINE.ewmaAppSwitchesPer5m, 0, 60) * 10) /
      10,
    ewmaApprovalMs: Math.round(
      clampFinite(rawBase.ewmaApprovalMs, DEFAULT_RAPPORT_BASELINE.ewmaApprovalMs, 300, 180_000),
    ),
  };

  const biases = createZeroCalibrationBiases();
  if (obj.calibrationBiases && typeof obj.calibrationBiases === 'object' && !Array.isArray(obj.calibrationBiases)) {
    const rb = obj.calibrationBiases as Record<string, unknown>;
    for (const key of PARTNER_STATE_KINDS) {
      biases[key] = clampFinite(rb[key], 0, -18, 18);
    }
  }

  return {
    version: 1,
    enabled,
    manualOverride,
    baseline,
    calibrationBiases: biases,
    calibrationCount: Math.floor(clampFinite(obj.calibrationCount, 0, 0, 100_000)),
    lastUpdatedAt: clampFinite(obj.lastUpdatedAt, now, 0, Number.MAX_SAFE_INTEGER),
  };
}

export class TomStateStore {
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(storageRoot: string) {
    this.filePath = join(storageRoot, 'state.json');
  }

  async load(now = Date.now()): Promise<PersistedTomState> {
    try {
      const text = await readFile(this.filePath, 'utf8');
      return normalizePersistedTomState(JSON.parse(text), now);
    } catch {
      return createDefaultPersistedTomState(now);
    }
  }

  save(state: PersistedTomState): Promise<void> {
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    const run = async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      try {
        await writeFile(tmp, payload, 'utf8');
        await rename(tmp, this.filePath);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
    };
    const next = this.writeChain.then(run, run);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  flush(): Promise<void> {
    return this.writeChain;
  }
}
