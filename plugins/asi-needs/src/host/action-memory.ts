/**
 * Action-Outcome Memory Ledger & Zero-Gain Silent Circuit Breaker (`0.3.0`).
 *
 * 1. `ActionOutcomeLedger`: Automatically measures and persists real post-action
 *    gains (`freedBytes`, `stoppedJobs`, `tokensSaved`, `satisfactionDelta`) per
 *    `(need, action)` pair, recommending high-efficacy actions first on wakeup.
 * 2. `EpisodeCircuitBreaker`: When a distress episode has already attempted safe
 *    self-rescue with zero gain AND an open HelpCard has been posted, silently
 *    fuses further autonomous LLM wakeups (0 tokens) until:
 *    - the environment changes substantially,
 *    - distress escalates from `uncomfortable` to `critical`,
 *    - the user approves/handles the HelpCard, or
 *    - the need recovers to `comfortable`.
 */

import {
  type ActionMeasurement,
  type ActionOutcomeLedgerEntry,
  effectiveDisks,
  type NeedEvaluation,
  type NeedZone,
  type SenseSnapshot,
  sanitizeForModel,
} from '@asi/sense-types';

const MAX_LEDGER_ENTRIES = 64;
const DISK_SUBSTANTIAL_DELTA_BYTES = 512 * 1024 ** 2; // 512 MiB substantive disk change threshold
const SATISFACTION_CHANGE_UNLOCK_DELTA = 10;

export function buildActionMeasurement(input: {
  freedBytes?: number;
  stoppedJobs?: number;
  tokensSaved?: number;
  satisfactionBefore?: number;
  satisfactionAfter?: number;
}): ActionMeasurement {
  const freedBytes = input.freedBytes && input.freedBytes > 0 ? Math.round(input.freedBytes) : 0;
  const stoppedJobs = input.stoppedJobs && input.stoppedJobs > 0 ? Math.round(input.stoppedJobs) : 0;
  const tokensSaved = input.tokensSaved && input.tokensSaved > 0 ? Math.round(input.tokensSaved) : 0;
  const hasSatPair =
    input.satisfactionBefore !== undefined &&
    Number.isFinite(input.satisfactionBefore) &&
    input.satisfactionAfter !== undefined &&
    Number.isFinite(input.satisfactionAfter);
  const satisfactionDelta = hasSatPair
    ? Math.round((input.satisfactionAfter ?? 0) - (input.satisfactionBefore ?? 0))
    : undefined;

  const effective =
    freedBytes > 0 || stoppedJobs > 0 || tokensSaved > 0 || (satisfactionDelta !== undefined && satisfactionDelta > 0);

  return {
    ...(freedBytes > 0 ? { freedBytes } : {}),
    ...(stoppedJobs > 0 ? { stoppedJobs } : {}),
    ...(tokensSaved > 0 ? { tokensSaved } : {}),
    ...(hasSatPair
      ? {
          satisfactionBefore: Math.round(input.satisfactionBefore ?? 0),
          satisfactionAfter: Math.round(input.satisfactionAfter ?? 0),
          satisfactionDelta,
        }
      : {}),
    effective,
  };
}

export class ActionOutcomeLedger {
  private readonly map = new Map<string, ActionOutcomeLedgerEntry>();

  private keyOf(need: string, action: string): string {
    return `${need}::${action}`;
  }

