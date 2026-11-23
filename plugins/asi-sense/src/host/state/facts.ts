import type { Fact, SenseState, SourceObservation, SourceRef } from '@asi/sense-types';
import { effectiveDisks, factStatusAt } from '@asi/sense-types';

/** Source stamped on facts before the first real observation. */
export const INIT_SOURCE: SourceRef = {
  id: 'asi-sense',
  api: 'state',
  host: 'local',
};

/**
 * Writable fact paths for the internal, trusted `fact.updated` collection
 * seam. Only these full paths may be written — no arbitrary dotted paths,
 * which also keeps prototype keys (`__proto__` etc.) out.
 */
export const FACT_PATHS: ReadonlySet<string> = new Set([
  'self.activity',
  'self.pending',
  'self.tools',
  'self.permissions',
  'self.body.cpu',
  'self.body.memory',
  'self.body.disks',
  'self.body.battery',
  'self.body.thermal',
  'self.body.network',
  'self.body.harnessProcess',
  'self.body.tokens',
  'env.where.model',
  'env.where.harness',
  'env.where.observed',
  'env.where.toolExec',
  'env.frontApp',
  'env.focusedWindow',
  'env.activeJobs',
  'env.system',
]);

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function ttlOf(v: unknown, fallback: number): number {
  const n = num(v);
  return n !== undefined && n >= 0 ? n : fallback;
}

function blank<T>(at: number, ttlMs: number): Fact<T> {
  return {
    value: null,
    status: 'unknown',
    source: { ...INIT_SOURCE },
    observedAt: at,
    ttlMs,
  };
}

/** Builds the initial state: every fact `unknown`/`null` at `at`. */
export function initialState(at: number, ttlMs: number): SenseState {
  const f = <T>(): Fact<T> => blank(at, ttlMs);
  return {
    self: {
      activity: f(),
      pending: f(),
      tools: f(),
      permissions: f(),
      body: {
        cpu: f(),
        memory: f(),
        disks: { ...f(), kind: 'disks' },
        battery: f(),
        thermal: f(),
        network: f(),
        harnessProcess: f(),
        tokens: f(),
      },
    },
    env: {
      where: { model: f(), harness: f(), observed: f(), toolExec: f() },
      frontApp: f(),
      focusedWindow: f(),
      activeJobs: f(),
      system: f(),
    },
    // Null-prototype dictionary: '__proto__'/'constructor' source ids are safe.
    observation: {
      sources: Object.create(null) as Record<string, SourceObservation>,
    },
  };
}

/** Walks a whitelisted dot path to its fact node. */
export function factAt(state: SenseState, path: string): Fact<unknown> {
  let node: unknown = state;
  for (const seg of path.split('.')) node = (node as Record<string, unknown>)[seg];
  return node as Fact<unknown>;
}

/** Recomputes every fact's TTL status in place (on a cloned snapshot). */
export function recomputeStatuses(state: SenseState, now: number): void {
  for (const path of FACT_PATHS) {
    if (path === 'self.body.disks') {
      state.self.body.disks = effectiveDisks(state.self.body.disks, now);
      continue;
    }
    const fact = factAt(state, path);
    fact.status = factStatusAt(fact, now);
  }
}
