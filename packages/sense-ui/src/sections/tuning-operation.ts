import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SensePanelModel } from '../view-model'

type Operation = { phase: 'pending' | 'waiting' | 'error' | 'unconfirmed'; label: string; timer?: ReturnType<typeof setTimeout> }

function reflected(key: string, model: SensePanelModel): boolean {
  if (key === 'retry-backup') return !model.tuning?.backupError
  if (key === 'dismiss-backup') return !model.tuning?.backupNotice
  return key.startsWith('suggestion:')
    ? !model.tuning?.suggestions?.some((suggestion) => suggestion.id === key.slice(11))
    : !model.tuning?.disabled
}

export function useTuningOperations(model: SensePanelModel) {
  const [operations, setOperations] = useState<Record<string, Operation>>({})
  const current = useRef(operations)
  const latestModel = useRef(model)
  const mounted = useRef(true)
  useLayoutEffect(() => { latestModel.current = model }, [model])

  const update = (key: string, operation?: Operation) => {
    const next = { ...current.current }
    if (operation) next[key] = operation
    else delete next[key]
    current.current = next
    if (mounted.current) setOperations(next)
  }

  useEffect(() => {
    for (const [key, operation] of Object.entries(current.current)) {
      if (operation.phase === 'waiting' && reflected(key, latestModel.current)) {
        clearTimeout(operation.timer)
        update(key)
      }
    }
  })

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      for (const operation of Object.values(current.current)) clearTimeout(operation.timer)
    }
  }, [])

  const run = (key: string, callback: () => Promise<void>, label: string) => {
    if (current.current[key]?.phase === 'pending' || current.current[key]?.phase === 'waiting') return
    const operation: Operation = { phase: 'pending', label }
    update(key, operation)
    try {
      const result: unknown = callback()
      if (!result || typeof (result as Promise<void>).then !== 'function') throw new TypeError('Expected a Promise')
      Promise.resolve(result).then(() => {
        if (!mounted.current) return
        if (reflected(key, latestModel.current)) update(key)
        else {
          operation.phase = 'waiting'
          operation.timer = setTimeout(() => update(key, { phase: 'unconfirmed', label }), 10_000)
          update(key, operation)
        }
      }, () => update(key, { phase: 'error', label }))
    } catch {
      update(key, { phase: 'error', label })
    }
  }
  return { operations, run, dismiss: (key: string) => update(key) }
}

export type TuningOperations = ReturnType<typeof useTuningOperations>