  restore(raw: unknown): void {
    this.map.clear();
    if (!Array.isArray(raw)) return;
    for (const item of raw.slice(0, MAX_LEDGER_ENTRIES)) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Partial<ActionOutcomeLedgerEntry>;
      if (
        typeof rec.need !== 'string' ||
        !rec.need.trim() ||
        typeof rec.action !== 'string' ||
        !rec.action.trim() ||
        typeof rec.attempts !== 'number' ||
        !Number.isFinite(rec.attempts) ||
        rec.attempts <= 0
      ) {
        continue;
      }
      const attempts = Math.max(1, Math.floor(rec.attempts));
      const effectiveCount = Math.max(0, Math.min(attempts, Math.floor(rec.effectiveCount ?? 0)));
      const entry: ActionOutcomeLedgerEntry = {
        need: rec.need,
        action: rec.action,
        attempts,
        effectiveCount,
        successRate: Math.round((effectiveCount / attempts) * 1000) / 1000,
        totalFreedBytes: Math.max(0, Math.round(Number(rec.totalFreedBytes) || 0)),
        totalStoppedJobs: Math.max(0, Math.round(Number(rec.totalStoppedJobs) || 0)),
        totalTokensSaved: Math.max(0, Math.round(Number(rec.totalTokensSaved) || 0)),
        totalSatisfactionDelta: Math.max(0, Math.round(Number(rec.totalSatisfactionDelta) || 0)),
        lastAttemptAt: Number.isFinite(rec.lastAttemptAt) ? Number(rec.lastAttemptAt) : 0,
        lastEffective: Boolean(rec.lastEffective),
      };
      this.map.set(this.keyOf(entry.need, entry.action), entry);
    }
  }

  record(input: { need: string; action: string; at: number; gain: ActionMeasurement }): ActionOutcomeLedgerEntry {
    const k = this.keyOf(input.need, input.action);
    const prev = this.map.get(k);
    const attempts = (prev?.attempts ?? 0) + 1;
    const effectiveCount = (prev?.effectiveCount ?? 0) + (input.gain.effective ? 1 : 0);
    const deltaGain =
      input.gain.satisfactionDelta !== undefined && input.gain.satisfactionDelta > 0 ? input.gain.satisfactionDelta : 0;

    const updated: ActionOutcomeLedgerEntry = {
      need: input.need,
      action: input.action,
      attempts,
      effectiveCount,
      successRate: Math.round((effectiveCount / attempts) * 1000) / 1000,
      totalFreedBytes: (prev?.totalFreedBytes ?? 0) + (input.gain.freedBytes ?? 0),
      totalStoppedJobs: (prev?.totalStoppedJobs ?? 0) + (input.gain.stoppedJobs ?? 0),
      totalTokensSaved: (prev?.totalTokensSaved ?? 0) + (input.gain.tokensSaved ?? 0),
      totalSatisfactionDelta: (prev?.totalSatisfactionDelta ?? 0) + deltaGain,
      lastAttemptAt: input.at,
      lastEffective: input.gain.effective,
    };
    this.map.set(k, updated);

    if (this.map.size > MAX_LEDGER_ENTRIES) {
      const oldest = [...this.map.entries()].sort((a, b) => a[1].lastAttemptAt - b[1].lastAttemptAt)[0];
      if (oldest) this.map.delete(oldest[0]);
    }
    return { ...updated };
  }

  entries(): ActionOutcomeLedgerEntry[] {
    return [...this.map.values()]
      .sort(
        (a, b) =>
          b.successRate - a.successRate || b.effectiveCount - a.effectiveCount || b.lastAttemptAt - a.lastAttemptAt,
      )
      .map((e) => ({ ...e }));
  }

  entriesForNeed(need: string): ActionOutcomeLedgerEntry[] {
    return this.entries().filter((e) => e.need === need);
  }

  formatPromptRecommendations(needs: readonly string[]): string[] {
    const lines: string[] = [];
    for (const need of needs) {
      const items = this.entriesForNeed(need);
      if (items.length === 0) continue;
      const effective = items.filter((i) => i.effectiveCount > 0 && (i.lastEffective || i.successRate >= 0.5));
      const ineffective = items.filter((i) => i.attempts > 0 && !effective.includes(i));
      const parts: string[] = [];
      if (effective.length > 0) {
        const top = effective
          .slice(0, 3)
          .map(
            (i) =>
              `${sanitizeForModel(i.action)}（有效率 ${Math.round(i.successRate * 100)}%，${i.effectiveCount}/${i.attempts}）`,
          )
          .join('、');
        parts.push(`优先推荐历史有效动作：${top}`);
      }
      if (ineffective.length > 0) {
        const zeroList = ineffective
          .slice(0, 3)
          .map((i) =>
            i.effectiveCount === 0
              ? `${sanitizeForModel(i.action)}（0/${i.attempts} 有效）`
              : `${sanitizeForModel(i.action)}（近期零收益，${i.effectiveCount}/${i.attempts} 有效）`,
          )
          .join('、');
        parts.push(`以下动作历史或近期零收益：${zeroList}，若无新迹象请先调用 needs_sniff_causes 嗅探病因或发起求助`);
      }
      if (parts.length > 0) {
        lines.push(`- [${sanitizeForModel(need)}] ${parts.join('；')}`);
      }
    }
    return lines;
  }
}

export interface PersistedCircuitBreakerEntry {
  need: string;
  trippedAt: number;
  zoneAtTrip: 'uncomfortable' | 'critical';
  satisfactionAtTrip: number;
  envFingerprint: string;
  diskFreeAtTrip?: number;
  reason: string;
}

export function primaryDiskFreeBytes(snapshot: SenseSnapshot): number | undefined {
  const disks = effectiveDisks(snapshot.state.self.body.disks, Number.NEGATIVE_INFINITY);
  const vols = (disks.value ?? []).filter((v) => v.status === 'ok' && Number.isFinite(v.free));
  if (vols.length === 0) return undefined;
  return Math.min(...vols.map((v) => v.free));
}

