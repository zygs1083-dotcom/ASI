/** 磁盘卷级健康度：每卷独立求值，父事实只做缺省兜底。 */

import type { DiskVolume, DisksFact, Fact, FactStatus } from './view-model'
import { effectiveStatus, type Severity } from './fact-status'

/** 有效磁盘读数：total 为正有限、free 有限（free 可为 0）。 */
export function diskValid(d: { total: number; free: number }): boolean {
  return Number.isFinite(d.total) && d.total > 0 && Number.isFinite(d.free)
}

/** unavailableMounts 去重后的挂载点集合。 */
export function unavailableMountSet(f: DisksFact): Set<string> {
  return new Set(f.unavailableMounts ?? [])
}

/**
 * 卷级事实：卷自声明 status 权威（父事实 stale/denied 不封顶
 * 显式 ok 的卷）；缺省字段回落到父事实——只有缺省 status 的卷才被父级有效
 * 状态兜底。unavailableMounts 命中即 unavailable 且清空读数（value 里带同名
 * 记录也不展示）；stale 保留读数供灰显，其余非 ok 清空；时间戳用于显示
 * 年龄，不再用于重判状态。
 */
export function diskFact(parent: DisksFact, disk: DiskVolume, now: number): Fact<DiskVolume> {
  const status = unavailableMountSet(parent).has(disk.mount)
    ? 'unavailable' : disk.status ?? effectiveStatus(parent, now)
  const observedAt = disk.observedAt ?? parent.observedAt
  const ttlMs = disk.ttlMs ?? parent.ttlMs
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

export function effectiveDisks(fact: DisksFact, now: number) {
  const volumes = (fact.value ?? []).map((volume) => {
    const { status, observedAt, ttlMs } = diskFact(fact, volume, now)
    return { ...volume, status, observedAt, ttlMs }
  })
  const fresh = volumes.filter((volume) => volume.status === 'ok')
  const pool = fresh.length ? fresh : volumes.filter((volume) => volume.status === 'stale')
  const observedAt = pool.length ? Math.min(...pool.map((volume) => volume.observedAt)) : fact.observedAt
  const ttlMs = pool.length ? Math.min(...pool.map((volume) => volume.observedAt + volume.ttlMs)) - observedAt : fact.ttlMs
  const status: FactStatus = fact.status === 'denied' || fact.status === 'unsupported'
    ? fact.status : fresh.length ? 'ok' : pool.length ? 'stale' : 'unknown'
  const indeterminateMounts = [...new Set([
    ...volumes.filter((volume) => volume.status !== 'ok').map((volume) => volume.mount),
    ...(fact.unavailableMounts ?? []),
  ])]
  return { ...fact, value: fact.value === null ? null : volumes, status, observedAt, ttlMs, indeterminateMounts }
}

/** 卷是否新鲜可用：读数有效、不在 unavailableMounts、卷级有效状态 ok。不做父级门槛。 */
export function diskUsable(f: DisksFact, d: DiskVolume, now: number): boolean {
  return diskValid(d) && effectiveStatus(diskFact(f, d, now), now) === 'ok'
}

/** 单个磁盘剩余比例 → 严重度（每个盘独立着色用）。 */
export function diskSeverity(freeRatio: number): Severity {
  return freeRatio <= 0.05 ? 'critical' : freeRatio <= 0.1 ? 'warn' : 'good'
}
