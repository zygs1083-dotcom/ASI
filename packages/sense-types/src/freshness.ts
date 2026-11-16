import type { Fact, FactStatus } from './index.js';

export function ttlStatusAt(fact: Pick<Fact<unknown>, 'status' | 'observedAt' | 'ttlMs'>, now: number): FactStatus {
  return fact.status === 'ok' && now >= fact.observedAt + fact.ttlMs ? 'stale' : fact.status;
}
