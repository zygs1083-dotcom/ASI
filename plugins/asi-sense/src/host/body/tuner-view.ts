import type { TuningValue } from '@asi/sense-types';
import type { TunerActor } from './tuner-guard.ts';
import type { TunerStore } from './tuner-state.ts';

export function safeNotify(listener?: () => void): () => void {
  return () => {
    try {
      listener?.();
    } catch {}
  };
}

export function parameters(
  store: TunerStore,
): { key: string; value: TuningValue; locked: boolean; source: TunerActor | 'default' }[] {
  return [...store.values].map(([key, value]) => ({
    key,
    value,
    locked: store.locked.has(key),
    source: store.applied.find((entry) => entry.id === store.lastApplied.get(key))?.by ?? 'default',
  }));
}
