import type { DiskVolume, DisksFact, Fact } from './view-model'
import { effectiveStatus, isUsable, type Severity } from './fact-status'

/** 有效磁盘读数：total 为正有限、free 有限（free 可为 0）。 */
export function diskValid(d: { total: number; free: number }): boolean {
  return Number.isFinite(d.total) && d.total > 0 && Number.isFinite(d.free)
}

/** unavailableMounts 去重后的挂载点集合。 */
export function unavailableMountSet(f: DisksFact): Set<string> {
  return new Set(f.unavailableMounts ?? [])
}

/**
 * 卷级事实：父事实为底，叠加卷级 status/observedAt/ttlMs 覆盖。
 * unavailableMounts 命中即 unavailable 且清空读数；父事实有效状态为上界
 * （整列 stale/denied/已过期不能被卷级 ok 复活）；stale 保留读数供灰显，
 * unknown/unavailable 清空。配 effectiveStatus 得含 TTL 的最终状态。
 */
export function diskFact(parent: DisksFact, disk: DiskVolume, now: number): Fact<DiskVolume> {
  const observedAt = disk.observedAt ?? parent.observedAt
  const ttlMs = disk.ttlMs ?? parent.ttlMs
  if (unavailableMountSet(parent).has(disk.mount)) {
    return {
      value: null,
      status: 'unavailable',
      source: parent.source,
      observedAt,
      ttlMs,
    }
  }
  // 父事实有效状态为上界：整体已过期/拒绝不能靠卷级元数据复活
  const parentEff = effectiveStatus(parent, now)
  const status = parentEff === 'ok' ? (disk.status ?? 'ok') : parentEff
  return {
    value:
      status === 'ok' || status === 'stale'
        ? { mount: disk.mount, total: disk.total, free: disk.free }
        : null,
    status,
    source: parent.source,
    observedAt,
    ttlMs,
    reason: parent.reason,
  }
}

/** 卷是否新鲜可用：父可用、读数有效、不在 unavailableMounts、卷级有效状态 ok。 */
export function diskUsable(f: DisksFact, d: DiskVolume, now: number): boolean {
  return isUsable(f, now) && diskValid(d) && effectiveStatus(diskFact(f, d, now), now) === 'ok'
}

/** 单个磁盘剩余比例 → 严重度（每个盘独立着色用）。 */
export function diskSeverity(freeRatio: number): Severity {
  return freeRatio <= 0.05 ? 'critical' : freeRatio <= 0.1 ? 'warn' : 'good'
}
