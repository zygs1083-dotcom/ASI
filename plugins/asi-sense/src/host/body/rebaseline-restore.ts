import type { AnomalyRule } from './anomaly.ts';
import { type Candidate, decode, keyOf, paramOf, validate } from './rebaseline-candidate.ts';
import { type AdaptiveState, BODY_HISTORY } from './state.ts';
import type { Tuner } from './tuner.ts';

export interface Undo {
  id: string;
  param: string;
  stream: string;
  metric: string;
  slot: number;
  backup: string;
}

export function restoreProgress(
  raw: unknown,
  state: AdaptiveState,
  tuner: Tuner,
  rules: readonly AnomalyRule[],
): { candidates: Map<string, Candidate>; undos: Undo[] } | undefined {
  const expected = tuner.undoableChanges.filter((entry) => entry.kind === 'rebaseline');
  const candidates = new Map<string, Candidate>();
  const undos: Undo[] = [];
  if (raw === undefined) return expected.length ? undefined : { candidates, undos };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const data = raw as Record<string, unknown>;
  if (
    !Array.isArray(data.candidates) ||
    data.candidates.length > 1024 ||
    !Array.isArray(data.undos) ||
    data.undos.length !== expected.length
  )
    return undefined;
  const expectedById = new Map(expected.map((entry) => [entry.id, entry]));
  try {
    for (const item of data.candidates) {
      const candidate = validate(item);
      const baseline = candidate && state[BODY_HISTORY]?.[candidate.stream]?.anomaly?.baseline;
      if (!candidate || !baseline) return undefined;
      if ((candidate.days.at(-1)?.elapsed ?? 0) > baseline.elapsed) return undefined;
      if (!rules.some((r) => r.metric === candidate.metric)) continue;
      const key = keyOf(candidate.stream, candidate.metric, candidate.slot);
      if (candidates.has(key)) return undefined;
      candidates.set(key, candidate);
    }
    for (const item of data.undos) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
      const u = item as Record<string, unknown>;
      if (
        typeof u.id !== 'string' ||
        typeof u.stream !== 'string' ||
        typeof u.metric !== 'string' ||
        !Number.isInteger(u.slot) ||
        (u.slot as number) < 0 ||
        (u.slot as number) >= 168 ||
        typeof u.backup !== 'string' ||
        u.param !== paramOf(u.stream, u.metric, u.slot as number) ||
        undos.some((old) => old.id === u.id) ||
        expectedById.get(u.id)?.param !== u.param ||
        !state[BODY_HISTORY]?.[u.stream]?.anomaly?.baseline
      )
        return undefined;
      decode(u.backup, u.slot as number);
      undos.push(u as unknown as Undo);
    }
  } catch {
    return undefined;
  }
  return { candidates, undos };
}
