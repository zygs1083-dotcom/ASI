/**
 * Maslow Multi-Tier Drive Arbiter (`ctx.asiDrives` core engine).
 *
 * - Tier 1 (`L1`): `asi-needs` built-in 5 physiological survival needs
 *   (`energy`, `space`, `memory`, `mind`, `thermals`).
 * - Tier 2..4 (`L2`–`L4`): Pluggable external drives registered by peer DSH
 *   bundles (e.g., `asi-sleep` at L2, `asi-care` at L3).
 * - Automatic Homeostatic Suppression: Whenever ANY L1 physiological drive is
 *   active/uncomfortable/critical OR `asi-sense` is in `'eco'` power mode, all
 *   higher-order (`L2`–`L4`) drives and their sandbox tools are automatically
 *   suspended (`suppressed = true`) so zero tokens or CPU cycles are spent on
 *   non-survival drives during physiological stress.
 */

import {
  type AsiDrivesSnapshot,
  type DriveEvaluation,
  type DriveHelpActionInput,
  type DriveHelpActionResult,
  type DriveSandboxToolSpec,
  type DriveSourceRegistration,
  type DriveTier,
  NEED_KEYS,
  type NeedEvaluation,
  type NeedKey,
  type PowerMode,
  type SenseSnapshot,
  sanitizeForModel,
} from '@asi/sense-types';
import { applyHysteresis, type PreviousNeedState } from './evaluator.js';

const RESERVED_TOOL_NAMES = new Set([
  'shell',
  'bash',
  'sh',
  'exec',
  'run_command',
  'write_file',
  'edit_file',
  'delete_file',
  'rm',
  'computer_use',
  'env_state',
  'env_detail',
  'needs_status',
  'memory_recall',
  'memory_profile',
  'care_status',
  'needs_sniff_causes',
  'needs_clean_cache',
  'needs_stop_job',
  'needs_compact_context',
  'needs_request_help',
]);

const VALID_ID_RE = /^[a-z][a-z0-9_-]{1,48}$/;
const VALID_TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;

function sliceCodePoints(value: string, maxChars: number): string {
  const chars = [...value];
  return chars.length > maxChars ? chars.slice(0, maxChars).join('') : value;
}

export interface RegisteredSandboxTool {
  sourceId: string;
  tier: 2 | 3 | 4;
  spec: DriveSandboxToolSpec;
  qualifiedDriveKey?: string;
}

export class MaslowDriveArbiter {
  private readonly sources = new Map<string, DriveSourceRegistration>();
  private readonly toolOwners = new Map<string, string>();
  private readonly prevHigherStates = new Map<string, PreviousNeedState>();
  private readonly listeners = new Set<(snapshot: AsiDrivesSnapshot) => void>();
  private readonly structureListeners = new Set<() => void>();

  private latestSnapshot: AsiDrivesSnapshot = {
    now: 0,
    powerMode: 'normal',
    higherOrderSuppressed: false,
    activeTier: null,
    drives: [],
  };

  constructor(
    private readonly onExternalChange?: () => void,
    private readonly onSourceUnregistered?: (sourceId: string) => void,
  ) {}

  qualifySourceDriveKey(sourceId: string, rawKey: string): string {
    return this.qualifyKey(sourceId, rawKey);
  }

  getSource(sourceId: string): DriveSourceRegistration | undefined {
    return this.sources.get(sourceId);
  }

  async executeHelpAction(driveKey: string, input: DriveHelpActionInput): Promise<DriveHelpActionResult> {
    const colon = driveKey.indexOf(':');
    const sourceId = colon > 0 ? driveKey.slice(0, colon) : '';
    const src = this.sources.get(sourceId);
    if (!src?.executeHelpAction) {
      throw new Error(`Drive source "${sourceId || driveKey}" cannot execute help action`);
    }
    return await src.executeHelpAction(input);
  }

  notifyHelpDismissed(
    driveKey: string,
    input: { cardId: string; driveKey: string; actionTarget?: string; now: number },
  ): void {
    const colon = driveKey.indexOf(':');
    const sourceId = colon > 0 ? driveKey.slice(0, colon) : '';
    const src = this.sources.get(sourceId);
    try {
      src?.onHelpDismissed?.(input);
    } catch {
      // Isolate dismissal callback errors
    }
  }

