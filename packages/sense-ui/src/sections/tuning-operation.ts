import { useEffect, useRef, useState } from 'react'
import type { SensePanelModel } from '../view-model'

type Operation = { phase: 'pending' | 'waiting' | 'error'; observed?: boolean; timer?: ReturnType<typeof setTimeout> }

function reflected(key: string, model: SensePanelModel): boolean {
  return key.startsWith('suggestion:')
    ? !model.tuning?.suggestions?.some((suggestion) => suggestion.id === key.slice(11))
    : !model.tuning?.disabled
}

export function useTuningOperations(model: SensePanelModel) {
  const [operations, setOperations] = useState<Record<string, Operation>>({})
  const current = useRef(operations)
  const latestModel = useRef(model)
  const mounted = useRef(true)
  latestModel.current = model

  const update = (key: string, operation?: Operation) => {
    const next = { ...current.current }
    if (operation) next[key] = operation
    else delete next[key]
    current.current = next
    if (mounted.current) setOperations(next)
  }

  useEffect(() => {
    for (const [key, operation] of Object.entries(current.current)) {
      if (operation.phase === 'error' || !reflected(key, model)) continue
      if (operation.phase === 'pending') operation.observed = true
      else {
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

  const run = (key: string, callback: () => void | Promise<void>) => {
    if (current.current[key]?.phase === 'pending' || current.current[key]?.phase === 'waiting') return
    const operation: Operation = { phase: 'pending' }
    update(key, operation)
    try {
      Promise.resolve(callback()).then(() => {
        if (!mounted.current) return
        if (operation.observed || reflected(key, latestModel.current)) update(key)
        else {
          operation.phase = 'waiting'
          operation.timer = setTimeout(() => update(key), 10_000)
          update(key, operation)
        }
      }, () => update(key, { phase: 'error' }))
    } catch {
      update(key, { phase: 'error' })
    }
  }
  return { operations, run }
}

export type TuningOperations = ReturnType<typeof useTuningOperations>
