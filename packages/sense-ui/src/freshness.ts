import { useEffect, useMemo, useState } from 'react'
import type { SensePanelModel } from './view-model'

function project(model: SensePanelModel, elapsed: number) {
  let deadline = Infinity
  function expire<T extends { status?: string; staleInMs?: number }>(value: T, fallback?: string): T {
    if ((value.status ?? fallback) !== 'ok' || !Number.isFinite(value.staleInMs)) return value
    if (value.staleInMs! <= elapsed) return { ...value, status: 'stale' }
    deadline = Math.min(deadline, value.staleInMs!)
    return value
  }
  function group<T extends object>(value: T): T {
    let result = value
    for (const [key, item] of Object.entries(value)) {
      if (!item || typeof item !== 'object') continue
      const next = expire(item)
      if (next !== item) {
        if (result === value) result = { ...value }
        Object.assign(result, { [key]: next })
      }
    }
    return result
  }
  const { self: originalSelf, env: originalEnv } = model.state
  let body = group(originalSelf.body)
  const disks = body.disks
  const volumes = disks.value?.map((volume) => expire(volume, disks.status))
  if (volumes?.some((volume, index) => volume !== disks.value![index])) {
    body = { ...body, disks: { ...disks, value: volumes } }
  }
  let self = group(originalSelf)
  if (body !== originalSelf.body) self = { ...self, body }
  const where = group(originalEnv.where)
  let env = group(originalEnv)
  if (where !== originalEnv.where) env = { ...env, where }
  return {
    model: self === originalSelf && env === originalEnv ? model : { ...model, now: model.now + elapsed, state: { ...model.state, self, env } },
    deadline,
  }
}

export function useFreshModel(model: SensePanelModel): SensePanelModel {
  const started = useMemo(() => performance.now(), [model])
  const [clock, setClock] = useState({ model, elapsed: 0 })
  const elapsed = clock.model === model ? clock.elapsed : 0
  const projected = useMemo(() => project(model, elapsed), [model, elapsed])
  useEffect(() => {
    if (!Number.isFinite(projected.deadline)) return
    const wait = Math.max(0, projected.deadline - (performance.now() - started))
    const timer = setTimeout(
      () => setClock({ model, elapsed: Math.max(0, performance.now() - started) }),
      Math.min(Math.ceil(wait), 2_147_483_647),
    )
    return () => clearTimeout(timer)
  }, [model, started, projected.deadline, elapsed])
  return projected.model
}