  async notifyHelpAcknowledged(
    driveKey: string,
    input: { cardId: string; driveKey: string; actionTarget?: string; now: number },
  ): Promise<void> {
    const colon = driveKey.indexOf(':');
    const sourceId = colon > 0 ? driveKey.slice(0, colon) : '';
    const src = this.sources.get(sourceId);
    try {
      await src?.onHelpAcknowledged?.(input);
    } catch {
      // Isolate acknowledge callback errors
    }
  }

  private qualifyKey(sourceId: string, rawKey: string): string {
    const clean = rawKey.trim();
    return clean.startsWith(`${sourceId}:`) ? clean : `${sourceId}:${clean}`;
  }

  registerSource(registration: DriveSourceRegistration): () => void {
    if (!VALID_ID_RE.test(registration.id) || registration.id === 'asi-needs' || registration.id === 'asi-sense') {
      throw new Error(`Invalid or reserved drive source id: ${String(registration.id)}`);
    }
    if (registration.tier !== 2 && registration.tier !== 3 && registration.tier !== 4) {
      throw new RangeError(`External drive source tier must be 2, 3, or 4 (got ${String(registration.tier)})`);
    }
    if (this.sources.has(registration.id)) {
      throw new Error(`Drive source already registered: ${registration.id}`);
    }

    const claimedTools: string[] = [];
    for (const tool of registration.sandboxTools ?? []) {
      if (!VALID_TOOL_NAME_RE.test(tool.name) || RESERVED_TOOL_NAMES.has(tool.name)) {
        throw new Error(`Forbidden or reserved sandbox tool name: ${String(tool.name)}`);
      }
      if (this.toolOwners.has(tool.name)) {
        throw new Error(`Sandbox tool name collision across drive sources: ${tool.name}`);
      }
      claimedTools.push(tool.name);
    }

    this.sources.set(registration.id, registration);
    for (const toolName of claimedTools) {
      this.toolOwners.set(toolName, registration.id);
    }

    for (const fn of [...this.structureListeners]) {
      try {
        fn();
      } catch {
        // Isolate structure listener errors
      }
    }
    this.onExternalChange?.();

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.sources.delete(registration.id);
      for (const toolName of claimedTools) {
        if (this.toolOwners.get(toolName) === registration.id) {
          this.toolOwners.delete(toolName);
        }
      }
      for (const key of [...this.prevHigherStates.keys()]) {
        if (key.startsWith(`${registration.id}:`)) {
          this.prevHigherStates.delete(key);
        }
      }
      const remainingDrives = this.latestSnapshot.drives.filter((d) => d.sourceId !== registration.id);
      let nextActiveTier: DriveTier | null = null;
      for (const d of remainingDrives) {
        if (d.driveActive && !d.suppressed && (nextActiveTier === null || d.tier < nextActiveTier)) {
          nextActiveTier = d.tier;
        }
      }
      this.latestSnapshot = {
        ...this.latestSnapshot,
        activeTier: nextActiveTier,
        drives: remainingDrives,
      };
      this.emit(this.latestSnapshot);
      for (const fn of [...this.structureListeners]) {
        try {
          fn();
        } catch {
          // Isolate structure listener errors
        }
      }
      this.onSourceUnregistered?.(registration.id);
      this.onExternalChange?.();
    };
  }

  notifySourceChanged(_sourceId?: string): void {
    this.onExternalChange?.();
  }

  onToolsStructureChanged(listener: () => void): () => void {
    this.structureListeners.add(listener);
    return () => {
      this.structureListeners.delete(listener);
    };
  }

  registeredSandboxTools(): RegisteredSandboxTool[] {
    const out: RegisteredSandboxTool[] = [];
    for (const src of this.sources.values()) {
      for (const spec of src.sandboxTools ?? []) {
        out.push({
          sourceId: src.id,
          tier: src.tier,
          spec,
          ...(spec.driveKey ? { qualifiedDriveKey: this.qualifyKey(src.id, spec.driveKey) } : {}),
        });
      }
    }
    return out;
  }

  checkSandboxToolGuard(
    toolName: string,
    options?: { autonomousTurn?: boolean },
  ): { allowed: boolean; reason?: string } {
    const ownerId = this.toolOwners.get(toolName);
    const src = ownerId ? this.sources.get(ownerId) : undefined;
    if (!ownerId || !src) {
      return { allowed: false, reason: 'ASI maintenance sandbox forbids non-whitelisted tools' };
    }
    if (this.latestSnapshot.higherOrderSuppressed) {
      return {
        allowed: false,
        reason:
          this.latestSnapshot.suppressionReason ??
          'Higher-order drive sandbox tool is suspended while L1 physiological needs or eco mode are active',
      };
    }
    if (options?.autonomousTurn) {
      const spec = src.sandboxTools?.find((t) => t.name === toolName);
      if (spec) {
        const regTool: RegisteredSandboxTool = {
          sourceId: src.id,
          tier: src.tier,
          spec,
          ...(spec.driveKey ? { qualifiedDriveKey: this.qualifyKey(src.id, spec.driveKey) } : {}),
        };
        const targetKey = this.resolveTargetDriveKey(regTool);
        const targetDrive = targetKey ? this.latestSnapshot.drives.find((d) => d.key === targetKey) : undefined;
        const sourceDrives = this.latestSnapshot.drives.filter((d) => d.sourceId === src.id);
        const autoMaintainDisabled =
          targetDrive?.autoMaintain === false ||
          (!targetDrive && sourceDrives.length > 0 && sourceDrives.every((d) => d.autoMaintain === false));
        if (autoMaintainDisabled) {
          return {
            allowed: false,
            reason: `Higher-order drive "${targetDrive?.key ?? src.id}" has autoMaintain=false and is deferred during autonomous maintenance turns`,
          };
        }
      }
    }
    return { allowed: true };
  }

  reconcile(input: { sense: SenseSnapshot; l1Needs: Record<NeedKey, NeedEvaluation>; powerMode: PowerMode }): {
    snapshot: AsiDrivesSnapshot;
    higherOrderDrives: DriveEvaluation[];
  } {
    const { sense, l1Needs, powerMode } = input;
    const l1Distressed = NEED_KEYS.some((k) => l1Needs[k].driveActive || l1Needs[k].zone !== 'comfortable');
    const ecoActive = powerMode === 'eco';
    const higherOrderSuppressed = l1Distressed || ecoActive;
    const suppressionReason =
      l1Distressed && ecoActive
        ? 'L1 生理需求不适且处于节能模式，高阶需求已挂起'
        : l1Distressed
          ? 'L1 生理需求处于不适或恢复期，高阶需求已挂起'
          : ecoActive
            ? '当前处于节能降频模式，高阶需求已挂起'
            : undefined;

    const l1Drives: DriveEvaluation[] = NEED_KEYS.map((k) => {
      const ev = l1Needs[k];
      return {
        key: ev.key,
        sourceId: 'asi-needs',
        tier: 1,
        label: ev.label,
        satisfaction: ev.satisfaction,
        urgency: ev.urgency,
        zone: ev.zone,
        driveActive: ev.driveActive,
        suppressed: false,
        summary: ev.summary,
        evidence: structuredClone(ev.evidence),
        updatedAt: ev.updatedAt,
      };
    });

    const higherOrderDrives: DriveEvaluation[] = [];
    const seenKeys = new Set<string>(NEED_KEYS);
    const sortedSources = [...this.sources.values()].sort((a, b) => a.tier - b.tier || a.id.localeCompare(b.id));
    const isolatedSense =
      sortedSources.length > 0
        ? (() => {
            const cloned = structuredClone(sense);
            if (!cloned.settings.sendTitles) {
              cloned.state.env.focusedWindow.value = null;
            }
            return cloned;
          })()
        : sense;

    for (const src of sortedSources) {
      let readings: readonly ReturnType<DriveSourceRegistration['evaluate']>[number][] = [];
      try {
        readings = src.evaluate(isolatedSense) ?? [];
      } catch {
        continue;
      }
      for (const r of readings) {
        if (!r?.key?.trim()) continue;
        const qKey = this.qualifyKey(src.id, r.key);
        if (seenKeys.has(qKey)) continue;
        seenKeys.add(qKey);
        const prev = this.prevHigherStates.get(qKey);
        const h = applyHysteresis(r.satisfaction, prev);
        this.prevHigherStates.set(qKey, {
          zone: h.zone,
          driveActive: h.driveActive,
          satisfaction: h.satisfaction,
        });

        const cleanLabel = sliceCodePoints(String(sanitizeForModel(r.label || r.key)), 48);
        const cleanSummary = sliceCodePoints(String(sanitizeForModel(r.summary || '')), 240);
        const cleanEvidence: Record<string, string | number | boolean | null> = {};
        for (const [ek, ev] of Object.entries(r.evidence ?? {})) {
          if (ev === null || typeof ev === 'boolean') {
            cleanEvidence[sanitizeForModel(ek)] = ev;
          } else if (typeof ev === 'number' && Number.isFinite(ev)) {
            cleanEvidence[sanitizeForModel(ek)] = ev;
          } else if (typeof ev === 'string') {
            cleanEvidence[sanitizeForModel(ek)] = sanitizeForModel(ev);
          }
        }

        higherOrderDrives.push({
          key: qKey,
          sourceId: src.id,
          tier: src.tier,
          label: cleanLabel,
          satisfaction: h.satisfaction,
          urgency: h.urgency,
          zone: h.zone,
          driveActive: h.driveActive,
          ...(r.autoMaintain !== undefined ? { autoMaintain: Boolean(r.autoMaintain) } : {}),
          suppressed: higherOrderSuppressed,
          ...(higherOrderSuppressed && suppressionReason ? { suppressionReason } : {}),
          summary: cleanSummary,
          evidence: cleanEvidence,
          updatedAt: sense.now,
        });
      }
    }

    const allDrives = [...l1Drives, ...higherOrderDrives];
    let activeTier: DriveTier | null = null;
    for (const d of allDrives) {
      if (d.driveActive && !d.suppressed) {
        if (activeTier === null || d.tier < activeTier) {
          activeTier = d.tier;
        }
      }
    }

    const nextSnap: AsiDrivesSnapshot = {
      now: sense.now,
      powerMode,
      higherOrderSuppressed,
      ...(suppressionReason ? { suppressionReason } : {}),
      activeTier,
      drives: allDrives,
    };
    this.latestSnapshot = nextSnap;
    this.emit(nextSnap);

    return {
      snapshot: structuredClone(nextSnap),
      higherOrderDrives: structuredClone(higherOrderDrives),
    };
  }

  actionableHigherOrderDrives(): DriveEvaluation[] {
    if (this.latestSnapshot.higherOrderSuppressed) return [];
    return this.latestSnapshot.drives
      .filter((d) => d.tier >= 2 && d.driveActive && !d.suppressed && d.autoMaintain !== false)
      .sort((a, b) => a.tier - b.tier || b.urgency - a.urgency)
      .map((d) => structuredClone(d));
  }

  findDrive(key: string): DriveEvaluation | undefined {
    const d = this.latestSnapshot.drives.find((item) => item.key === key);
    return d ? structuredClone(d) : undefined;
  }

  resolveTargetDriveKey(tool: RegisteredSandboxTool): string | undefined {
    if (tool.qualifiedDriveKey) return tool.qualifiedDriveKey;
    const candidates = this.latestSnapshot.drives.filter((d) => d.sourceId === tool.sourceId);
    if (candidates.length === 0) return undefined;
    const active = candidates.filter((d) => d.driveActive).sort((a, b) => b.urgency - a.urgency);
    return (active[0] ?? candidates[0])?.key;
  }

  snapshot(): AsiDrivesSnapshot {
    return structuredClone(this.latestSnapshot);
  }

  subscribe(listener: (snapshot: AsiDrivesSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(snap: AsiDrivesSnapshot): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(structuredClone(snap));
      } catch {
        // Isolate subscriber errors
      }
    }
  }
}