export function computeDriveEnvFingerprint(input: {
  key: string;
  snapshot: SenseSnapshot;
  evaluation: Pick<NeedEvaluation, 'zone' | 'satisfaction' | 'evidence'>;
  stuckJobCount: number;
  idleSessionCount: number;
}): string {
  const { key, snapshot, evaluation, stuckJobCount, idleSessionCount } = input;
  if (key === 'space') {
    const disks = effectiveDisks(snapshot.state.self.body.disks, Number.NEGATIVE_INFINITY);
    const mounts = (disks.value ?? [])
      .filter((v) => v.status === 'ok' && Number.isFinite(v.free))
      .map((v) => v.mount)
      .sort()
      .join('|');
    return `space:${mounts}`;
  }
  if (key === 'memory') {
    const mem = snapshot.state.self.body.memory;
    const pressure = mem.status === 'ok' ? (mem.value?.pressure ?? 'unknown') : mem.status;
    return `memory:${pressure}:stuck=${stuckJobCount}`;
  }
  if (key === 'mind') {
    return `mind:active=${snapshot.activeSessionId ?? 'none'}:idle=${idleSessionCount}`;
  }
  if (key === 'thermals') {
    const th = snapshot.state.self.body.thermal;
    return `thermals:${th.status === 'ok' ? (th.value ?? 'unknown') : th.status}`;
  }
  const evidencePairs = Object.entries(evaluation.evidence ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('&');
  return evidencePairs ? `drive:${key}:${evidencePairs}` : `drive:${key}`;
}

export class EpisodeCircuitBreaker {
  private readonly tripped = new Map<string, PersistedCircuitBreakerEntry>();

  restore(raw: unknown): void {
    this.tripped.clear();
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const e = item as Partial<PersistedCircuitBreakerEntry>;
      if (
        typeof e.need !== 'string' ||
        (e.zoneAtTrip !== 'uncomfortable' && e.zoneAtTrip !== 'critical') ||
        typeof e.satisfactionAtTrip !== 'number' ||
        typeof e.envFingerprint !== 'string'
      ) {
        continue;
      }
      this.tripped.set(e.need, {
        need: e.need,
        trippedAt: Number.isFinite(e.trippedAt) ? Number(e.trippedAt) : 0,
        zoneAtTrip: e.zoneAtTrip,
        satisfactionAtTrip: e.satisfactionAtTrip,
        envFingerprint: e.envFingerprint,
        ...(typeof e.diskFreeAtTrip === 'number' && Number.isFinite(e.diskFreeAtTrip)
          ? { diskFreeAtTrip: e.diskFreeAtTrip }
          : {}),
        reason: typeof e.reason === 'string' ? e.reason : '零收益静默熔断',
      });
    }
  }

  serialize(): PersistedCircuitBreakerEntry[] {
    return [...this.tripped.values()].map((e) => ({ ...e }));
  }

  trippedNeeds(): string[] {
    return [...this.tripped.keys()];
  }

  isTripped(need: string): boolean {
    return this.tripped.has(need);
  }

  clear(need: string): boolean {
    return this.tripped.delete(need);
  }

  reconcileNeed(input: {
    need: string;
    driveActive: boolean;
    zone: NeedZone;
    satisfaction: number;
    envFingerprint: string;
    diskFreeBytes?: number;
  }): boolean {
    if (!input.driveActive || input.zone === 'comfortable') {
      this.tripped.delete(input.need);
      return false;
    }
    const existing = this.tripped.get(input.need);
    if (!existing) return false;

    // 1. Worsened from uncomfortable to critical -> lift breaker immediately
    if (existing.zoneAtTrip === 'uncomfortable' && input.zone === 'critical') {
      this.tripped.delete(input.need);
      return false;
    }

    // 2. Substantial disk free-space shift (>= 512 MiB from trip baseline, immune to grid boundary wobble)
    if (
      input.need === 'space' &&
      existing.diskFreeAtTrip !== undefined &&
      input.diskFreeBytes !== undefined &&
      Math.abs(input.diskFreeBytes - existing.diskFreeAtTrip) >= DISK_SUBSTANTIAL_DELTA_BYTES
    ) {
      this.tripped.delete(input.need);
      return false;
    }

    // 3. Substantial environment change or large satisfaction shift -> lift breaker
    if (
      input.envFingerprint !== existing.envFingerprint ||
      Math.abs(input.satisfaction - existing.satisfactionAtTrip) >= SATISFACTION_CHANGE_UNLOCK_DELTA
    ) {
      this.tripped.delete(input.need);
      return false;
    }

    return true;
  }

  trip(entry: PersistedCircuitBreakerEntry): void {
    this.tripped.set(entry.need, { ...entry });
  }
}
